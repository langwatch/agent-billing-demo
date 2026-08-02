import Database from "better-sqlite3";

/**
 * The app's own database: customers (tenants), their seats, their agents,
 * their chat transcripts, and the billing events its webhook receiver
 * ingested.
 *
 * What is deliberately absent is the interesting part: no spend
 * calculation, no cap arithmetic, no metering. Caps and spend live on
 * LangWatch and are read back over REST; the `billing_events` table is a
 * verbatim archive of what the platform delivered, which is what the usage
 * meters and the owner console render.
 */
export interface Customer {
  id: number;
  name: string;
  /** LangWatch virtual key id: the tenant's identity on the gateway. */
  virtual_key_id: string;
  /** The VK secret, held server-side like any tenant credential. */
  virtual_key_secret: string;
  /** The MANUAL-window BLOCK budget; reset closes the billing period. */
  hard_cap_budget_id: string;
  /** The MANUAL-window WARN budget that trips before the hard cap. */
  soft_cap_budget_id: string;
  /** The ATTRIBUTED_USER template that caps every seat of this tenant. */
  per_user_budget_id: string;
  created_at: string;
}

export interface AppUser {
  id: number;
  customer_id: number;
  email: string;
  created_at: string;
}

export interface Agent {
  id: number;
  customer_id: number;
  name: string;
  system_prompt: string;
  model: string;
  created_at: string;
}

export interface Message {
  id: number;
  agent_id: number;
  customer_id: number;
  user_id: number;
  role: "user" | "assistant";
  content: string;
  gateway_request_id: string | null;
  created_at: string;
}

export interface BillingEvent {
  event_id: string;
  type: string;
  gateway_request_id: string | null;
  virtual_key_id: string | null;
  end_user_id: string | null;
  model: string | null;
  status: string | null;
  cost_nano_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  occurred_at: string;
  received_at: string;
  payload: string;
}

export type AppDatabase = Database.Database;

const SCHEMA_VERSION = 3;

export function openDb(path: string): AppDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
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
  `);

  addColumn(db, "customers", "soft_cap_budget_id", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "customers", "per_user_budget_id", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "customers", "created_at", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "agents", "created_at", "TEXT NOT NULL DEFAULT ''");

  // Seats are unique per tenant, not globally: two customers may both have
  // an owner@ address, and the gateway attributes by tenant plus seat.
  db.exec(`
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
  `);

  migrateLegacyUsers(db);
  backfillTimestamps(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

function columns(db: AppDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(
  db: AppDatabase,
  table: string,
  column: string,
  definition: string,
) {
  if (columns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Earlier revisions kept seats in a `users` table with a globally unique
 * email. Carry those rows into `seats` once, then leave the old table alone
 * so a half-finished migration can be repeated safely.
 */
function migrateLegacyUsers(db: AppDatabase) {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  if (!legacy) return;
  db.exec(`
    INSERT OR IGNORE INTO seats (id, customer_id, email, created_at)
    SELECT id, customer_id, email, '' FROM users;
    DROP TABLE users;
  `);
}

function backfillTimestamps(db: AppDatabase) {
  const now = new Date().toISOString();
  db.prepare("UPDATE customers SET created_at = ? WHERE created_at = ''").run(now);
  db.prepare("UPDATE agents SET created_at = ? WHERE created_at = ''").run(now);
  db.prepare("UPDATE seats SET created_at = ? WHERE created_at = ''").run(now);
}
