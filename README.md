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
- **Reconciliation**: aggregate checksums first, cursor diff only on divergence.
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
`budget_scope`: a personal allowance and a company cap are different problems.

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
provisioning, cap reads, budget resets, and reconciliation are SDK calls, never
hand-rolled HTTP. Only the wire-contract modules (signature verification and
the webhook receivers) stay dependency-free on purpose: they document the raw
contract a consumer without an SDK implements.

The integration surfaces exist twice, one per language, each self-contained:

| Surface | TypeScript | Python |
|---|---|---|
| Signature verification | `ts/src/verify-signature.ts` | `python/verify_signature.py` |
| Webhook receiver | `ts/src/receiver.ts` | `python/receiver.py` |
| Billing ledger | `ts/src/ledger.ts` | `python/ledger.py` |
| Reconciliation | `ts/src/reconcile.ts` | `python/reconcile.py` |
| Provisioning | `ts/src/provision.ts` | `python/provision.py` |
| App shell | `app/` (Express + React, :4100) | `python/app.py` (FastAPI, :4200) |

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

### Reconciling

```bash
pnpm reconcile:ts         # or: python python/reconcile.py
```

Exit code 0 means every virtual key's local totals match LangWatch's checksums
for the last 24 hours. Delete a row from `ts/ledger.sqlite` and run it again to
watch the cursor diff name exactly the missing request id.

### The edges worth trying

- **Breach**: chat until a cap trips, or lower one from the owner console. The
  UI distinguishes "your allowance" from "your company's cap" using the 402's
  `budget_scope`, and the message you tried to send is handed back for a retry.
- **Period close**: the owner console resets the MANUAL-window caps. Traffic
  admits again, the ledger keeps every recorded row, and the MONTH-window seat
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
    App->>LW: POST /budgets {VIRTUAL_KEY, MANUAL, $5, BLOCK}
    App->>LW: POST /budgets {VIRTUAL_KEY, MANUAL, $2.50, WARN}
    App->>LW: POST /budgets {ATTRIBUTED_USER, MONTH, $1, BLOCK}
    App->>App: store {vk id, secret, budget ids} on the customer row
    App-->>Browser: 201, redirect into the dashboard
    Note over App,GW: from here the tenant chats via the gateway<br/>with its own key; seats need NO provisioning,<br/>their buckets appear on first spend
```

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
    LW->>RX: POST batch {gateway.request.completed} signed t=,v1=
    RX->>RX: verify HMAC over raw body (5 min tolerance)
    RX->>UI: ingest (dedup by event id), push over SSE
    Note over LW,RX: a request whose confirmation never arrived is delivered<br/>as gateway.request.settled with null cost; if the real completion<br/>arrives later it SUPERSEDES the settled row: replace, never sum

    App->>GW: chat until a cap is crossed
    GW-->>App: 402 {code: budget_exceeded, budget_scope, budget_id}
    LW->>RX: gateway.budget.threshold_crossed, then gateway.budget.breached
    Note over App: budget_scope tells the app whether to say<br/>"your allowance ran out" (attributed_user)<br/>or "your company's cap ran out" (virtual_key)

    App->>LW: POST /api/gateway/v1/budgets/:id/reset  (period close)
    Note over LW: reset moves the MANUAL window boundary;<br/>recorded spend and emitted events are immutable
    App->>GW: traffic admits again
```

## The rules this code follows

Worth internalizing before you adapt it:

1. **Verify the raw bytes.** The HMAC covers the exact body received. Parse
   after verification, never before.
2. **Dedup by `event_id`.** Delivery is at-least-once; ingest must be
   idempotent. Event ids are stable across retries and replays.
3. **Completed supersedes settled.** Replace, never sum, joined on
   `gateway_request_id`. This app picks the winner at read time, so both
   envelopes stay archived.
4. **Money is integer nano-USD.** Sum integers; round exactly once at display
   or invoice time. Never parse floats for money.
5. **Show the figure the platform enforces.** Caps and their spend are read
   back from LangWatch, so a seat can never sit at "37% used" on screen while
   the gateway is already refusing its requests.
6. **Checksums before walks.** One `spend-summaries` call reconciles the common
   case; the cursor walk is only for divergence.
7. **Answer 2xx only after durable ingest.** A failed database write should
   fail the delivery so LangWatch retries it.
8. **Never leak a driver error.** Every failure crosses the wire as
   `{"error": {"code", "message", "hint"}}` and reaches the person as a
   sentence they can act on.

## License

MIT. All tenant names fictional.
