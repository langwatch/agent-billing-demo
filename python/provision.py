"""Provision one tenant on LangWatch through the official python SDK
(``langwatch``): the four calls a customer signup makes.

1. Mint a virtual key. The VK IS the tenant boundary: its secret is the
   tenant's gateway credential, and every budget and spend row hangs off its
   id. The secret is returned exactly once; store it like a password.
2. A hard cap: ``on_breach: BLOCK``, MANUAL window. MANUAL accrues until an
   explicit reset (``POST /budgets/:id/reset``), which is how a billing
   period closes without ever mutating recorded spend.
3. A soft cap: ``on_breach: WARN`` at a lower limit. Crossing it emits
   ``gateway.budget.threshold_crossed`` and stamps a warning header on
   responses; traffic keeps flowing.
4. An attributed-user template: ONE budget row that caps every current and
   future end user of this tenant. Nothing is provisioned per user; buckets
   appear lazily on first spend. Fail-closed: once this template is active,
   requests without an end-user id are rejected (``end_user_required``)
   instead of passing uncapped.

Plus, once per receiver (not per tenant): register the webhook endpoint and
store its signing secret.

Usage::

    python provision.py --tenant "ACME Corp"
    python provision.py --register-webhook http://localhost:4102/webhooks/langwatch
"""

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
# authorizes; LANGWATCH_PROJECT_ID (read by the gateway_admin facade)
# says which project provisioned objects live under.
langwatch.setup(api_key=API_KEY, endpoint_url=BASE_URL, skip_open_telemetry_setup=True)


def provision_tenant(name: str) -> dict:
    admin = langwatch.gateway_admin
    minted = admin.create_virtual_key(
        name=name,
        description=f"Tenant key for {name} (provisioned by acme-agents)",
    )
    vk_id = minted["virtual_key"]["id"]

    hard_cap = admin.create_budget(
        scope={"kind": "VIRTUAL_KEY", "virtual_key_id": vk_id},
        name=f"{name} hard cap",
        window="MANUAL",
        limit_usd="5.00",
        on_breach="BLOCK",
    )
    soft_cap = admin.create_budget(
        scope={"kind": "VIRTUAL_KEY", "virtual_key_id": vk_id},
        name=f"{name} soft cap",
        window="MANUAL",
        limit_usd="2.50",
        on_breach="WARN",
    )
    per_user = admin.create_budget(
        scope={"kind": "ATTRIBUTED_USER", "anchor_virtual_key_id": vk_id},
        name=f"{name} per-user allowance",
        window="MONTH",
        limit_usd="1.00",
        on_breach="BLOCK",
    )

    return {
        "virtual_key_id": vk_id,
        "virtual_key_secret": minted["secret"],
        "hard_cap_budget_id": hard_cap["id"],
        "soft_cap_budget_id": soft_cap["id"],
        "per_user_budget_id": per_user["id"],
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
