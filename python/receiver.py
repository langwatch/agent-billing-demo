"""The webhook receiver: LangWatch POSTs signed batches of event envelopes
here, and every verified envelope lands in the local billing ledger.

The body shape is ``{"batch": [envelope, ...]}``. Each envelope is
``{id, type, created, schema_version, data}``; ``id`` is the dedup key and
``data.gateway_request_id`` is the join key across a settled/completed pair.

Answer 2xx only after the batch is durably ingested. A non-2xx (or a
timeout) makes LangWatch retry the whole batch along its ladder, which is
exactly what you want if your database hiccups: at-least-once delivery plus
idempotent ingest equals exactly-once accounting.

Run: ``python receiver.py`` (needs PY_WEBHOOK_SECRET in the environment).
"""

import json
import os
import sys
from pathlib import Path

from flask import Flask, jsonify, request

from ledger import Ledger
from verify_signature import verify_signature

PORT = int(os.environ.get("PY_RECEIVER_PORT", "4102"))
SECRET = os.environ.get("PY_WEBHOOK_SECRET", "")
if not SECRET:
    print("PY_WEBHOOK_SECRET is not set; refusing to start unverified.")
    sys.exit(1)

app = Flask(__name__)
ledger = Ledger(str(Path(__file__).parent / "ledger.sqlite"))


@app.post("/webhooks/langwatch")
def receive():
    # The signature covers the raw bytes, so verify before any parsing.
    raw_body = request.get_data()
    if not verify_signature(
        raw_body, request.headers.get("X-LangWatch-Signature"), SECRET
    ):
        print("rejected: bad or missing signature")
        return jsonify({"error": "invalid signature"}), 401

    body = json.loads(raw_body)
    for envelope in body["batch"]:
        outcome = ledger.ingest(envelope)
        print(f"{envelope['type']} {envelope['id']}: {outcome}")
    return jsonify({"received": len(body["batch"])})


if __name__ == "__main__":
    print(f"Python receiver listening on :{PORT} (POST /webhooks/langwatch)")
    app.run(port=PORT)
