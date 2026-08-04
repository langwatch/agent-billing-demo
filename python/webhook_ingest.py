"""The app hosts its own webhook endpoint, so the meters on screen are fed by
the same signed deliveries a production integration receives. The standalone
receivers in ``ts/`` and ``python/receiver.py`` implement the identical
contract; this module is the version that lives inside the product.

The contract, in four rules:

1. Verify the HMAC over the EXACT raw bytes received, then parse. The SDK's
   ``verify_webhook_signature`` is the verifier: it takes every secret this
   receiver currently accepts, so a rotation has no refusing window.
2. Dedup by envelope id. Delivery is at-least-once.
   ``X-LangWatch-Delivery-Id`` names the DELIVERY, which carries a whole
   batch, so it is a log correlation handle and never the dedup key.
3. Fail closed: no secret configured means no verification is possible.
4. Answer 2xx only once the batch is durably stored, so a failed write makes
   LangWatch retry instead of dropping money on the floor.
"""

import json
import sqlite3
from typing import Any, Dict, Optional, Tuple

from store import now_iso


def ingest_envelope(
    conn: sqlite3.Connection, envelope: Dict[str, Any]
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Store one envelope verbatim. Request events carry money and are
    unpacked into their own columns so the meters can sum them; budget and
    virtual key events are operational signals, kept whole for the live feed.

    A later ``gateway.request.completed`` does not overwrite the ``settled``
    row it supersedes: both envelopes are archived, and the spend query prefers
    the completed one per gateway request id. Replace at read time, never sum.

    Returns ``("ingested", row)`` or ``("duplicate", None)``.
    """
    existing = conn.execute(
        "SELECT 1 FROM billing_events WHERE event_id = ?", (envelope["id"],)
    ).fetchone()
    if existing:
        return "duplicate", None

    data = envelope.get("data") or {}
    usage = data.get("usage") or {}
    cost = data.get("cost") or {}
    row = {
        "event_id": envelope["id"],
        "type": envelope["type"],
        "gateway_request_id": _as_string(data.get("gateway_request_id")),
        "virtual_key_id": _as_string(data.get("virtual_key_id"))
        or _archived_bucket_virtual_key(data),
        "end_user_id": _as_string(data.get("end_user_id")),
        "model": _as_string(data.get("model")),
        "status": _as_string(data.get("status")),
        "cost_nano_usd": _as_int(cost.get("nano_usd")),
        "input_tokens": _as_int(usage.get("input_tokens")),
        "output_tokens": _as_int(usage.get("output_tokens")),
        "occurred_at": _as_string(data.get("occurred_at"))
        or envelope.get("created")
        or now_iso(),
        "received_at": now_iso(),
        "payload": json.dumps(envelope),
    }
    conn.execute(
        """
        INSERT INTO billing_events (
            event_id, type, gateway_request_id, virtual_key_id, end_user_id,
            model, status, cost_nano_usd, input_tokens, output_tokens,
            occurred_at, received_at, payload
        ) VALUES (
            :event_id, :type, :gateway_request_id, :virtual_key_id, :end_user_id,
            :model, :status, :cost_nano_usd, :input_tokens, :output_tokens,
            :occurred_at, :received_at, :payload
        )
        """,
        row,
    )
    return "ingested", row


def _as_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


def _as_int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _archived_bucket_virtual_key(data: Dict[str, Any]) -> Optional[str]:
    """Budget events name their tenant directly: ``virtual_key_id`` is
    first-class on every ``gateway.budget.*`` payload, so a threshold warning
    lands on the right customer's feed by reading one field.

    This is the fallback for envelopes archived BEFORE that field existed,
    which is the only place the old shape still appears: those payloads carry
    the bucket that moved rather than the key, as ``"<vk id>"`` for a tenant
    cap and ``"<anchor vk id>:<end user id>"`` for a per-seat allowance.
    """
    bucket = _as_string(data.get("bucket_scope_id"))
    if not bucket:
        return None
    key = bucket.split(":")[0]
    return key if key.startswith("vk_") else None
