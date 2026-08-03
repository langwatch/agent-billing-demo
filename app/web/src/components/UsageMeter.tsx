import type { BudgetView, UsageView } from "../api";
import { Badge, Card, cx, money } from "./ui";

/**
 * The meter the customer sees: real caps, real spend. Limits come from the
 * budgets provisioned on LangWatch at sign-up, and the spend is what the
 * platform has actually recorded against this tenant's virtual key.
 */
export function UsageMeter({
  usage,
  loading,
  action,
}: {
  usage: UsageView | null;
  loading: boolean;
  action?: React.ReactNode;
}) {
  return (
    <Card
      title="Usage this billing period"
      subtitle="Caps and spend read back from the LangWatch AI Gateway"
      action={action}
    >
      {loading && !usage ? (
        <div className="space-y-3">
          <div className="h-3 w-40 animate-pulse rounded bg-slate-100" />
          <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
        </div>
      ) : !usage ? (
        <p className="text-sm text-slate-500">No usage recorded yet.</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat
              label="Spend"
              value={money(usage.primary?.spend_usd ?? usage.ledger.cost_usd)}
            />
            <Stat
              label="Hard cap"
              value={usage.primary ? money(usage.primary.limit_usd) : "not set"}
            />
            <Stat label="Billed requests" value={String(usage.ledger.requests)} />
            <Stat
              label="Tokens in / out"
              value={`${usage.ledger.input_tokens} / ${usage.ledger.output_tokens}`}
            />
          </div>

          <div className="space-y-4">
            {usage.budgets.map((budget) => (
              <BudgetBar key={budget.id} budget={budget} />
            ))}
          </div>

          {usage.per_user_budgets.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                Per seat allowance
              </p>
              <div className="space-y-3">
                {usage.per_user_budgets.map((budget) => (
                  <BudgetBar
                    key={`${budget.id}:${budget.end_user_id}`}
                    budget={budget}
                    label={budget.end_user_id ?? "unattributed"}
                  />
                ))}
              </div>
            </div>
          )}

          <FeedNote usage={usage} />
        </div>
      )}
    </Card>
  );
}

export function BudgetBar({
  budget,
  label,
}: {
  budget: BudgetView;
  label?: string;
}) {
  // No percentage without a spend figure: an empty bar beside the word
  // "unknown" reads as unknown, which is what it is.
  const percent = Math.min(100, Math.max(0, budget.percent ?? 0));
  const tone =
    percent >= 100
      ? "bg-rose-500"
      : percent >= 75
        ? "bg-amber-500"
        : "bg-brand-500";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-700">
            {label ?? budget.name}
          </span>
          <Badge tone={budget.on_breach === "block" ? "rose" : "amber"}>
            {budget.on_breach === "block" ? "blocks" : "warns"}
          </Badge>
          <span className="hidden text-xs text-slate-400 sm:inline">
            {budget.window} window
          </span>
        </div>
        <span className="shrink-0 font-mono text-xs text-slate-600 tabular-nums">
          {money(budget.spend_usd)} / {money(budget.limit_usd)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cx("h-full rounded-full transition-all duration-500", tone)}
          style={{ width: `${Math.max(percent, percent > 0 ? 1.5 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-lg text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}

function FeedNote({ usage }: { usage: UsageView }) {
  if (usage.degraded) {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
        Showing spend from the local billing ledger: {usage.degraded}
      </p>
    );
  }
  return (
    <p className="text-xs text-slate-500">
      {usage.ledger.requests} request
      {usage.ledger.requests === 1 ? "" : "s"} billed from signed webhook events
      {usage.ledger.awaiting_cost > 0 &&
        `, ${usage.ledger.awaiting_cost} awaiting final cost`}
      .
    </p>
  );
}
