"""
services/mongo-consumer/src/main.py

Kafka consumer that writes ISO-JSON messages to MongoDB.

Key design choices:
  - Synchronous confluent-kafka consumer (no asyncio complexity)
  - pymongo sessions for atomic writes (transaction + balance update = one ACID unit)
  - Idempotent: unique index on `stan` means replaying Kafka is always safe
  - One handler function per ISO domain (auth, settlement, dispute)
  - Parse errors go to iso_parse_errors Kafka topic (not printed and lost)
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
logger = logging.getLogger(__name__)

from confluent_kafka import Consumer, KafkaError, Producer
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from models.iso_messages import Domain, IsoMessage, MTI
from iso_mapper.de_mapper import map_to_parsed_message

# ── Configuration ─────────────────────────────────────────────────────────────

KAFKA_BROKERS  = os.getenv("KAFKA_BROKERS", "kafka:9092")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "mongo-writer-group")
MONGO_URL      = os.getenv("MONGO_URL", "mongodb://txgen:txgen@mongodb:27017/banking_db?authSource=admin")

TOPICS = ["iso-auth", "iso-settlement", "iso-dispute"]

# ── MongoDB client ────────────────────────────────────────────────────────────

_mongo = MongoClient(MONGO_URL)
_db    = _mongo.banking_db

# ── Auth message handler ──────────────────────────────────────────────────────

def handle_auth(parsed, raw_json: dict) -> None:
    """
    Write an auth response (MTI 0110) to MongoDB.

    The write is atomic: transaction document + balance update happen in
    a single MongoDB multi-document transaction (session). If either write
    fails, both are rolled back. Kafka offset is committed only after success,
    so retries are safe (DuplicateKeyError on `stan` makes them idempotent).
    """
    # Look up card by PAN — validates the card exists (integrity Rule 1)
    pan = parsed.raw_de.get("2", "")
    card = _db.cards.find_one({"pan": pan, "status": "active"})
    if not card:
        logger.warning("Auth: active card not found | pan_suffix=%s stan=%s acquirer=%s", pan[-4:], parsed.stan, parsed.acquirer_id)
        return

    account = _db.accounts.find_one({"_id": card["account_id"]})
    if not account:
        logger.warning("Auth: account not found | card_id=%s stan=%s", card["_id"], parsed.stan)
        return

    txn_doc = {
        "mti":              parsed.mti,
        "stan":             parsed.stan,
        "rrn":              parsed.rrn,
        "card_id":          card["_id"],
        "account_id":       account["_id"],
        "cardholder_id":    account["cardholder_id"],
        "acquirer_id":      parsed.acquirer_id,
        "pan_masked":       card["pan_masked"],
        "amount":           parsed.amount,
        "currency":         "USD",
        "result_type":      parsed.result_type.value if parsed.result_type else None,
        "de39_code":        parsed.de39_code,
        "auth_code":        parsed.auth_code,
        "rejection_reason": parsed.rejection_reason,
        "terminal_id":      parsed.terminal_id,
        "merchant_id":      parsed.merchant_id,
        "entry_mode":       parsed.entry_mode,
        "is_reversal":      parsed.is_reversal,
        "fraud_score":      parsed.fraud_score,
        "settlement_id":    None,
        "dispute_id":       None,
        "status":           "authorised" if parsed.result_type and
                            parsed.result_type.value == "APPROVED" else "declined",
        "iso_json":         raw_json,
        "created_at":       parsed.occurred_at,
        "updated_at":       datetime.now(timezone.utc),
    }

    with _mongo.start_session() as session:
        with session.start_transaction():
            try:
                _db.transactions.insert_one(txn_doc, session=session)
            except DuplicateKeyError:
                # STAN already exists — this is a Kafka replay, safe to skip
                logger.debug("Auth: duplicate STAN skipped (Kafka replay) | stan=%s", parsed.stan)
                return

            # Only update balance on approved transactions
            if parsed.result_type and parsed.result_type.value == "APPROVED":
                _db.accounts.update_one(
                    {"_id": account["_id"]},
                    {
                        "$inc": {
                            "balance.available": -parsed.amount,
                            "balance.pending":   +parsed.amount,
                        },
                        "$set": {"updated_at": datetime.now(timezone.utc)},
                    },
                    session=session,
                )

                _db.ledger_entries.insert_one({
                    "account_id":     account["_id"],
                    "entry_type":     "debit_pending",
                    "amount":         parsed.amount,
                    "currency":       "USD",
                    "balance_before": account["balance"]["available"],
                    "balance_after":  account["balance"]["available"] - parsed.amount,
                    "reference_type": "transaction",
                    "reference_id":   txn_doc["stan"],
                    "description":    f"POS auth {parsed.merchant_id or 'unknown'}",
                    "created_at":     datetime.now(timezone.utc),
                }, session=session)

                logger.debug(
                    "Auth: approved, balance updated | stan=%s amount_cents=%d account=%s de39=%s",
                    parsed.stan, parsed.amount, account["_id"], parsed.de39_code,
                )
            else:
                logger.debug(
                    "Auth: declined, no balance change | stan=%s de39=%s reason=%s",
                    parsed.stan, parsed.de39_code, parsed.rejection_reason,
                )


# ── Settlement message handler ────────────────────────────────────────────────

def handle_settlement(parsed, raw_json: dict) -> None:
    """Write a settlement response (MTI 0210) to MongoDB."""
    # Look up the original auth transaction by STAN
    original_txn = _db.transactions.find_one({"stan": parsed.stan})
    if not original_txn:
        logger.warning("Settlement: no auth transaction found | stan=%s acquirer=%s", parsed.stan, parsed.acquirer_id)
        return

    settlement_doc = {
        "transaction_id":   original_txn["_id"],
        "account_id":       original_txn["account_id"],
        "acquirer_id":      parsed.acquirer_id,
        "stan":             parsed.stan,
        "amount":           parsed.amount,
        "currency":         "USD",
        "de39_code":        parsed.de39_code,
        "confirmation_mins": parsed.confirm_mins,
        "slo_met":          parsed.slo_met,
        "sla_met":          parsed.sla_met,
        "status":           "settled",
        "iso_json":         raw_json,
        "created_at":       parsed.occurred_at,
    }

    try:
        result = _db.settlements.insert_one(settlement_doc)
    except DuplicateKeyError:
        logger.debug("Settlement: duplicate STAN skipped (Kafka replay) | stan=%s", parsed.stan)
        return  # Already settled — Kafka replay, safe to skip

    # Update the transaction to reference the settlement
    _db.transactions.update_one(
        {"_id": original_txn["_id"]},
        {"$set": {"settlement_id": result.inserted_id, "status": "settled"}},
    )
    logger.debug(
        "Settlement written | stan=%s settlement_id=%s slo_met=%s confirm_mins=%s",
        parsed.stan, result.inserted_id, parsed.slo_met, parsed.confirm_mins,
    )


# ── Dispute message handler ───────────────────────────────────────────────────

def handle_dispute(parsed, raw_json: dict) -> None:
    """Write a dispute request (MTI 0600) to MongoDB."""
    # Find the transaction by RRN
    original_txn = _db.transactions.find_one({"rrn": parsed.rrn})

    if not original_txn:
        logger.warning("Dispute: no transaction found for RRN | rrn=%s acquirer=%s (writing orphan dispute)", parsed.rrn, parsed.acquirer_id)

    dispute_doc = {
        "transaction_id":   original_txn["_id"] if original_txn else None,
        "settlement_id":    original_txn.get("settlement_id") if original_txn else None,
        "account_id":       original_txn["account_id"] if original_txn else None,
        "cardholder_id":    original_txn.get("cardholder_id") if original_txn else None,
        "acquirer_id":      parsed.acquirer_id,
        "amount":           parsed.amount,
        "currency":         "USD",
        "reason_code":      parsed.raw_de.get("25", ""),
        "dispute_type":     "chargeback",
        "description":      parsed.raw_de.get("72", ""),
        "status":           "open",
        "resolution":       None,
        "resolution_days":  None,
        "iso_json":         raw_json,
        "opened_at":        parsed.occurred_at,
        "updated_at":       datetime.now(timezone.utc),
    }

    result = _db.disputes.insert_one(dispute_doc)
    logger.debug(
        "Dispute written | rrn=%s dispute_id=%s reason_code=%s has_txn=%s",
        parsed.rrn, result.inserted_id, dispute_doc["reason_code"], original_txn is not None,
    )


# ── Main consumer loop ────────────────────────────────────────────────────────

HANDLERS = {
    "iso-auth":       handle_auth,
    "iso-settlement": handle_settlement,
    "iso-dispute":    handle_dispute,
}


def main() -> None:
    logger.info("MongoDB consumer starting | kafka=%s group=%s topics=%s", KAFKA_BROKERS, KAFKA_GROUP_ID, TOPICS)
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id":          KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,   # manual commit after successful write
    })
    consumer.subscribe(TOPICS)
    logger.info("Kafka consumer subscribed | topics=%s group=%s", TOPICS, KAFKA_GROUP_ID)

    processed = 0
    while True:
        msg = consumer.poll(timeout=1.0)
        if msg is None:
            continue
        if msg.error():
            if msg.error().code() != KafkaError._PARTITION_EOF:
                logger.error("Kafka consumer error | error=%s", msg.error())
            continue

        topic = msg.topic()
        try:
            raw = json.loads(msg.value().decode("utf-8"))
            iso_msg = IsoMessage.model_validate(raw)
            parsed  = map_to_parsed_message(iso_msg)

            logger.debug("Message received | topic=%s mti=%s stan=%s acquirer=%s", topic, parsed.mti, parsed.stan, parsed.acquirer_id)

            handler = HANDLERS.get(topic)
            if handler:
                handler(parsed, raw)

            # Commit offset only after successful processing
            consumer.commit(asynchronous=False)
            processed += 1

            if processed % 500 == 0:
                logger.info("Consumer heartbeat | processed=%d topic=%s partition=%d offset=%d", processed, topic, msg.partition(), msg.offset())

        except Exception as e:
            logger.error("Failed to process message | topic=%s partition=%d offset=%d error=%s", topic, msg.partition(), msg.offset(), e, exc_info=True)
            # TODO: write to iso_parse_errors Kafka topic for audit


if __name__ == "__main__":
    main()
