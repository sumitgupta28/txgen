"""
packages/iso_mapper/src/iso_mapper/de39_codes.py

ISO 8583 DE39 response code → domain model mapping.

This dict is the single source of truth for response code interpretation.
The same data is seeded into TimescaleDB's de39_response_codes table by
the Alembic migration — both must be kept in sync.

Adding a new response code: update this dict AND the migration seed data.
"""

from typing import TypedDict


class DE39Mapping(TypedDict):
    result_type: str           # APPROVED | REJECTED | FAILED | BLOCKED
    description: str
    rejection_reason: str | None   # maps to the rejection_reason enum


# Keys are the 2-character DE39 code strings exactly as they appear in ISO messages
DE39_MAP: dict[str, DE39Mapping] = {
    # ── Approvals ────────────────────────────────────────────────────────────
    "00": {"result_type": "APPROVED", "description": "Approved",                        "rejection_reason": None},
    "08": {"result_type": "APPROVED", "description": "Honour with identification",      "rejection_reason": None},
    "10": {"result_type": "APPROVED", "description": "Partial approval",                "rejection_reason": None},

    # ── Rejections (issuer declined) ─────────────────────────────────────────
    "05": {"result_type": "REJECTED", "description": "Do not honour",                   "rejection_reason": "declined_by_issuer"},
    "14": {"result_type": "REJECTED", "description": "Invalid card number",             "rejection_reason": "incorrect_card_details"},
    "51": {"result_type": "REJECTED", "description": "Insufficient funds",              "rejection_reason": "insufficient_funds"},
    "54": {"result_type": "REJECTED", "description": "Expired card",                    "rejection_reason": "expired_card"},
    "55": {"result_type": "REJECTED", "description": "Incorrect PIN",                   "rejection_reason": "incorrect_card_details"},
    "57": {"result_type": "REJECTED", "description": "Transaction not permitted to cardholder", "rejection_reason": "declined_by_issuer"},
    "65": {"result_type": "REJECTED", "description": "Exceeds withdrawal limit",        "rejection_reason": "over_credit_limit"},

    # ── Blocked cards ─────────────────────────────────────────────────────────
    "41": {"result_type": "BLOCKED", "description": "Lost card, pick up",               "rejection_reason": "card_blocked"},
    "43": {"result_type": "BLOCKED", "description": "Stolen card, pick up",             "rejection_reason": "card_blocked"},
    "62": {"result_type": "BLOCKED", "description": "Restricted card",                  "rejection_reason": "card_blocked"},
    "78": {"result_type": "BLOCKED", "description": "Card blocked",                     "rejection_reason": "card_blocked"},

    # ── System / network failures ─────────────────────────────────────────────
    "30": {"result_type": "FAILED",  "description": "Format error",                     "rejection_reason": None},
    "68": {"result_type": "FAILED",  "description": "Response received too late",       "rejection_reason": None},
    "91": {"result_type": "FAILED",  "description": "Issuer unavailable",               "rejection_reason": None},
    "96": {"result_type": "FAILED",  "description": "System malfunction",               "rejection_reason": None},
}
