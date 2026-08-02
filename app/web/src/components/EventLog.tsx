import { useState } from "react";
import type { BillingEventView } from "../api";
import { Badge, Card, cx, money, relativeTime } from "./ui";

/**
 * The developer-visible panel. The audience for this demo reads JSON, so
 * every envelope stays inspectable, but it lives in one polished panel
 * instead of being the whole product.
 */
const TYPE_TONE: Record<string, "brand" | "amber" | "rose" | "sky" | "neutral"> = {
  "gateway.request.completed": "brand",
  "gateway.request.settled": "sky",
  "gateway.budget.threshold_crossed": "amber",
  "gateway.budget.breached": "rose",
  "gateway.virtual_key.disabled": "rose",
  "gateway.virtual_key.enabled": "sky",
};

export function EventLog({
  events,
  emptyHint,
  className,
  showCustomer,
  compact,
}: {
  events: BillingEventView[];
  emptyHint: string;
  className?: string;
  showCustomer?: boolean;
  /** Drops the timestamp column so the rows fit a narrow sidebar. */
  compact?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 px-6 py-8 text-center">
        <p className="text-sm text-slate-500">{emptyHint}</p>
      </div>
    );
  }

  return (
    <ul className={cx("scroll-slim divide-y divide-slate-100 overflow-y-auto", className)}>
      {events.map((event) => (
        <EventRow
          key={event.event_id}
          event={event}
          showCustomer={showCustomer}
          compact={compact}
        />
      ))}
    </ul>
  );
}

function EventRow({
  event,
  showCustomer,
  compact,
}: {
  event: BillingEventView;
  showCustomer?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="animate-rise">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-1 py-2.5 text-left transition hover:bg-slate-50"
      >
        <Badge tone={TYPE_TONE[event.type] ?? "neutral"} className="font-mono">
          {event.type.replace("gateway.", "")}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {showCustomer && event.customer_name ? `${event.customer_name} · ` : ""}
          {event.end_user_id ?? "no seat"}
          {event.model ? ` · ${event.model}` : ""}
        </span>
        {event.status === "error" ? (
          <Badge tone="rose" className="shrink-0 font-mono">
            {event.error_class ?? "error"}
          </Badge>
        ) : event.cost_usd !== null ? (
          <span className="shrink-0 font-mono text-xs text-slate-700 tabular-nums">
            {money(event.cost_usd)}
          </span>
        ) : event.type === "gateway.request.settled" ? (
          <Badge tone="sky" className="shrink-0">
            cost pending
          </Badge>
        ) : null}
        {!compact && (
          <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">
            {relativeTime(event.received_at)}
          </span>
        )}
        <svg
          className={cx(
            "h-4 w-4 shrink-0 text-slate-400 transition",
            open && "rotate-90",
          )}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M7.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L10.94 10 7.22 6.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <pre className="scroll-slim mb-3 max-h-72 overflow-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-slate-200">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </li>
  );
}
