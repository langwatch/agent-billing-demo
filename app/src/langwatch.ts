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
 * 2. A hard cap: `on_breach: "block"` on a `manual` window. A manual window
 *    accrues until an explicit reset, which is how a billing period closes
 *    without ever mutating recorded spend.
 * 3. A soft cap: `on_breach: "warn"` at half the limit. Crossing it emits
 *    `gateway.budget.threshold_crossed` and stamps a warning header on
 *    responses; traffic keeps flowing.
 * 4. An attributed-user template: ONE budget row that caps every current
 *    and future seat of this tenant. Nothing is provisioned per seat;
 *    buckets appear lazily on first spend. Fail-closed: once the template
 *    is active, requests without an end-user id are rejected with
 *    `end_user_required` instead of passing uncapped.
 *
 * Every enum on this surface is lowercase snake, on the way in and on the
 * way out. Uppercase is rejected, so there is exactly one spelling of a
 * scope kind, a window or a breach action to match on anywhere.
 *
 * TODO-VALIDATE: run a real signup against the gateway and confirm all four
 * creates are accepted with these lowercase values, and that the rows come
 * back with scope_type "virtual_key" / "attributed_user" so loadBudgets
 * sorts them into perKey and perSeatTemplate rather than dropping them.
 */
export async function provisionTenant(name: string): Promise<ProvisionedTenant> {
  const minted = await virtualKeys.create({
    name,
    description: `Tenant key for ${name} (ACME Agents signup)`,
  });
  const virtualKeyId = minted.virtual_key.id;

  const hardCap = await budgets.create({
    scope: { kind: "virtual_key", virtual_key_id: virtualKeyId },
    name: `${name} hard cap`,
    window: "manual",
    limit_usd: CAPS.hardUsd,
    on_breach: "block",
  });

  const softCap = await budgets.create({
    scope: { kind: "virtual_key", virtual_key_id: virtualKeyId },
    name: `${name} soft cap`,
    window: "manual",
    limit_usd: CAPS.softUsd,
    on_breach: "warn",
  });

  const perUser = await budgets.create({
    scope: { kind: "attributed_user", anchor_virtual_key_id: virtualKeyId },
    name: `${name} per-seat allowance`,
    window: "month",
    limit_usd: CAPS.perSeatUsd,
    on_breach: "block",
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
  /** Canonical integer limit, nano-USD. Null past the safe integer range. */
  limit_nano_usd: number | null;
  /**
   * Canonical integer spend, nano-USD. Null when the platform could not
   * total spend for this period, which is not the same as zero and must not
   * be rendered as a figure.
   */
  spent_nano_usd: number | null;
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
 * `list()` walks the cursor to exhaustion, so this is the complete set of
 * caps and not a first page.
 *
 * Money is taken as the integer nano-USD fields the rows carry, never parsed
 * out of the decimal display strings beside them.
 */
export async function loadBudgets(): Promise<BudgetsByKey> {
  const response = await budgets.list();
  const perKey = new Map<string, BudgetSnapshot[]>();
  const perSeatTemplate = new Map<string, BudgetSnapshot>();

  for (const budget of response.data) {
    const snapshot: BudgetSnapshot = {
      id: budget.id,
      name: budget.name,
      scope_type: budget.scope_type,
      scope_id: budget.scope_id,
      window: budget.window,
      on_breach: budget.on_breach,
      limit_nano_usd: budget.limit_nano_usd,
      spent_nano_usd: budget.spent_nano_usd,
      current_period_started_at: budget.current_period_started_at,
      resets_at: budget.resets_at,
    };
    if (budget.archived_at) continue;

    // attributed_user rows are templates anchored to a virtual key: one row
    // that defines the allowance every seat of that tenant gets.
    if (budget.scope_type === "attributed_user") {
      perSeatTemplate.set(budget.scope_id, snapshot);
      continue;
    }
    if (budget.scope_type === "virtual_key") {
      const existing = perKey.get(budget.scope_id) ?? [];
      existing.push(snapshot);
      perKey.set(budget.scope_id, existing);
    }
  }

  // Blocking caps first, then the widest limit, so the meter leads with the
  // number that actually stops traffic.
  for (const list of perKey.values()) {
    list.sort((left, right) => {
      if (left.on_breach !== right.on_breach) return left.on_breach === "block" ? -1 : 1;
      return (right.limit_nano_usd ?? 0) - (left.limit_nano_usd ?? 0);
    });
  }

  return { perKey, perSeatTemplate, spendAvailable: response.spend_available };
}

/** Close a billing period: move the manual window boundary, keep the books. */
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
 * Spend per end user for the current allowance period, in one call, as
 * integer nano-USD.
 *
 * The per-seat allowance is what the gateway enforces, so the meter has to
 * render the platform's own figure. Reading it from the local webhook
 * ledger instead would let a seat sit at "37% used" on screen while the
 * gateway is already refusing its requests.
 *
 * Windows are epoch milliseconds on every spend route.
 *
 * `iterSummaries` is lazy and walks the cursor to exhaustion, so a tenant
 * whose seats land on the second page is still metered. `summariesPage` is
 * the single-page call, and a page is not the answer here.
 */
export async function seatSpendSince(
  fromIso: string,
): Promise<Map<string, number>> {
  const from = new Date(fromIso).getTime();
  const spendBySeat = new Map<string, number>();
  const rows = spendEvents.iterSummaries({
    groupBy: "end_user",
    from: Number.isFinite(from) ? from : Date.now() - 30 * 86_400_000,
    to: Date.now(),
  });
  for await (const row of rows) {
    spendBySeat.set(row.key, row.cost.nano_usd);
  }
  return spendBySeat;
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
