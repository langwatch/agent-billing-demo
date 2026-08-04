import express from "express";
import { readFileSync } from "node:fs";
import {
  WEBHOOK_SIGNATURE_HEADER,
  WebhookSignatureVerificationError,
  verifyWebhookSignature,
} from "langwatch";
import { Ledger } from "./ledger.js";
import "./env.js";

/**
 * Names the delivery, not an event: one delivery carries a whole batch, so
 * this correlates logs and is never the dedup key. Dedup on the envelope
 * `id` inside the body.
 */
const DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id";

/**
 * The webhook receiver: LangWatch POSTs signed batches of event envelopes
 * here, and every verified envelope lands in the local billing ledger.
 *
 * The body shape is `{"batch": [envelope, ...]}`. Each envelope is
 * `{id, type, created, schema_version, data}`; `id` is the dedup key and
 * `data.gateway_request_id` is the join key across a settled/completed pair.
 *
 * `X-LangWatch-Delivery-Id` identifies the DELIVERY, which carries the whole
 * batch. It is the handle that correlates this receiver's log with the
 * delivery log on the LangWatch side, and it is never the dedup key.
 *
 * Answer 2xx only after the batch is durably ingested. A non-2xx (or a
 * timeout) makes LangWatch retry the whole batch along its ladder, which is
 * exactly what you want if your database hiccups: at-least-once delivery
 * plus idempotent ingest equals exactly-once accounting.
 */
const PORT = Number(process.env.TS_RECEIVER_PORT ?? 4101);

/**
 * Every secret this receiver accepts right now, newest first. Rolling a
 * secret leaves the previous one valid for a day, and a delivery sent mid
 * rotation is signed with both, so holding the outgoing one in its own slot
 * is what makes the swap invisible to the sender.
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
const app = express();

/**
 * Failure-drill switch, used by the QA runbook to exercise LangWatch's
 * retry ladder against a misbehaving receiver:
 *   - file contains "before": refuse with 503 before touching the ledger
 *     (an outage; nothing ingested, the ladder retries the whole batch).
 *   - file contains "after": ingest, then answer 503 anyway (an ack lost
 *     after commit, the classic at-least-once duplicate source; the retry
 *     must land as all-duplicates).
 */
const JAM_FILE = new URL("../jam", import.meta.url).pathname;
const jamMode = (): "before" | "after" | null => {
  try {
    const mode = readFileSync(JAM_FILE, "utf8").trim();
    return mode === "before" || mode === "after" ? mode : null;
  } catch {
    return null;
  }
};

// The signature covers the raw bytes, so capture them before any parsing.
app.use(express.raw({ type: "application/json", limit: "2mb" }));

app.post("/webhooks/langwatch", (req, res) => {
  const rawBody = req.body as Buffer;
  try {
    // The SDK verifier, over the raw bytes and against every secret this
    // receiver holds. It throws rather than returning false, so a delivery
    // cannot be trusted by forgetting to read a return value.
    verifyWebhookSignature({
      body: rawBody,
      header: req.header(WEBHOOK_SIGNATURE_HEADER) ?? "",
      secret: SECRETS,
    });
  } catch (error) {
    if (!(error instanceof WebhookSignatureVerificationError)) throw error;
    console.warn(`rejected: ${error.code}`);
    return res.status(401).json({ error: error.code });
  }

  const jam = jamMode();
  if (jam === "before") {
    console.warn("jammed (before ingest): refusing batch with 503");
    return res.status(503).json({ error: "jammed" });
  }

  const deliveryId = req.header(DELIVERY_ID_HEADER) ?? "unknown";
  const body = JSON.parse(rawBody.toString("utf8")) as {
    batch: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  };
  for (const envelope of body.batch) {
    const outcome = ledger.ingest(envelope);
    console.log(`[${deliveryId}] ${envelope.type} ${envelope.id}: ${outcome}`);
  }
  if (jam === "after") {
    console.warn("jammed (after ingest): dropping the ack with 503");
    return res.status(503).json({ error: "jammed after commit" });
  }
  res.json({ received: body.batch.length });
});

app.listen(PORT, () => {
  console.log(`TS receiver listening on :${PORT} (POST /webhooks/langwatch)`);
});
