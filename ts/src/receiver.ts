import express from "express";
import { verifySignature } from "./verify-signature.js";
import { Ledger } from "./ledger.js";

/**
 * The webhook receiver: LangWatch POSTs signed batches of event envelopes
 * here, and every verified envelope lands in the local billing ledger.
 *
 * The body shape is `{"batch": [envelope, ...]}`. Each envelope is
 * `{id, type, created, schema_version, data}`; `id` is the dedup key and
 * `data.gateway_request_id` is the join key across a settled/completed pair.
 *
 * Answer 2xx only after the batch is durably ingested. A non-2xx (or a
 * timeout) makes LangWatch retry the whole batch along its ladder, which is
 * exactly what you want if your database hiccups: at-least-once delivery
 * plus idempotent ingest equals exactly-once accounting.
 */
const PORT = Number(process.env.TS_RECEIVER_PORT ?? 4101);
const SECRET = process.env.TS_WEBHOOK_SECRET ?? "";
if (!SECRET) {
  console.error("TS_WEBHOOK_SECRET is not set; refusing to start unverified.");
  process.exit(1);
}

const ledger = new Ledger(new URL("../ledger.sqlite", import.meta.url).pathname);
const app = express();

// The signature covers the raw bytes, so capture them before any parsing.
app.use(express.raw({ type: "application/json", limit: "2mb" }));

app.post("/webhooks/langwatch", (req, res) => {
  const rawBody = req.body as Buffer;
  const ok = verifySignature({
    rawBody,
    signatureHeader: req.header("X-LangWatch-Signature"),
    secret: SECRET,
  });
  if (!ok) {
    console.warn("rejected: bad or missing signature");
    return res.status(401).json({ error: "invalid signature" });
  }

  const body = JSON.parse(rawBody.toString("utf8")) as {
    batch: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  };
  for (const envelope of body.batch) {
    const outcome = ledger.ingest(envelope);
    console.log(`${envelope.type} ${envelope.id}: ${outcome}`);
  }
  res.json({ received: body.batch.length });
});

app.listen(PORT, () => {
  console.log(`TS receiver listening on :${PORT} (POST /webhooks/langwatch)`);
});
