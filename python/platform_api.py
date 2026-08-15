"""Every call this app makes to the billing platform, in one place. The
facades come from the official SDK: provisioning, cap reads, period closes and
spend analytics are SDK calls, never hand-rolled HTTP.

Two scopes are in play and they authenticate differently, which the SDK hides:
virtual keys and budgets are project-scoped (the project id rides along),
webhook endpoints, spend analytics, teams and projects are
organization-scoped.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import langwatch

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
PROJECT_ID = os.environ.get("LANGWATCH_PROJECT_ID", "")

#: What a signup provisions.
#:
#: - ``virtual_key``: one virtual key per customer, under the control
#:   project. The key is the whole tenant boundary and every cap hangs off it.
#: - ``project``: a LangWatch project per customer, under one stable team,
#:   with the key scoped to that project and pointed at it, so each customer's
#:   traces and costs land in a project of their own.
#:
#: LANGWATCH_PROJECT_ID stays the control project either way: it is what the
#: virtual key and budget calls authenticate as. A customer's own project is
#: data in those request bodies, never a change of who is calling.
PROVISION_MODE = (
    "project" if os.environ.get("LANGWATCH_PROVISION_MODE") == "project" else "virtual_key"
)

#: The team every customer project goes under. ``pnpm setup:team`` fills it in.
TEAM_ID = os.environ.get("LANGWATCH_TEAM_ID", "")

#: What a customer project is tagged with: the stack that produces its traces,
#: which is this app, not whatever the customer builds on top of it.
PROJECT_LANGUAGE = "python"
PROJECT_FRAMEWORK = "openai"

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
    #: The customer's own project in ``project`` mode; None otherwise.
    project_id: Optional[str]
    #: True when this signup created that project rather than finding it.
    project_created: bool


def _signup_key(name: str, resource: str) -> str:
    """The idempotency key for one resource of one signup.

    Derived from the customer's identity, so a retried or double-submitted
    signup asks for the same four resources and gets the same four back
    instead of a second set. The name is normalized the same way the workspace
    uniqueness check normalizes it: case and surrounding space are not what
    makes two signups different.

    The mode namespaces the keys, because it decides what a signup creates:
    the same customer provisioned the other way asks for different resources,
    and a key that meant one body must never be replayed for another.
    """
    identity = "-".join(name.strip().lower().split())
    mode = "project:" if PROVISION_MODE == "project" else ""
    return f"acme-agents:signup:{mode}{identity}:{resource}"


def _find_project_by_name(name: str) -> Optional[Dict[str, Any]]:
    """The project with this exact name, or None.

    ``list()`` walks every page, so a match that landed on the second page
    still counts; ``list_page()`` is the single-page call, and a page is not
    the answer here.
    """
    return next(
        (project for project in langwatch.projects.list() if project["name"] == name),
        None,
    )


def ensure_customer_project(name: str) -> Tuple[str, bool]:
    """The customer's own project, created once and found again after that.

    Returns the project id and whether this call created it.

    Project creates take no idempotency key, so the name carries that weight
    instead: a retried signup finds the project the first attempt made rather
    than stacking a second one beside it. The name is the customer's own, the
    same identity the workspace uniqueness check and the idempotency keys are
    derived from, and the listing never returns archived projects, so a
    customer that was rolled back is provisioned fresh.
    """
    if not TEAM_ID:
        raise RuntimeError(
            "LANGWATCH_TEAM_ID is not set. Run `pnpm setup:team` once before"
            " provisioning customers in project mode."
        )
    existing = _find_project_by_name(name)
    if existing:
        return existing["id"], False

    # The create also mints a service key for the new project. It is
    # deliberately not stored: the customer's runtime credential is the
    # virtual key, and one credential per tenant is the whole point.
    created = langwatch.projects.create(
        name=name,
        team_id=TEAM_ID,
        language=PROJECT_LANGUAGE,
        framework=PROJECT_FRAMEWORK,
    )
    return created["id"], True


def archive_project(project_id: str) -> None:
    """Archive a project this signup created and could not hand to anyone."""
    langwatch.projects.archive(project_id)


def provision_tenant(name: str) -> ProvisionedTenant:
    """The four calls a signup makes, or five in project mode.

    0. In ``project`` mode only: create the customer's own project under the
       team from LANGWATCH_TEAM_ID. Everything below then hangs off that
       project instead of off the key, and the key is scoped to it and sends
       its traces there, so the customer's traffic, spend and traces are one
       thing the platform separates rather than something this app filters.
    1. Mint a virtual key. The VK IS the tenant boundary in ``virtual_key``
       mode: its secret is the tenant's gateway credential, and every budget
       and spend row hangs off its id. The secret comes back exactly once;
       store it like a password.
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

    Those two properties depend on each other. An idempotency key covers the
    request BODY, so a retry that recomputes the anchor from the clock sends a
    different body under the same key and is refused as a mismatch rather than
    replayed. The anchor is therefore read from the virtual key the first call
    minted: it is the instant the tenant came into existence, and every retry
    gets the same key back and sends the same body.
    """
    replays: List[bool] = []

    def on_replay() -> None:
        replays.append(True)

    # In project mode the customer's project comes first: the key is scoped to
    # it and points its traces at it, and the caps are attached to it.
    project_id: Optional[str] = None
    project_created = False
    if PROVISION_MODE == "project":
        project_id, project_created = ensure_customer_project(name)

    key_scoping: Dict[str, Any] = (
        {
            "scopes": [{"scope_type": "project", "scope_id": project_id}],
            # Where this key's traces and costs land. Not a scope: it grants
            # the key nothing, it decides which project sees the traffic.
            "trace_project_id": project_id,
        }
        if project_id
        else {}
    )
    minted = langwatch.virtual_keys.create(
        name=name,
        description=f"Tenant key for {name} (ACME Agents signup)",
        idempotency_key=_signup_key(name, "virtual-key"),
        on_idempotent_replay=on_replay,
        **key_scoping,
    )
    virtual_key_id = minted["virtual_key"]["id"]
    # The tenant's own birth instant, and the same value on every retry.
    cycle_anchor_at = minted["virtual_key"]["created_at"]

    # What the caps hang off. A project cap covers every key that ever points
    # at that project, so in project mode the tenant boundary outlives any one
    # key; in virtual key mode the key IS the boundary.
    tenant_scope: Dict[str, Any] = (
        {"kind": "project", "project_id": project_id}
        if project_id
        else {"kind": "virtual_key", "virtual_key_id": virtual_key_id}
    )
    seat_scope: Dict[str, Any] = (
        {"kind": "attributed_user", "anchor_project_id": project_id}
        if project_id
        else {"kind": "attributed_user", "anchor_virtual_key_id": virtual_key_id}
    )

    hard_cap = langwatch.gateway_budgets.create(
        scope=tenant_scope,
        name=f"{name} hard cap",
        window="manual",
        limit_usd=CAPS["hard_usd"],
        on_breach="block",
        idempotency_key=_signup_key(name, "hard-cap"),
        on_idempotent_replay=on_replay,
    )
    soft_cap = langwatch.gateway_budgets.create(
        scope=tenant_scope,
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
        scope=seat_scope,
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
        project_id=project_id,
        project_created=project_created,
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
class BudgetsByAnchor:
    """Caps indexed by the id they hang off, which is the customer's project
    when it has one and its virtual key otherwise. Both are "the tenant" as
    far as a cap is concerned, so both land in the same map and a meter reads
    it with one lookup whichever way the customer was provisioned."""

    #: Tenant anchor id to the caps that apply to the whole tenant.
    per_tenant: Dict[str, List[BudgetSnapshot]]
    #: Tenant anchor id to the per-seat template anchored to it.
    per_seat_template: Dict[str, BudgetSnapshot]
    #: False when the platform could not total spend; show it as unknown.
    spend_available: bool


def _spend_available_across(rows: List[Dict[str, Any]]) -> bool:
    """Whether the platform could total spend for the caps just read. A row
    whose spend could not be totalled carries null there rather than a stale
    figure, so a null is the signal.

    Per-seat templates are exempt: one allowance per person has no single total
    to report, so their null says the question does not apply rather than that
    the answer failed. Counting them would leave every tenant that offers
    per-seat caps permanently reading as degraded. Each seat's own figure comes
    from the spend summaries.
    """
    return not any(
        row.get("scope_type") != "attributed_user" and row.get("spent_nano_usd") is None
        for row in rows
    )


def load_budgets() -> BudgetsByAnchor:
    """Read every cap once. One list call covers every tenant on screen, which
    is what the owner console needs and what keeps a customer dashboard to a
    single round trip.

    Money is taken as the integer nano-USD fields the rows carry, never parsed
    out of the decimal display strings beside them.

    ``list()`` walks the cursor to exhaustion, so this is the complete set of
    caps and not a first page; ``list_page()`` is the single-page call.
    """
    rows: List[Dict[str, Any]] = langwatch.gateway_budgets.list()
    spend_available = _spend_available_across(rows)

    per_tenant: Dict[str, List[BudgetSnapshot]] = {}
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
        # attributed_user rows are templates anchored to a virtual key or to a
        # project: one row that defines the allowance every seat of that
        # tenant gets. Either way the anchor is the scope id.
        if snapshot.scope_type == "attributed_user":
            per_seat_template[snapshot.scope_id] = snapshot
        elif snapshot.scope_type in ("virtual_key", "project"):
            per_tenant.setdefault(snapshot.scope_id, []).append(snapshot)

    # Blocking caps first, then the widest limit, so the meter leads with the
    # number that actually stops traffic.
    for caps in per_tenant.values():
        caps.sort(key=lambda cap: (cap.on_breach != "block", -(cap.limit_nano_usd or 0)))

    return BudgetsByAnchor(per_tenant, per_seat_template, spend_available)


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


def budgets_for_tenant(
    data: BudgetsByAnchor, tenant_anchor_id: str
) -> Tuple[List[BudgetSnapshot], Optional[BudgetSnapshot]]:
    """The caps that apply to a workspace, resolved from the platform rather
    than from the ids stored at sign-up. Budgets live on LangWatch, so the
    platform is the source of truth: a cap added or replaced there is managed
    here too, and a workspace provisioned by an earlier revision still gets
    every one of its caps reset."""
    return data.per_tenant.get(tenant_anchor_id, []), data.per_seat_template.get(
        tenant_anchor_id
    )
