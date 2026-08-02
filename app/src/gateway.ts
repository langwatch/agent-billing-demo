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
  code: string;
  message: string;
  meta: Record<string, string>;
}

/**
 * The gateway's error body rides on `responseBody` as
 * `{error: {code, message, meta}}`. The ai-sdk wraps provider errors, so
 * walk the `cause` chain and parse defensively; anything unrecognized is
 * reported as null and handled as a generic upstream failure.
 */
export function readGatewayFailure(error: unknown): GatewayFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const body = Reflect.get(error, "responseBody");
  if (typeof body !== "string") {
    return readGatewayFailure(Reflect.get(error, "cause"));
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const inner = (parsed.error ?? parsed) as Record<string, unknown>;
    const code = inner.code ?? inner.type;
    if (typeof code !== "string") return null;
    const metaSource =
      typeof inner.meta === "object" && inner.meta !== null
        ? (inner.meta as Record<string, unknown>)
        : inner;
    const meta: Record<string, string> = {};
    for (const [key, value] of Object.entries(metaSource)) {
      if (typeof value === "string") meta[key] = value;
    }
    return {
      code,
      message: typeof inner.message === "string" ? inner.message : code,
      meta,
    };
  } catch {
    return null;
  }
}
