/**
 * Provision one tenant on LangWatch through the official TypeScript SDK
 * (`langwatch`): the four calls a customer signup makes, or five when
 * LANGWATCH_PROVISION_MODE is `project`.
 *
 * 0. In `project` mode only: create the tenant's own project under the team
 *    from LANGWATCH_TEAM_ID, and hang everything below off that project. The
 *    key is scoped to it and sends its traces there, so the tenant's traffic,
 *    spend and traces are separated by the platform rather than by a filter.
 * 1. Mint a virtual key. The VK IS the tenant boundary in `virtual_key` mode:
 *    its secret is the tenant's gateway credential, and every budget and
 *    spend row hangs off its id. The secret is returned exactly once; store
 *    it like a password.
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
  ProjectsApiService,
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

/**
 * What a signup provisions: one virtual key per tenant under the control
 * project (`virtual_key`), or a project per tenant with the key scoped to it
 * (`project`). LANGWATCH_PROJECT_ID stays the control project either way,
 * because it is what these calls authenticate as; a tenant's own project is
 * data in the request bodies.
 */
const PROVISION_MODE =
  process.env.LANGWATCH_PROVISION_MODE === "project" ? "project" : "virtual_key";
/** The team every tenant project goes under. `pnpm setup:team` fills it in. */
const TEAM_ID = process.env.LANGWATCH_TEAM_ID ?? "";
/** What a tenant project is tagged with: the stack that produces its traces. */
const PROJECT_LANGUAGE = "typescript";
const PROJECT_FRAMEWORK = "vercel_ai";

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
// Projects are organization-scoped: they are what a project id would target,
// so this one does not take one.
const projects = new ProjectsApiService({ endpoint: BASE_URL, apiKey: API_KEY });

/**
 * The key one resource of one signup is created under. Derived from the
 * tenant's identity, so running this twice for the same tenant asks for the
 * same resources and gets the same ones back rather than a second set. The
 * mode namespaces the keys, because it decides what a signup creates.
 */
function signupKey(name: string, resource: string): string {
  const identity = name.trim().toLowerCase().replace(/\s+/g, "-");
  const mode = PROVISION_MODE === "project" ? "project:" : "";
  return `acme-agents:signup:${mode}${identity}:${resource}`;
}

/**
 * The tenant's own project, created once and found again after that.
 *
 * Project creates take no idempotency key, so the name carries that weight
 * instead: a retried signup finds the project the first attempt made rather
 * than stacking a second one beside it. The listing walks every page and
 * never returns archived projects, so a tenant that was rolled back is
 * provisioned fresh.
 */
async function ensureTenantProject(name: string) {
  if (!TEAM_ID) {
    throw new Error(
      "LANGWATCH_TEAM_ID is not set. Run `pnpm setup:team` once before" +
        " provisioning tenants in project mode.",
    );
  }
  const limit = 100;
  for (let page = 1; ; page += 1) {
    const { data, pagination } = await projects.list({ page, limit });
    const match = data.find((project) => project.name === name);
    if (match) return { id: match.id, created: false };
    if (data.length < limit || page * limit >= pagination.total) break;
  }
  // The create also mints a service key for the new project. It is
  // deliberately dropped: the tenant's runtime credential is the virtual key.
  const created = await projects.create({
    name,
    teamId: TEAM_ID,
    language: PROJECT_LANGUAGE,
    framework: PROJECT_FRAMEWORK,
  });
  return { id: created.id, created: true };
}

export async function provisionTenant(name: string) {
  let replayed = false;
  const onIdempotentReplay = () => {
    replayed = true;
  };

  // In project mode the tenant's project comes first: the key is scoped to it
  // and points its traces at it, and the caps are attached to it.
  const project =
    PROVISION_MODE === "project" ? await ensureTenantProject(name) : null;

  const minted = await virtualKeys.create(
    {
      name,
      description: `Tenant key for ${name} (ACME Agents signup)`,
      ...(project
        ? {
            scopes: [{ scope_type: "project" as const, scope_id: project.id }],
            // Where this key's traces and costs land. Not a scope: it grants
            // the key nothing, it decides which project sees the traffic.
            trace_project_id: project.id,
          }
        : {}),
    },
    { idempotencyKey: signupKey(name, "virtual-key"), onIdempotentReplay },
  );
  const vkId = minted.virtual_key.id;
  // The tenant's own birth instant, and the same value on every retry.
  const cycleAnchorAt = minted.virtual_key.created_at;

  // What the caps hang off. A project cap covers every key that ever points
  // at that project; in virtual key mode the key IS the boundary.
  const tenantScope = project
    ? ({ kind: "project", project_id: project.id } as const)
    : ({ kind: "virtual_key", virtual_key_id: vkId } as const);
  const seatScope = project
    ? ({ kind: "attributed_user", anchor_project_id: project.id } as const)
    : ({ kind: "attributed_user", anchor_virtual_key_id: vkId } as const);

  const hardCap = await budgets.create(
    {
      scope: tenantScope,
      name: `${name} hard cap`,
      window: "manual",
      limit_usd: "5.00",
      on_breach: "block",
    },
    { idempotencyKey: signupKey(name, "hard-cap"), onIdempotentReplay },
  );

  const softCap = await budgets.create(
    {
      scope: tenantScope,
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
      scope: seatScope,
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
    projectId: project?.id ?? null,
    projectCreated: project?.created ?? false,
  };
}

/**
 * Register a receiver, over HTTPS or on an Amazon SQS queue.
 *
 * `DEMO_TRANSPORT=sqs` reads the address as a queue URL rather than a
 * receiver URL; the events, the signature and the envelope are identical
 * either way.
 */
export async function registerWebhookEndpoint(address: string) {
  const destination =
    (process.env.DEMO_TRANSPORT ?? "http") === "sqs"
      ? { destination_kind: "sqs" as const, sqs: { queue_url: address } }
      : { url: address };
  // Endpoint bodies are the wire shape: lowercase snake, in and out.
  const created = await webhooks.create({
    ...destination,
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
