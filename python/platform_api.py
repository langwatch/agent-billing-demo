"""Every call this app makes to the billing platform, in one place. The
facades come from the official SDK: provisioning, cap reads and period closes
are SDK calls, never hand-rolled HTTP.

Two scopes are in play and they authenticate differently, which the SDK hides:
virtual keys and budgets are project-scoped (the project id rides along),
webhook endpoints and spend analytics are organization-scoped.

Two calls do go over REST here, and both are gaps in the python SDK that the
TypeScript SDK already covers. Each is marked SDK-GAP below with what to
replace it with once the python side ships the method.
"""

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
import langwatch

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
PROJECT_ID = os.environ.get("LANGWATCH_PROJECT_ID", "")

CAPS = {"hard_usd": "5.00", "soft_usd": "2.50", "per_seat_usd": "1.00"}

#: The listing endpoint pages, and a page is not the answer. 100 is the
#: server's ceiling per request; the walk below is what makes the result
#: complete.
PAGE_SIZE = 100


def _rest() -> httpx.Client:
    """The REST client for the two calls the python SDK does not cover.
    Same auth as the SDK: an org key plus the project id header."""
    headers = {"X-Auth-Token": API_KEY}
    if PROJECT_ID:
        headers["X-Project-Id"] = PROJECT_ID
    return httpx.Client(base_url=BASE_URL, headers=headers, timeout=30)


# ── Provisioning ────────────────────────────────────────────────────────


@dataclass
class ProvisionedTenant:
    virtual_key_id: str
    virtual_key_secret: str
    hard_cap_budget_id: str
    soft_cap_budget_id: str
    per_user_budget_id: str


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
    """
    admin = langwatch.gateway_admin
    minted = admin.create_virtual_key(
        name=name, description=f"Tenant key for {name} (ACME Agents signup)"
    )
    virtual_key_id = minted["virtual_key"]["id"]

    hard_cap = admin.create_budget(
        scope={"kind": "virtual_key", "virtual_key_id": virtual_key_id},
        name=f"{name} hard cap",
        window="manual",
        limit_usd=CAPS["hard_usd"],
        on_breach="block",
    )
    soft_cap = admin.create_budget(
        scope={"kind": "virtual_key", "virtual_key_id": virtual_key_id},
        name=f"{name} soft cap",
        window="manual",
        limit_usd=CAPS["soft_usd"],
        on_breach="warn",
    )
    per_user = admin.create_budget(
        scope={"kind": "attributed_user", "anchor_virtual_key_id": virtual_key_id},
        name=f"{name} per-seat allowance",
        window="month",
        limit_usd=CAPS["per_seat_usd"],
        on_breach="block",
    )

    return ProvisionedTenant(
        virtual_key_id=virtual_key_id,
        virtual_key_secret=minted["secret"],
        hard_cap_budget_id=hard_cap["id"],
        soft_cap_budget_id=soft_cap["id"],
        per_user_budget_id=per_user["id"],
    )


def revoke_virtual_key(virtual_key_id: str) -> None:
    """Hand a key back for good. Used when a sign-up minted one and then lost
    the race to claim the name, so the key has no owner and never will.

    SDK-GAP: the python SDK offers ``disable_virtual_key`` (reversible) but no
    ``revoke``. The TypeScript SDK's ``virtualKeys.revoke(id)`` is this call.
    An orphan wants the permanent one, so it goes over REST until the python
    facade grows it.
    """
    with _rest() as rest:
        response = rest.post(f"/api/gateway/v1/virtual-keys/{virtual_key_id}/revoke")
        response.raise_for_status()


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
    current_period_started_at: str
    resets_at: str


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

    SDK-GAP: ``langwatch.gateway_admin.list_budgets()`` reads ONE page and
    accepts neither a cursor nor a limit, so on an organization with more
    budgets than the server's page size it silently drops the rest and a
    tenant's caps go missing from the meter. The TypeScript SDK's
    ``budgets.list()`` walks the cursor for you. Swap the walk below for the
    facade once the python SDK does the same.
    """
    rows: List[Dict[str, Any]] = []
    spend_available = True
    cursor: Optional[str] = None
    with _rest() as rest:
        while True:
            params: Dict[str, Any] = {"limit": PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor
            response = rest.get("/api/gateway/v1/budgets", params=params)
            response.raise_for_status()
            page = response.json()
            rows.extend(page["data"])
            # One page that could not total spend makes the whole listing's
            # spend unreal, so the set's honest answer is the pessimistic one.
            spend_available = spend_available and bool(page.get("spend_available"))
            cursor = page.get("next_cursor")
            if not cursor:
                break

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
    return langwatch.gateway_admin.reset_budget(budget_id, reason=reason)


def set_budget_limit(budget_id: str, limit_usd: str) -> Dict[str, Any]:
    """Move a customer onto a different allowance. Only the limit changes; the
    window and the scope are fixed at creation, and recorded spend is never
    touched, so raising a cap admits traffic again without rewriting history.

    SDK-GAP: the python SDK has no ``update_budget``. The TypeScript SDK's
    ``budgets.update(id, {limit_usd})`` is this exact call. Swap it in once
    the python facade grows the method.
    """
    with _rest() as rest:
        response = rest.patch(
            f"/api/gateway/v1/budgets/{budget_id}", json={"limit_usd": limit_usd}
        )
        response.raise_for_status()
        return response.json()["budget"]


# ── Spend analytics ─────────────────────────────────────────────────────


def seat_spend_since(from_iso: str) -> Dict[str, int]:
    """Spend per end user for the current allowance period, in one call, as
    integer nano-USD.

    The per-seat allowance is what the gateway enforces, so the meter has to
    render the platform's own figure. Reading it from the local webhook ledger
    instead would let a seat sit at "37% used" on screen while the gateway is
    already refusing its requests.

    Windows are epoch milliseconds on every spend route.
    """
    try:
        start = int(datetime.fromisoformat(from_iso.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        start = _now_ms() - 30 * 86_400_000
    rows = langwatch.spend_events.summaries(
        group_by="end_user", from_ms=start, to_ms=_now_ms(), limit=1000
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
