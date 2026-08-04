# ACME Agents: metering and rebilling through the LangWatch AI Gateway

A small agent-platform SaaS, complete enough to be believable: customers sign
up, create agents, chat with them, and watch what they are spending. The
platform meters every LLM call and rebills its customers, and it does so with
**zero metering code of its own**. Everything hard is delegated to
[LangWatch](https://langwatch.ai):

- **Provisioning**: signing up a customer mints one virtual key (the tenant
  boundary), a hard cap, a soft cap, and a per-seat allowance, through the
  official LangWatch SDKs (TypeScript and Python) with one org API key.
- **Request path**: chat calls the gateway on the OpenAI wire with the `user`
  field set. That one field is all the attribution the whole billing pipeline
  needs.
- **Billing**: the meters on screen are fed by LangWatch's signed webhooks and
  its budget APIs. If the numbers are right, the pipeline works end to end.
- **Reconciliation**: aggregate checksums first, cursor diff only on
  divergence, and the same walk backfills whatever the books are missing.
- **Period close**: an explicit budget reset that never mutates recorded spend.

This repo is the canonical integration example our docs point at. If you are
building the same shape of platform, point your coding agent at this repo and
at the [migration guide](https://docs.langwatch.ai/ai-gateway/billing-events);
every file is written to be copied from.

## What it looks like

Sign-up provisions the tenant on LangWatch and drops straight into the
dashboard, so the customer sees the outcome instead of a spinner:

![Sign-up lands in the dashboard with the workspace provisioned](https://raw.githubusercontent.com/langwatch/pr-screenshots/main/billing-events-platform/demo-app-signup.png)

The workspace: agents on the left, a streaming chat in the middle, and a usage
meter underneath showing real spend against the real caps, with the signed
billing events that produced those numbers below it.

![Customer dashboard with chat, usage meter and billing events](https://raw.githubusercontent.com/langwatch/pr-screenshots/main/billing-events-platform/demo-app-dashboard.png)

When a cap is reached the customer gets a sentence, not a stack trace, and the
message stays in the box so it can be retried. The wording follows the 402's
`error.meta.budget_scope`: a personal allowance and a company cap are
different problems.

![A blocked request explained in the customer's own terms](https://raw.githubusercontent.com/langwatch/pr-screenshots/main/billing-events-platform/demo-app-budget-blocked.png)

The SaaS owner console is the behind-the-scenes view: every customer, their
caps and spend, per-seat allowances, the reset and cap actions, receiver
health, and a live feed of billing events as they are delivered.

![Owner console with every customer, their caps and the live event feed](https://raw.githubusercontent.com/langwatch/pr-screenshots/main/billing-events-platform/demo-app-owner-console.png)

The developer panel keeps every raw envelope one click away, next to the two
snippets that are the whole integration.

![Developer panel with the request path, the webhook contract and raw envelopes](https://raw.githubusercontent.com/langwatch/pr-screenshots/main/billing-events-platform/demo-app-developer.png)

## Layout

```
app/         the SaaS itself (:4100)
  src/       Express API, the gateway request path, the in-process webhook receiver
  web/       the browser app (React + Tailwind, built by Vite)
ts/          the integration surfaces in TypeScript (standalone receiver on :4101)
python/      the SAME integration surfaces in Python (receiver on :4102),
             plus the SaaS shell again as one FastAPI process (:4200)
scripts/     seed two fictional tenants, register the app's webhook endpoint
```

Both app shells consume the official LangWatch SDK for their language:
zero hand-rolled HTTP and zero hand-rolled crypto. Provisioning, cap reads,
budget resets and reconciliation are SDK calls, and so is the one piece of
security-critical code an integration used to write itself: webhook signatures
are verified by the SDK's own verifier, which takes every secret the receiver
currently holds so a rotation never drops a delivery.

The integration surfaces exist twice, one per language, each self-contained:

| Surface | TypeScript | Python |
|---|---|---|
| Webhook receiver | `ts/src/receiver.ts` | `python/receiver.py` |
| Billing ledger | `ts/src/ledger.ts` | `python/ledger.py` |
| Reconciliation | `ts/src/reconcile.ts` | `python/reconcile.py` |
| Provisioning | `ts/src/provision.ts` | `python/provision.py` |
| App shell | `app/` (Express + React, :4100) | `python/app.py` (FastAPI, :4200) |

The two app shells are split the same way, so a module can be read beside its
twin: routes (`app/src/server.ts` / `python/app.py`), the gateway request path
(`gateway.ts` / `gateway.py`), every platform call (`langwatch.ts` /
`platform_api.py`), the meters (`usage.ts` / `usage.py`), the error envelope
(`errors.ts` / `errors.py`), the SSE fan-out (`events.ts` / `live_feed.py`),
the webhook archive (`webhooks.ts` / `webhook_ingest.py`), the schema
(`db.ts` / `store.py`) and the money rules (`money.ts` / `money.py`).

The app also hosts its own receiver at `app/src/webhooks.ts`, which is what
makes the meters move on their own: an ingested event is written, then pushed
to the browser over Server-Sent Events in the same breath.

## Running it

You need a LangWatch instance (local dev, self-hosted, or cloud) and an org API
key with gateway permissions.

```bash
cp .env.example .env      # fill in LANGWATCH_API_KEY, LANGWATCH_PROJECT_ID and the URLs
pnpm install

pnpm setup:webhook        # registers this app's receiver, writes APP_WEBHOOK_SECRET to .env
pnpm build                # builds the browser app into app/web/dist
pnpm dev                  # ACME Agents on http://localhost:4100
```

Open http://localhost:4100, create a workspace, add an agent, and chat. The
usage meter fills from the billing events the gateway delivers to this same
process.

Optional extras:

```bash
pnpm seed                 # two fictional tenants, already provisioned
pnpm dev:web              # Vite with hot reload on :4300, proxying the API to :4100
pnpm receiver:ts          # the standalone TypeScript receiver on :4101
python python/receiver.py # the standalone Python receiver on :4102
```

### The same browser app, either backend

The two app shells implement the same HTTP contract on purpose: same paths,
same request bodies, same response shapes, same status codes, and the same
`{"error": {"code", "message", "hint"}}` envelope. The React app in `app/web`
is one bundle, and it cannot tell which one it is talking to. Sign-up, the
streaming chat, the live meters, the event feed, the owner console and the
period close all work against either.

```bash
pnpm dev                  # TypeScript app on :4100, serving the UI at :4100
pnpm dev:python           # Python app on :4200, serving the same UI at :4200
```

Both serve the built bundle from `app/web/dist`, so each port is a complete
app on its own. For hot reload, Vite runs on :4300 and proxies to whichever
backend you point it at:

```bash
pnpm dev:web              # :4300 against the TypeScript app
pnpm dev:web:python       # :4300 against the Python app
```

`DEMO_API_TARGET` is the knob underneath, a full origin, so any other target
works too:

```bash
DEMO_API_TARGET=http://localhost:4200 pnpm dev:web
```

The two shells keep separate databases (`app/app.sqlite` and
`python/app_py.sqlite`) and separate webhook endpoints, so a tenant signed up
on one does not appear on the other. Everything they read back, the caps, the
spend and the delivered billing events, comes from the same LangWatch project.

### Reconciling

```bash
pnpm reconcile:ts         # or: python python/reconcile.py
```

Exit code 0 means every virtual key's local totals match LangWatch's checksums
for the last 24 hours. Delete a row from `ts/ledger.sqlite` and run it again to
watch the cursor diff name exactly the missing request id, pull it back from
`GET /api/gateway/v1/spend-events`, write it into the local ledger, and re-read
the checksum as reconciled.

Reconciliation repairs by PULLING, never by asking for a redelivery. A
replayed envelope carries its original id, and every receiver dedups on ids
forever, so replaying a window your receiver has already seen is a guaranteed
no-op no matter what is missing from your books. `POST /spend-events/replay`
is a redelivery test tool, for proving an endpoint receives and verifies what
it is sent. It is not a repair.

### The edges worth trying

- **Breach**: chat until a cap trips, or lower one from the owner console. The
  UI distinguishes "your allowance" from "your company's cap" using the 402's
  `error.meta.budget_scope`, and the message you tried to send is handed back
  for a retry.
- **Period close**: the owner console resets the manual-window caps. Traffic
  admits again, the ledger keeps every recorded row, and the month-window seat
  allowances are left to roll over on their own.
- **Switch customer**: the account menu swaps agents, transcripts, meter and
  event feed together. Nothing is shared between tenants but the code.
- **Tamper**: `curl -X POST localhost:4100/webhooks/langwatch -d '{}'` and watch
  the receiver reject the unsigned body.

## How a customer comes to exist

```mermaid
sequenceDiagram
    participant Browser
    participant App as ACME Agents app
    participant LW as LangWatch REST
    participant GW as AI Gateway

    Browser->>App: POST /api/customers {name, email}
    App->>LW: POST /api/gateway/v1/virtual-keys
    LW-->>App: {virtual_key.id, secret}  (secret shown once)
    App->>LW: POST /budgets {virtual_key, manual, $5, block}
    App->>LW: POST /budgets {virtual_key, manual, $2.50, warn}
    App->>LW: POST /budgets {attributed_user, month, $1, block, cycle_anchor_at: now}
    App->>App: store {vk id, secret, budget ids} on the customer row
    App-->>Browser: 201, redirect into the dashboard
    Note over App,GW: from here the tenant chats via the gateway<br/>with its own key; seats need NO provisioning,<br/>their buckets appear on first spend
```

Every one of those four creates carries an idempotency key derived from the
customer's name, so a double-submitted form or a retry after a timeout returns
the SAME key and the SAME budgets rather than a second set, and the app says so
instead of reporting a fresh provisioning. The monthly seat allowance carries a
`cycle_anchor_at` of the signup instant, so the customer's billing period runs
from the day they started rather than from the calendar first, and the usage
meter shows the dates.

A name that is already taken never reaches the platform: the app checks first,
answers `409 {"error": {"code": "customer_exists"}}` with the existing
workspace, and offers to open it. If two sign-ups race past that check, the key
minted a moment earlier is revoked rather than left orphaned.

## How money flows (and what happens at the edges)

```mermaid
sequenceDiagram
    participant App as ACME Agents app
    participant GW as AI Gateway
    participant LW as LangWatch
    participant RX as Webhook receiver
    participant UI as Usage meter

    App->>GW: POST /v1/chat/completions (VK secret, user: seat email)
    GW-->>App: streamed response + X-LangWatch-Gateway-Request-Id
    LW->>RX: POST batch {gateway.request.completed} signed t=,v1=[,v1=]
    RX->>RX: verify HMAC over raw body (5 min tolerance, any v1 may match)
    RX->>UI: ingest (dedup by envelope id), push over SSE
    Note over LW,RX: a request whose confirmation never arrived is delivered<br/>as gateway.request.settled with null cost; if the real completion<br/>arrives later it SUPERSEDES the settled row: replace, never sum

    App->>GW: chat until a cap is crossed
    GW-->>App: 402 {error: {code: budget_exceeded, meta: {budget_scope, budget_id, budget_window}}}
    LW->>RX: gateway.budget.threshold_crossed, then gateway.budget.breached
    Note over App: meta.budget_scope tells the app whether to say<br/>"your allowance ran out" (attributed_user)<br/>or "your company's cap ran out" (virtual_key)
    Note over LW,RX: budget events name their tenant directly:<br/>virtual_key_id and anchor_project_id are first-class

    App->>LW: POST /api/gateway/v1/budgets/:id/reset  (period close)
    Note over LW: reset moves the manual window boundary;<br/>recorded spend and emitted events are immutable
    App->>GW: traffic admits again
```

## The rules this code follows

Worth internalizing before you adapt it:

1. **Verify the raw bytes with the SDK verifier.** `verifyWebhookSignature`
   (`verify_webhook_signature` in python) covers the exact body received, so
   parse after verification and never before. Hand it every secret the
   receiver currently holds: `v1` repeats while a secret is rotating, one per
   currently valid secret, and the delivery is good when any of them matches.
   It throws rather than returning false, so a delivery cannot be trusted by
   forgetting to read a return value, and the error's `code` says which check
   failed (`malformed_header`, `stale_timestamp`, `invalid_signature`).
2. **Dedup by the envelope `id`.** Delivery is at-least-once; ingest must be
   idempotent. Ids are stable across retries and replays.
   `X-LangWatch-Delivery-Id` names the DELIVERY, which carries a whole batch,
   so it is a log correlation handle and never the dedup key.
3. **Completed supersedes settled.** Replace, never sum, joined on
   `gateway_request_id`. This app picks the winner at read time, so both
   envelopes stay archived.
4. **Money is integer nano-USD.** Every row carries `*_nano_usd` beside the
   `*_usd` display string. Read and sum the integer; convert exactly once, at
   the edge, where a figure becomes something a person looks at. Never parse
   a float out of the string. A spend figure the platform could not total
   arrives as null and must stay null: rendering it as $0.00 is a number the
   reader takes for real money.
5. **Show the figure the platform enforces.** Caps and their spend are read
   back from LangWatch, so a seat can never sit at "37% used" on screen while
   the gateway is already refusing its requests.
6. **Checksums before walks, and pull to repair.** One `spend-summaries` call
   reconciles the common case; the cursor walk is only for divergence, and it
   carries the full envelopes, so it also repairs. Never reach for a replay to
   fix your books.
7. **Answer 2xx only after durable ingest.** A failed database write should
   fail the delivery so LangWatch retries it.
8. **One error shape, read once.** Every LangWatch refusal crosses the wire as
   `{"error": {"type", "code", "message", "meta"?}}`, where `type` and `code`
   carry the same value and `meta` holds the machine-readable detail for that
   code. Read that shape; do not write a parser that tolerates several. This
   app's own API answers its browser in its own shape,
   `{"error": {"code", "message", "hint"}}`, so a person always gets a
   sentence they can act on and a driver error never leaks.
9. **Enums are lowercase snake, in and out.** Scope kinds
   (`virtual_key`, `attributed_user`, `organization`, `project`,
   `principal`, `group`, `team`), windows (`manual`, `month`, ...),
   `on_breach` (`block`, `warn`) and virtual key status
   (`active`, `disabled`, `revoked`). Uppercase is rejected on create, so
   there is one spelling to send and one to match on. The webhook ENDPOINT
   status is a separate enum on a separate surface and is still
   `ACTIVE` / `DISABLED`.
10. **Spend windows are epoch milliseconds.** `from` and `to` on every spend
    route are integer milliseconds, not ISO strings.

## License

MIT. All tenant names fictional.
