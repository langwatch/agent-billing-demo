"""The webhook receiver: LangWatch POSTs signed batches of event envelopes
here, and every verified envelope lands in the local billing ledger.

The body shape is ``{"batch": [envelope, ...]}``. Each envelope is
``{id, type, created, schema_version, data}``; ``id`` is the dedup key and
``data.gateway_request_id`` is the join key across a settled/completed pair.

``X-LangWatch-Delivery-Id`` identifies the DELIVERY, which carries the whole
batch. It is the handle that correlates this receiver's log with the delivery
log on the LangWatch side, and it is never the dedup key.

Answer 2xx only after the batch is durably ingested. A non-2xx (or a
timeout) makes LangWatch retry the whole batch along its ladder, which is
exactly what you want if your database hiccups: at-least-once delivery plus
idempotent ingest equals exactly-once accounting.

Run: ``python receiver.py`` (needs PY_WEBHOOK_SECRET in the environment).
"""

import env  # noqa: F401  (loads .env before anything reads it)

import json
import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request
from langwatch import (
    WEBHOOK_SIGNATURE_HEADER,
    WebhookSignatureVerificationError,
    verify_webhook_signature,
)

from ledger import Ledger

#: Names the delivery, not an event: one delivery carries a whole batch, so
#: this correlates logs and is never the dedup key. Dedup on the envelope
#: ``id`` inside the body.
DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id"

PORT = int(os.environ.get("PY_RECEIVER_PORT", "4102"))

#: Every secret this receiver accepts right now, newest first. Rolling a
#: secret leaves the previous one valid for a day, and a delivery sent mid
#: rotation is signed with both, so holding the outgoing one in its own slot
#: is what makes the swap invisible to the sender.
SECRETS = [
    secret
    for secret in (
        os.environ.get("PY_WEBHOOK_SECRET", ""),
        os.environ.get("PY_WEBHOOK_SECRET_PREVIOUS", ""),
    )
    if secret
]
if not SECRETS:
    print("PY_WEBHOOK_SECRET is not set; refusing to start unverified.")
    sys.exit(1)

app = Flask(__name__)
ledger = Ledger(str(Path(__file__).parent / "ledger.sqlite"))


@app.post("/webhooks/langwatch")
def receive():
    # The signature covers the raw bytes, so verify before any parsing. The
    # SDK verifier takes every secret this receiver holds and raises rather
    # than returning False, so a delivery cannot be trusted by forgetting to
    # read a return value.
    raw_body = request.get_data()
    try:
        verify_webhook_signature(
            body=raw_body,
            header=request.headers.get(WEBHOOK_SIGNATURE_HEADER, ""),
            secret=SECRETS,
        )
    except WebhookSignatureVerificationError as error:
        print(f"rejected: {error.code}")
        return jsonify({"error": error.code}), 401

    delivery_id = request.headers.get(DELIVERY_ID_HEADER, "unknown")
    body = json.loads(raw_body)
    for envelope in body["batch"]:
        outcome = ledger.ingest(envelope)
        print(f"[{delivery_id}] {envelope['type']} {envelope['id']}: {outcome}")
    return jsonify({"received": len(body["batch"])})


if __name__ == "__main__":
    print(f"Python receiver listening on :{PORT} (POST /webhooks/langwatch)")
    app.run(port=PORT)
