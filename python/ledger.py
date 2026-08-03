"""The local billing ledger the webhook receiver feeds.

One row per gateway request; money is integer nano-USD (billionths of a
dollar), never floats. Two invariants, straight from the delivery contract:

- **Dedup by event id.** Delivery is at-least-once, so the same envelope can
  arrive more than once (retries, replays). ``seen_events`` records every
  event id ever ingested; a repeat is a no-op.
- **Completed supersedes settled: replace, never sum.** A settled event means
  "this request happened but its cost is unknown". If the real completion
  arrives later, it REPLACES the settled row for the same
  ``gateway_request_id``. A settled event arriving after a completion is
  ignored; the completion already carries the truth.

Those two rules together are why repairing a gap needs ``backfill()`` rather
than a redelivery: an event whose id is already in ``seen_events`` can never
be ingested again, so re-sending it cannot put back a row that went missing
after it was first seen.
"""

import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS seen_events (
    event_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
    gateway_request_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    virtual_key_id TEXT NOT NULL,
    end_user_id TEXT,
    model TEXT,
    status TEXT NOT NULL,
    cost_nano_usd INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    needs_reconciliation INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL
);
"""


class Ledger:
    def __init__(self, path: str):
        # check_same_thread off: Flask serves each request on its own
        # thread and this demo's writes are tiny and serialized by SQLite.
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)

    def ingest(self, envelope: dict) -> str:
        """Ingest one delivered envelope; returns 'ingested', 'duplicate', or
        'superseded-noop' (a settled event arrived after its completion)."""
        event_id = envelope["id"]
        seen = self.db.execute(
            "SELECT 1 FROM seen_events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if seen:
            return "duplicate"
        self._mark_seen(event_id)

        # Only the request families are money and belong in the ledger.
        # Budget and lifecycle events are operational signals: deduped
        # above, surfaced to the operator, never rows in the books.
        if not envelope["type"].startswith("gateway.request."):
            self.db.commit()
            return "ingested"

        return "ingested" if self._write_row(envelope) else "superseded-noop"

    def backfill(self, envelope: dict) -> str:
        """Write one envelope PULLED from ``GET /api/gateway/v1/spend-events``,
        bypassing the delivery dedup gate.

        This is the repair path, and it exists because redelivery cannot
        repair. A replayed envelope carries its original id, every receiver
        dedups on ids forever, so replaying a window a receiver has already
        seen is a guaranteed no-op no matter what is missing from the books.
        Reconciliation therefore fetches the authoritative rows and writes
        them here.

        The supersede rule still holds: a pulled settled event never
        overwrites a completion already on the row. Returns 'written' or
        'superseded-noop'.
        """
        self._mark_seen(envelope["id"])
        if not envelope["type"].startswith("gateway.request."):
            self.db.commit()
            return "superseded-noop"
        return "written" if self._write_row(envelope) else "superseded-noop"

    def _mark_seen(self, event_id: str) -> None:
        self.db.execute(
            "INSERT OR IGNORE INTO seen_events (event_id, received_at) VALUES (?, ?)",
            (event_id, datetime.now(timezone.utc).isoformat()),
        )

    def _write_row(self, envelope: dict) -> bool:
        """Upsert the money row for one request event. False when the write
        was declined because a completion already answered this request."""
        data = envelope["data"]
        request_id = data["gateway_request_id"]
        settled = envelope["type"] == "gateway.request.settled"

        if settled:
            # Only record the unknown if no completion already answered it.
            existing = self.db.execute(
                "SELECT status FROM ledger WHERE gateway_request_id = ?",
                (request_id,),
            ).fetchone()
            if existing and existing[0] != "settled":
                self.db.commit()
                return False

        usage = data.get("usage")
        cost = data.get("cost")
        self.db.execute(
            """
            INSERT INTO ledger (
                gateway_request_id, event_id, virtual_key_id, end_user_id,
                model, status, cost_nano_usd, input_tokens, output_tokens,
                needs_reconciliation, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (gateway_request_id) DO UPDATE SET
                event_id = excluded.event_id,
                status = excluded.status,
                cost_nano_usd = excluded.cost_nano_usd,
                input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                needs_reconciliation = excluded.needs_reconciliation,
                occurred_at = excluded.occurred_at
            """,
            (
                request_id,
                envelope["id"],
                data.get("virtual_key_id") or "",
                data.get("end_user_id"),
                data.get("model"),
                data["status"],
                cost["nano_usd"] if cost else None,
                usage["input_tokens"] if usage else None,
                usage["output_tokens"] if usage else None,
                1 if data.get("needs_reconciliation") is True else 0,
                data["occurred_at"],
            ),
        )
        self.db.commit()
        return True

    def totals_by_virtual_key(self, from_iso: str, to_iso: str) -> list[tuple]:
        """(virtual_key_id, event_count, cost_nano_usd) per key, settled excluded."""
        return self.db.execute(
            """
            SELECT virtual_key_id, COUNT(*), COALESCE(SUM(cost_nano_usd), 0)
            FROM ledger
            WHERE status != 'settled' AND occurred_at >= ? AND occurred_at < ?
            GROUP BY virtual_key_id
            """,
            (from_iso, to_iso),
        ).fetchall()

    def totals_by_end_user(self, virtual_key_id: str) -> list[dict]:
        """Per end user for one tenant key: what the platform rebills.
        Settled rows are counted but never summed (unknown is not zero)."""
        rows = self.db.execute(
            """
            SELECT end_user_id,
                   COUNT(*) AS request_count,
                   COALESCE(SUM(CASE WHEN status != 'settled' THEN cost_nano_usd END), 0)
                       AS cost_nano_usd,
                   SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END)
                       AS settled_count
            FROM ledger
            WHERE virtual_key_id = ?
            GROUP BY end_user_id
            ORDER BY cost_nano_usd DESC
            """,
            (virtual_key_id,),
        ).fetchall()
        return [
            {
                "end_user_id": row[0],
                "request_count": row[1],
                "cost_nano_usd": row[2],
                "settled_count": row[3],
            }
            for row in rows
        ]

    def request_ids(self, virtual_key_id: str, from_iso: str, to_iso: str) -> set[str]:
        rows = self.db.execute(
            "SELECT gateway_request_id FROM ledger"
            " WHERE virtual_key_id = ? AND occurred_at >= ? AND occurred_at < ?",
            (virtual_key_id, from_iso, to_iso),
        ).fetchall()
        return {row[0] for row in rows}
