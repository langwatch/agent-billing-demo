import { Ledger } from "./ledger.js";

/**
 * Reconciliation, two grains:
 *
 * 1. **Checksums first.** `GET /api/gateway/v1/spend-summaries` returns, per
 *    virtual key, the event count and the exact nano-USD sum LangWatch has
 *    on its ledger for a window. If our local totals match, the window is
 *    reconciled and we are done; this is one request, not a walk.
 * 2. **Cursor diff on divergence.** Only when a key's checksum diverges do
 *    we walk `GET /api/gateway/v1/spend-events` for that key and window and
 *    diff by `gateway_request_id`. Cursor pagination is stable under live
 *    writes, so a moving table cannot hide or duplicate rows mid-walk.
 *
 * Settled rows never count toward the money sums (their cost is unknown, and
 * unknown is not zero); the summary reports them in `settled_count`, which
 * is your reconciliation work queue, not your invoice.
 */
const BASE_URL = process.env.LANGWATCH_BASE_URL ?? "http://localhost:5560";
const API_KEY = process.env.LANGWATCH_API_KEY ?? "";
if (!API_KEY) {
  console.error("LANGWATCH_API_KEY is not set.");
  process.exit(1);
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

interface SummaryRow {
  key: string;
  event_count: number;
  settled_count: number;
  cost: { nano_usd: number };
}

async function walkRequestIds(params: {
  virtualKeyId: string;
  fromMs: number;
  toMs: number;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      from: String(params.fromMs),
      to: String(params.toMs),
      virtual_key_id: params.virtualKeyId,
      limit: "200",
    });
    if (cursor) query.set("cursor", cursor);
    const page = await api<{
      data: Array<{ data: { gateway_request_id: string } }>;
      next_cursor: string | null;
    }>(`/api/gateway/v1/spend-events?${query}`);
    for (const event of page.data) ids.add(event.data.gateway_request_id);
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

async function main() {
  const toMs = Date.now();
  const fromMs = toMs - 24 * 60 * 60 * 1000;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  const ledger = new Ledger(
    new URL("../ledger.sqlite", import.meta.url).pathname,
  );
  const local = new Map(
    ledger.totalsByVirtualKey(fromIso, toIso).map((r) => [r.virtual_key_id, r]),
  );

  const summaries = await api<{ data: SummaryRow[] }>(
    `/api/gateway/v1/spend-summaries?group_by=virtual_key&from=${fromMs}&to=${toMs}`,
  );

  let clean = true;
  for (const remote of summaries.data) {
    const mine = local.get(remote.key);
    const localCount = mine?.event_count ?? 0;
    const localNano = mine?.cost_nano_usd ?? 0;
    const match =
      localCount === remote.event_count && localNano === remote.cost.nano_usd;

    console.log(
      `${remote.key}: remote ${remote.event_count} events / ${remote.cost.nano_usd} nano-USD` +
        ` vs local ${localCount} / ${localNano}` +
        (remote.settled_count > 0
          ? ` (${remote.settled_count} settled awaiting resolution)`
          : "") +
        ` -> ${match ? "MATCH" : "DIVERGED"}`,
    );

    if (!match) {
      clean = false;
      // Checksum diverged: find exactly which requests differ.
      const remoteIds = await walkRequestIds({
        virtualKeyId: remote.key,
        fromMs,
        toMs,
      });
      const localIds = ledger.requestIds(fromIso, toIso);
      const missingLocally = [...remoteIds].filter((id) => !localIds.has(id));
      const unknownRemotely = [...localIds].filter((id) => !remoteIds.has(id));
      for (const id of missingLocally) {
        console.log(`  missing locally: ${id} (re-ingest or replay this window)`);
      }
      for (const id of unknownRemotely) {
        console.log(`  local row LangWatch does not have: ${id}`);
      }
    }
  }
  process.exitCode = clean ? 0 : 1;
}

await main();
