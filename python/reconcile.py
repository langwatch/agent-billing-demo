"""Reconciliation, three steps:

1. **Checksums first.** ``GET /api/gateway/v1/spend-summaries`` returns, per
   virtual key, the event count and the exact nano-USD sum LangWatch has on
   its ledger for a window. If our local totals match, the window is
   reconciled and we are done; this is one request, not a walk.
2. **Cursor diff on divergence.** Only when a key's checksum diverges do we
   walk ``GET /api/gateway/v1/spend-events`` for that key and window and
   diff by ``gateway_request_id``. Cursor pagination is stable under live
   writes, so a moving table cannot hide or duplicate rows mid-walk.
3. **Backfill from the same walk.** The walk already carries the full
   envelopes, so every request the books are missing is written straight into
   the local ledger and the checksum is re-read to confirm.

Why the repair pulls rather than asks for a redelivery: a replayed envelope
keeps its original id, and every receiver dedups on ids forever. Replaying a
window this ledger has already seen is therefore a guaranteed no-op no matter
what is missing from the books. ``POST /spend-events/replay`` is a redelivery
TEST tool, for proving an endpoint receives and verifies what it is sent; it
is not a repair, and it is not used here.

Settled rows never count toward the money sums (their cost is unknown, and
unknown is not zero); the summary reports them in ``settled_count``, which
is your reconciliation work queue, not your invoice.

Exit code 0 means every virtual key's local totals match LangWatch's
checksums, whether they already did or were repaired to.

Run: ``python reconcile.py`` (needs LANGWATCH_API_KEY in the environment).
"""

import env  # noqa: F401  (loads .env before anything reads it)

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import langwatch

from ledger import Ledger

BASE_URL = os.environ.get("LANGWATCH_BASE_URL", "http://localhost:5560")
API_KEY = os.environ.get("LANGWATCH_API_KEY", "")
if not API_KEY:
    print("LANGWATCH_API_KEY is not set.")
    sys.exit(1)

# The official python SDK: one setup, then the spend-events facade drives
# both grains of the reconciliation.
langwatch.setup(api_key=API_KEY, endpoint_url=BASE_URL, skip_open_telemetry_setup=True)


#: Page size for the divergence walk; the endpoint caps this at 200.
WALK_PAGE_SIZE = 200


def walk_events(virtual_key_id: str, from_ms: int, to_ms: int) -> dict[str, list[dict]]:
    """Every spend event LangWatch holds for one key and window, keyed by
    request. A request can have two (a settled event and the completion that
    supersedes it), so the values are lists and the ledger applies its own
    replace rule."""
    by_request: dict[str, list[dict]] = {}
    cursor: str | None = None
    while True:
        page = langwatch.spend_events.list(
            from_ms=from_ms,
            to_ms=to_ms,
            virtual_key_id=virtual_key_id,
            limit=WALK_PAGE_SIZE,
            cursor=cursor,
        )
        for event in page["data"]:
            by_request.setdefault(event["data"]["gateway_request_id"], []).append(event)
        # A null next_cursor is the only end of the walk: a full page is not a
        # promise of more, and a short one is not a promise of the end.
        cursor = page.get("next_cursor")
        if not cursor:
            return by_request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=int, default=24 * 60)
    args = parser.parse_args()
    to_ms = int(time.time() * 1000)
    from_ms = to_ms - args.minutes * 60 * 1000
    from_iso = datetime.fromtimestamp(from_ms / 1000, timezone.utc).isoformat()
    to_iso = datetime.fromtimestamp(to_ms / 1000, timezone.utc).isoformat()

    ledger = Ledger(str(Path(__file__).parent / "ledger.sqlite"))
    local = {
        row[0]: {"event_count": row[1], "cost_nano_usd": row[2]}
        for row in ledger.totals_by_virtual_key(from_iso, to_iso)
    }

    summaries = langwatch.spend_events.summaries(
        group_by="virtual_key", from_ms=from_ms, to_ms=to_ms
    )

    clean = True
    for remote in summaries:
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

        if match:
            continue

        # Checksum diverged: find exactly which requests differ, and repair
        # the ones LangWatch can still answer for.
        remote_events = walk_events(remote["key"], from_ms, to_ms)
        local_ids = ledger.request_ids(remote["key"], from_iso, to_iso)
        missing_locally = sorted(set(remote_events) - local_ids)
        unknown_remotely = sorted(local_ids - set(remote_events))

        backfilled = 0
        for request_id in missing_locally:
            for event in remote_events[request_id]:
                if ledger.backfill(event) == "written":
                    backfilled += 1
            print(f"  backfilled from the pull API: {request_id}")
        for request_id in unknown_remotely:
            # Nothing to pull: the row exists only here. Either it is outside
            # the window LangWatch was asked about, or it was written by
            # something other than a delivered event. Worth a person's
            # attention, not a silent delete.
            print(f"  local row LangWatch does not have: {request_id}")

        if backfilled == 0 and not missing_locally:
            print("  nothing to backfill: the gap is not missing rows")
        else:
            print(
                f"  wrote {backfilled} event(s) covering"
                f" {len(missing_locally)} request(s)"
            )

        # Re-read the checksum so the run reports the state it leaves behind,
        # not the state it found.
        repaired = {
            row[0]: {"event_count": row[1], "cost_nano_usd": row[2]}
            for row in ledger.totals_by_virtual_key(from_iso, to_iso)
        }.get(remote["key"], {"event_count": 0, "cost_nano_usd": 0})
        reconciled = (
            repaired["event_count"] == remote["event_count"]
            and repaired["cost_nano_usd"] == remote["cost"]["nano_usd"]
        )
        print(
            f"  after backfill: local {repaired['event_count']} /"
            f" {repaired['cost_nano_usd']} ->"
            f" {'RECONCILED' if reconciled else 'STILL DIVERGED'}"
        )
        if not reconciled:
            clean = False
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
