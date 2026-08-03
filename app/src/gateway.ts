import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type CoreMessage } from "ai";

/**
 * The whole request-path integration. This is the point of the demo: the
 * app talks to the LangWatch gateway exactly like it talks to OpenAI. The
 * only differences from a direct OpenAI call:
 *
 * - `baseURL` points at the gateway.
 * - `apiKey` is the TENANT's virtual key secret, so every request is
 *   attributed (and budgeted) to that tenant.
 * - the OpenAI `user` field carries the end-user id, so per-user budgets
 *   apply and every spend event carries the id. Nothing else is needed
 *   for attribution.
 */
const GATEWAY_URL = process.env.LANGWATCH_GATEWAY_URL ?? "http://localhost:6560";

/** The models the agent builder offers. Any gateway model id works. */
export const MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-3-5-haiku-latest",
] as const;

export interface ChatCompletionMeta {
  /**
   * The gateway request id: the same identifier that keys every billing
   * event and reconciliation row for this request. Store it next to the
   * message and the transcript joins straight to the invoice.
   */
  gatewayRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StreamChatParams {
  virtualKeySecret: string;
  model: string;
  systemPrompt: string;
  /** The conversation so far, oldest first, excluding the system prompt. */
  history: CoreMessage[];
  /** The seat this request is billed to, e.g. "owner@acme.example". */
  endUserId: string;
  onDelta: (text: string) => void;
}

/** A request that hangs is worse than one that fails, so bound it. */
const REQUEST_TIMEOUT_MS = 60_000;

export async function streamChatAsTenant(
  params: StreamChatParams,
): Promise<ChatCompletionMeta> {
  const gateway = createOpenAI({
    baseURL: `${GATEWAY_URL}/v1`,
    apiKey: params.virtualKeySecret,
  });

  const result = streamText({
    // The second argument's `user` becomes the OpenAI `user` field on the
    // wire; that one field is the whole attribution contract.
    model: gateway.chat(params.model, { user: params.endUserId }),
    system: params.systemPrompt,
    messages: params.history,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // `streamText` reports failures as an `error` part rather than throwing,
  // so a rejected request looks like an empty stream. Read the full stream
  // and raise the error part: a budget breach has to reach the caller as an
  // error, not as a silent stream that never produces a response.
  const settled = [result.response, result.usage];
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        params.onDelta(part.textDelta);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
  } catch (error) {
    // Nothing will await these once the stream has failed.
    for (const promise of settled) void promise.catch(() => undefined);
    throw error;
  }

  const [response, usage] = await Promise.all([result.response, result.usage]);
  const headers = response.headers ?? {};
  const requestId = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "x-langwatch-gateway-request-id",
  )?.[1];
  return {
    gatewayRequestId: requestId ?? null,
    inputTokens: Number.isFinite(usage.promptTokens) ? usage.promptTokens : null,
    outputTokens: Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : null,
  };
}

export interface GatewayFailure {
  /** OpenAI-compatible discriminant. Always equal to `code`. */
  type: string;
  code: string;
  message: string;
  /**
   * Machine-readable detail for this code. Values are arbitrary JSON, not
   * just strings: a 402 carries `budget_id` / `budget_scope` /
   * `budget_window` as strings, a 400 carries `reasons` as an array of
   * `{code, message, meta?}`. Read a key with `metaString` when you expect
   * a string; keep the rest as it arrived rather than dropping it.
   */
  meta: Record<string, unknown>;
}

/** One canonical envelope, everywhere on the wire:
 *
 *     {"error": {"type", "code", "message", "meta"?}}
 *
 * The gateway data plane and every /api/gateway/v1 route answer this exact
 * body, so there is one shape to read and no shape to guess. `type` and
 * `code` always carry the same value; read whichever your transport taught
 * you.
 *
 * The only wrinkle here is transport, not shape: the ai-sdk wraps provider
 * errors, so the body has to be found down the `cause` chain.
 */
export function readGatewayFailure(error: unknown): GatewayFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const body = Reflect.get(error, "responseBody");
  if (typeof body !== "string") {
    return readGatewayFailure(Reflect.get(error, "cause"));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  const inner = asRecord(envelope?.error);
  // No `error` object means this is not a LangWatch refusal at all (a proxy
  // page, an upstream body passed through). Report it as unrecognized and
  // let the caller answer with a generic upstream failure.
  if (!inner) return null;

  const code = typeof inner.code === "string" ? inner.code : inner.type;
  if (typeof code !== "string") return null;
  const type = typeof inner.type === "string" ? inner.type : code;
  return {
    type,
    code,
    message: typeof inner.message === "string" ? inner.message : code,
    meta: asRecord(inner.meta) ?? {},
  };
}

/** One `meta` value, when the code documents that key as a string. */
export function metaString(
  meta: Record<string, unknown>,
  key: string,
): string | null {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
