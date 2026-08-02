import express from "express";
import { readFileSync } from "node:fs";
import { verifySignature } from "./verify-signature.js";
import { Ledger } from "./ledger.js";
import "./env.js";

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
  const ok = verifySignature({
    rawBody,
    signatureHeader: req.header("X-LangWatch-Signature"),
    secret: SECRET,
  });
  if (!ok) {
    console.warn("rejected: bad or missing signature");
    return res.status(401).json({ error: "invalid signature" });
  }

  const jam = jamMode();
  if (jam === "before") {
    console.warn("jammed (before ingest): refusing batch with 503");
    return res.status(503).json({ error: "jammed" });
  }

  const body = JSON.parse(rawBody.toString("utf8")) as {
    batch: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  };
  for (const envelope of body.batch) {
    const outcome = ledger.ingest(envelope);
    console.log(`${envelope.type} ${envelope.id}: ${outcome}`);
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
