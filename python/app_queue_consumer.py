"""The python app's own queue consumer: the same meters, fed from an Amazon
SQS queue instead of the HTTP route this process also hosts.

It reuses ``ingest_envelope`` verbatim, so both transports write the same rows
through the same code. Which one runs is ``DEMO_TRANSPORT``.

── THE ONE THING THAT CATCHES EVERY CONSUMER ────────────────────────────────
``receive_message`` returns NO message attributes unless you ask for them by
name. Without ``MessageAttributeNames=["All"]`` below, the signature simply is
not there, and this consumer would reject every message it is sent while the
body sitting in front of you looks perfectly fine.
─────────────────────────────────────────────────────────────────────────────
"""

import json
import logging
import os
import re
import threading
import time
from typing import Any, Callable, Dict, List

import boto3
from langwatch import (
    WEBHOOK_SIGNATURE_HEADER,
    WebhookSignatureVerificationError,
    verify_webhook_signature,
)

from webhook_ingest import ingest_envelope

log = logging.getLogger("acme.queue")

#: Names the delivery, not an event: one delivery carries a whole batch.
DELIVERY_ID_ATTRIBUTE = "X-LangWatch-Delivery-Id"


def region_from_queue_url(queue_url: str) -> str:
    """The region is in the queue URL, so there is nothing to configure twice."""
    match = re.match(r"^https://sqs\.([a-z0-9-]+)\.", queue_url)
    return match.group(1) if match else ""


def start_queue_consumer(
    *,
    db: Callable[[], Any],
    secrets: List[str],
    on_ingested: Callable[[Dict[str, Any]], None],
    queue_url: str = "",
) -> None:
    """Poll the queue on a daemon thread, ingesting every verified batch.

    Returns immediately when no queue is configured, so the caller can start it
    unconditionally and let ``DEMO_TRANSPORT`` decide.
    """
    queue_url = queue_url or os.environ.get("APP_PY_QUEUE_URL", "")
    if not queue_url:
        log.warning(
            "DEMO_TRANSPORT=sqs but APP_PY_QUEUE_URL is not set: "
            "no billing events will arrive."
        )
        return
    if not secrets:
        log.warning(
            "PY_APP_WEBHOOK_SECRET is not set: "
            "every queued billing event will be rejected."
        )
        return

    sqs = boto3.client(
        "sqs",
        region_name=os.environ.get("AWS_REGION") or region_from_queue_url(queue_url),
    )

    def drain() -> None:
        received = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=20,
            # WITHOUT THIS LINE THERE IS NO SIGNATURE. See the note above.
            MessageAttributeNames=["All"],
        )
        for message in received.get("Messages", []):
            raw_body = message.get("Body", "").encode("utf-8")
            attributes = message.get("MessageAttributes", {})
            delivery_id = attributes.get(DELIVERY_ID_ATTRIBUTE, {}).get(
                "StringValue", "unknown"
            )

            try:
                # The same verifier, over the same bytes, as the HTTP route in
                # app.py. That is the whole point of the body being identical.
                verify_webhook_signature(
                    body=raw_body,
                    header=attributes.get(WEBHOOK_SIGNATURE_HEADER, {}).get(
                        "StringValue", ""
                    ),
                    secret=secrets,
                )
            except WebhookSignatureVerificationError as error:
                # NOT deleted: it returns after the visibility timeout and
                # reaches the dead letter queue, rather than disappearing.
                log.warning(
                    "[%s] rejected: %s (left on the queue)", delivery_id, error.code
                )
                continue

            batch = json.loads(raw_body).get("batch", [])
            ingested = []
            with db() as conn:
                for envelope in batch:
                    outcome, row = ingest_envelope(conn, envelope)
                    if outcome == "ingested" and row:
                        ingested.append(row)
                    log.info(
                        "[%s] %s %s: %s",
                        delivery_id,
                        envelope.get("type"),
                        envelope.get("id"),
                        outcome,
                    )
            for row in ingested:
                on_ingested(row)

            # Only now: deleting before the ingest would turn a database
            # hiccup into money on the floor.
            sqs.delete_message(
                QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"]
            )

    def loop() -> None:
        log.info("Consuming billing events from %s", queue_url)
        while True:
            try:
                drain()
            except Exception as error:  # noqa: BLE001 (a poll failure must not stop the loop)
                log.warning("queue poll failed, retrying in 5s: %s", error)
                time.sleep(5)

    threading.Thread(target=loop, name="acme-queue-consumer", daemon=True).start()
