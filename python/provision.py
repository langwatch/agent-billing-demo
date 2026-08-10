"""Provision one tenant on LangWatch through the official python SDK
(``langwatch``): the four calls a customer signup makes, or five when
LANGWATCH_PROVISION_MODE is ``project``.

0. In ``project`` mode only: create the tenant's own project under the team
   from LANGWATCH_TEAM_ID, and hang everything below off that project. The key
   is scoped to it and sends its traces there, so the tenant's traffic, spend
   and traces are separated by the platform rather than by a filter.
1. Mint a virtual key. The VK IS the tenant boundary in ``virtual_key`` mode:
   its secret is the tenant's gateway credential, and every budget and spend
   row hangs off its id. The secret is returned exactly once; store it like a
   password.
2. A hard cap: ``on_breach: "block"``, ``manual`` window. A manual window
   accrues until an explicit reset (``POST /budgets/:id/reset``), which is how
   a billing period closes without ever mutating recorded spend.
3. A soft cap: ``on_breach: "warn"`` at a lower limit. Crossing it emits
   ``gateway.budget.threshold_crossed`` and stamps a warning header on
   responses; traffic keeps flowing.
4. An attributed-user template: ONE budget row that caps every current and
   future end user of this tenant. Nothing is provisioned per user; buckets
   appear lazily on first spend. Fail-closed: once this template is active,
   requests without an end-user id are rejected (``end_user_required``)
   instead of passing uncapped.

Plus, once per receiver (not per tenant): register the webhook endpoint and
store its signing secret.

Every enum on this surface is lowercase snake, on the way in and on the way
out: scope kinds, windows, breach actions and key statuses. Uppercase is
rejected, so there is exactly one spelling of each to send and to match on.

Every create carries an idempotency key derived from the tenant's identity, so
a retry after a timeout returns the resources the first attempt made instead of
a duplicate set, and the monthly allowance carries a cycle anchor so the
tenant's period runs from the day it signed up.

Usage::

    python provision.py --tenant "ACME Corp"
    python provision.py --register-webhook http://localhost:4102/webhooks/langwatch
"""

import env  # noqa: F401  (loads .env before anything reads it)

import argparse
import json
import os
import sys
from typing import Optional

import langwatch

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
if not API_KEY:
    print("LANGWATCH_API_KEY is not set.")
    sys.exit(1)

# What a signup provisions: one virtual key per tenant under the control
# project (`virtual_key`), or a project per tenant with the key scoped to it
# (`project`). LANGWATCH_PROJECT_ID stays the control project either way,
# because it is what these calls authenticate as; a tenant's own project is
# data in the request bodies.
PROVISION_MODE = (
    "project" if os.environ.get("LANGWATCH_PROVISION_MODE") == "project" else "virtual_key"
)
# The team every tenant project goes under. `pnpm setup:team` fills it in.
TEAM_ID = os.environ.get("LANGWATCH_TEAM_ID", "")
# What a tenant project is tagged with: the stack that produces its traces.
PROJECT_LANGUAGE = "python"
PROJECT_FRAMEWORK = "openai"

# The official python SDK: one setup, then the facades. The org key
# authorizes; LANGWATCH_PROJECT_ID (read by the virtual key and budget
# facades) says which project provisioned objects live under. Teams and
# projects are organization-scoped and take no project id at all.
langwatch.setup(api_key=API_KEY, endpoint_url=BASE_URL, skip_open_telemetry_setup=True)


def _signup_key(name: str, resource: str) -> str:
    """The key one resource of one signup is created under. Derived from the
    tenant's identity, so running this twice for the same tenant asks for the
    same resources and gets the same ones back rather than a second set. The
    mode namespaces the keys, because it decides what a signup creates."""
    identity = "-".join(name.strip().lower().split())
    mode = "project:" if PROVISION_MODE == "project" else ""
    return f"acme-agents:signup:{mode}{identity}:{resource}"


def ensure_tenant_project(name: str) -> tuple[str, bool]:
    """The tenant's own project, created once and found again after that.

    Project creates take no idempotency key, so the name carries that weight
    instead: a retried signup finds the project the first attempt made rather
    than stacking a second one beside it. ``list()`` walks every page and
    never returns archived projects, so a tenant that was rolled back is
    provisioned fresh.
    """
    if not TEAM_ID:
        raise RuntimeError(
            "LANGWATCH_TEAM_ID is not set. Run `pnpm setup:team` once before"
            " provisioning tenants in project mode."
        )
    existing = next(
        (project for project in langwatch.projects.list() if project["name"] == name),
        None,
    )
    if existing:
        return existing["id"], False
    # The create also mints a service key for the new project. It is
    # deliberately dropped: the tenant's runtime credential is the virtual key.
    created = langwatch.projects.create(
        name=name,
        team_id=TEAM_ID,
        language=PROJECT_LANGUAGE,
        framework=PROJECT_FRAMEWORK,
    )
    return created["id"], True


def provision_tenant(name: str) -> dict:
    replays: list[bool] = []

    def on_replay() -> None:
        replays.append(True)

    # In project mode the tenant's project comes first: the key is scoped to
    # it and points its traces at it, and the caps are attached to it.
    project_id: Optional[str] = None
    project_created = False
    if PROVISION_MODE == "project":
        project_id, project_created = ensure_tenant_project(name)

    key_scoping: dict = (
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
    vk_id = minted["virtual_key"]["id"]
    # The tenant's own birth instant, and the same value on every retry.
    cycle_anchor_at = minted["virtual_key"]["created_at"]

    # What the caps hang off. A project cap covers every key that ever points
    # at that project; in virtual key mode the key IS the boundary.
    tenant_scope: dict = (
        {"kind": "project", "project_id": project_id}
        if project_id
        else {"kind": "virtual_key", "virtual_key_id": vk_id}
    )
    seat_scope: dict = (
        {"kind": "attributed_user", "anchor_project_id": project_id}
        if project_id
        else {"kind": "attributed_user", "anchor_virtual_key_id": vk_id}
    )

    hard_cap = langwatch.gateway_budgets.create(
        scope=tenant_scope,
        name=f"{name} hard cap",
        window="manual",
        limit_usd="5.00",
        on_breach="block",
        idempotency_key=_signup_key(name, "hard-cap"),
        on_idempotent_replay=on_replay,
    )
    soft_cap = langwatch.gateway_budgets.create(
        scope=tenant_scope,
        name=f"{name} soft cap",
        window="manual",
        limit_usd="2.50",
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
        limit_usd="1.00",
        on_breach="block",
        cycle_anchor_at=cycle_anchor_at,
        idempotency_key=_signup_key(name, "seat-allowance"),
        on_idempotent_replay=on_replay,
    )

    return {
        "virtual_key_id": vk_id,
        "virtual_key_secret": minted["secret"],
        "hard_cap_budget_id": hard_cap["id"],
        "soft_cap_budget_id": soft_cap["id"],
        "per_user_budget_id": per_user["id"],
        "cycle_anchor_at": per_user.get("cycle_anchor_at") or cycle_anchor_at,
        "replayed": bool(replays),
        "project_id": project_id,
        "project_created": project_created,
    }


def register_webhook_endpoint(url: str) -> dict:
    created = langwatch.webhooks.create(
        url=url,
        enabled_events=[
            "gateway.request.completed",
            "gateway.request.settled",
            "gateway.budget.threshold_crossed",
            "gateway.budget.breached",
            "gateway.virtual_key.disabled",
            "gateway.virtual_key.enabled",
        ],
    )
    return {"endpoint_id": created["id"], "secret": created["secret"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant")
    parser.add_argument("--register-webhook")
    args = parser.parse_args()

    if args.tenant:
        tenant = provision_tenant(args.tenant)
        print(json.dumps(tenant, indent=2))
        print(
            "\nStore virtual_key_secret in your tenant record;"
            " it is not retrievable again."
        )
    if args.register_webhook:
        endpoint = register_webhook_endpoint(args.register_webhook)
        print(json.dumps(endpoint, indent=2))
        print("\nPut secret in PY_WEBHOOK_SECRET in .env.")
    if not args.tenant and not args.register_webhook:
        parser.print_help()
