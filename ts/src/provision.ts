/**
 * Provision one tenant on LangWatch through the official TypeScript SDK
 * (`langwatch`): the four calls a customer signup makes.
 *
 * 1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
 *    tenant's gateway credential, and every budget and spend row hangs off
 *    its id. The secret is returned exactly once; store it like a password.
 * 2. A hard cap: `on_breach: BLOCK`, MANUAL window. MANUAL accrues until an
 *    explicit reset (POST /budgets/:id/reset), which is how a billing period
 *    closes without ever mutating recorded spend.
 * 3. A soft cap: `on_breach: WARN` at a lower limit. Crossing it emits
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
 * Usage:
 *   pnpm provision -- --tenant "ACME Corp" [--register-webhook http://host:port/webhooks/langwatch]
 */
import {
  GatewayBudgetsApiService,
  VirtualKeysApiService,
  WebhooksApiService,
} from "langwatch";

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

export async function provisionTenant(name: string) {
  const minted = await virtualKeys.create({
    name,
    description: `Tenant key for ${name} (provisioned by acme-agents)`,
  });
  const vkId = minted.virtual_key.id;

  const hardCap = await budgets.create({
    scope: { kind: "VIRTUAL_KEY", virtual_key_id: vkId },
    name: `${name} hard cap`,
    window: "MANUAL",
    limit_usd: "5.00",
    on_breach: "BLOCK",
  });

  const softCap = await budgets.create({
    scope: { kind: "VIRTUAL_KEY", virtual_key_id: vkId },
    name: `${name} soft cap`,
    window: "MANUAL",
    limit_usd: "2.50",
    on_breach: "WARN",
  });

  const perUser = await budgets.create({
    scope: { kind: "ATTRIBUTED_USER", anchor_virtual_key_id: vkId },
    name: `${name} per-user allowance`,
    window: "MONTH",
    limit_usd: "1.00",
    on_breach: "BLOCK",
  });

  return {
    virtualKeyId: vkId,
    virtualKeySecret: minted.secret,
    hardCapBudgetId: hardCap.id,
    softCapBudgetId: softCap.id,
    perUserBudgetId: perUser.id,
  };
}

export async function registerWebhookEndpoint(url: string) {
  const created = await webhooks.create({
    url,
    enabledEvents: [
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
