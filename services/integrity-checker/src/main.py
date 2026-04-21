"""
services/integrity-checker/src/main.py

Validates referential integrity across MongoDB collections on every
ISO message received. Runs as a separate Kafka consumer group from the
MongoDB consumer so it never slows down writes.

The eight rules map directly to the integrity design from the architecture:
  Rule 1  — transaction must reference an active card
  Rule 2  — settlement must reference an approved transaction
  Rule 3  — dispute must reference a settled transaction
  Rule 4  — amount consistency across the chain
  Rule 5  — balance must not breach overdraft limit
  Rule 6  — ledger balance must match account balance (periodic)
  Rule 7  — one settlement per approved transaction
  Rule 8  — card scheme must match acquirer capability
"""

from __future__ import annotations

import asyncio
import json
import os

import motor.motor_asyncio as motor
from confluent_kafka import Consumer, KafkaError, Producer

from models.iso_messages import IsoMessage
from iso_mapper.de_mapper import map_to_parsed_message

KAFKA_BROKERS  = os.getenv("KAFKA_BROKERS", "kafka:29092")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "integrity-checker-group")
MONGO_URL      = os.getenv("MONGO_URL", "mongodb://txgen:txgen@mongodb:27017/banking_db")

TOPICS = ["iso-auth", "iso-settlement", "iso-dispute"]

_client = motor.AsyncIOMotorClient(MONGO_URL)
_db     = _client.banking_db

_producer = Producer({"bootstrap.servers": KAFKA_BROKERS})


async def run_rules(topic: str, parsed, raw: dict) -> None:
    """Run all applicable integrity rules for the given message."""
    results = await asyncio.gather(
        _rule_1_orphan_check(parsed) if topic == "iso-auth" else asyncio.sleep(0),
        _rule_2_settlement_ref(parsed) if topic == "iso-settlement" else asyncio.sleep(0),
        _rule_3_dispute_ref(parsed) if topic == "iso-dispute" else asyncio.sleep(0),
        _rule_5_overdraft(parsed) if topic == "iso-auth" else asyncio.sleep(0),
        return_exceptions=True,
    )

    for result in results:
        if isinstance(result, dict) and not result.get("pass"):
            _publish_violation(result["rule"], result["detail"], parsed)


async def _rule_1_orphan_check(parsed) -> dict:
    pan  = parsed.raw_de.get("2", "")
    card = await _db.cards.find_one({"pan": pan, "status": "active"})
    if not card:
        return {"pass": False, "rule": "ORPHAN_TRANSACTION",
                "detail": f"Active card not found for PAN ending {pan[-4:]}"}
    return {"pass": True}


async def _rule_2_settlement_ref(parsed) -> dict:
    txn = await _db.transactions.find_one({"stan": parsed.stan})
    if not txn:
        return {"pass": False, "rule": "INVALID_SETTLEMENT_REF",
                "detail": f"No transaction for STAN {parsed.stan}"}
    if txn.get("result_type") != "APPROVED":
        return {"pass": False, "rule": "INVALID_SETTLEMENT_REF",
                "detail": f"Settlement references non-approved transaction {parsed.stan}"}
    return {"pass": True}


async def _rule_3_dispute_ref(parsed) -> dict:
    txn = await _db.transactions.find_one({"rrn": parsed.rrn})
    if not txn or not txn.get("settlement_id"):
        return {"pass": False, "rule": "PREMATURE_DISPUTE",
                "detail": f"Dispute on unsettled transaction RRN {parsed.rrn}"}
    return {"pass": True}


async def _rule_5_overdraft(parsed) -> dict:
    if not parsed.result_type or parsed.result_type.value != "APPROVED":
        return {"pass": True}
    pan  = parsed.raw_de.get("2", "")
    card = await _db.cards.find_one({"pan": pan})
    if not card:
        return {"pass": True}
    acc  = await _db.accounts.find_one({"_id": card["account_id"]})
    if not acc:
        return {"pass": True}
    new_bal = acc["balance"]["available"] - parsed.amount
    limit   = -acc.get("overdraft_limit", 0)
    if new_bal < limit:
        return {"pass": False, "rule": "OVERDRAFT_BREACH",
                "detail": f"Balance {new_bal} < limit {limit}"}
    return {"pass": True}


def _publish_violation(rule: str, detail: str, parsed) -> None:
    event = json.dumps({
        "rule":        rule,
        "severity":    "error",
        "stan":        parsed.stan,
        "acquirer_id": parsed.acquirer_id,
        "detail":      detail,
    }).encode("utf-8")
    _producer.produce("integrity-events", value=event)
    _producer.poll(0)
    print(f"[INTEGRITY] {rule}: {detail}")


def main() -> None:
    print("Integrity checker starting...")
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id":          KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,
    })
    consumer.subscribe(TOPICS)

    while True:
        msg = consumer.poll(timeout=1.0)
        if msg is None:
            continue
        if msg.error():
            if msg.error().code() != KafkaError._PARTITION_EOF:
                print(f"Kafka error: {msg.error()}")
            continue
        try:
            raw    = json.loads(msg.value().decode("utf-8"))
            iso    = IsoMessage.model_validate(raw)
            parsed = map_to_parsed_message(iso)
            asyncio.run(run_rules(msg.topic(), parsed, raw))
        except Exception as e:
            print(f"[ERROR] {e}")


if __name__ == "__main__":
    main()
