"""Every call this app makes to the billing platform, in one place. The
facades come from the official SDK: provisioning, cap reads, period closes and
spend analytics are SDK calls, never hand-rolled HTTP.

Two scopes are in play and they authenticate differently, which the SDK hides:
virtual keys and budgets are project-scoped (the project id rides along),
webhook endpoints and spend analytics are organization-scoped.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import langwatch

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
PROJECT_ID = os.environ.get("LANGWATCH_PROJECT_ID", "")

CAPS = {"hard_usd": "5.00", "soft_usd": "2.50", "per_seat_usd": "1.00"}


# ── Provisioning ────────────────────────────────────────────────────────


@dataclass
class ProvisionedTenant:
    virtual_key_id: str
    virtual_key_secret: str
    hard_cap_budget_id: str
    soft_cap_budget_id: str
    per_user_budget_id: str
    #: The instant the seat allowance's monthly cycle is anchored to.
    cycle_anchor_at: str
    #: True when the platform replayed an earlier signup instead of creating.
    replayed: bool


def _signup_key(name: str, resource: str) -> str:
    """The idempotency key for one resource of one signup.

    Derived from the customer's identity, so a retried or double-submitted
    signup asks for the same four resources and gets the same four back
    instead of a second set. The name is normalized the same way the workspace
    uniqueness check normalizes it: case and surrounding space are not what
    makes two signups different.
    """
    identity = "-".join(name.strip().lower().split())
    return f"acme-agents:signup:{identity}:{resource}"


def provision_tenant(name: str) -> ProvisionedTenant:
    """The four calls a signup makes.

    1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
       tenant's gateway credential, and every budget and spend row hangs off
       its id. The secret comes back exactly once; store it like a password.
    2. A hard cap: ``on_breach: "block"`` on a ``manual`` window. A manual
       window accrues until an explicit reset, which is how a billing period
       closes without ever mutating recorded spend.
    3. A soft cap: ``on_breach: "warn"`` at half the limit. Crossing it emits
       ``gateway.budget.threshold_crossed`` and stamps a warning header on
       responses; traffic keeps flowing.
    4. An attributed-user template: ONE budget row that caps every current and
       future seat of this tenant. Nothing is provisioned per seat; buckets
       appear lazily on first spend. Fail-closed: once the template is active,
       requests without an end-user id are rejected with ``end_user_required``
       instead of passing uncapped.

    Every enum on this surface is lowercase snake, on the way in and on the
    way out. Uppercase is rejected, so there is exactly one spelling of a
    scope kind, a window or a breach action to match on anywhere.

    Two properties make this safe to retry, and both come from the SDK rather
    than from bookkeeping here:

    - **Idempotency.** Every create carries a key derived from the customer's
      identity, so a double-submitted signup returns the SAME virtual key and
      the SAME budgets. A replay is reported back rather than hidden, because
      the second caller still needs to know it did not mint anything.
    - **An anchored cycle.** The seat allowance's month window starts at the
      instant the customer signed up, not on the calendar first. A customer
      who starts on the 30th gets a period that runs to the 30th.
    """
    # One instant for the whole signup: the anchor the customer's billing
    # period is measured from.
    cycle_anchor_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    replays: List[bool] = []

    def on_replay() -> None:
        replays.append(True)

    minted = langwatch.virtual_keys.create(
        name=name,
        description=f"Tenant key for {name} (ACME Agents signup)",
        idempotency_key=_signup_key(name, "virtual-key"),
        on_idempotent_replay=on_replay,
    )
    virtual_key_id = minted["virtual_key"]["id"]

    hard_cap = langwatch.gateway_budgets.create(
        scope={"kind": "virtual_key", "virtual_key_id": virtual_key_id},
        name=f"{name} hard cap",
        window="manual",
        limit_usd=CAPS["hard_usd"],
        on_breach="block",
        idempotency_key=_signup_key(name, "hard-cap"),
        on_idempotent_replay=on_replay,
    )
    soft_cap = langwatch.gateway_budgets.create(
        scope={"kind": "virtual_key", "virtual_key_id": virtual_key_id},
        name=f"{name} soft cap",
        window="manual",
        limit_usd=CAPS["soft_usd"],
        on_breach="warn",
        idempotency_key=_signup_key(name, "soft-cap"),
        on_idempotent_replay=on_replay,
    )
    # A cycle anchor belongs to a windowed budget: a manual window accrues
    # until an explicit reset, and the platform rejects an anchor on one.
    per_user = langwatch.gateway_budgets.create(
        scope={"kind": "attributed_user", "anchor_virtual_key_id": virtual_key_id},
        name=f"{name} per-seat allowance",
        window="month",
        limit_usd=CAPS["per_seat_usd"],
        on_breach="block",
        cycle_anchor_at=cycle_anchor_at,
        idempotency_key=_signup_key(name, "seat-allowance"),
        on_idempotent_replay=on_replay,
    )

    return ProvisionedTenant(
        virtual_key_id=virtual_key_id,
        virtual_key_secret=minted["secret"],
        hard_cap_budget_id=hard_cap["id"],
        soft_cap_budget_id=soft_cap["id"],
        per_user_budget_id=per_user["id"],
        cycle_anchor_at=per_user.get("cycle_anchor_at") or cycle_anchor_at,
        replayed=bool(replays),
    )


def revoke_virtual_key(virtual_key_id: str) -> None:
    """Hand a key back for good. Used when a sign-up minted one and then lost
    the race to claim the name, so the key has no owner and never will.

    Revoking is the permanent one; ``disable`` is the reversible one, and an
    orphan is not coming back."""
    langwatch.virtual_keys.revoke(virtual_key_id)


# ── Caps ────────────────────────────────────────────────────────────────


@dataclass
class BudgetSnapshot:
    id: str
    name: str
    scope_type: str
    scope_id: str
    window: str
    on_breach: str
    #: Canonical integer limit, nano-USD. Null past the safe integer range.
    limit_nano_usd: Optional[int]
    #: Canonical integer spend, nano-USD. Null when the platform could not
    #: total spend for this period, which is not the same as zero and must not
    #: be rendered as a figure.
    spent_nano_usd: Optional[int]
    #: The current cycle's boundaries, as the platform enforces them.
    current_period_started_at: str
    resets_at: str
    #: Set when the cycle is anchored to an instant of this tenant's own,
    #: which is what makes a period run from the day they signed up rather
    #: than from the calendar first. None on a calendar-aligned or manual
    #: budget.
    cycle_anchor_at: Optional[str]


@dataclass
class BudgetsByKey:
    #: Virtual key id to the caps that apply to the whole tenant.
    per_key: Dict[str, List[BudgetSnapshot]]
    #: Virtual key id to the per-seat template anchored to it.
    per_seat_template: Dict[str, BudgetSnapshot]
    #: False when the platform could not total spend; show it as unknown.
    spend_available: bool


def load_budgets() -> BudgetsByKey:
    """Read every cap once. One list call covers every tenant on screen, which
    is what the owner console needs and what keeps a customer dashboard to a
    single round trip.

    Money is taken as the integer nano-USD fields the rows carry, never parsed
    out of the decimal display strings beside them.

    ``list()`` walks the cursor to exhaustion, so this is the complete set of
    caps and not a first page; ``list_page()`` is the single-page call. Its
    ``spend_available`` is the pessimistic answer across every page walked,
    because one page that could not total spend makes the whole listing's
    spend unreal.
    """
    listing = langwatch.gateway_budgets.list()
    rows: List[Dict[str, Any]] = listing["data"]
    spend_available = bool(listing["spend_available"])

    per_key: Dict[str, List[BudgetSnapshot]] = {}
    per_seat_template: Dict[str, BudgetSnapshot] = {}
    for row in rows:
        if row.get("archived_at"):
            continue
        snapshot = BudgetSnapshot(
            id=row["id"],
            name=row["name"],
            scope_type=row["scope_type"],
            scope_id=row["scope_id"],
            window=row["window"],
            on_breach=row["on_breach"],
            limit_nano_usd=row.get("limit_nano_usd"),
            spent_nano_usd=row.get("spent_nano_usd"),
            current_period_started_at=row.get("current_period_started_at") or "",
            resets_at=row.get("resets_at") or "",
            cycle_anchor_at=row.get("cycle_anchor_at"),
        )
        # attributed_user rows are templates anchored to a virtual key: one row
        # that defines the allowance every seat of that tenant gets.
        if snapshot.scope_type == "attributed_user":
            per_seat_template[snapshot.scope_id] = snapshot
        elif snapshot.scope_type == "virtual_key":
            per_key.setdefault(snapshot.scope_id, []).append(snapshot)

    # Blocking caps first, then the widest limit, so the meter leads with the
    # number that actually stops traffic.
    for caps in per_key.values():
        caps.sort(key=lambda cap: (cap.on_breach != "block", -(cap.limit_nano_usd or 0)))

    return BudgetsByKey(per_key, per_seat_template, spend_available)


def reset_budget(budget_id: str, reason: str) -> Dict[str, Any]:
    """Close a billing period: move the manual window boundary, keep the
    books."""
    return langwatch.gateway_budgets.reset(budget_id, reason=reason)


def set_budget_limit(budget_id: str, limit_usd: str) -> Dict[str, Any]:
    """Move a customer onto a different allowance. Only the limit changes; the
    window, the scope and the cycle anchor are fixed at creation, and recorded
    spend is never touched, so raising a cap admits traffic again without
    rewriting history.
    """
    return langwatch.gateway_budgets.update(budget_id, limit_usd=limit_usd)


# ── Spend analytics ─────────────────────────────────────────────────────


def seat_spend_since(from_iso: str) -> Dict[str, int]:
    """Spend per end user for the current allowance period, in one call, as
    integer nano-USD.

    The per-seat allowance is what the gateway enforces, so the meter has to
    render the platform's own figure. Reading it from the local webhook ledger
    instead would let a seat sit at "37% used" on screen while the gateway is
    already refusing its requests.

    Windows are epoch milliseconds on every spend route.

    ``iter_summaries`` is lazy and walks the cursor to exhaustion, so a tenant
    whose seats land on the second page is still metered. ``summaries_page``
    is the single-page call, and a page is not the answer here.
    """
    try:
        start = int(datetime.fromisoformat(from_iso.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        start = _now_ms() - 30 * 86_400_000
    rows = langwatch.spend_events.iter_summaries(
        group_by="end_user", from_ms=start, to_ms=_now_ms()
    )
    return {row["key"]: row["cost"]["nano_usd"] for row in rows}


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


# ── The app's own receiver ──────────────────────────────────────────────


@dataclass
class ReceiverStatus:
    registered: bool
    url: str
    endpoint_id: Optional[str]
    status: Optional[str]
    last_success_at: Optional[str]
    last_failure_at: Optional[str]


def receiver_status(url: str) -> ReceiverStatus:
    """Whether this app's own webhook endpoint is registered and healthy. The
    owner console shows it, because a demo whose meters stop moving is almost
    always a receiver that was never registered."""
    mine = next(
        (
            endpoint
            for endpoint in langwatch.webhooks.list()
            if endpoint.get("url") == url
        ),
        None,
    )
    return ReceiverStatus(
        registered=mine is not None,
        url=url,
        endpoint_id=mine.get("id") if mine else None,
        status=mine.get("status") if mine else None,
        last_success_at=mine.get("last_success_at") if mine else None,
        last_failure_at=mine.get("last_failure_at") if mine else None,
    )


def budgets_for_key(
    data: BudgetsByKey, virtual_key_id: str
) -> Tuple[List[BudgetSnapshot], Optional[BudgetSnapshot]]:
    """The caps that apply to a workspace, resolved from the platform rather
    than from the ids stored at sign-up. Budgets live on LangWatch, so the
    platform is the source of truth: a cap added or replaced there is managed
    here too, and a workspace provisioned by an earlier revision still gets
    every one of its caps reset."""
    return data.per_key.get(virtual_key_id, []), data.per_seat_template.get(
        virtual_key_id
    )
