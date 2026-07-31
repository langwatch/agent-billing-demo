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
        """Ingest one envelope; returns 'ingested', 'duplicate', or
        'superseded-noop' (a settled event arrived after its completion)."""
        event_id = envelope["id"]
        seen = self.db.execute(
            "SELECT 1 FROM seen_events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if seen:
            return "duplicate"
        self.db.execute(
            "INSERT INTO seen_events (event_id, received_at) VALUES (?, ?)",
            (event_id, datetime.now(timezone.utc).isoformat()),
        )

        # Only the request families are money and belong in the ledger.
        # Budget and lifecycle events are operational signals: deduped
        # above, surfaced to the operator, never rows in the books.
        if not envelope["type"].startswith("gateway.request."):
            self.db.commit()
            return "ingested"

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
                return "superseded-noop"

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
                event_id,
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
        return "ingested"

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

    def request_ids(self, virtual_key_id: str, from_iso: str, to_iso: str) -> set[str]:
        rows = self.db.execute(
            "SELECT gateway_request_id FROM ledger"
            " WHERE virtual_key_id = ? AND occurred_at >= ? AND occurred_at < ?",
            (virtual_key_id, from_iso, to_iso),
        ).fetchall()
        return {row[0] for row in rows}
