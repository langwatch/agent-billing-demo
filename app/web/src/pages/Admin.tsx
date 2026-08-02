import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiFailure,
  type AdminOverview,
  type BillingEventView,
  type BudgetView,
  type CustomerSummary,
} from "../api";
import { EventLog } from "../components/EventLog";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { BudgetBar } from "../components/UsageMeter";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  money,
  relativeTime,
  Spinner,
} from "../components/ui";
import { useLiveFeed } from "../liveFeed";

/**
 * The behind-the-scenes view: every customer, what they are metered at,
 * what they have spent, and the reset actions that close a billing period.
 * The event feed on the right is the same delivery stream that drives the
 * customer-facing meters, shown as it arrives.
 */
export function Admin() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [events, setEvents] = useState<BillingEventView[]>([]);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [resetting, setResetting] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const { frames, revision } = useLiveFeed();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [overviewBody, eventsBody] = await Promise.all([
        api.get<AdminOverview>("/api/admin/overview"),
        api.get<{ events: BillingEventView[] }>("/api/events?limit=40"),
      ]);
      setOverview(overviewBody);
      setEvents(eventsBody.events);
      setFailure(null);
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "Could not load the console."),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Every delivered billing event moves somebody's meter, so refresh.
  useEffect(() => {
    if (revision === 0) return;
    const billing = frames.filter((frame) => frame.kind === "billing_event");
    if (billing.length === 0) return;
    void load();
  }, [revision, frames, load]);

  async function closePeriod(customer: CustomerSummary) {
    setResetting(customer.id);
    try {
      const result = await api.post<{ reset: string[] }>(
        `/api/customers/${customer.id}/close-period`,
        { budget: "all" },
      );
      toast.success(
        `Billing period closed for ${customer.name}`,
        `Reset the ${result.reset.join(" and ")}. Recorded spend is untouched.`,
      );
      await load();
    } catch (error) {
      const apiFailure =
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "The reset did not go through.");
      toast.error("Reset failed", apiFailure.message);
    } finally {
      setResetting(null);
    }
  }

  const customers = overview?.customers.map((row) => row.customer) ?? [];

  return (
    <Shell customers={customers} activeCustomer={null} owner>
      <div className="mx-auto max-w-7xl space-y-6">
        {failure && <ErrorNote error={failure} />}

        {!overview ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading the owner console
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="Customers" value={String(overview.totals.customers)} />
              <Tile
                label="Billed requests"
                value={String(overview.totals.requests)}
              />
              <Tile label="Revenue metered" value={money(overview.totals.cost_usd)} />
              <Tile
                label="Events ingested"
                value={String(overview.receiver.events_ingested)}
                foot={
                  overview.receiver.last_event_at
                    ? `last ${relativeTime(overview.receiver.last_event_at)}`
                    : "none yet"
                }
              />
            </div>

            <div className="grid gap-6 xl:grid-cols-3">
              <div className="space-y-6 xl:col-span-2">
                <Card
                  title="Customers"
                  subtitle="Caps and spend read from the LangWatch AI Gateway"
                  bodyClassName="space-y-4"
                >
                  {overview.customers.length === 0 ? (
                    <EmptyState
                      title="No customers yet"
                      body="Sign one up from the product side and it appears here with its virtual key and caps."
                    />
                  ) : (
                    overview.customers.map(({ customer, usage }) => (
                      <div
                        key={customer.id}
                        className="rounded-xl border border-slate-200 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar name={customer.name} className="h-9 w-9" />
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-slate-900">
                                {customer.name}
                              </p>
                              <p className="truncate font-mono text-xs text-slate-500">
                                {customer.virtual_key_id}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone="neutral">
                              {usage.ledger.requests} requests
                            </Badge>
                            <Button
                              variant="secondary"
                              onClick={() =>
                                setEditing((current) =>
                                  current === customer.id ? null : customer.id,
                                )
                              }
                            >
                              {editing === customer.id ? "Done" : "Adjust caps"}
                            </Button>
                            <Button
                              variant="danger"
                              loading={resetting === customer.id}
                              onClick={() => closePeriod(customer)}
                            >
                              Close billing period
                            </Button>
                          </div>
                        </div>

                        {editing === customer.id && (
                          <CapEditor
                            customerId={customer.id}
                            budgets={[
                              ...usage.budgets,
                              ...(usage.per_user_budgets[0]
                                ? [usage.per_user_budgets[0]]
                                : []),
                            ]}
                            onSaved={async (name) => {
                              toast.success(
                                `${customer.name} moved to a new ${name}`,
                                "Recorded spend is untouched; the new limit applies from now.",
                              );
                              await load();
                            }}
                          />
                        )}

                        <div className="mt-4 space-y-3">
                          {usage.budgets.length === 0 ? (
                            <p className="text-xs text-slate-500">
                              No caps attached to this key.
                            </p>
                          ) : (
                            usage.budgets.map((budget) => (
                              <BudgetBar key={budget.id} budget={budget} />
                            ))
                          )}
                        </div>

                        {usage.per_user_budgets.length > 0 && (
                          <div className="mt-4 border-t border-slate-100 pt-3">
                            <p className="mb-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                              Seat allowances
                            </p>
                            <div className="space-y-2.5">
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
                      </div>
                    ))
                  )}
                </Card>
              </div>

              <div className="space-y-6">
                <Card
                  title="Webhook receiver"
                  subtitle="Where the billing events land"
                >
                  <dl className="space-y-2.5 text-sm">
                    <Row label="Endpoint">
                      <span className="font-mono text-xs break-all text-slate-600">
                        {overview.receiver.url}
                      </span>
                    </Row>
                    <Row label="Registered">
                      {overview.receiver.registered ? (
                        <Badge tone="emerald">active</Badge>
                      ) : (
                        <Badge tone="rose">not registered</Badge>
                      )}
                    </Row>
                    <Row label="Events stored">
                      <span className="font-mono tabular-nums">
                        {overview.receiver.events_ingested}
                      </span>
                    </Row>
                  </dl>
                  {!overview.receiver.registered && (
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
                      Run <code className="font-mono">pnpm setup:webhook</code> to
                      register this endpoint and store its signing secret.
                    </p>
                  )}
                </Card>

                <Card
                  title="Live billing events"
                  subtitle="Signed deliveries, newest first"
                  action={<LiveDot />}
                  bodyClassName="pt-2"
                >
                  <EventLog
                    events={events}
                    showCustomer
                    compact
                    className="max-h-[26rem]"
                    emptyHint="Nothing delivered yet. A chat message produces an event within a second."
                  />
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </Shell>
  );
}

/**
 * Put a workspace on a different allowance. Each row is one real budget on
 * the platform, and saving calls the budgets API; nothing about recorded
 * spend changes, which is why raising a breached cap admits traffic again.
 */
function CapEditor({
  customerId,
  budgets,
  onSaved,
}: {
  customerId: number;
  budgets: BudgetView[];
  onSaved: (budgetName: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      budgets.map((budget) => [budget.id, String(budget.limit_usd)]),
    ),
  );
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  async function save(budget: BudgetView) {
    setSaving(budget.id);
    setFailure(null);
    try {
      await api.post(`/api/customers/${customerId}/budgets/${budget.id}/limit`, {
        limit_usd: Number(drafts[budget.id]),
      });
      await onSaved(budget.name.replace(/^.*?(hard cap|soft cap|allowance)$/, "$1"));
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "The cap did not change."),
      );
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mt-4 space-y-3 rounded-lg bg-slate-50 p-4">
      {failure && <ErrorNote error={failure} />}
      {budgets.map((budget) => (
        <div key={budget.id} className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
            {budget.name}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-slate-500">$</span>
            <input
              className="w-28 rounded-lg border-0 bg-white px-2.5 py-1.5 text-right font-mono text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600"
              value={drafts[budget.id] ?? ""}
              inputMode="decimal"
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [budget.id]: event.target.value,
                }))
              }
            />
          </div>
          <Button
            variant="secondary"
            loading={saving === budget.id}
            disabled={
              drafts[budget.id] === undefined ||
              Number(drafts[budget.id]) === budget.limit_usd
            }
            onClick={() => save(budget)}
          >
            Save
          </Button>
        </div>
      ))}
    </div>
  );
}

function Tile({
  label,
  value,
  foot,
}: {
  label: string;
  value: string;
  foot?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 font-mono text-2xl text-slate-900 tabular-nums">{value}</p>
      {foot && <p className="mt-0.5 text-xs text-slate-400">{foot}</p>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function LiveDot() {
  const { connected } = useLiveFeed();
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-500">
      <span
        className={
          connected
            ? "h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-500"
            : "h-1.5 w-1.5 rounded-full bg-slate-300"
        }
      />
      {connected ? "live" : "offline"}
    </span>
  );
}
