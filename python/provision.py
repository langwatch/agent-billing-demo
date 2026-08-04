"""Provision one tenant on LangWatch through the official python SDK
(``langwatch``): the four calls a customer signup makes.

1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
   tenant's gateway credential, and every budget and spend row hangs off its
   id. The secret is returned exactly once; store it like a password.
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

import langwatch

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
if not API_KEY:
    print("LANGWATCH_API_KEY is not set.")
    sys.exit(1)

# The official python SDK: one setup, then the facades. The org key
# authorizes; LANGWATCH_PROJECT_ID (read by the virtual key and budget
# facades) says which project provisioned objects live under.
langwatch.setup(api_key=API_KEY, endpoint_url=BASE_URL, skip_open_telemetry_setup=True)


def _signup_key(name: str, resource: str) -> str:
    """The key one resource of one signup is created under. Derived from the
    tenant's identity, so running this twice for the same tenant asks for the
    same resources and gets the same ones back rather than a second set."""
    identity = "-".join(name.strip().lower().split())
    return f"acme-agents:signup:{identity}:{resource}"


def provision_tenant(name: str) -> dict:
    replays: list[bool] = []

    def on_replay() -> None:
        replays.append(True)

    minted = langwatch.virtual_keys.create(
        name=name,
        description=f"Tenant key for {name} (ACME Agents signup)",
        idempotency_key=_signup_key(name, "virtual-key"),
        on_idempotent_replay=on_replay,
    )
    vk_id = minted["virtual_key"]["id"]
    # The tenant's own birth instant, and the same value on every retry.
    cycle_anchor_at = minted["virtual_key"]["created_at"]

    hard_cap = langwatch.gateway_budgets.create(
        scope={"kind": "virtual_key", "virtual_key_id": vk_id},
        name=f"{name} hard cap",
        window="manual",
        limit_usd="5.00",
        on_breach="block",
        idempotency_key=_signup_key(name, "hard-cap"),
        on_idempotent_replay=on_replay,
    )
    soft_cap = langwatch.gateway_budgets.create(
        scope={"kind": "virtual_key", "virtual_key_id": vk_id},
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
        scope={"kind": "attributed_user", "anchor_virtual_key_id": vk_id},
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
