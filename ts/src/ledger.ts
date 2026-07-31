import Database from "better-sqlite3";

/**
 * The local billing ledger the webhook receiver feeds. One row per gateway
 * request; money is integer nano-USD (billionths of a dollar), never floats.
 *
 * Two invariants, straight from the delivery contract:
 *
 * - **Dedup by event id.** Delivery is at-least-once, so the same envelope
 *   can arrive more than once (retries, replays). `seen_events` records every
 *   event id ever ingested; a repeat is a no-op.
 * - **Completed supersedes settled: replace, never sum.** A settled event
 *   means "this request happened but its cost is unknown". If the real
 *   completion arrives later, it REPLACES the settled row for the same
 *   `gateway_request_id`. A settled event arriving after a completion is
 *   ignored; the completion already carries the truth.
 */
export interface LedgerRow {
  gateway_request_id: string;
  event_id: string;
  virtual_key_id: string;
  end_user_id: string | null;
  model: string | null;
  status: string;
  cost_nano_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  needs_reconciliation: number;
  occurred_at: string;
}

export class Ledger {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
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
    `);
  }

  /**
   * Ingest one envelope. Returns what happened, which the receiver logs:
   * "ingested", "duplicate" (dedup hit), or "superseded-noop" (a settled
   * event arrived after the completion it would have flagged).
   */
  ingest(envelope: {
    id: string;
    type: string;
    data: Record<string, unknown>;
  }): "ingested" | "duplicate" | "superseded-noop" {
    const seen = this.db
      .prepare("SELECT 1 FROM seen_events WHERE event_id = ?")
      .get(envelope.id);
    if (seen) return "duplicate";
    this.db
      .prepare("INSERT INTO seen_events (event_id, received_at) VALUES (?, ?)")
      .run(envelope.id, new Date().toISOString());

    // Only the request families are money and belong in the ledger.
    // Budget and lifecycle events are operational signals: deduped above,
    // surfaced to the operator, never rows in the books.
    if (!envelope.type.startsWith("gateway.request.")) return "ingested";

    const d = envelope.data;
    const requestId = String(d.gateway_request_id);
    const settled = envelope.type === "gateway.request.settled";

    if (settled) {
      // Only record the unknown if no completion already answered it.
      const existing = this.db
        .prepare("SELECT status FROM ledger WHERE gateway_request_id = ?")
        .get(requestId) as { status: string } | undefined;
      if (existing && existing.status !== "settled") return "superseded-noop";
    }

    const usage = d.usage as Record<string, number> | null;
    const cost = d.cost as { nano_usd: number } | null;
    this.db
      .prepare(
        `INSERT INTO ledger (
           gateway_request_id, event_id, virtual_key_id, end_user_id, model,
           status, cost_nano_usd, input_tokens, output_tokens,
           needs_reconciliation, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (gateway_request_id) DO UPDATE SET
           event_id = excluded.event_id,
           status = excluded.status,
           cost_nano_usd = excluded.cost_nano_usd,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           needs_reconciliation = excluded.needs_reconciliation,
           occurred_at = excluded.occurred_at`,
      )
      .run(
        requestId,
        envelope.id,
        String(d.virtual_key_id ?? ""),
        (d.end_user_id as string | null) ?? null,
        (d.model as string | null) ?? null,
        String(d.status),
        cost ? cost.nano_usd : null,
        usage ? usage.input_tokens : null,
        usage ? usage.output_tokens : null,
        d.needs_reconciliation === true ? 1 : 0,
        String(d.occurred_at),
      );
    return "ingested";
  }

  /** Per-virtual-key totals over a window, for reconciliation checksums. */
  totalsByVirtualKey(fromIso: string, toIso: string) {
    return this.db
      .prepare(
        `SELECT virtual_key_id,
                COUNT(*) AS event_count,
                COALESCE(SUM(cost_nano_usd), 0) AS cost_nano_usd
         FROM ledger
         WHERE status != 'settled'
           AND occurred_at >= ? AND occurred_at < ?
         GROUP BY virtual_key_id`,
      )
      .all(fromIso, toIso) as Array<{
      virtual_key_id: string;
      event_count: number;
      cost_nano_usd: number;
    }>;
  }

  /** One key's request ids in a window, for the item-level diff. */
  requestIds(virtualKeyId: string, fromIso: string, toIso: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT gateway_request_id FROM ledger
         WHERE virtual_key_id = ? AND occurred_at >= ? AND occurred_at < ?`,
      )
      .all(virtualKeyId, fromIso, toIso) as Array<{
      gateway_request_id: string;
    }>;
    return new Set(rows.map((r) => r.gateway_request_id));
  }

  all(): LedgerRow[] {
    return this.db
      .prepare("SELECT * FROM ledger ORDER BY occurred_at")
      .all() as LedgerRow[];
  }
}
