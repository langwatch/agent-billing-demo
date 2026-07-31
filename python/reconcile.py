"""Reconciliation, two grains:

1. **Checksums first.** ``GET /api/gateway/v1/spend-summaries`` returns, per
   virtual key, the event count and the exact nano-USD sum LangWatch has on
   its ledger for a window. If our local totals match, the window is
   reconciled and we are done; this is one request, not a walk.
2. **Cursor diff on divergence.** Only when a key's checksum diverges do we
   walk ``GET /api/gateway/v1/spend-events`` for that key and window and
   diff by ``gateway_request_id``. Cursor pagination is stable under live
   writes, so a moving table cannot hide or duplicate rows mid-walk.

Settled rows never count toward the money sums (their cost is unknown, and
unknown is not zero); the summary reports them in ``settled_count``, which
is your reconciliation work queue, not your invoice.

Run: ``python reconcile.py`` (needs LANGWATCH_API_KEY in the environment).
"""

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from ledger import Ledger

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
if not API_KEY:
    print("LANGWATCH_API_KEY is not set.")
    sys.exit(1)

HEADERS = {"Authorization": f"Bearer {API_KEY}"}


def api(path: str, params: dict | None = None) -> dict:
    response = requests.get(
        f"{BASE_URL}{path}", headers=HEADERS, params=params, timeout=30
    )
    response.raise_for_status()
    return response.json()


def walk_request_ids(virtual_key_id: str, from_ms: int, to_ms: int) -> set[str]:
    ids: set[str] = set()
    cursor: str | None = None
    while True:
        params = {
            "from": from_ms,
            "to": to_ms,
            "virtual_key_id": virtual_key_id,
            "limit": 200,
        }
        if cursor:
            params["cursor"] = cursor
        page = api("/api/gateway/v1/spend-events", params)
        for event in page["data"]:
            ids.add(event["data"]["gateway_request_id"])
        cursor = page.get("next_cursor")
        if not cursor:
            return ids


def main() -> int:
    to_ms = int(time.time() * 1000)
    from_ms = to_ms - 24 * 60 * 60 * 1000
    from_iso = datetime.fromtimestamp(from_ms / 1000, timezone.utc).isoformat()
    to_iso = datetime.fromtimestamp(to_ms / 1000, timezone.utc).isoformat()

    ledger = Ledger(str(Path(__file__).parent / "ledger.sqlite"))
    local = {
        row[0]: {"event_count": row[1], "cost_nano_usd": row[2]}
        for row in ledger.totals_by_virtual_key(from_iso, to_iso)
    }

    summaries = api(
        "/api/gateway/v1/spend-summaries",
        {"group_by": "virtual_key", "from": from_ms, "to": to_ms},
    )

    clean = True
    for remote in summaries["data"]:
        mine = local.get(remote["key"], {"event_count": 0, "cost_nano_usd": 0})
        match = (
            mine["event_count"] == remote["event_count"]
            and mine["cost_nano_usd"] == remote["cost"]["nano_usd"]
        )
        settled_note = (
            f" ({remote['settled_count']} settled awaiting resolution)"
            if remote["settled_count"] > 0
            else ""
        )
        verdict = "MATCH" if match else "DIVERGED"
        print(
            f"{remote['key']}: remote {remote['event_count']} events / "
            f"{remote['cost']['nano_usd']} nano-USD vs local "
            f"{mine['event_count']} / {mine['cost_nano_usd']}{settled_note}"
            f" -> {verdict}"
        )

        if not match:
            clean = False
            # Checksum diverged: find exactly which requests differ.
            remote_ids = walk_request_ids(remote["key"], from_ms, to_ms)
            local_ids = ledger.request_ids(from_iso, to_iso)
            for request_id in sorted(remote_ids - local_ids):
                print(
                    f"  missing locally: {request_id}"
                    " (re-ingest or replay this window)"
                )
            for request_id in sorted(local_ids - remote_ids):
                print(f"  local row LangWatch does not have: {request_id}")
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
