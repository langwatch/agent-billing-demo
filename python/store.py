"""The app's own database: customers (tenants), their seats, their agents,
their chat transcripts, and the billing events its webhook receiver ingested.

What is deliberately absent is the interesting part: no spend calculation, no
cap arithmetic, no metering. Caps and spend live on LangWatch and are read
back over REST; the ``billing_events`` table is a verbatim archive of what the
platform delivered, which is what the usage meters and the owner console
render.

Same tables, same columns as the TypeScript twin's ``app/src/db.ts``, so the
two app shells answer the same API from the same shape.
"""

import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Set

SCHEMA_VERSION = 3


def now_iso() -> str:
    """UTC, milliseconds, trailing Z: the timestamp spelling on the wire."""
    return (
        datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


@contextmanager
def connect(path: Path) -> Iterator[sqlite3.Connection]:
    """One connection per unit of work: commit on the way out, roll back if the
    body raised, and always close. SQLite handles the concurrency a demo has,
    and a short-lived connection keeps the threadpool free of shared state.

    ``with conn`` on its own only ends the transaction; the close has to be
    here or every request leaks a file handle.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def open_db(path: Path) -> None:
    """Create or migrate the schema once, at startup."""
    with connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                virtual_key_id TEXT NOT NULL,
                virtual_key_secret TEXT NOT NULL,
                hard_cap_budget_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                name TEXT NOT NULL,
                system_prompt TEXT NOT NULL,
                model TEXT NOT NULL
            );
            """
        )

        _add_column(conn, "customers", "soft_cap_budget_id", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "customers", "per_user_budget_id", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "customers", "created_at", "TEXT NOT NULL DEFAULT ''")
        _add_column(conn, "agents", "created_at", "TEXT NOT NULL DEFAULT ''")

        # Seats are unique per tenant, not globally: two customers may both
        # have an owner@ address, and the gateway attributes by tenant plus
        # seat.
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS seats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                email TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (customer_id, email)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER NOT NULL REFERENCES agents(id),
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                gateway_request_id TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_by_agent ON messages (agent_id, id);

            CREATE TABLE IF NOT EXISTS billing_events (
                event_id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                gateway_request_id TEXT,
                virtual_key_id TEXT,
                end_user_id TEXT,
                model TEXT,
                status TEXT,
                cost_nano_usd INTEGER,
                input_tokens INTEGER,
                output_tokens INTEGER,
                occurred_at TEXT NOT NULL,
                received_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS billing_events_by_key
                ON billing_events (virtual_key_id, occurred_at);
            CREATE INDEX IF NOT EXISTS billing_events_by_request
                ON billing_events (gateway_request_id);
            """
        )

        _migrate_legacy_users(conn)
        _backfill_timestamps(conn)

        # A workspace name is the tenant's identity in the product, so it is
        # claimed once. The index is case-insensitive to match the check the
        # sign-up route makes before it mints anything on the platform.
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS customers_name_unique"
            " ON customers (name COLLATE NOCASE)"
        )
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _columns(conn: sqlite3.Connection, table: str) -> Set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column(
    conn: sqlite3.Connection, table: str, column: str, definition: str
) -> None:
    if column in _columns(conn, table):
        return
    conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _migrate_legacy_users(conn: sqlite3.Connection) -> None:
    """Earlier revisions kept seats in a ``users`` table with a globally
    unique email. Carry those rows into ``seats`` once, then leave the old
    table alone so a half-finished migration can be repeated safely."""
    legacy = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    ).fetchone()
    if not legacy:
        return
    conn.executescript(
        """
        INSERT OR IGNORE INTO seats (id, customer_id, email, created_at)
        SELECT id, customer_id, email, '' FROM users;
        DROP TABLE users;
        """
    )


def _backfill_timestamps(conn: sqlite3.Connection) -> None:
    stamp = now_iso()
    for table in ("customers", "agents", "seats"):
        conn.execute(f"UPDATE {table} SET created_at = ? WHERE created_at = ''", (stamp,))


CUSTOMER_SUMMARY = """
    SELECT c.id, c.name, c.virtual_key_id, c.created_at,
           (SELECT COUNT(*) FROM agents WHERE customer_id = c.id) AS agent_count,
           (SELECT COUNT(*) FROM seats WHERE customer_id = c.id) AS seat_count
    FROM customers c
"""


def seat_email_for(raw: object, company_name: str) -> str:
    """The first seat: the address given at sign-up, or one derived from the
    name."""
    provided = str(raw or "").strip().lower()
    if "@" in provided:
        return provided
    slug = re.sub(r"[^a-z0-9]+", "-", company_name.lower()).strip("-")[:24]
    return f"owner@{slug or 'workspace'}.example"
