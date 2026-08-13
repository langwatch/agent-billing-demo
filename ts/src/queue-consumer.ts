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
import { Ledger } from "./ledger.js";
import "./env.js";

/**
 * The Amazon SQS half of the receiver: the same signed batches, pulled off a
 * queue instead of pushed to a URL.
 *
 * ── THE ONE THING THAT CATCHES EVERY CONSUMER ────────────────────────────
 * `ReceiveMessage` returns NO message attributes unless you ask for them by
 * name. Without `MessageAttributeNames: ["All"]` below, the signature simply
 * is not there, and this consumer would reject every message it is sent
 * while the body sitting in front of you looks perfectly fine.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Everything else is the HTTP receiver's contract, unchanged:
 *
 * - The body is byte-identical to what an HTTPS receiver would be POSTed:
 *   `{"batch": [envelope, ...]}`. Verify the HMAC over those exact bytes
 *   BEFORE parsing, with the same `verifyWebhookSignature` call.
 * - The signature, the delivery id and the attempt ride as message
 *   attributes under the same names they use as HTTP headers.
 * - Delete the message only AFTER the batch is durably ingested. Not
 *   deleting is how you say "retry": the message returns after its
 *   visibility timeout, and after `maxReceiveCount` attempts it lands in the
 *   dead letter queue, which is where a message you can never accept
 *   belongs.
 * - Dedup on the envelope `id` inside the body, never on the delivery id,
 *   which names the whole batch.
 */
const DELIVERY_ID_ATTRIBUTE = "X-LangWatch-Delivery-Id";
const ATTEMPT_ATTRIBUTE = "X-LangWatch-Delivery-Attempt";

const QUEUE_URL = process.env.TS_QUEUE_URL ?? "";
if (!QUEUE_URL) {
  console.error("TS_QUEUE_URL is not set; nothing to consume.");
  process.exit(1);
}

/**
 * Every secret this consumer accepts right now, newest first. Rolling a
 * secret leaves the previous one valid for a day and deliveries mid-rotation
 * are signed with both, so holding the outgoing one in its own slot is what
 * makes the swap invisible.
 */
const SECRETS = [
  process.env.TS_WEBHOOK_SECRET ?? "",
  process.env.TS_WEBHOOK_SECRET_PREVIOUS ?? "",
].filter(Boolean);
if (SECRETS.length === 0) {
  console.error("TS_WEBHOOK_SECRET is not set; refusing to start unverified.");
  process.exit(1);
}

const ledger = new Ledger(new URL("../ledger.sqlite", import.meta.url).pathname);
const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? regionFromQueueUrl(QUEUE_URL),
});

/** The region is in the queue URL, so there is nothing to configure twice. */
function regionFromQueueUrl(queueUrl: string): string {
  return /^https:\/\/sqs\.([a-z0-9-]+)\./.exec(queueUrl)?.[1] ?? "";
}

async function drain(): Promise<void> {
  const received = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 10,
      // Long polling: one call waits for work instead of ten returning empty.
      WaitTimeSeconds: 20,
      // WITHOUT THIS LINE THERE IS NO SIGNATURE. See the note above.
      MessageAttributeNames: ["All"],
    }),
  );

  for (const message of received.Messages ?? []) {
    const rawBody = Buffer.from(message.Body ?? "", "utf8");
    const attributes = message.MessageAttributes ?? {};
    const signature = attributes[WEBHOOK_SIGNATURE_HEADER]?.StringValue ?? "";
    const deliveryId =
      attributes[DELIVERY_ID_ATTRIBUTE]?.StringValue ?? "unknown";
    const attempt = attributes[ATTEMPT_ATTRIBUTE]?.StringValue ?? "1";

    try {
      // The same verifier, over the same bytes, as the HTTP receiver. That is
      // the whole point of the body being byte-identical.
      verifyWebhookSignature({
        body: rawBody,
        header: signature,
        secret: SECRETS,
      });
    } catch (error) {
      if (!(error instanceof WebhookSignatureVerificationError)) throw error;
      // NOT deleted. An unverifiable message is not one to drop quietly: it
      // returns after the visibility timeout and reaches the dead letter
      // queue, where it can be looked at.
      console.warn(
        `[${deliveryId}] attempt ${attempt} rejected: ${error.code} (left on the queue)`,
      );
      continue;
    }

    const body = JSON.parse(rawBody.toString("utf8")) as {
      batch: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    };
    for (const envelope of body.batch) {
      const outcome = ledger.ingest(envelope);
      console.log(`[${deliveryId}] ${envelope.type} ${envelope.id}: ${outcome}`);
    }

    // Only now. Deleting before the ingest would turn a database hiccup into
    // money on the floor.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}

console.log(`TS queue consumer polling ${QUEUE_URL}`);
for (;;) {
  try {
    await drain();
  } catch (error) {
    console.error("poll failed, retrying in 5s:", error);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
