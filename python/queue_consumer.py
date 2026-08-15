"""The Amazon SQS half of the receiver: the same signed batches, pulled off a
queue instead of pushed to a URL.

── THE ONE THING THAT CATCHES EVERY CONSUMER ────────────────────────────────
``receive_message`` returns NO message attributes unless you ask for them by
name. Without ``MessageAttributeNames=["All"]`` below, the signature simply is
not there, and this consumer would reject every message it is sent while the
body sitting in front of you looks perfectly fine.
─────────────────────────────────────────────────────────────────────────────

Everything else is the HTTP receiver's contract, unchanged:

- The body is byte-identical to what an HTTPS receiver would be POSTed:
  ``{"batch": [envelope, ...]}``. Verify the HMAC over those exact bytes
  BEFORE parsing, with the same ``verify_webhook_signature`` call.
- The signature, the delivery id and the attempt ride as message attributes
  under the same names they use as HTTP headers.
- Delete the message only AFTER the batch is durably ingested. Not deleting is
  how you say "retry": the message returns after its visibility timeout, and
  after ``maxReceiveCount`` attempts it lands in the dead letter queue, which
  is where a message you can never accept belongs.
- Dedup on the envelope ``id`` inside the body, never on the delivery id,
  which names the whole batch.

Run: ``python queue_consumer.py`` (needs PY_QUEUE_URL and PY_WEBHOOK_SECRET).
"""

import env  # noqa: F401  (loads .env before anything reads it)

import json
import os
import re
import sys
import time
from pathlib import Path

import boto3
from langwatch import (
    WEBHOOK_SIGNATURE_HEADER,
    WebhookSignatureVerificationError,
    verify_webhook_signature,
)

from ledger import Ledger

#: Names the delivery, not an event: one delivery carries a whole batch.
DELIVERY_ID_ATTRIBUTE = "X-LangWatch-Delivery-Id"
ATTEMPT_ATTRIBUTE = "X-LangWatch-Delivery-Attempt"

QUEUE_URL = os.environ.get("PY_QUEUE_URL", "")
if not QUEUE_URL:
    print("PY_QUEUE_URL is not set; nothing to consume.")
    sys.exit(1)

#: Every secret this consumer accepts right now, newest first. Rolling a
#: secret leaves the previous one valid for a day and deliveries mid-rotation
#: are signed with both, so holding the outgoing one in its own slot is what
#: makes the swap invisible.
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


def region_from_queue_url(queue_url: str) -> str:
    """The region is in the queue URL, so there is nothing to configure twice."""
    match = re.match(r"^https://sqs\.([a-z0-9-]+)\.", queue_url)
    return match.group(1) if match else ""


ledger = Ledger(str(Path(__file__).parent / "ledger.sqlite"))
sqs = boto3.client(
    "sqs", region_name=os.environ.get("AWS_REGION") or region_from_queue_url(QUEUE_URL)
)


def drain() -> None:
    received = sqs.receive_message(
        QueueUrl=QUEUE_URL,
        MaxNumberOfMessages=10,
        # Long polling: one call waits for work instead of ten returning empty.
        WaitTimeSeconds=20,
        # WITHOUT THIS LINE THERE IS NO SIGNATURE. See the note above.
        MessageAttributeNames=["All"],
    )

    for message in received.get("Messages", []):
        raw_body = message.get("Body", "").encode("utf-8")
        attributes = message.get("MessageAttributes", {})
        signature = attributes.get(WEBHOOK_SIGNATURE_HEADER, {}).get("StringValue", "")
        delivery_id = attributes.get(DELIVERY_ID_ATTRIBUTE, {}).get(
            "StringValue", "unknown"
        )
        attempt = attributes.get(ATTEMPT_ATTRIBUTE, {}).get("StringValue", "1")

        try:
            # The same verifier, over the same bytes, as the HTTP receiver.
            # That is the whole point of the body being byte-identical.
            verify_webhook_signature(
                body=raw_body, header=signature, secret=SECRETS
            )
        except WebhookSignatureVerificationError as error:
            # NOT deleted. An unverifiable message is not one to drop quietly:
            # it returns after the visibility timeout and reaches the dead
            # letter queue, where it can be looked at.
            print(
                f"[{delivery_id}] attempt {attempt} rejected: {error.code} "
                "(left on the queue)"
            )
            continue

        body = json.loads(raw_body)
        for envelope in body["batch"]:
            outcome = ledger.ingest(envelope)
            print(f"[{delivery_id}] {envelope['type']} {envelope['id']}: {outcome}")

        # Only now. Deleting before the ingest would turn a database hiccup
        # into money on the floor.
        sqs.delete_message(
            QueueUrl=QUEUE_URL, ReceiptHandle=message["ReceiptHandle"]
        )


if __name__ == "__main__":
    print(f"Python queue consumer polling {QUEUE_URL}")
    while True:
        try:
            drain()
        except Exception as error:  # noqa: BLE001 (a poll failure must not stop the loop)
            print(f"poll failed, retrying in 5s: {error}")
            time.sleep(5)
