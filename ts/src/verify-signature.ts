import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a LangWatch webhook signature.
 *
 * The header looks like:
 *
 *     X-LangWatch-Signature: t=1722400000,v1=6f5a1b3c...
 *
 * where `v1` is hex HMAC-SHA256 over the string `"<t>.<raw body>"` with your
 * endpoint's signing secret. Four rules matter:
 *
 * 1. Compute over the EXACT raw bytes you received. Do not parse and
 *    re-serialize the JSON first; any re-encoding difference changes the
 *    digest.
 * 2. `v1` MAY REPEAT. While a secret is being rotated the header carries one
 *    `v1` per currently valid secret, newest first:
 *
 *        X-LangWatch-Signature: t=1722400000,v1=<new>,v1=<old>
 *
 *    Accept the delivery when ANY of them matches. That is what lets you
 *    swap the stored secret on your own schedule instead of dropping
 *    deliveries during the swap.
 * 3. Reject stale timestamps. The tolerance is five minutes; a replayed
 *    capture outside that window fails even with a valid digest.
 * 4. Fail closed. No secret configured means no verification is possible,
 *    which is a rejection, never a pass.
 *
 * Compare in constant time, and compare every candidate even after one has
 * matched, so the work does not depend on WHICH signature matched.
 *
 * Delivery identity is a separate header and not part of this check:
 * `X-LangWatch-Delivery-Id` names the DELIVERY, and one delivery carries a
 * whole batch of envelopes. Dedup on the envelope `id` inside the body.
 *
 * TODO-VALIDATE: roll an endpoint's secret and, inside the 24 hour window
 * that keeps the previous secret valid, confirm a delivery signed with both
 * secrets is accepted by a receiver still holding the OLD one and by one
 * already holding the NEW one. That is the case a single-`v1` verifier
 * fails, and it is the only one that needs a live rotation to prove.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Names the delivery, not an event: one delivery carries a whole batch. */
export const DELIVERY_ID_HEADER = "X-LangWatch-Delivery-Id";

export function verifySignature(params: {
  /** The raw request body, exactly as received. */
  rawBody: string | Buffer;
  /** The X-LangWatch-Signature header value. */
  signatureHeader: string | undefined;
  /** Your endpoint's signing secret (shown once when the endpoint is created). */
  secret: string;
  /** Injectable clock for tests; defaults to Date.now. */
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

  // Signed over the timestamp exactly as it appears in the header, so the
  // digest matches the signer byte for byte.
  const expected = createHmac("sha256", params.secret)
    .update(`${timestamp}.`)
    .update(params.rawBody)
    .digest("hex");

  let matched = false;
  for (const candidate of candidates) {
    if (digestsMatch(expected, candidate)) matched = true;
  }
  return matched;
}

/** The timestamp and EVERY `v1` the header carries, in the order sent. */
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
