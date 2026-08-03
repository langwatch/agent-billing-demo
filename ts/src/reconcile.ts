import { Ledger, type LedgerEnvelope } from "./ledger.js";

/**
 * Reconciliation, three steps:
 *
 * 1. **Checksums first.** `GET /api/gateway/v1/spend-summaries` returns, per
 *    virtual key, the event count and the exact nano-USD sum LangWatch has
 *    on its ledger for a window. If our local totals match, the window is
 *    reconciled and we are done; this is one request, not a walk.
 * 2. **Cursor diff on divergence.** Only when a key's checksum diverges do
 *    we walk `GET /api/gateway/v1/spend-events` for that key and window and
 *    diff by `gateway_request_id`. Cursor pagination is stable under live
 *    writes, so a moving table cannot hide or duplicate rows mid-walk.
 * 3. **Backfill from the same walk.** The walk already carries the full
 *    envelopes, so every request the books are missing is written straight
 *    into the local ledger and the checksum is re-read to confirm.
 *
 * Why the repair pulls rather than asks for a redelivery: a replayed
 * envelope keeps its original id, and every receiver dedups on ids forever.
 * Replaying a window this ledger has already seen is therefore a guaranteed
 * no-op no matter what is missing from the books. `POST /spend-events/replay`
 * is a redelivery TEST tool, for proving an endpoint receives and verifies
 * what it is sent; it is not a repair, and it is not used here.
 *
 * Settled rows never count toward the money sums (their cost is unknown, and
 * unknown is not zero); the summary reports them in `settled_count`, which
 * is your reconciliation work queue, not your invoice.
 *
 * Exit code 0 means every virtual key's local totals match LangWatch's
 * checksums, whether they already did or were repaired to.
 */
import { SpendEventsApiService, type SpendEvent } from "langwatch";
import "./env.js";

const BASE_URL = process.env.LANGWATCH_BASE_URL ?? "http://localhost:5560";
const API_KEY = process.env.LANGWATCH_API_KEY ?? "";
if (!API_KEY) {
  console.error("LANGWATCH_API_KEY is not set.");
  process.exit(1);
}

const spendEvents = new SpendEventsApiService({
  endpoint: BASE_URL,
  apiKey: API_KEY,
});

/** Page size for the divergence walk; the endpoint caps this at 200. */
const WALK_PAGE_SIZE = 200;

/**
 * Every spend event LangWatch holds for one key and window, keyed by request.
 * A request can have two (a settled event and the completion that supersedes
 * it), so the values are lists and the ledger applies its own replace rule.
 */
async function walkEvents(params: {
  virtualKeyId: string;
  fromMs: number;
  toMs: number;
}): Promise<Map<string, SpendEvent[]>> {
  const byRequest = new Map<string, SpendEvent[]>();
  let cursor: string | undefined;
  do {
    const page = await spendEvents.list({
      from: params.fromMs,
      to: params.toMs,
      virtualKeyId: params.virtualKeyId,
      limit: WALK_PAGE_SIZE,
      cursor,
    });
    for (const event of page.data) {
      const requestId = event.data.gateway_request_id;
      const existing = byRequest.get(requestId);
      if (existing) existing.push(event);
      else byRequest.set(requestId, [event]);
    }
    // Null next_cursor is the only end of the walk: a full page is not a
    // promise of more, and a short one is not a promise of the end.
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return byRequest;
}

async function main() {
  // --minutes N narrows the reconciled window (default: last 24 hours).
  const args = process.argv.slice(2);
  const minutesIndex = args.indexOf("--minutes");
  const minutes =
    minutesIndex >= 0 ? Number(args[minutesIndex + 1]) : 24 * 60;
  const toMs = Date.now();
  const fromMs = toMs - minutes * 60 * 1000;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();

  const ledger = new Ledger(
    new URL("../ledger.sqlite", import.meta.url).pathname,
  );
  const local = new Map(
    ledger.totalsByVirtualKey(fromIso, toIso).map((r) => [r.virtual_key_id, r]),
  );

  // Windows are epoch milliseconds on every spend route.
  const summaries = await spendEvents.summaries({
    groupBy: "virtual_key",
    from: fromMs,
    to: toMs,
  });

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
    if (match) continue;

    // Checksum diverged: find exactly which requests differ, and repair the
    // ones LangWatch can still answer for.
    const remoteEvents = await walkEvents({
      virtualKeyId: remote.key,
      fromMs,
      toMs,
    });
    const localIds = ledger.requestIds(remote.key, fromIso, toIso);
    const missingLocally = [...remoteEvents.keys()].filter(
      (id) => !localIds.has(id),
    );
    const unknownRemotely = [...localIds].filter((id) => !remoteEvents.has(id));

    let backfilled = 0;
    for (const requestId of missingLocally) {
      for (const event of remoteEvents.get(requestId) ?? []) {
        if (ledger.backfill(event as LedgerEnvelope) === "written") {
          backfilled += 1;
        }
      }
      console.log(`  backfilled from the pull API: ${requestId}`);
    }
    for (const requestId of unknownRemotely) {
      // Nothing to pull: the row exists only here. Either it is outside the
      // window LangWatch was asked about, or it was written by something
      // other than a delivered event. Worth a person's attention, not a
      // silent delete.
      console.log(`  local row LangWatch does not have: ${requestId}`);
    }

    if (backfilled === 0 && missingLocally.length === 0) {
      console.log("  nothing to backfill: the gap is not missing rows");
    } else {
      console.log(
        `  wrote ${backfilled} event(s) covering ${missingLocally.length} request(s)`,
      );
    }

    // Re-read the checksum so the run reports the state it leaves behind,
    // not the state it found.
    const repaired = ledger
      .totalsByVirtualKey(fromIso, toIso)
      .find((row) => row.virtual_key_id === remote.key);
    const nowCount = repaired?.event_count ?? 0;
    const nowNano = repaired?.cost_nano_usd ?? 0;
    const reconciled =
      nowCount === remote.event_count && nowNano === remote.cost.nano_usd;
    console.log(
      `  after backfill: local ${nowCount} / ${nowNano} -> ${
        reconciled ? "RECONCILED" : "STILL DIVERGED"
      }`,
    );
    if (!reconciled) clean = false;
  }
  process.exitCode = clean ? 0 : 1;
}

await main();
