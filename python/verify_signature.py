"""Verify a LangWatch webhook signature.

The header looks like::

    X-LangWatch-Signature: t=1722400000,v1=6f5a1b3c...

where ``v1`` is hex HMAC-SHA256 over the string ``"<t>.<raw body>"`` with
your endpoint's signing secret. Two rules matter:

1. Compute over the EXACT raw bytes you received. Do not parse and
   re-serialize the JSON first; any re-encoding difference changes the
   digest.
2. Reject stale timestamps. LangWatch documents a 5-minute tolerance; a
   replayed capture outside that window fails even with a valid digest.
"""

import hashlib
import hmac
import time

TOLERANCE_SECONDS = 5 * 60


def verify_signature(
    raw_body: bytes,
    signature_header: str | None,
    secret: str,
    now: float | None = None,
) -> bool:
    if not signature_header:
        return False

    parts: dict[str, str] = {}
    for piece in signature_header.split(","):
        key, eq, value = piece.partition("=")
        if eq:
            parts[key.strip()] = value.strip()
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature:
        return False

    try:
        timestamp_seconds = float(timestamp)
    except ValueError:
        return False
    now_seconds = time.time() if now is None else now
    if abs(now_seconds - timestamp_seconds) > TOLERANCE_SECONDS:
        return False

    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)
