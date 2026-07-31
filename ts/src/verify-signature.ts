import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a LangWatch webhook signature.
 *
 * The header looks like:
 *
 *     X-LangWatch-Signature: t=1722400000,v1=6f5a1b3c...
 *
 * where `v1` is hex HMAC-SHA256 over the string `"<t>.<raw body>"` with your
 * endpoint's signing secret. Two rules matter:
 *
 * 1. Compute over the EXACT raw bytes you received. Do not parse and
 *    re-serialize the JSON first; any re-encoding difference changes the
 *    digest.
 * 2. Reject stale timestamps. LangWatch documents a 5-minute tolerance; a
 *    replayed capture outside that window fails even with a valid digest.
 */
const TOLERANCE_SECONDS = 5 * 60;

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
  if (!params.signatureHeader) return false;

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
