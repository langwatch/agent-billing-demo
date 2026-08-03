"""Verify a LangWatch webhook signature.

The header looks like::

    X-LangWatch-Signature: t=1722400000,v1=6f5a1b3c...

where ``v1`` is hex HMAC-SHA256 over the string ``"<t>.<raw body>"`` with
your endpoint's signing secret. Four rules matter:

1. Compute over the EXACT raw bytes you received. Do not parse and
   re-serialize the JSON first; any re-encoding difference changes the
   digest.
2. ``v1`` MAY REPEAT. While a secret is being rotated the header carries one
   ``v1`` per currently valid secret, newest first::

       X-LangWatch-Signature: t=1722400000,v1=<new>,v1=<old>

   Accept the delivery when ANY of them matches. That is what lets you swap
   the stored secret on your own schedule instead of dropping deliveries
   during the swap.
3. Reject stale timestamps. The tolerance is five minutes; a replayed
   capture outside that window fails even with a valid digest.
4. Fail closed. No secret configured means no verification is possible,
   which is a rejection, never a pass.

Compare in constant time, and compare every candidate even after one has
matched, so the work does not depend on WHICH signature matched.

Delivery identity is a separate header and not part of this check:
``X-LangWatch-Delivery-Id`` names the DELIVERY, and one delivery carries a
whole batch of envelopes. Dedup on the envelope ``id`` inside the body.

TODO-VALIDATE: roll an endpoint's secret and, inside the 24 hour window that
keeps the previous secret valid, confirm a delivery signed with both secrets
is accepted by a receiver still holding the OLD one and by one already
holding the NEW one. That is the case a single-``v1`` verifier fails, and it
is the only one that needs a live rotation to prove.
"""

import hashlib
import hmac
import time

SIGNATURE_TOLERANCE_SECONDS = 5 * 60

#: Names the delivery, not an event: one delivery carries a whole batch.
DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id"


def verify_signature(
    raw_body: bytes,
    signature_header: str | None,
    secret: str,
    now: float | None = None,
) -> bool:
    # No header and no secret are both "cannot verify", which is a rejection.
    if not signature_header or not secret:
        return False

    timestamp, candidates = _parse_signature_header(signature_header)
    if timestamp is None or not candidates:
        return False

    try:
        timestamp_seconds = float(timestamp)
    except ValueError:
        return False
    now_seconds = time.time() if now is None else now
    if abs(now_seconds - timestamp_seconds) > SIGNATURE_TOLERANCE_SECONDS:
        return False

    # Signed over the timestamp exactly as it appears in the header, so the
    # digest matches the signer byte for byte.
    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256
    ).hexdigest()

    matched = False
    for candidate in candidates:
        if hmac.compare_digest(expected, candidate):
            matched = True
    return matched


def _parse_signature_header(header: str) -> tuple[str | None, list[str]]:
    """The timestamp and EVERY ``v1`` the header carries, in the order sent."""
    timestamp: str | None = None
    candidates: list[str] = []
    for piece in header.split(","):
        key, eq, value = piece.partition("=")
        if not eq:
            continue
        key = key.strip()
        if key == "t":
            timestamp = value.strip()
        elif key == "v1":
            candidates.append(value.strip())
    return timestamp, candidates
