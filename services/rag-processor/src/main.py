"""
services/rag-processor/src/main.py

The RAG Processor consumes ISO-JSON messages from Kafka, maintains
windowed metric accumulators per acquirer, evaluates configurable rules,
and writes R/A/G classifications to TimescaleDB's rag_metrics hypertable.

Architecture:
  - Main thread: confluent-kafka sync poll loop
  - Timer thread: fires every 60s to materialise completed windows
  - Shared state: _accumulator dict protected by threading.Lock

No FastAPI, no HTTP server, no asyncio. This is a focused data pipeline
service. Simplicity is a feature — it restarts cleanly if it crashes.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone

import asyncpg
from confluent_kafka import Consumer, KafkaError
from models.iso_messages import IsoMessage, ParsedMessage
from iso_mapper.de_mapper import map_to_parsed_message

# ── Configuration ─────────────────────────────────────────────────────────────

KAFKA_BROKERS  = os.getenv("KAFKA_BROKERS", "kafka:29092")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "rag-processor-group")
DATABASE_URL   = os.getenv("DATABASE_URL", "postgresql://txgen:txgen@timescaledb:5432/txgen")
WINDOW_SECS    = 60     # 1-minute tumbling windows
RULE_CACHE_TTL = 30     # refresh rules from DB every 30 seconds

TOPICS = ["iso-auth", "iso-settlement", "iso-dispute"]

# ── Shared accumulator state ──────────────────────────────────────────────────
#
# Structure: {(acquirer_id, domain, window_minute): [ParsedMessage, ...]}
#
# window_minute = int(time.time() // 60) — the Unix minute the window started.
# A window is "complete" when window_minute < current_minute.

_accumulator: dict = defaultdict(list)
_lock = threading.Lock()

# ── Rule cache ────────────────────────────────────────────────────────────────

_rule_cache: list[dict] = []
_rule_cache_at: float = 0.0
_db_pool: asyncpg.Pool | None = None


async def _get_rules() -> list[dict]:
    """Fetch active RAG rules from TimescaleDB, cached for RULE_CACHE_TTL seconds."""
    global _rule_cache, _rule_cache_at
    if time.time() - _rule_cache_at < RULE_CACHE_TTL:
        return _rule_cache

    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM rag_rules WHERE is_active = true"
        )
    _rule_cache = [dict(r) for r in rows]
    _rule_cache_at = time.time()
    return _rule_cache


# ── Classification logic ──────────────────────────────────────────────────────

def _classify(value: float, rule: dict) -> str:
    """Apply a single rule to a metric value → 'R', 'A', or 'G'."""
    op = rule["operator"]
    red   = float(rule["threshold_red"])
    amber = float(rule["threshold_amber"])

    def compare(val: float, threshold: float) -> bool:
        return {
            "GT":  val >  threshold,
            "GTE": val >= threshold,
            "LT":  val <  threshold,
            "LTE": val <= threshold,
        }.get(op, False)

    if compare(value, red):
        return "R"
    if compare(value, amber):
        return "A"
    return "G"


def _compute_metrics(messages: list[ParsedMessage]) -> dict[str, float]:
    """
    Compute all metrics for a window of messages from one acquirer+domain.
    Returns a dict of metric_name → float value.
    """
    if not messages:
        return {}

    total = len(messages)
    domain = messages[0].domain.value

    if domain == "auth":
        approved  = sum(1 for m in messages if m.result_type and m.result_type.value == "APPROVED")
        rejected  = sum(1 for m in messages if m.result_type and m.result_type.value == "REJECTED")
        failed    = sum(1 for m in messages if m.result_type and m.result_type.value == "FAILED")
        response_times = [m.fraud_score for m in messages
                          if m.fraud_score is not None]  # using fraud_score as proxy
        return {
            "approval_rate":   approved / total,
            "rejection_rate":  rejected / total,
            "failure_rate":    failed   / total,
            "fraud_rate":      sum(1 for m in messages if m.fraud_score and m.fraud_score > 0.7) / total,
        }

    if domain == "settlement":
        slo_met = sum(1 for m in messages if m.slo_met)
        confirm_times = [m.confirm_mins for m in messages if m.confirm_mins is not None]
        return {
            "slo_met_rate":    slo_met / total,
            "error_rate":      sum(1 for m in messages
                                   if m.result_type and m.result_type.value != "APPROVED") / total,
            "avg_confirm_mins": sum(confirm_times) / len(confirm_times) if confirm_times else 0,
        }

    return {}


# ── Window materialisation ────────────────────────────────────────────────────

async def _materialise_windows() -> None:
    """
    Called every WINDOW_SECS by the timer thread.
    Finds all completed windows, computes metrics, evaluates rules,
    and writes RAG classifications to TimescaleDB.
    """
    current_minute = int(time.time() // WINDOW_SECS)

    # Take a snapshot of completed windows under the lock
    with _lock:
        completed = {
            k: v for k, v in _accumulator.items()
            if k[2] < current_minute    # window_minute < now → window is complete
        }
        for k in completed:
            del _accumulator[k]

    if not completed:
        return

    rules = await _get_rules()

    async with _db_pool.acquire() as conn:
        for (acquirer_id, domain, window_minute), messages in completed.items():
            metrics = _compute_metrics(messages)
            window_start = datetime.fromtimestamp(
                window_minute * WINDOW_SECS, tz=timezone.utc
            )

            for metric_name, value in metrics.items():
                # Find the most specific matching rule (acquirer-specific > wildcard)
                matching_rule = next(
                    (r for r in rules
                     if r["domain"] == domain
                     and r["metric_name"] == metric_name
                     and str(r.get("acquirer_id", "*")) == acquirer_id),
                    next(
                        (r for r in rules
                         if r["domain"] == domain
                         and r["metric_name"] == metric_name
                         and r.get("acquirer_id", "*") == "*"),
                        None
                    )
                )

                if not matching_rule:
                    continue

                rag_status = _classify(value, matching_rule)

                await conn.execute("""
                    INSERT INTO rag_metrics
                        (domain, metric_name, acquirer_id, value, rag_status, window, evaluated_at)
                    VALUES ($1, $2, $3::uuid, $4, $5, $6, $7)
                    ON CONFLICT DO NOTHING
                """,
                    domain, metric_name,
                    acquirer_id if acquirer_id != "*" else None,
                    value, rag_status, f"{WINDOW_SECS}s", window_start
                )

                if rag_status == "R":
                    print(
                        f"[RAG] RED  {domain}.{metric_name} "
                        f"acquirer={acquirer_id} value={value:.3f}"
                    )


def _timer_worker() -> None:
    """Background thread that triggers window materialisation every WINDOW_SECS."""
    while True:
        time.sleep(WINDOW_SECS)
        asyncio.run(_materialise_windows())


# ── Kafka consumer main loop ──────────────────────────────────────────────────

def main() -> None:
    global _db_pool

    print("RAG Processor starting...")

    # Create DB connection pool synchronously before starting the consumer
    _db_pool = asyncio.run(asyncpg.create_pool(DATABASE_URL.replace("+asyncpg", "")))

    # Start the window materialisation timer in a daemon thread
    timer = threading.Thread(target=_timer_worker, daemon=True)
    timer.start()

    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id": KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,
    })
    consumer.subscribe(TOPICS)

    print(f"Consuming from topics: {TOPICS}")

    try:
        while True:
            msg = consumer.poll(timeout=1.0)
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    print(f"Kafka error: {msg.error()}")
                continue

            try:
                raw = json.loads(msg.value().decode("utf-8"))
                iso_msg = IsoMessage.model_validate(raw)
                parsed = map_to_parsed_message(iso_msg)

                window_minute = int(time.time() // WINDOW_SECS)
                key = (parsed.acquirer_id, parsed.domain.value, window_minute)

                with _lock:
                    _accumulator[key].append(parsed)

            except Exception as e:
                print(f"Failed to process message: {e}")
                # Dead-letter: write to iso_parse_errors table
                # TODO: implement DLQ write

    except KeyboardInterrupt:
        pass
    finally:
        consumer.close()
        if _db_pool:
            asyncio.run(_db_pool.close())


if __name__ == "__main__":
    main()
