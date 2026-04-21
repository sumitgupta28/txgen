"""
packages/iso_mapper/src/iso_mapper/validators.py

Utility validators for ISO 8583 field content.
"""

import logging

logger = logging.getLogger(__name__)


def luhn_check(card_number: str) -> bool:
    """
    Validate a PAN using the Luhn algorithm.

    The Luhn algorithm is used by all major card networks to detect
    transcription errors. A valid PAN must pass this check.

    How it works:
      1. Double every second digit from the right
      2. If doubling gives > 9, subtract 9
      3. Sum all digits — if divisible by 10, the number is valid
    """
    digits = [int(d) for d in card_number if d.isdigit()]
    if len(digits) < 13:
        logger.debug("Luhn check failed: too short | length=%d", len(digits))
        return False

    # Process from right to left, doubling every second digit
    total = 0
    for i, digit in enumerate(reversed(digits)):
        if i % 2 == 1:          # every second position from the right
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit

    valid = total % 10 == 0
    if not valid:
        logger.debug("Luhn check failed | pan_suffix=%s", card_number[-4:] if len(card_number) >= 4 else "????")
    return valid


def validate_pan_bin(pan: str, scheme: str) -> bool:
    """
    Validate that a PAN's BIN (Bank Identification Number — first 6 digits)
    matches the expected range for the given card scheme.
    """
    bin_prefix = pan[:6]

    rules = {
        "visa":       lambda b: b.startswith("4"),
        "mastercard": lambda b: 510000 <= int(b) <= 559999,
        "amex":       lambda b: b[:2] in ("34", "37"),
        "discover":   lambda b: (
            b.startswith("6011")
            or b.startswith("65")
            or 622126 <= int(b) <= 622925
            or 644000 <= int(b) <= 649999
        ),
    }

    validator = rules.get(scheme.lower())
    if not validator:
        logger.debug("BIN validation skipped: unknown scheme | scheme=%s", scheme)
        return True   # unknown scheme — allow through

    try:
        result = validator(bin_prefix)
        if not result:
            logger.debug("BIN validation failed | scheme=%s bin=%s", scheme, bin_prefix)
        return result
    except ValueError:
        logger.debug("BIN validation error: non-numeric BIN | scheme=%s bin=%r", scheme, bin_prefix)
        return False
