import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppDatabase, BillingEvent } from "./db.js";

/**
 * The app hosts its own webhook endpoint, so the meters on screen are fed
 * by the same signed deliveries a production integration receives. The
 * standalone receivers in `ts/` and `python/` implement the identical
 * contract; this module is the version that lives inside the product.
 *
 * The contract, in three rules:
 *
 * 1. Verify the HMAC over the EXACT raw bytes received. Parse afterwards.
 * 2. Dedup by envelope id. Delivery is at-least-once.
 * 3. Answer 2xx only once the batch is durably stored, so a failed write
 *    makes LangWatch retry instead of dropping money on the floor.
 */
const TOLERANCE_SECONDS = 5 * 60;

export function verifySignature(params: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
  nowMs?: number;
}): boolean {
  if (!params.signatureHeader || !params.secret) return false;

  const parts = new Map<string, string>();
  for (const piece of params.signatureHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = (params.nowMs ?? Date.now()) / 1000;
  if (Math.abs(nowSeconds - timestampSeconds) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", params.secret)
    .update(`${timestamp}.`)
    .update(params.rawBody)
    .digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
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
    virtual_key_id: asString(data.virtual_key_id) ?? bucketVirtualKey(data),
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
 * Budget events identify the bucket that moved, not the key: a tenant cap
 * carries `bucket_scope_id: "<vk id>"` and a per-seat allowance carries
 * `"<anchor vk id>:<end user id>"`. Both resolve to the same tenant, which
 * is what puts a threshold warning on the right customer's feed.
 */
function bucketVirtualKey(data: Record<string, unknown>): string | null {
  const bucket = asString(data.bucket_scope_id);
  if (!bucket) return null;
  const [key] = bucket.split(":");
  return key && key.startsWith("vk_") ? key : null;
}
