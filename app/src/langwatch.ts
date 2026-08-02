import {
  GatewayBudgetsApiService,
  SpendEventsApiService,
  VirtualKeysApiService,
  WebhooksApiService,
} from "langwatch";

/**
 * Every call this app makes to the billing platform, in one place. The
 * services come from the official SDK: provisioning, cap reads and period
 * closes are SDK calls, never hand-rolled HTTP.
 *
 * Two scopes are in play and they authenticate differently, which the SDK
 * hides: virtual keys and budgets are project-scoped (the project id rides
 * along), webhook endpoints are organization-scoped.
 */
const BASE_URL = process.env.LANGWATCH_BASE_URL ?? "http://localhost:5560";
const API_KEY = process.env.LANGWATCH_API_KEY ?? "";
const PROJECT_ID = process.env.LANGWATCH_PROJECT_ID ?? "";

export const virtualKeys = new VirtualKeysApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
  projectId: PROJECT_ID || undefined,
});

export const budgets = new GatewayBudgetsApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
  projectId: PROJECT_ID || undefined,
});

export const webhooks = new WebhooksApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
});

// Spend analytics are organization-scoped: no project id on this one.
export const spendEvents = new SpendEventsApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
});

export const CAPS = {
  hardUsd: "5.00",
  softUsd: "2.50",
  perSeatUsd: "1.00",
} as const;

export interface ProvisionedTenant {
  virtualKeyId: string;
  virtualKeySecret: string;
  hardCapBudgetId: string;
  softCapBudgetId: string;
  perUserBudgetId: string;
}

/**
 * The four calls a signup makes.
 *
 * 1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
 *    tenant's gateway credential, and every budget and spend row hangs off
 *    its id. The secret comes back exactly once; store it like a password.
 * 2. A hard cap: `on_breach: BLOCK` on a MANUAL window. MANUAL accrues
 *    until an explicit reset, which is how a billing period closes without
 *    ever mutating recorded spend.
 * 3. A soft cap: `on_breach: WARN` at half the limit. Crossing it emits
 *    `gateway.budget.threshold_crossed` and stamps a warning header on
 *    responses; traffic keeps flowing.
 * 4. An attributed-user template: ONE budget row that caps every current
 *    and future seat of this tenant. Nothing is provisioned per seat;
 *    buckets appear lazily on first spend. Fail-closed: once the template
 *    is active, requests without an end-user id are rejected with
 *    `end_user_required` instead of passing uncapped.
 */
export async function provisionTenant(name: string): Promise<ProvisionedTenant> {
  const minted = await virtualKeys.create({
    name,
    description: `Tenant key for ${name} (ACME Agents signup)`,
  });
  const virtualKeyId = minted.virtual_key.id;

  const hardCap = await budgets.create({
    scope: { kind: "VIRTUAL_KEY", virtual_key_id: virtualKeyId },
    name: `${name} hard cap`,
    window: "MANUAL",
    limit_usd: CAPS.hardUsd,
    on_breach: "BLOCK",
  });

  const softCap = await budgets.create({
    scope: { kind: "VIRTUAL_KEY", virtual_key_id: virtualKeyId },
    name: `${name} soft cap`,
    window: "MANUAL",
    limit_usd: CAPS.softUsd,
    on_breach: "WARN",
  });

  const perUser = await budgets.create({
    scope: { kind: "ATTRIBUTED_USER", anchor_virtual_key_id: virtualKeyId },
    name: `${name} per-seat allowance`,
    window: "MONTH",
    limit_usd: CAPS.perSeatUsd,
    on_breach: "BLOCK",
  });

  return {
    virtualKeyId,
    virtualKeySecret: minted.secret,
    hardCapBudgetId: hardCap.id,
    softCapBudgetId: softCap.id,
    perUserBudgetId: perUser.id,
  };
}

export interface BudgetSnapshot {
  id: string;
  name: string;
  scope_type: string;
  scope_id: string;
  window: string;
  on_breach: string;
  limit_usd: number;
  spent_usd: number;
  current_period_started_at: string;
  resets_at: string;
}

export interface BudgetsByKey {
  /** Virtual key id to the caps that apply to the whole tenant. */
  perKey: Map<string, BudgetSnapshot[]>;
  /** Virtual key id to the per-seat template anchored to it. */
  perSeatTemplate: Map<string, BudgetSnapshot>;
  /** False when the platform could not total spend; show it as unknown. */
  spendAvailable: boolean;
}

/**
 * One list call covers every tenant on screen, which is what the owner
 * console needs and what keeps a customer dashboard to a single round trip.
 * Money arrives as decimal strings and is parsed once, here.
 */
export async function loadBudgets(): Promise<BudgetsByKey> {
  const response = await budgets.list();
  const perKey = new Map<string, BudgetSnapshot[]>();
  const perSeatTemplate = new Map<string, BudgetSnapshot>();

  for (const budget of response.budgets) {
    const snapshot: BudgetSnapshot = {
      id: budget.id,
      name: budget.name,
      scope_type: budget.scope_type,
      scope_id: budget.scope_id,
      window: budget.window,
      on_breach: budget.on_breach,
      limit_usd: Number(budget.limit_usd),
      spent_usd: Number(budget.spent_usd),
      current_period_started_at: budget.current_period_started_at,
      resets_at: budget.resets_at,
    };
    if (budget.archived_at) continue;

    // ATTRIBUTED_USER rows are templates anchored to a virtual key: one row
    // that defines the allowance every seat of that tenant gets.
    if (String(budget.scope_type) === "ATTRIBUTED_USER") {
      perSeatTemplate.set(budget.scope_id, snapshot);
      continue;
    }
    if (budget.scope_type === "VIRTUAL_KEY") {
      const existing = perKey.get(budget.scope_id) ?? [];
      existing.push(snapshot);
      perKey.set(budget.scope_id, existing);
    }
  }

  // Blocking caps first, then the widest limit, so the meter leads with the
  // number that actually stops traffic.
  for (const list of perKey.values()) {
    list.sort((left, right) => {
      if (left.on_breach !== right.on_breach) return left.on_breach === "BLOCK" ? -1 : 1;
      return right.limit_usd - left.limit_usd;
    });
  }

  return { perKey, perSeatTemplate, spendAvailable: response.spend_available };
}

/** Close a billing period: move the MANUAL window boundary, keep the books. */
export function resetBudget(budgetId: string, reason: string) {
  return budgets.reset(budgetId, { reason });
}

/**
 * Move a customer onto a different allowance. Only the limit changes; the
 * window and the scope are fixed at creation, and recorded spend is never
 * touched, so raising a cap admits traffic again without rewriting history.
 */
export function setBudgetLimit(budgetId: string, limitUsd: string) {
  return budgets.update(budgetId, { limit_usd: limitUsd });
}

/**
 * Spend per end user for the current allowance period, in one call.
 *
 * The per-seat allowance is what the gateway enforces, so the meter has to
 * render the platform's own figure. Reading it from the local webhook
 * ledger instead would let a seat sit at "37% used" on screen while the
 * gateway is already refusing its requests.
 */
export async function seatSpendSince(fromIso: string): Promise<Map<string, number>> {
  const from = new Date(fromIso).getTime();
  const summaries = await spendEvents.summaries({
    groupBy: "end_user",
    from: Number.isFinite(from) ? from : Date.now() - 30 * 86_400_000,
    to: Date.now(),
    limit: 1000,
  });
  return new Map(
    summaries.data.map((row) => [row.key, row.cost.nano_usd / 1_000_000_000] as const),
  );
}

export interface ReceiverStatus {
  registered: boolean;
  url: string;
  endpointId: string | null;
  status: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/**
 * Whether this app's own webhook endpoint is registered and healthy. The
 * owner console shows it, because a demo whose meters stop moving is almost
 * always a receiver that was never registered.
 */
export async function receiverStatus(url: string): Promise<ReceiverStatus> {
  const endpoints = await webhooks.list();
  const mine = endpoints.find((endpoint) => endpoint.url === url);
  return {
    registered: Boolean(mine),
    url,
    endpointId: mine?.id ?? null,
    status: mine?.status ?? null,
    lastSuccessAt: mine?.last_success_at ?? null,
    lastFailureAt: mine?.last_failure_at ?? null,
  };
}
