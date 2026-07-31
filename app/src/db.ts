import Database from "better-sqlite3";

/**
 * The app's own tiny database: customers (tenants), their users, their
 * agents. Deliberately boring. The interesting part is what is NOT here:
 * no spend tracking, no caps, no metering tables. All of that lives on
 * LangWatch; the local billing ledger (ts/ and python/) is fed by webhooks.
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
}

export interface AppUser {
  id: number;
  customer_id: number;
  email: string;
}

export interface Agent {
  id: number;
  customer_id: number;
  name: string;
  system_prompt: string;
  model: string;
}

export function openDb(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      virtual_key_id TEXT NOT NULL,
      virtual_key_secret TEXT NOT NULL,
      hard_cap_budget_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      model TEXT NOT NULL
    );
  `);
  return db;
}
