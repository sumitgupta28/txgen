"""
packages/models/src/models/iso_messages.py

Pydantic v2 models for ISO 8583 JSON-format messages.

These models serve three purposes simultaneously:
  1. Runtime validation — invalid messages are rejected before any processing
  2. Type safety      — IDE autocomplete and mypy catch errors at write time
  3. Documentation    — the model IS the schema, no separate JSON Schema files

Design decision: The _meta block is a non-standard extension added by the
Transaction Generator to carry generator-specific context (acquirer UUID,
scenario name, pre-computed timing fields). A real production ISO message
would not have _meta. The parsers handle its absence gracefully.
"""

from __future__ import annotations
from enum import Enum
from datetime import datetime
from pydantic import BaseModel, Field, field_validator


class MTI(str, Enum):
    """ISO 8583 Message Type Indicators supported by this system."""
    AUTH_REQUEST        = "0100"
    AUTH_RESPONSE       = "0110"
    FINANCIAL_REQUEST   = "0200"   # Settlement
    FINANCIAL_RESPONSE  = "0210"
    REVERSAL_REQUEST    = "0400"
    REVERSAL_RESPONSE   = "0410"
    DISPUTE_REQUEST     = "0600"
    DISPUTE_RESPONSE    = "0610"
    NETWORK_MGMT        = "0800"


class ResultType(str, Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    FAILED   = "FAILED"
    BLOCKED  = "BLOCKED"


class Domain(str, Enum):
    AUTH       = "auth"
    SETTLEMENT = "settlement"
    DISPUTE    = "dispute"
    NETMGMT    = "netmgmt"


class IsoMeta(BaseModel):
    """Generator-injected metadata — not part of the ISO standard."""
    acquirer_id:   str
    scenario:      str | None = None
    response_ms:   int | None = None        # auth domain
    confirm_mins:  float | None = None      # settlement domain
    slo_met:       bool | None = None       # settlement domain
    sla_met:       bool | None = None       # settlement domain
    generated_at:  datetime


class IsoMessage(BaseModel):
    """
    Base JSON-ISO message. All message types share this structure.
    
    The `de` field is a dict keyed by DE number strings ("2", "39", etc.)
    rather than integers because JSON object keys are always strings.
    """
    mti:    MTI
    bitmap: list[int] = Field(
        default_factory=list,
        description="64 or 128-element array, 0=absent 1=present. "
                    "Informational only in JSON format — presence determined by de keys."
    )
    de:     dict[str, str]      # Data Elements: {"2": "453201...", "39": "00", ...}
    meta:   IsoMeta = Field(alias="_meta")

    model_config = {"populate_by_name": True}

    @field_validator("de")
    @classmethod
    def validate_de_keys_are_numeric(cls, v: dict) -> dict:
        for key in v:
            if not key.isdigit():
                raise ValueError(f"DE key must be numeric string, got: {key!r}")
        return v


class ParsedMessage(BaseModel):
    """
    The domain object produced by the ISO mapper after validation.
    
    This is what the RAG Processor and MongoDB Consumer actually work with.
    They never touch the raw IsoMessage — the mapper layer absorbs all
    ISO field extraction logic. If the ISO format ever changes, only the
    mapper changes; the RAG Processor and consumers are untouched.
    """
    mti:               str
    domain:            Domain
    acquirer_id:       str
    stan:              str           # DE11 — System Trace Audit Number
    rrn:               str           # DE37 — Retrieval Reference Number
    occurred_at:       datetime
    amount:            int           # in cents/minor currency units
    currency_code:     str           # DE49 — ISO 4217 numeric ("840" = USD)
    result_type:       ResultType | None = None    # None for request messages
    auth_code:         str | None = None           # DE38 — present on approvals
    rejection_reason:  str | None = None           # derived from DE39
    de39_code:         str | None = None           # raw DE39 for audit
    terminal_id:       str | None = None           # DE41
    merchant_id:       str | None = None           # DE42
    entry_mode:        str | None = None           # DE22 decoded
    is_reversal:       bool = False
    fraud_score:       float | None = None         # DE63 custom field
    confirm_mins:      float | None = None         # settlement only
    slo_met:           bool | None = None          # settlement only
    sla_met:           bool | None = None          # settlement only
    raw_de:            dict[str, str]              # original DE map for audit
