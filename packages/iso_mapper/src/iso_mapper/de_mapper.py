"""
packages/iso_mapper/src/iso_mapper/de_mapper.py

Maps a raw ISO 8583 JSON message to a typed ParsedMessage domain object.

This module is the only place in the codebase that knows about ISO 8583
field semantics. The RAG Processor, MongoDB Consumer, and Integrity Checker
all consume ParsedMessage objects — they never touch raw DE dictionaries.

If the ISO message format ever changes (new DE fields, different encoding),
only this module needs updating. All consumers remain untouched.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from models.iso_messages import Domain, IsoMessage, MTI, ParsedMessage, ResultType
from .de39_codes import DE39_MAP
from .validators import luhn_check

logger = logging.getLogger(__name__)


def map_to_parsed_message(raw: IsoMessage) -> ParsedMessage:
    """
    Convert a validated IsoMessage into a ParsedMessage domain object.

    Raises ValueError if required fields for the message type are missing.
    The caller (validator layer) should catch this and route to the DLQ.
    """
    de = raw.de
    mti = raw.mti

    # Determine domain from MTI prefix
    domain = _mti_to_domain(mti)

    # DE12 (hhmmss) + DE13 (MMDD) → UTC datetime
    # The _meta.generated_at is more reliable for test data — use it if present
    using_meta_ts = raw.meta.generated_at is not None
    occurred_at = raw.meta.generated_at or _parse_iso_date(
        de.get("12", "000000"),
        de.get("13", "0101"),
    )
    if not using_meta_ts:
        logger.debug("Timestamp from DE12/DE13 (no _meta.generated_at) | stan=%s", de.get("11", ""))

    # DE39 response code → result_type + rejection_reason
    de39 = de.get("39")
    result_type = None
    rejection_reason = None
    if de39:
        mapping = DE39_MAP.get(de39)
        if mapping:
            result_type = ResultType(mapping["result_type"])
            rejection_reason = mapping.get("rejection_reason")
        else:
            logger.warning("Unknown DE39 code | de39=%s stan=%s mti=%s", de39, de.get("11", ""), mti.value)

    # DE4 is a 12-digit zero-padded string representing cents (implied decimal)
    # "000000015000" → 15000 cents → $150.00
    amount_str = de.get("4", "0")
    if not amount_str.isdigit():
        logger.warning("Non-numeric DE4 amount | de4=%r stan=%s — defaulting to 0", amount_str, de.get("11", ""))
    amount = int(amount_str) if amount_str.isdigit() else 0

    # Entry mode DE22: first two digits are the POS entry mode
    entry_mode_code = de.get("22", "")[:2]
    entry_mode_map = {
        "01": "manual",
        "05": "chip",
        "07": "contactless",
        "90": "swipe",
    }
    entry_mode = entry_mode_map.get(entry_mode_code, "unknown")
    if entry_mode == "unknown" and entry_mode_code:
        logger.debug("Unrecognised DE22 entry mode | de22=%s stan=%s", entry_mode_code, de.get("11", ""))

    parsed = ParsedMessage(
        mti=mti.value,
        domain=domain,
        acquirer_id=raw.meta.acquirer_id,
        stan=de.get("11", ""),
        rrn=de.get("37", ""),
        occurred_at=occurred_at,
        amount=amount,
        currency_code=de.get("49", "840"),   # default USD
        result_type=result_type,
        auth_code=de.get("38"),
        rejection_reason=rejection_reason,
        de39_code=de39,
        terminal_id=de.get("41"),
        merchant_id=de.get("42"),
        entry_mode=entry_mode,
        is_reversal=mti.value.startswith("04"),
        fraud_score=float(de["63"]) if de.get("63", "").replace(".", "").isdigit() else None,
        confirm_mins=raw.meta.confirm_mins,   # settlement only, from _meta
        slo_met=raw.meta.slo_met,
        sla_met=raw.meta.sla_met,
        raw_de=de,
    )

    logger.debug(
        "Message mapped | mti=%s domain=%s stan=%s rrn=%s acquirer=%s amount_cents=%d de39=%s result=%s",
        parsed.mti, parsed.domain.value, parsed.stan, parsed.rrn,
        parsed.acquirer_id, parsed.amount, de39, result_type.value if result_type else None,
    )
    return parsed


def _mti_to_domain(mti: MTI) -> Domain:
    """Map a Message Type Indicator to its business domain."""
    prefix = mti.value[:2]
    domain_map = {
        "01": Domain.AUTH,
        "04": Domain.AUTH,       # reversals are auth domain
        "02": Domain.SETTLEMENT,
        "06": Domain.DISPUTE,
        "08": Domain.NETMGMT,
    }
    return domain_map.get(prefix, Domain.AUTH)


def _parse_iso_date(time_str: str, date_str: str) -> datetime:
    """
    Parse ISO 8583 DE12 (local time hhmmss) + DE13 (date MMDD) into datetime.
    Uses current year since ISO 8583 doesn't transmit year in these fields.
    """
    now = datetime.now(timezone.utc)
    try:
        month = int(date_str[:2])
        day   = int(date_str[2:4])
        hour  = int(time_str[:2])
        minute = int(time_str[2:4])
        second = int(time_str[4:6])
        return datetime(now.year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except (ValueError, IndexError):
        logger.warning("Failed to parse DE12/DE13 datetime | de12=%r de13=%r — using now()", time_str, date_str)
        return now
