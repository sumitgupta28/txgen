"""
infra/timescaledb/migrations/001_init.py

Initial TimescaleDB schema migration.

Alembic runs this once via the db-migrations Docker container.
All subsequent code assumes this schema exists.

Tables created:
  acquirers          - the 10 payment acquirers (reference data)
  de39_response_codes - ISO 8583 DE39 → result_type mapping (reference data)
  rag_rules          - configurable RAG classification thresholds
  auth_transactions  - ISO auth events (hypertable partitioned by occurred_at)
  settlement_transactions - ISO settlement events (hypertable)
  dispute_transactions    - ISO dispute events (hypertable)
  rag_metrics        - RAG Processor output (hypertable partitioned by evaluated_at)
  iso_parse_errors   - dead-letter queue for malformed messages
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID
import uuid


def upgrade() -> None:

    # ── Reference tables ──────────────────────────────────────────────────────

    op.create_table(
        "acquirers",
        sa.Column("acquirer_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("name", sa.Text, nullable=False, unique=True),
        sa.Column("network_id", sa.Text),
        sa.Column("region", sa.Text),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
    )

    # Seed the 10 acquirers from the original dashboard design
    op.execute("""
        INSERT INTO acquirers (acquirer_id, name, network_id, region) VALUES
        ('a1b2c3d4-0001-0001-0001-000000000001', 'Fiserv',     'FIS',   'US-East'),
        ('a1b2c3d4-0001-0001-0001-000000000002', 'BoFA',       'BOFA',  'US-East'),
        ('a1b2c3d4-0001-0001-0001-000000000003', 'TSYS',       'TSYS',  'US-West'),
        ('a1b2c3d4-0001-0001-0001-000000000004', 'Adyen',      'ADYN',  'EU'),
        ('a1b2c3d4-0001-0001-0001-000000000005', 'Stripe',     'STRP',  'US-West'),
        ('a1b2c3d4-0001-0001-0001-000000000006', 'JPMC',       'JPMC',  'US-East'),
        ('a1b2c3d4-0001-0001-0001-000000000007', 'WellsFargo', 'WFC',   'US-West'),
        ('a1b2c3d4-0001-0001-0001-000000000008', 'Citi',       'CITI',  'US-East'),
        ('a1b2c3d4-0001-0001-0001-000000000009', 'WorldPay',   'WOPAY', 'EU'),
        ('a1b2c3d4-0001-0001-0001-000000000010', 'Elevon',     'ELVN',  'US-West')
    """)

    op.create_table(
        "de39_response_codes",
        sa.Column("code", sa.CHAR(2), primary_key=True),
        sa.Column("result_type", sa.Text, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("rejection_reason", sa.Text),
    )

    op.execute("""
        INSERT INTO de39_response_codes (code, result_type, description, rejection_reason) VALUES
        ('00', 'APPROVED',  'Approved',                           NULL),
        ('08', 'APPROVED',  'Honour with identification',         NULL),
        ('10', 'APPROVED',  'Partial approval',                   NULL),
        ('05', 'REJECTED',  'Do not honour',                      'declined_by_issuer'),
        ('14', 'REJECTED',  'Invalid card number',                'incorrect_card_details'),
        ('51', 'REJECTED',  'Insufficient funds',                 'insufficient_funds'),
        ('54', 'REJECTED',  'Expired card',                       'expired_card'),
        ('65', 'REJECTED',  'Exceeds withdrawal limit',           'over_credit_limit'),
        ('41', 'BLOCKED',   'Lost card, pick up',                 'card_blocked'),
        ('43', 'BLOCKED',   'Stolen card, pick up',               'card_blocked'),
        ('62', 'BLOCKED',   'Restricted card',                    'card_blocked'),
        ('68', 'FAILED',    'Response received too late',          NULL),
        ('91', 'FAILED',    'Issuer unavailable',                  NULL),
        ('96', 'FAILED',    'System malfunction',                  NULL),
        ('30', 'FAILED',    'Format error',                        NULL)
    """)

    # ── RAG rules table (editable without code deploy) ────────────────────────

    op.create_table(
        "rag_rules",
        sa.Column("rule_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("domain", sa.Text, nullable=False),       # auth|settlement|dispute
        sa.Column("metric_name", sa.Text, nullable=False),
        sa.Column("acquirer_id", sa.Text, default="*"),     # "*" = applies to all
        sa.Column("operator", sa.Text, nullable=False),     # GT|LT|GTE|LTE
        sa.Column("threshold_red", sa.Numeric, nullable=False),
        sa.Column("threshold_amber", sa.Numeric, nullable=False),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("description", sa.Text),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
    )

    # Default RAG rules seeded from the dashboard wireframes
    op.execute("""
        INSERT INTO rag_rules
            (domain, metric_name, acquirer_id, operator, threshold_red, threshold_amber, description)
        VALUES
        -- Auth domain
        ('auth', 'failure_rate',       'Fiserv', 'GT', 0.03, 0.02, 'Auth failure > 3% for Fiserv'),
        ('auth', 'failure_rate',       '*',      'GT', 0.05, 0.03, 'Auth failure rate (all acquirers)'),
        ('auth', 'rejection_rate',     '*',      'GT', 0.10, 0.07, 'Auth rejection rate'),
        ('auth', 'avg_response_ms',    '*',      'GT', 3000, 2000, 'Auth avg response time'),
        ('auth', 'fraud_rate',         '*',      'GT', 0.10, 0.07, 'Fraud detection rate'),
        -- Settlement domain
        ('settlement', 'confirm_mins', 'BoFA',   'GT', 30,   25,   'Settlement confirmation > 30 mins for BoFA'),
        ('settlement', 'confirm_mins', '*',      'GT', 45,   30,   'Settlement confirmation time (all)'),
        ('settlement', 'error_rate',   '*',      'GT', 0.05, 0.03, 'Settlement error rate'),
        -- Dispute domain
        ('dispute', 'open_rate',       '*',      'GT', 0.05, 0.03, 'Open dispute rate')
    """)

    # ── Transaction tables (TimescaleDB hypertables) ───────────────────────────

    op.create_table(
        "auth_transactions",
        sa.Column("txn_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("acquirer_id", UUID(as_uuid=True),
                  sa.ForeignKey("acquirers.acquirer_id"), nullable=False),
        sa.Column("stan", sa.CHAR(6)),
        sa.Column("rrn", sa.VARCHAR(12)),
        sa.Column("mti", sa.CHAR(4)),
        sa.Column("result_type", sa.Text),
        sa.Column("de39_code", sa.CHAR(2)),
        sa.Column("amount", sa.Integer),              # cents/minor units
        sa.Column("currency_code", sa.CHAR(3)),       # ISO 4217 numeric
        sa.Column("rejection_reason", sa.Text),
        sa.Column("response_time_ms", sa.Integer),
        sa.Column("auth_code", sa.CHAR(6)),
        sa.Column("terminal_id", sa.CHAR(8)),
        sa.Column("merchant_id", sa.VARCHAR(15)),
        sa.Column("entry_mode", sa.Text),
        sa.Column("is_fraud", sa.Boolean, default=False),
        sa.Column("is_reversal", sa.Boolean, default=False),
        sa.Column("fraud_score", sa.Numeric(5, 2)),
        sa.Column("occurred_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("raw_iso_json", JSONB),             # original message for audit
    )

    # Create hypertable — partitions by occurred_at (time dimension)
    op.execute("SELECT create_hypertable('auth_transactions', 'occurred_at')")
    op.execute("SELECT add_retention_policy('auth_transactions', INTERVAL '90 days')")
    op.execute("SELECT add_compression_policy('auth_transactions', INTERVAL '7 days')")
    op.create_index("ix_auth_txn_acquirer_time",
                    "auth_transactions", ["acquirer_id", "occurred_at"])
    op.create_index("ix_auth_txn_de39",
                    "auth_transactions", ["de39_code", "occurred_at"])

    op.create_table(
        "settlement_transactions",
        sa.Column("txn_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("acquirer_id", UUID(as_uuid=True),
                  sa.ForeignKey("acquirers.acquirer_id"), nullable=False),
        sa.Column("stan", sa.CHAR(6)),
        sa.Column("mti", sa.CHAR(4)),
        sa.Column("amount", sa.Integer),
        sa.Column("currency_code", sa.CHAR(3)),
        sa.Column("confirmation_mins", sa.Numeric(6, 2)),
        sa.Column("slo_met", sa.Boolean),
        sa.Column("sla_met", sa.Boolean),
        sa.Column("error_reason", sa.Text),
        sa.Column("clearing_time_mins", sa.Numeric(6, 2)),
        sa.Column("ontime_payout", sa.Boolean),
        sa.Column("batch_id", sa.Text),
        sa.Column("occurred_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("raw_iso_json", JSONB),
    )

    op.execute("SELECT create_hypertable('settlement_transactions', 'occurred_at')")
    op.execute("SELECT add_retention_policy('settlement_transactions', INTERVAL '90 days')")
    op.create_index("ix_settle_txn_acquirer_time",
                    "settlement_transactions", ["acquirer_id", "occurred_at"])

    op.create_table(
        "dispute_transactions",
        sa.Column("txn_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("acquirer_id", UUID(as_uuid=True),
                  sa.ForeignKey("acquirers.acquirer_id"), nullable=False),
        sa.Column("stan", sa.CHAR(6)),
        sa.Column("dispute_type", sa.Text),
        sa.Column("reason_code", sa.VARCHAR(4)),
        sa.Column("status", sa.Text),
        sa.Column("amount", sa.Integer),
        sa.Column("resolution", sa.Text),
        sa.Column("resolution_days", sa.Integer),
        sa.Column("occurred_at", sa.TIMESTAMP(timezone=True), nullable=False),
        sa.Column("raw_iso_json", JSONB),
    )

    op.execute("SELECT create_hypertable('dispute_transactions', 'occurred_at')")
    op.create_index("ix_dispute_txn_acquirer_time",
                    "dispute_transactions", ["acquirer_id", "occurred_at"])

    # ── RAG metrics output table ───────────────────────────────────────────────

    op.create_table(
        "rag_metrics",
        sa.Column("metric_id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4),
        sa.Column("rule_id", UUID(as_uuid=True), sa.ForeignKey("rag_rules.rule_id")),
        sa.Column("domain", sa.Text, nullable=False),
        sa.Column("metric_name", sa.Text, nullable=False),
        sa.Column("acquirer_id", UUID(as_uuid=True),
                  sa.ForeignKey("acquirers.acquirer_id")),
        sa.Column("value", sa.Numeric),
        sa.Column("rag_status", sa.CHAR(1)),          # R | A | G
        sa.Column("slo_met", sa.Boolean),
        sa.Column("sla_met", sa.Boolean),
        sa.Column("window", sa.Text),                 # 1m | 5m | 1h
        sa.Column("evaluated_at", sa.TIMESTAMP(timezone=True), nullable=False),
    )

    op.execute("SELECT create_hypertable('rag_metrics', 'evaluated_at')")
    op.execute("SELECT add_retention_policy('rag_metrics', INTERVAL '365 days')")
    op.create_index("ix_rag_metrics_domain_acquirer",
                    "rag_metrics", ["domain", "acquirer_id", "evaluated_at"])

    # ── Error / dead-letter queue ─────────────────────────────────────────────

    op.create_table(
        "iso_parse_errors",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("kafka_topic", sa.Text),
        sa.Column("kafka_offset", sa.BigInteger),
        sa.Column("error_code", sa.Text),
        sa.Column("error_message", sa.Text),
        sa.Column("raw_payload", sa.Text),
        sa.Column("received_at", sa.TIMESTAMP(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("iso_parse_errors")
    op.drop_table("rag_metrics")
    op.drop_table("dispute_transactions")
    op.drop_table("settlement_transactions")
    op.drop_table("auth_transactions")
    op.drop_table("rag_rules")
    op.drop_table("de39_response_codes")
    op.drop_table("acquirers")
