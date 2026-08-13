import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WebhookSignatureVerificationError,
  verifyWebhookSignature,
} from "langwatch";
import type { AppDatabase, BillingEvent } from "./db.js";
import { acceptedSecrets, ingestEnvelope, type Envelope } from "./webhooks.js";

/**
 * The app's own queue consumer: the same meters, fed from an Amazon SQS queue
 * instead of the HTTP route this process also hosts.
 *
 * It reuses `ingestEnvelope` verbatim, so both transports write the same rows
 * through the same code. Which one runs is `DEMO_TRANSPORT`.
 *
 * ── THE ONE THING THAT CATCHES EVERY CONSUMER ────────────────────────────
 * `ReceiveMessage` returns NO message attributes unless you ask for them by
 * name. Without `MessageAttributeNames: ["All"]` below, the signature simply
 * is not there, and this consumer would reject every message it is sent
 * while the body sitting in front of you looks perfectly fine.
 * ─────────────────────────────────────────────────────────────────────────
 */
const DELIVERY_ID_ATTRIBUTE = "X-LangWatch-Delivery-Id";

/** The region is in the queue URL, so there is nothing to configure twice. */
function regionFromQueueUrl(queueUrl: string): string {
  return /^https:\/\/sqs\.([a-z0-9-]+)\./.exec(queueUrl)?.[1] ?? "";
}

/**
 * Poll the queue until the process exits, ingesting every verified batch.
 *
 * Returns immediately when no queue is configured, so the caller can start it
 * unconditionally and let `DEMO_TRANSPORT` decide.
 */
export function startQueueConsumer({
  db,
  onIngested,
  queueUrl = process.env.APP_QUEUE_URL ?? "",
}: {
  db: AppDatabase;
  /** Called for each newly stored row, so the caller publishes it to the
   *  live feed in its own shape. The HTTP route does the same thing with the
   *  same row. */
  onIngested: (row: BillingEvent) => void;
  queueUrl?: string;
}): void {
  if (!queueUrl) {
    console.warn(
      "DEMO_TRANSPORT=sqs but APP_QUEUE_URL is not set: no billing events will arrive.",
    );
    return;
  }
  const secrets = acceptedSecrets();
  if (secrets.length === 0) {
    console.warn(
      "APP_WEBHOOK_SECRET is not set: every queued billing event will be rejected.",
    );
    return;
  }

  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? regionFromQueueUrl(queueUrl),
  });

  const drain = async (): Promise<void> => {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        // WITHOUT THIS LINE THERE IS NO SIGNATURE. See the note above.
        MessageAttributeNames: ["All"],
      }),
    );

    for (const message of received.Messages ?? []) {
      const rawBody = Buffer.from(message.Body ?? "", "utf8");
      const attributes = message.MessageAttributes ?? {};
      const deliveryId =
        attributes[DELIVERY_ID_ATTRIBUTE]?.StringValue ?? "unknown";

      try {
        // The same verifier, over the same bytes, as the HTTP route in
        // server.ts. That is the whole point of the body being identical.
        verifyWebhookSignature({
          body: rawBody,
          header: attributes[WEBHOOK_SIGNATURE_HEADER]?.StringValue ?? "",
          secret: secrets,
        });
      } catch (error) {
        if (!(error instanceof WebhookSignatureVerificationError)) throw error;
        // NOT deleted: it returns after the visibility timeout and reaches the
        // dead letter queue, rather than disappearing.
        console.warn(
          `[${deliveryId}] rejected: ${error.code} (left on the queue)`,
        );
        continue;
      }

      const body = JSON.parse(rawBody.toString("utf8")) as {
        batch: Envelope[];
      };
      for (const envelope of body.batch) {
        const { outcome, row } = ingestEnvelope(db, envelope);
        if (row) onIngested(row);
        console.log(
          `[${deliveryId}] ${envelope.type} ${envelope.id}: ${outcome}`,
        );
      }

      // Only now: deleting before the ingest would turn a database hiccup
      // into money on the floor.
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
  };

  console.log(`Consuming billing events from ${queueUrl}`);
  void (async () => {
    for (;;) {
      try {
        await drain();
      } catch (error) {
        console.error("queue poll failed, retrying in 5s:", error);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  })();
}
