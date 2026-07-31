import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

/**
 * The whole request-path integration. This is the point of the demo: your
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

export async function chatAsTenant(params: {
  virtualKeySecret: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  /** The demo end-user id, e.g. "user-42@acme". */
  endUserId: string;
}) {
  const gateway = createOpenAI({
    baseURL: `${GATEWAY_URL}/v1`,
    apiKey: params.virtualKeySecret,
  });

  const result = await generateText({
    model: gateway.chat(params.model),
    system: params.systemPrompt,
    prompt: params.userMessage,
    providerOptions: {
      // Becomes the OpenAI `user` field on the wire.
      openai: { user: params.endUserId },
    },
  });

  return {
    text: result.text,
    usage: result.usage,
    // The gateway request id: the same ULID that keys every billing event
    // and reconciliation row for this request. Log it and you can join
    // your request logs to your invoices later.
    gatewayRequestId:
      result.response.headers?.["x-langwatch-gateway-request-id"] ?? null,
  };
}
