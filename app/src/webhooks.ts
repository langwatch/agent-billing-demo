import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppDatabase, BillingEvent } from "./db.js";

/**
 * The app hosts its own webhook endpoint, so the meters on screen are fed
 * by the same signed deliveries a production integration receives. The
 * standalone receivers in `ts/` and `python/` implement the identical
 * contract; this module is the version that lives inside the product.
 *
 * The contract, in four rules:
 *
 * 1. Verify the HMAC over the EXACT raw bytes received. Parse afterwards.
 *    `v1` repeats during a secret rotation, so ANY `v1` matching accepts.
 * 2. Dedup by envelope id. Delivery is at-least-once. `X-LangWatch-Delivery-Id`
 *    names the DELIVERY, which carries a whole batch, so it is a log
 *    correlation handle and never the dedup key.
 * 3. Fail closed: no secret configured means no verification is possible.
 * 4. Answer 2xx only once the batch is durably stored, so a failed write
 *    makes LangWatch retry instead of dropping money on the floor.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Names the delivery, not an event: one delivery carries a whole batch. */
export const DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id";

export function verifySignature(params: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
  nowMs?: number;
}): boolean {
  // No header and no secret are both "cannot verify", which is a rejection.
  if (!params.signatureHeader || !params.secret) return false;

  const { timestamp, candidates } = parseSignatureHeader(params.signatureHeader);
  if (!timestamp || candidates.length === 0) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = (params.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = createHmac("sha256", params.secret)
    .update(`${timestamp}.`)
    .update(params.rawBody)
    .digest("hex");

  // Every candidate is compared even once one has matched, so the work does
  // not depend on WHICH signature matched.
  let matched = false;
  for (const candidate of candidates) {
    if (digestsMatch(expected, candidate)) matched = true;
  }
  return matched;
}

/**
 * The timestamp and EVERY `v1` the header carries. A rotation sends one per
 * currently valid secret, newest first: `t=...,v1=<new>,v1=<old>`.
 */
function parseSignatureHeader(header: string): {
  timestamp: string | null;
  candidates: string[];
} {
  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const piece of header.split(",")) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  return { timestamp, candidates };
}

/**
 * Constant-time equality over the hex digests, length-safe. Compared as
 * text rather than decoded bytes: hex decoding accepts a malformed digest by
 * truncating it, which would compare a prefix instead of failing.
 */
function digestsMatch(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Envelope {
  id: string;
  type: string;
  created?: string;
  schema_version?: string;
  data: Record<string, unknown>;
}

export type IngestOutcome = "ingested" | "duplicate";

/**
 * Store one envelope verbatim. Request events carry money and are unpacked
 * into their own columns so the meters can sum them; budget and virtual key
 * events are operational signals, kept whole for the live feed.
 *
 * A later `gateway.request.completed` does not overwrite the `settled` row
 * it supersedes: both envelopes are archived, and the spend query prefers
 * the completed one per gateway request id. Replace at read time, never sum.
 */
export function ingestEnvelope(
  db: AppDatabase,
  envelope: Envelope,
): { outcome: IngestOutcome; row: BillingEvent | null } {
  const existing = db
    .prepare("SELECT 1 FROM billing_events WHERE event_id = ?")
    .get(envelope.id);
  if (existing) return { outcome: "duplicate", row: null };

  const data = envelope.data ?? {};
  const usage = (data.usage as Record<string, number> | null) ?? null;
  const cost = (data.cost as { nano_usd?: number } | null) ?? null;
  const row: BillingEvent = {
    event_id: envelope.id,
    type: envelope.type,
    gateway_request_id: asString(data.gateway_request_id),
    virtual_key_id: asString(data.virtual_key_id) ?? archivedBucketVirtualKey(data),
    end_user_id: asString(data.end_user_id),
    model: asString(data.model),
    status: asString(data.status),
    cost_nano_usd: cost && typeof cost.nano_usd === "number" ? cost.nano_usd : null,
    input_tokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    output_tokens:
      usage && typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    occurred_at: asString(data.occurred_at) ?? envelope.created ?? new Date().toISOString(),
    received_at: new Date().toISOString(),
    payload: JSON.stringify(envelope),
  };

  db.prepare(
    `INSERT INTO billing_events (
       event_id, type, gateway_request_id, virtual_key_id, end_user_id, model,
       status, cost_nano_usd, input_tokens, output_tokens, occurred_at,
       received_at, payload
     ) VALUES (
       @event_id, @type, @gateway_request_id, @virtual_key_id, @end_user_id, @model,
       @status, @cost_nano_usd, @input_tokens, @output_tokens, @occurred_at,
       @received_at, @payload
     )`,
  ).run(row);

  return { outcome: "ingested", row };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Budget events name their tenant directly: `virtual_key_id` is first-class
 * on every `gateway.budget.*` payload, alongside `anchor_project_id`, so a
 * threshold warning lands on the right customer's feed by reading one field.
 *
 * This is the fallback for envelopes archived BEFORE that field existed,
 * which is the only place the old shape still appears: those payloads carry
 * the bucket that moved rather than the key, as `"<vk id>"` for a tenant cap
 * and `"<anchor vk id>:<end user id>"` for a per-seat allowance. Reading
 * them keeps the historical feed intact instead of dropping rows the demo
 * ingested weeks ago; nothing arriving now takes this path.
 */
function archivedBucketVirtualKey(data: Record<string, unknown>): string | null {
  const bucket = asString(data.bucket_scope_id);
  if (!bucket) return null;
  const [key] = bucket.split(":");
  return key && key.startsWith("vk_") ? key : null;
}
