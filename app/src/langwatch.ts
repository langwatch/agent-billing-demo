import {
  GatewayBudgetsApiService,
  ProjectsApiService,
  SpendEventsApiService,
  TeamsApiService,
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
 * along), webhook endpoints, teams and projects are organization-scoped.
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

// Teams and projects are organization-scoped too: they are what a project
// belongs to, so neither of them is addressed from inside one.
export const teams = new TeamsApiService({ endpoint: BASE_URL, apiKey: API_KEY });

export const projects = new ProjectsApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
});

/**
 * What a signup provisions.
 *
 * - `virtual_key`: one virtual key per customer, under the control project.
 *   The key is the whole tenant boundary and every cap hangs off it.
 * - `project`: a LangWatch project per customer, under one stable team, with
 *   the key scoped to that project and pointed at it, so each customer's
 *   traces and costs land in a project of their own.
 *
 * LANGWATCH_PROJECT_ID stays the control project either way: it is what the
 * virtual key and budget calls authenticate as. A customer's own project is
 * data in those request bodies, never a change of who is calling.
 */
export type ProvisionMode = "virtual_key" | "project";

export const PROVISION_MODE: ProvisionMode =
  process.env.LANGWATCH_PROVISION_MODE === "project" ? "project" : "virtual_key";

/** The team every customer project goes under. `pnpm setup:team` fills it in. */
const TEAM_ID = process.env.LANGWATCH_TEAM_ID ?? "";

/**
 * What a customer project is tagged with: the stack that produces its
 * traces, which is this app, not whatever the customer builds on top of it.
 */
const PROJECT_LANGUAGE = "typescript";
const PROJECT_FRAMEWORK = "vercel_ai";

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
  /** The instant the seat allowance's monthly cycle is anchored to. */
  cycleAnchorAt: string;
  /** True when the platform replayed an earlier signup instead of creating. */
  replayed: boolean;
  /** The customer's own project in `project` mode; null in `virtual_key` mode. */
  projectId: string | null;
  /** True when this signup created that project rather than finding it. */
  projectCreated: boolean;
}

/**
 * The idempotency key for one resource of one signup. Derived from the
 * customer's identity, so a retried or double-submitted signup asks for the
 * same four resources and gets the same four back instead of a second set.
 *
 * The name is the identity a customer types, so it is normalized the same way
 * the workspace uniqueness check normalizes it: case and surrounding space are
 * not what makes two signups different.
 *
 * The mode namespaces the keys, because it decides what a signup creates: the
 * same customer provisioned the other way asks for different resources, and a
 * key that meant one body must never be replayed for another.
 */
function signupKey(name: string, resource: string): string {
  const identity = name.trim().toLowerCase().replace(/\s+/g, "-");
  const mode = PROVISION_MODE === "project" ? "project:" : "";
  return `acme-agents:signup:${mode}${identity}:${resource}`;
}

interface CustomerProject {
  id: string;
  /** True when this call created it, false when it found one already there. */
  created: boolean;
}

/**
 * The customer's own project, created once and found again after that.
 *
 * Project creates take no idempotency key, so the name carries that weight
 * instead: a retried signup finds the project the first attempt made rather
 * than stacking a second one beside it. The name is the customer's own, the
 * same identity the workspace uniqueness check and the idempotency keys are
 * derived from, and the listing never returns archived projects, so a
 * customer that was rolled back is provisioned fresh.
 */
async function ensureCustomerProject(name: string): Promise<CustomerProject> {
  if (!TEAM_ID) {
    throw new Error(
      "LANGWATCH_TEAM_ID is not set. Run `pnpm setup:team` once before" +
        " provisioning customers in project mode.",
    );
  }
  const existing = await findProjectByName(name);
  if (existing) return { id: existing.id, created: false };

  // The create also mints a service key for the new project. It is
  // deliberately not stored: the customer's runtime credential is the
  // virtual key, and one credential per tenant is the whole point.
  const created = await projects.create({
    name,
    teamId: TEAM_ID,
    language: PROJECT_LANGUAGE,
    framework: PROJECT_FRAMEWORK,
  });
  return { id: created.id, created: true };
}

/** Walk the project listing to exhaustion, so a match on page two counts. */
async function findProjectByName(name: string) {
  const limit = 100;
  for (let page = 1; ; page += 1) {
    const { data, pagination } = await projects.list({ page, limit });
    const match = data.find((project) => project.name === name);
    if (match) return match;
    if (data.length < limit || page * limit >= pagination.total) return null;
  }
}

/** Archive a project this signup created and could not hand to anyone. */
export function archiveProject(projectId: string) {
  return projects.archive(projectId);
}

/**
 * The four calls a signup makes, or five in project mode.
 *
 * 0. In `project` mode only: create the customer's own project under the
 *    team from LANGWATCH_TEAM_ID. Everything below then hangs off that
 *    project instead of off the key, and the key is scoped to it and sends
 *    its traces there, so the customer's traffic, spend and traces are one
 *    thing the platform separates rather than something this app filters.
 * 1. Mint a virtual key. The VK IS the tenant boundary in `virtual_key`
 *    mode: its secret is the tenant's gateway credential, and every budget
 *    and spend row hangs off its id. The secret comes back exactly once;
 *    store it like a password.
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
 * Two properties make this safe to retry, and both come from the SDK rather
 * than from bookkeeping here:
 *
 * - **Idempotency.** Every create carries a key derived from the customer's
 *   identity, so a double-submitted signup returns the SAME virtual key and
 *   the SAME budgets. A replay is reported back rather than hidden, because
 *   the second caller still needs to know it did not mint anything.
 * - **An anchored cycle.** The seat allowance's month window starts at the
 *   instant the customer signed up, not on the calendar first. A customer who
 *   starts on the 30th gets a period that runs to the 30th.
 *
 * Those two properties depend on each other. An idempotency key covers the
 * request BODY, so a retry that recomputes the anchor from the clock sends a
 * different body under the same key and is refused as a mismatch rather than
 * replayed. The anchor is therefore read from the virtual key the first call
 * minted: it is the instant the tenant came into existence, and every retry
 * gets the same key back and sends the same body.
 */
export async function provisionTenant(name: string): Promise<ProvisionedTenant> {
  let replayed = false;
  const onIdempotentReplay = () => {
    replayed = true;
  };

  // In project mode the customer's project comes first: the key is scoped to
  // it and points its traces at it, and the caps are attached to it.
  const project =
    PROVISION_MODE === "project" ? await ensureCustomerProject(name) : null;

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
  const virtualKeyId = minted.virtual_key.id;
  // The tenant's own birth instant, and the same value on every retry.
  const cycleAnchorAt = minted.virtual_key.created_at;

  // What the caps hang off. A project cap covers every key that ever points
  // at that project, so in project mode the tenant boundary outlives any one
  // key; in virtual key mode the key IS the boundary.
  const tenantScope = project
    ? ({ kind: "project", project_id: project.id } as const)
    : ({ kind: "virtual_key", virtual_key_id: virtualKeyId } as const);
  const seatScope = project
    ? ({ kind: "attributed_user", anchor_project_id: project.id } as const)
    : ({ kind: "attributed_user", anchor_virtual_key_id: virtualKeyId } as const);

  const hardCap = await budgets.create(
    {
      scope: tenantScope,
      name: `${name} hard cap`,
      window: "manual",
      limit_usd: CAPS.hardUsd,
      on_breach: "block",
    },
    { idempotencyKey: signupKey(name, "hard-cap"), onIdempotentReplay },
  );

  const softCap = await budgets.create(
    {
      scope: tenantScope,
      name: `${name} soft cap`,
      window: "manual",
      limit_usd: CAPS.softUsd,
      on_breach: "warn",
    },
    { idempotencyKey: signupKey(name, "soft-cap"), onIdempotentReplay },
  );

  const perUser = await budgets.create(
    {
      scope: seatScope,
      name: `${name} per-seat allowance`,
      window: "month",
      limit_usd: CAPS.perSeatUsd,
      on_breach: "block",
      cycle_anchor_at: cycleAnchorAt,
    },
    { idempotencyKey: signupKey(name, "seat-allowance"), onIdempotentReplay },
  );

  return {
    virtualKeyId,
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
  /** The current cycle's boundaries, as the platform enforces them. */
  current_period_started_at: string;
  resets_at: string;
  /**
   * Set when the cycle is anchored to an instant of this tenant's own, which
   * is what makes a period run from the day they signed up rather than from
   * the calendar first. Null on a calendar-aligned or manual budget.
   */
  cycle_anchor_at: string | null;
}

/**
 * Caps indexed by the id they hang off, which is the customer's project when
 * it has one and its virtual key otherwise. Both are "the tenant" as far as
 * a cap is concerned, so both land in the same map and a meter reads it with
 * one lookup whichever way the customer was provisioned.
 */
export interface BudgetsByAnchor {
  /** Tenant anchor id to the caps that apply to the whole tenant. */
  perTenant: Map<string, BudgetSnapshot[]>;
  /** Tenant anchor id to the per-seat template anchored to it. */
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
export async function loadBudgets(): Promise<BudgetsByAnchor> {
  const rows = await budgets.list();
  const perTenant = new Map<string, BudgetSnapshot[]>();
  const perSeatTemplate = new Map<string, BudgetSnapshot>();

  for (const budget of rows) {
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
      cycle_anchor_at: budget.cycle_anchor_at,
    };
    if (budget.archived_at) continue;

    // attributed_user rows are templates anchored to a virtual key or to a
    // project: one row that defines the allowance every seat of that tenant
    // gets. Either way the anchor is the scope id.
    if (budget.scope_type === "attributed_user") {
      perSeatTemplate.set(budget.scope_id, snapshot);
      continue;
    }
    if (budget.scope_type === "virtual_key" || budget.scope_type === "project") {
      const existing = perTenant.get(budget.scope_id) ?? [];
      existing.push(snapshot);
      perTenant.set(budget.scope_id, existing);
    }
  }

  // Blocking caps first, then the widest limit, so the meter leads with the
  // number that actually stops traffic.
  for (const list of perTenant.values()) {
    list.sort((left, right) => {
      if (left.on_breach !== right.on_breach) return left.on_breach === "block" ? -1 : 1;
      return (right.limit_nano_usd ?? 0) - (left.limit_nano_usd ?? 0);
    });
  }

  return { perTenant, perSeatTemplate, spendAvailable: spendAvailableAcross(rows) };
}

/**
 * Whether the platform could total spend for the caps just read. A row whose
 * spend could not be totalled carries null there rather than a stale figure,
 * so a null is the signal.
 *
 * Per-seat templates are exempt: one allowance per person has no single total
 * to report, so their null says the question does not apply rather than that
 * the answer failed. Counting them would leave every tenant that offers
 * per-seat caps permanently reading as degraded. Each seat's own figure comes
 * from the spend summaries.
 */
function spendAvailableAcross(rows: Awaited<ReturnType<typeof budgets.list>>): boolean {
  return !rows.some(
    (budget) => budget.scope_type !== "attributed_user" && budget.spent_nano_usd === null,
  );
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
