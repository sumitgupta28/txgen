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

import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s %(name)s | %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)
logger.info("integrity-checker process starting | python=%s", sys.version.split()[0])

try:
    from pymongo import MongoClient
    logger.info("pymongo imported successfully")
except ImportError as e:
    logger.critical("Failed to import pymongo: %s", e)
    sys.exit(1)

try:
    from confluent_kafka import Consumer, KafkaError, Producer
    logger.info("confluent-kafka imported successfully")
except ImportError as e:
    logger.critical("Failed to import confluent_kafka: %s", e)
    sys.exit(1)

try:
    from models.iso_messages import IsoMessage
    from iso_mapper.de_mapper import map_to_parsed_message
    logger.info("shared packages (models, iso_mapper) imported successfully")
except ImportError as e:
    logger.critical("Failed to import shared packages: %s", e)
    sys.exit(1)

KAFKA_BROKERS  = os.getenv("KAFKA_BROKERS", "kafka:9092")
KAFKA_GROUP_ID = os.getenv("KAFKA_GROUP_ID", "integrity-checker-group")
MONGO_URL      = os.getenv("MONGO_URL", "mongodb://txgen:txgen@mongodb:27017/banking_db")

logger.info("Config | kafka_brokers=%s group=%s mongo_url=%s", KAFKA_BROKERS, KAFKA_GROUP_ID, MONGO_URL)

TOPICS = ["iso-auth", "iso-settlement", "iso-dispute"]

try:
    _mongo  = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
    _mongo.admin.command("ping")
    _db     = _mongo.banking_db
    logger.info("MongoDB connection verified | url=%s", MONGO_URL)
except Exception as e:
    logger.critical("MongoDB connection failed | url=%s error=%s", MONGO_URL, e)
    sys.exit(1)

try:
    _producer = Producer({"bootstrap.servers": KAFKA_BROKERS})
    logger.info("Kafka producer created | brokers=%s", KAFKA_BROKERS)
except Exception as e:
    logger.critical("Failed to create Kafka producer | brokers=%s error=%s", KAFKA_BROKERS, e)
    sys.exit(1)


def run_rules(topic: str, parsed, raw: dict) -> None:
    """Run all applicable integrity rules in parallel for the given message."""
    logger.debug("Running integrity rules | topic=%s stan=%s acquirer=%s", topic, parsed.stan, parsed.acquirer_id)

    rule_fns = []
    if topic == "iso-auth":
        rule_fns = [
            lambda: _rule_1_orphan_check(parsed),
            lambda: _rule_5_overdraft(parsed),
        ]
    elif topic == "iso-settlement":
        rule_fns = [lambda: _rule_2_settlement_ref(parsed)]
    elif topic == "iso-dispute":
        rule_fns = [lambda: _rule_3_dispute_ref(parsed)]

    violations = 0
    with ThreadPoolExecutor(max_workers=len(rule_fns) or 1) as pool:
        futures = {pool.submit(fn): fn for fn in rule_fns}
        for future in as_completed(futures):
            try:
                result = future.result()
            except Exception as e:
                logger.error("Rule raised exception | stan=%s error=%s", parsed.stan, e, exc_info=True)
                continue
            if isinstance(result, dict) and not result.get("pass"):
                violations += 1
                _publish_violation(result["rule"], result["detail"], parsed)

    if violations == 0:
        logger.debug("All rules passed | topic=%s stan=%s", topic, parsed.stan)


def _rule_1_orphan_check(parsed) -> dict:
    pan  = parsed.raw_de.get("2", "")
    card = _db.cards.find_one({"pan": pan, "status": "active"})
    if not card:
        logger.debug("Rule 1 FAIL | stan=%s pan_suffix=%s", parsed.stan, pan[-4:])
        return {"pass": False, "rule": "ORPHAN_TRANSACTION",
                "detail": f"Active card not found for PAN ending {pan[-4:]}"}
    logger.debug("Rule 1 pass | stan=%s", parsed.stan)
    return {"pass": True}


def _rule_2_settlement_ref(parsed) -> dict:
    txn = _db.transactions.find_one({"stan": parsed.stan})
    if not txn:
        logger.debug("Rule 2 FAIL: no transaction | stan=%s", parsed.stan)
        return {"pass": False, "rule": "INVALID_SETTLEMENT_REF",
                "detail": f"No transaction for STAN {parsed.stan}"}
    if txn.get("result_type") != "APPROVED":
        logger.debug("Rule 2 FAIL: non-approved transaction | stan=%s result_type=%s", parsed.stan, txn.get("result_type"))
        return {"pass": False, "rule": "INVALID_SETTLEMENT_REF",
                "detail": f"Settlement references non-approved transaction {parsed.stan}"}
    logger.debug("Rule 2 pass | stan=%s", parsed.stan)
    return {"pass": True}


def _rule_3_dispute_ref(parsed) -> dict:
    txn = _db.transactions.find_one({"rrn": parsed.rrn})
    if not txn or not txn.get("settlement_id"):
        logger.debug("Rule 3 FAIL: unsettled transaction | rrn=%s has_txn=%s", parsed.rrn, txn is not None)
        return {"pass": False, "rule": "PREMATURE_DISPUTE",
                "detail": f"Dispute on unsettled transaction RRN {parsed.rrn}"}
    logger.debug("Rule 3 pass | rrn=%s", parsed.rrn)
    return {"pass": True}


def _rule_5_overdraft(parsed) -> dict:
    if not parsed.result_type or parsed.result_type.value != "APPROVED":
        return {"pass": True}
    pan  = parsed.raw_de.get("2", "")
    card = _db.cards.find_one({"pan": pan})
    if not card:
        return {"pass": True}
    acc  = _db.accounts.find_one({"_id": card["account_id"]})
    if not acc:
        return {"pass": True}
    new_bal = acc["balance"]["available"] - parsed.amount
    limit   = -acc.get("overdraft_limit", 0)
    if new_bal < limit:
        logger.debug("Rule 5 FAIL: overdraft breach | stan=%s new_bal=%d limit=%d", parsed.stan, new_bal, limit)
        return {"pass": False, "rule": "OVERDRAFT_BREACH",
                "detail": f"Balance {new_bal} < limit {limit}"}
    logger.debug("Rule 5 pass | stan=%s new_bal=%d limit=%d", parsed.stan, new_bal, limit)
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
    logger.warning("Integrity violation published | rule=%s stan=%s acquirer=%s detail=%s",
                   rule, parsed.stan, parsed.acquirer_id, detail)


def main() -> None:
    logger.info("main() entered — creating Kafka consumer")
    logger.info("Integrity checker starting | kafka=%s group=%s topics=%s", KAFKA_BROKERS, KAFKA_GROUP_ID, TOPICS)
    consumer = Consumer({
        "bootstrap.servers": KAFKA_BROKERS,
        "group.id":          KAFKA_GROUP_ID,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": True,
    })
    consumer.subscribe(TOPICS)
    logger.info("Kafka consumer subscribed | topics=%s group=%s", TOPICS, KAFKA_GROUP_ID)

    processed = 0
    try:
        while True:
            msg = consumer.poll(timeout=1.0)
            if msg is None:
                continue
            if msg.error():
                if msg.error().code() != KafkaError._PARTITION_EOF:
                    logger.error("Kafka consumer error | error=%s", msg.error())
                continue
            try:
                raw    = json.loads(msg.value().decode("utf-8"))
                iso    = IsoMessage.model_validate(raw)
                parsed = map_to_parsed_message(iso)
                run_rules(msg.topic(), parsed, raw)
                processed += 1
                if processed % 500 == 0:
                    logger.info("Integrity checker heartbeat | processed=%d topic=%s", processed, msg.topic())
            except Exception as e:
                logger.error("Failed to process message | topic=%s partition=%d offset=%d error=%s",
                             msg.topic(), msg.partition(), msg.offset(), e, exc_info=True)
    finally:
        consumer.close()
        logger.info("Integrity checker stopped")


if __name__ == "__main__":
    main()
