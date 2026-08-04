/**
 * Provision one tenant on LangWatch through the official TypeScript SDK
 * (`langwatch`): the four calls a customer signup makes.
 *
 * 1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
 *    tenant's gateway credential, and every budget and spend row hangs off
 *    its id. The secret is returned exactly once; store it like a password.
 * 2. A hard cap: `on_breach: "block"`, `manual` window. A manual window accrues
 *    until an explicit reset (POST /budgets/:id/reset), which is how a billing
 *    period closes without ever mutating recorded spend.
 * 3. A soft cap: `on_breach: "warn"` at a lower limit. Crossing it emits
 *    `gateway.budget.threshold_crossed` and stamps a warning header on
 *    responses; traffic keeps flowing.
 * 4. An attributed-user template: ONE budget row that caps every current and
 *    future end user of this tenant. Nothing is provisioned per user;
 *    buckets appear lazily on first spend. Fail-closed: once this template
 *    is active, requests without an end-user id are rejected
 *    (`end_user_required`) instead of passing uncapped.
 *
 * Plus, once per receiver (not per tenant): register the webhook endpoint
 * and store its signing secret.
 *
 * Every enum on this surface is lowercase snake, on the way in and on the way
 * out: scope kinds, windows, breach actions and key statuses. Uppercase is
 * rejected, so there is exactly one spelling of each to send and to match on.
 *
 * Every create carries an idempotency key derived from the tenant's identity,
 * so a retry after a timeout returns the resources the first attempt made
 * instead of a duplicate set, and the monthly allowance carries a cycle anchor
 * so the tenant's period runs from the day it signed up.
 *
 * Usage:
 *   pnpm provision -- --tenant "ACME Corp" [--register-webhook http://host:port/webhooks/langwatch]
 */
import {
  GatewayBudgetsApiService,
  VirtualKeysApiService,
  WebhooksApiService,
} from "langwatch";
import "./env.js";

const BASE_URL = process.env.LANGWATCH_BASE_URL ?? "http://localhost:5560";
const API_KEY = process.env.LANGWATCH_API_KEY ?? "";
const PROJECT_ID = process.env.LANGWATCH_PROJECT_ID ?? "";
if (!API_KEY) {
  console.error("LANGWATCH_API_KEY is not set.");
  process.exit(1);
}

const virtualKeys = new VirtualKeysApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
  projectId: PROJECT_ID || undefined,
});
const budgets = new GatewayBudgetsApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
  projectId: PROJECT_ID || undefined,
});
const webhooks = new WebhooksApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
});

/**
 * The key one resource of one signup is created under. Derived from the
 * tenant's identity, so running this twice for the same tenant asks for the
 * same resources and gets the same ones back rather than a second set.
 */
function signupKey(name: string, resource: string): string {
  const identity = name.trim().toLowerCase().replace(/\s+/g, "-");
  return `acme-agents:signup:${identity}:${resource}`;
}

export async function provisionTenant(name: string) {
  let replayed = false;
  const onIdempotentReplay = () => {
    replayed = true;
  };

  const minted = await virtualKeys.create(
    {
      name,
      description: `Tenant key for ${name} (ACME Agents signup)`,
    },
    { idempotencyKey: signupKey(name, "virtual-key"), onIdempotentReplay },
  );
  const vkId = minted.virtual_key.id;
  // The tenant's own birth instant, and the same value on every retry.
  const cycleAnchorAt = minted.virtual_key.created_at;

  const hardCap = await budgets.create(
    {
      scope: { kind: "virtual_key", virtual_key_id: vkId },
      name: `${name} hard cap`,
      window: "manual",
      limit_usd: "5.00",
      on_breach: "block",
    },
    { idempotencyKey: signupKey(name, "hard-cap"), onIdempotentReplay },
  );

  const softCap = await budgets.create(
    {
      scope: { kind: "virtual_key", virtual_key_id: vkId },
      name: `${name} soft cap`,
      window: "manual",
      limit_usd: "2.50",
      on_breach: "warn",
    },
    { idempotencyKey: signupKey(name, "soft-cap"), onIdempotentReplay },
  );

  // A cycle anchor belongs to a windowed budget: a manual window accrues
  // until an explicit reset, and the platform rejects an anchor on one.
  const perUser = await budgets.create(
    {
      scope: { kind: "attributed_user", anchor_virtual_key_id: vkId },
      name: `${name} per-seat allowance`,
      window: "month",
      limit_usd: "1.00",
      on_breach: "block",
      cycle_anchor_at: cycleAnchorAt,
    },
    { idempotencyKey: signupKey(name, "seat-allowance"), onIdempotentReplay },
  );

  return {
    virtualKeyId: vkId,
    virtualKeySecret: minted.secret,
    hardCapBudgetId: hardCap.id,
    softCapBudgetId: softCap.id,
    perUserBudgetId: perUser.id,
    cycleAnchorAt: perUser.cycle_anchor_at ?? cycleAnchorAt,
    replayed,
  };
}

export async function registerWebhookEndpoint(url: string) {
  // Endpoint bodies are the wire shape: lowercase snake, in and out.
  const created = await webhooks.create({
    url,
    enabled_events: [
      "gateway.request.completed",
      "gateway.request.settled",
      "gateway.budget.threshold_crossed",
      "gateway.budget.breached",
      "gateway.virtual_key.disabled",
      "gateway.virtual_key.enabled",
    ],
  });
  return { endpointId: created.id, secret: created.secret };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const tenantIndex = args.indexOf("--tenant");
  const webhookIndex = args.indexOf("--register-webhook");

  if (tenantIndex >= 0) {
    const tenant = await provisionTenant(args[tenantIndex + 1]!);
    console.log(JSON.stringify(tenant, null, 2));
    console.log(
      "\nStore virtualKeySecret in your tenant record; it is not retrievable again.",
    );
  }
  if (webhookIndex >= 0) {
    const endpoint = await registerWebhookEndpoint(args[webhookIndex + 1]!);
    console.log(JSON.stringify(endpoint, null, 2));
    console.log(
      "\nPut secret in TS_WEBHOOK_SECRET (or PY_WEBHOOK_SECRET) in .env.",
    );
  }
  if (tenantIndex < 0 && webhookIndex < 0) {
    console.log(
      'Usage: pnpm provision -- --tenant "ACME Corp" [--register-webhook <url>]',
    );
  }
}
