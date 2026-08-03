import type { AppDatabase } from "./db.js";
import { nanoToUsd, nanoToUsdOrNull } from "./money.js";
import {
  loadBudgets,
  seatSpendSince,
  type BudgetsByKey,
  type BudgetSnapshot,
} from "./langwatch.js";

/**
 * What the meters render. Caps and tenant spend are read back from
 * LangWatch, and the request-level detail comes from the billing events
 * this app's own webhook receiver ingested. Two independent sources for the
 * same money, which is exactly the property a rebilling platform wants.
 */
export interface BudgetView {
  id: string;
  name: string;
  scope: string;
  window: string;
  on_breach: string;
  /** Canonical integer figures. These are the money; sum and compare these. */
  limit_nano_usd: number | null;
  spend_nano_usd: number | null;
  /**
   * Display only, converted once at this boundary. Null stays null all the
   * way to the screen, where it renders as unknown rather than as zero.
   */
  limit_usd: number | null;
  spend_usd: number | null;
  /** Null when spend could not be totalled: no spend, no percentage. */
  percent: number | null;
  end_user_id?: string | null;
}

export interface LedgerTotals {
  requests: number;
  /** Canonical integer total, nano-USD: what an invoice would be built on. */
  cost_nano_usd: number;
  /** Display only, converted once at this boundary. */
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  /** Requests delivered as `settled`: real traffic whose cost is not final. */
  awaiting_cost: number;
  by_seat: Array<{
    end_user_id: string;
    requests: number;
    cost_nano_usd: number;
    cost_usd: number;
  }>;
}

export interface UsageView {
  virtual_key_id: string;
  budgets: BudgetView[];
  per_user_budgets: BudgetView[];
  ledger: LedgerTotals;
  primary: BudgetView | null;
  source: "langwatch" | "ledger";
  degraded: string | null;
}

/**
 * The winning row per gateway request. Delivery is at-least-once and a
 * `completed` event supersedes the `settled` one it answers, so the choice
 * is made at read time: rank completed first, take one row per request,
 * never sum a pair.
 */
const WINNING_EVENTS = `
  SELECT event_id, gateway_request_id, virtual_key_id, end_user_id, model, status,
         cost_nano_usd, input_tokens, output_tokens, occurred_at,
         ROW_NUMBER() OVER (
           PARTITION BY gateway_request_id
           ORDER BY CASE WHEN type = 'gateway.request.completed' THEN 0 ELSE 1 END,
                    occurred_at DESC
         ) AS pick
  FROM billing_events
  WHERE type LIKE 'gateway.request.%' AND gateway_request_id IS NOT NULL
`;

export function ledgerTotals(db: AppDatabase, virtualKeyId: string): LedgerTotals {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(CASE WHEN cost_nano_usd IS NULL THEN 1 ELSE 0 END), 0) AS awaiting_cost
       FROM (${WINNING_EVENTS}) WHERE pick = 1 AND virtual_key_id = ?`,
    )
    .get(virtualKeyId) as {
    requests: number;
    cost_nano_usd: number;
    input_tokens: number;
    output_tokens: number;
    awaiting_cost: number;
  };

  const bySeat = db
    .prepare(
      `SELECT COALESCE(end_user_id, '') AS end_user_id,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd
       FROM (${WINNING_EVENTS}) WHERE pick = 1 AND virtual_key_id = ?
       GROUP BY COALESCE(end_user_id, '')
       ORDER BY cost_nano_usd DESC`,
    )
    .all(virtualKeyId) as Array<{
    end_user_id: string;
    requests: number;
    cost_nano_usd: number;
  }>;

  // SQLite sums the nano-USD integers; the dollar figure is derived once,
  // here, for the screen.
  return {
    requests: totals.requests,
    cost_nano_usd: totals.cost_nano_usd,
    cost_usd: nanoToUsd(totals.cost_nano_usd),
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    awaiting_cost: totals.awaiting_cost,
    by_seat: bySeat.map((row) => ({
      end_user_id: row.end_user_id,
      requests: row.requests,
      cost_nano_usd: row.cost_nano_usd,
      cost_usd: nanoToUsd(row.cost_nano_usd),
    })),
  };
}

/** Percent of an allowance used, from the integers. Null when unknowable. */
function percentOf(spendNano: number | null, limitNano: number | null): number | null {
  if (spendNano === null || limitNano === null || limitNano <= 0) return null;
  return (spendNano / limitNano) * 100;
}

function toView(budget: BudgetSnapshot): BudgetView {
  return {
    id: budget.id,
    name: budget.name,
    scope: budget.scope_type,
    window: budget.window,
    on_breach: budget.on_breach,
    limit_nano_usd: budget.limit_nano_usd,
    spend_nano_usd: budget.spent_nano_usd,
    limit_usd: nanoToUsdOrNull(budget.limit_nano_usd),
    spend_usd: nanoToUsdOrNull(budget.spent_nano_usd),
    percent: percentOf(budget.spent_nano_usd, budget.limit_nano_usd),
  };
}

/**
 * Build one tenant's meter. `budgetData` is passed in so the owner console
 * can read every tenant's caps with a single platform call.
 */
export function usageFor(
  db: AppDatabase,
  params: {
    virtualKeyId: string;
    seats: string[];
    budgetData: BudgetsByKey | null;
    /** Platform spend per end user; falls back to the local ledger. */
    seatSpend?: Map<string, number> | null;
    degraded: string | null;
  },
): UsageView {
  const ledger = ledgerTotals(db, params.virtualKeyId);
  const caps = params.budgetData?.perKey.get(params.virtualKeyId) ?? [];
  const template = params.budgetData?.perSeatTemplate.get(params.virtualKeyId) ?? null;

  const budgets = caps.map(toView);
  let degraded = params.degraded;
  if (!degraded && params.budgetData && !params.budgetData.spendAvailable) {
    degraded = "the platform could not total spend for this period";
  }
  if (!degraded && params.budgetData && budgets.length === 0) {
    degraded = "no caps are attached to this workspace yet";
  }

  // The per-seat template defines one allowance that every seat gets. Both
  // the limit and the spend come from the platform, because that is the
  // figure the gateway enforces against; the local ledger is the fallback
  // when spend analytics are unavailable.
  // Both maps are integer nano-USD, so the platform figure and the local
  // fallback are the same unit and never silently mix scales.
  const ledgerBySeat = new Map(
    ledger.by_seat.map((row) => [row.end_user_id, row.cost_nano_usd] as const),
  );
  const spendBySeat = params.seatSpend ?? ledgerBySeat;
  // Which seats belong to this workspace is the app's own question: the
  // seats it provisioned, plus any that show up in its own ledger. The
  // platform spend map is organization-wide and is only ever read through
  // these ids, never enumerated.
  const seatIds = new Set([...params.seats, ...ledgerBySeat.keys()].filter(Boolean));
  const perUserBudgets: BudgetView[] = template
    ? [...seatIds].map((seat) => {
        const spendNano = spendBySeat.get(seat) ?? ledgerBySeat.get(seat) ?? 0;
        return {
          id: template.id,
          name: template.name,
          scope: template.scope_type,
          window: template.window,
          on_breach: template.on_breach,
          limit_nano_usd: template.limit_nano_usd,
          spend_nano_usd: spendNano,
          limit_usd: nanoToUsdOrNull(template.limit_nano_usd),
          spend_usd: nanoToUsd(spendNano),
          percent: percentOf(spendNano, template.limit_nano_usd),
          end_user_id: seat,
        };
      })
    : [];

  return {
    virtual_key_id: params.virtualKeyId,
    budgets,
    per_user_budgets: perUserBudgets,
    ledger,
    primary: budgets.find((budget) => budget.on_breach === "block") ?? budgets[0] ?? null,
    source: degraded ? "ledger" : "langwatch",
    degraded,
  };
}

/**
 * Read every cap once, and if the platform is unreachable say so instead of
 * failing the page: the local ledger still has the request-level truth.
 */
export async function loadBudgetsOrDegrade(): Promise<{
  data: BudgetsByKey | null;
  degraded: string | null;
}> {
  try {
    return { data: await loadBudgets(), degraded: null };
  } catch (error) {
    console.error("[langwatch:budgets.list]", error);
    return {
      data: null,
      degraded: "the LangWatch API is not reachable right now",
    };
  }
}

/**
 * Per-seat spend for the oldest allowance period on screen, in one call, as
 * integer nano-USD. Best effort: without it the meters fall back to the
 * local ledger, which is complete but only as fresh as the last webhook
 * delivery.
 */
export async function loadSeatSpend(
  budgetData: BudgetsByKey | null,
): Promise<Map<string, number> | null> {
  if (!budgetData || budgetData.perSeatTemplate.size === 0) return null;
  const periodStarts = [...budgetData.perSeatTemplate.values()]
    .map((template) => template.current_period_started_at)
    .filter(Boolean)
    .sort();
  const from = periodStarts[0];
  if (!from) return null;
  try {
    return await seatSpendSince(from);
  } catch (error) {
    console.error("[langwatch:spend-summaries]", error);
    return null;
  }
}
