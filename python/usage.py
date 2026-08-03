"""What the meters render. Caps and tenant spend are read back from LangWatch,
and the request-level detail comes from the billing events this app's own
webhook receiver ingested. Two independent sources for the same money, which
is exactly the property a rebilling platform wants.

The shapes below are the browser app's wire contract, identical to the
TypeScript twin's ``app/src/usage.ts``.
"""

import logging
import sqlite3
from typing import Any, Dict, List, Optional, Sequence

from money import nano_to_usd, nano_to_usd_or_none
from platform_api import BudgetSnapshot, BudgetsByKey, load_budgets, seat_spend_since

log = logging.getLogger("acme.usage")

# The winning row per gateway request. Delivery is at-least-once and a
# `completed` event supersedes the `settled` one it answers, so the choice is
# made at read time: rank completed first, take one row per request, never sum
# a pair.
WINNING_EVENTS = """
  SELECT event_id, gateway_request_id, virtual_key_id, end_user_id, model, status,
         cost_nano_usd, input_tokens, output_tokens, occurred_at,
         ROW_NUMBER() OVER (
           PARTITION BY gateway_request_id
           ORDER BY CASE WHEN type = 'gateway.request.completed' THEN 0 ELSE 1 END,
                    occurred_at DESC
         ) AS pick
  FROM billing_events
  WHERE type LIKE 'gateway.request.%' AND gateway_request_id IS NOT NULL
"""


def ledger_totals(conn: sqlite3.Connection, virtual_key_id: str) -> Dict[str, Any]:
    totals = conn.execute(
        f"""SELECT COUNT(*) AS requests,
                   COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(CASE WHEN cost_nano_usd IS NULL THEN 1 ELSE 0 END), 0)
                       AS awaiting_cost
            FROM ({WINNING_EVENTS}) WHERE pick = 1 AND virtual_key_id = ?""",
        (virtual_key_id,),
    ).fetchone()

    by_seat = conn.execute(
        f"""SELECT COALESCE(end_user_id, '') AS end_user_id,
                   COUNT(*) AS requests,
                   COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd
            FROM ({WINNING_EVENTS}) WHERE pick = 1 AND virtual_key_id = ?
            GROUP BY COALESCE(end_user_id, '')
            ORDER BY cost_nano_usd DESC""",
        (virtual_key_id,),
    ).fetchall()

    # SQLite sums the nano-USD integers; the dollar figure is derived once,
    # here, for the screen.
    return {
        "requests": totals["requests"],
        "cost_nano_usd": totals["cost_nano_usd"],
        "cost_usd": nano_to_usd(totals["cost_nano_usd"]),
        "input_tokens": totals["input_tokens"],
        "output_tokens": totals["output_tokens"],
        "awaiting_cost": totals["awaiting_cost"],
        "by_seat": [
            {
                "end_user_id": row["end_user_id"],
                "requests": row["requests"],
                "cost_nano_usd": row["cost_nano_usd"],
                "cost_usd": nano_to_usd(row["cost_nano_usd"]),
            }
            for row in by_seat
        ],
    }


def _percent_of(spend_nano: Optional[int], limit_nano: Optional[int]) -> Optional[float]:
    """Percent of an allowance used, from the integers. Null when unknowable."""
    if spend_nano is None or limit_nano is None or limit_nano <= 0:
        return None
    return (spend_nano / limit_nano) * 100


def _to_view(budget: BudgetSnapshot) -> Dict[str, Any]:
    return {
        "id": budget.id,
        "name": budget.name,
        "scope": budget.scope_type,
        "window": budget.window,
        "on_breach": budget.on_breach,
        # Canonical integer figures. These are the money; sum and compare
        # these.
        "limit_nano_usd": budget.limit_nano_usd,
        "spend_nano_usd": budget.spent_nano_usd,
        # Display only, converted once at this boundary. Null stays null all
        # the way to the screen, where it renders as unknown rather than zero.
        "limit_usd": nano_to_usd_or_none(budget.limit_nano_usd),
        "spend_usd": nano_to_usd_or_none(budget.spent_nano_usd),
        "percent": _percent_of(budget.spent_nano_usd, budget.limit_nano_usd),
    }


def usage_for(
    conn: sqlite3.Connection,
    *,
    virtual_key_id: str,
    seats: Sequence[str],
    budget_data: Optional[BudgetsByKey],
    seat_spend: Optional[Dict[str, int]],
    degraded: Optional[str],
) -> Dict[str, Any]:
    """Build one tenant's meter. ``budget_data`` is passed in so the owner
    console can read every tenant's caps with a single platform call."""
    ledger = ledger_totals(conn, virtual_key_id)
    caps = budget_data.per_key.get(virtual_key_id, []) if budget_data else []
    template = budget_data.per_seat_template.get(virtual_key_id) if budget_data else None

    budgets = [_to_view(cap) for cap in caps]
    if not degraded and budget_data and not budget_data.spend_available:
        degraded = "the platform could not total spend for this period"
    if not degraded and budget_data and not budgets:
        degraded = "no caps are attached to this workspace yet"

    # The per-seat template defines one allowance that every seat gets. Both
    # the limit and the spend come from the platform, because that is the
    # figure the gateway enforces against; the local ledger is the fallback
    # when spend analytics are unavailable.
    # Both maps are integer nano-USD, so the platform figure and the local
    # fallback are the same unit and never silently mix scales.
    ledger_by_seat = {row["end_user_id"]: row["cost_nano_usd"] for row in ledger["by_seat"]}
    spend_by_seat = seat_spend if seat_spend is not None else ledger_by_seat
    # Which seats belong to this workspace is the app's own question: the
    # seats it provisioned, plus any that show up in its own ledger. The
    # platform spend map is organization-wide and is only ever read through
    # these ids, never enumerated.
    seat_ids = [seat for seat in dict.fromkeys([*seats, *ledger_by_seat]) if seat]

    per_user_budgets: List[Dict[str, Any]] = []
    if template:
        for seat in seat_ids:
            spend_nano = spend_by_seat.get(seat, ledger_by_seat.get(seat, 0))
            per_user_budgets.append(
                {
                    "id": template.id,
                    "name": template.name,
                    "scope": template.scope_type,
                    "window": template.window,
                    "on_breach": template.on_breach,
                    "limit_nano_usd": template.limit_nano_usd,
                    "spend_nano_usd": spend_nano,
                    "limit_usd": nano_to_usd_or_none(template.limit_nano_usd),
                    "spend_usd": nano_to_usd(spend_nano),
                    "percent": _percent_of(spend_nano, template.limit_nano_usd),
                    "end_user_id": seat,
                }
            )

    primary = next(
        (budget for budget in budgets if budget["on_breach"] == "block"),
        budgets[0] if budgets else None,
    )
    return {
        "virtual_key_id": virtual_key_id,
        "budgets": budgets,
        "per_user_budgets": per_user_budgets,
        "ledger": ledger,
        "primary": primary,
        "source": "ledger" if degraded else "langwatch",
        "degraded": degraded,
    }


def load_budgets_or_degrade() -> Dict[str, Any]:
    """Read every cap once, and if the platform is unreachable say so instead
    of failing the page: the local ledger still has the request-level truth."""
    try:
        return {"data": load_budgets(), "degraded": None}
    except Exception as error:
        log.error("[langwatch:budgets.list] %s", error)
        return {"data": None, "degraded": "the LangWatch API is not reachable right now"}


def load_seat_spend(budget_data: Optional[BudgetsByKey]) -> Optional[Dict[str, int]]:
    """Per-seat spend for the oldest allowance period on screen, in one call,
    as integer nano-USD. Best effort: without it the meters fall back to the
    local ledger, which is complete but only as fresh as the last webhook
    delivery."""
    if not budget_data or not budget_data.per_seat_template:
        return None
    period_starts = sorted(
        template.current_period_started_at
        for template in budget_data.per_seat_template.values()
        if template.current_period_started_at
    )
    if not period_starts:
        return None
    try:
        return seat_spend_since(period_starts[0])
    except Exception as error:
        log.error("[langwatch:spend-summaries] %s", error)
        return None
