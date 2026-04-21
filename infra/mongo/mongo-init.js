/**
 * infra/mongo/mongo-init.js
 *
 * Runs automatically when the MongoDB container starts for the first time
 * (mounted at /docker-entrypoint-initdb.d/init.js).
 *
 * Creates all indexes and JSON Schema validation rules for banking_db.
 * Idempotent — createIndex() with the same spec on an existing index is a no-op.
 */

db = db.getSiblingDB("banking_db");

print("Creating indexes for banking_db...");

// ── cardholders ───────────────────────────────────────────────────────────────
db.cardholders.createIndex({ "email": 1 }, { unique: true, sparse: true });
db.cardholders.createIndex({ "kyc_status": 1 });

// ── accounts ──────────────────────────────────────────────────────────────────
db.accounts.createIndex({ "cardholder_id": 1 });
db.accounts.createIndex({ "acquirer_id": 1 });
// Compound index: generator queries active USD accounts per acquirer
db.accounts.createIndex({ "status": 1, "currency": 1, "acquirer_id": 1 });

// ── cards ─────────────────────────────────────────────────────────────────────
// PAN lookup is the hottest read path — every auth transaction resolves PAN → card
db.cards.createIndex({ "pan": 1 }, { unique: true });
db.cards.createIndex({ "account_id": 1 });
db.cards.createIndex({ "status": 1, "scheme": 1 });

// ── transactions ──────────────────────────────────────────────────────────────
// STAN is unique — used for idempotent writes (safe Kafka replay)
db.transactions.createIndex({ "stan": 1 }, { unique: true });
db.transactions.createIndex({ "account_id": 1, "created_at": -1 });
db.transactions.createIndex({ "card_id": 1 });
// settlement_id is null until settled — index supports integrity Rule 3
db.transactions.createIndex({ "settlement_id": 1 }, { sparse: true });
// Grafana queries: rejection rates per acquirer over time
db.transactions.createIndex({ "acquirer_id": 1, "result_type": 1, "created_at": -1 });

// ── settlements ───────────────────────────────────────────────────────────────
// One settlement per transaction — enforced by unique index (integrity Rule 7)
db.settlements.createIndex({ "transaction_id": 1 }, { unique: true });
db.settlements.createIndex({ "acquirer_id": 1, "created_at": -1 });
db.settlements.createIndex({ "slo_met": 1, "sla_met": 1 });

// ── disputes ──────────────────────────────────────────────────────────────────
db.disputes.createIndex({ "transaction_id": 1 });
db.disputes.createIndex({ "account_id": 1, "status": 1 });
db.disputes.createIndex({ "reason_code": 1, "acquirer_id": 1 });

// ── ledger_entries ────────────────────────────────────────────────────────────
// Reconciliation query: sum all entries for an account ordered by time
db.ledger_entries.createIndex({ "account_id": 1, "created_at": 1 });
db.ledger_entries.createIndex({ "reference_id": 1 });

print("All indexes created successfully.");

// ── MongoDB Schema Validation (optional but recommended) ──────────────────────
// Validates documents at write time — rejects invalid shapes before they persist.

db.runCommand({
  collMod: "transactions",
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["stan", "card_id", "account_id", "acquirer_id", "amount", "currency", "status", "created_at"],
      properties: {
        stan:       { bsonType: "string", minLength: 6, maxLength: 6 },
        amount:     { bsonType: "int", minimum: 0 },
        currency:   { bsonType: "string", enum: ["USD"] },
        status:     { bsonType: "string", enum: ["authorised", "declined", "reversed", "settled"] },
        result_type: { bsonType: "string", enum: ["APPROVED", "REJECTED", "FAILED", "BLOCKED"] },
      }
    }
  },
  validationAction: "warn"  // "warn" logs violations without rejecting writes — safer in dev
});

print("Schema validation configured.");
