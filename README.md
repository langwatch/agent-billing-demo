# ACME Agents: metering and rebilling through the LangWatch AI Gateway

A deliberately small agent-platform SaaS: customers sign up, create agents,
and chat with them. The platform meters every LLM call and rebills its
customers, and it does so with **zero metering code of its own**. Everything
hard is delegated to [LangWatch](https://langwatch.ai):

- **Provisioning**: signing up a customer mints one virtual key (the tenant
  boundary), a hard cap, a soft cap, and a per-end-user allowance, all over
  REST with one org API key.
- **Request path**: the chat calls the gateway on the OpenAI wire with the
  `user` field set. That one field is all the attribution the whole billing
  pipeline needs.
- **Billing**: a local ledger is fed exclusively by LangWatch's signed
  webhooks. If the numbers on screen are right, the pipeline works end to
  end.
- **Reconciliation**: aggregate checksums first, cursor diff only on
  divergence.
- **Period close**: an explicit budget reset that never mutates recorded
  spend.

This repo is the canonical integration example our docs point at. If you are
building the same shape of platform, point your coding agent at this repo
and at the [migration guide](https://docs.langwatch.ai/ai-gateway/billing-events);
every file is written to be copied from.

## Layout

```
app/       the SaaS shell (TypeScript + Express): signup, agents, chat UI
ts/        the integration surfaces in TypeScript
python/    the SAME integration surfaces in Python
scripts/   seed two fictional tenants
```

The integration surfaces exist twice on purpose, one per language, each
self-contained:

| Surface | TypeScript | Python |
|---|---|---|
| Signature verification | `ts/src/verify-signature.ts` | `python/verify_signature.py` |
| Webhook receiver | `ts/src/receiver.ts` | `python/receiver.py` |
| Billing ledger | `ts/src/ledger.ts` | `python/ledger.py` |
| Reconciliation | `ts/src/reconcile.ts` | `python/reconcile.py` |
| Provisioning | `ts/src/provision.ts` | `python/provision.py` |

## How a customer comes to exist

```mermaid
sequenceDiagram
    participant Browser
    participant App as ACME Agents app
    participant LW as LangWatch REST
    participant GW as AI Gateway

    Browser->>App: POST /api/customers {name}
    App->>LW: POST /api/gateway/v1/virtual-keys
    LW-->>App: {virtual_key.id, secret}  (secret shown once)
    App->>LW: POST /budgets {VIRTUAL_KEY, MANUAL, $5, BLOCK}
    App->>LW: POST /budgets {VIRTUAL_KEY, MANUAL, $2.50, WARN}
    App->>LW: POST /budgets {ATTRIBUTED_USER, MONTH, $1, BLOCK}
    App->>App: store {vk id, secret, budget ids} on the customer row
    Note over App,GW: from here the tenant chats via the gateway<br/>with its own key; end users need NO provisioning,<br/>their buckets appear on first spend
```

## How money flows (and what happens at the edges)

```mermaid
sequenceDiagram
    participant App as ACME Agents app
    participant GW as AI Gateway
    participant LW as LangWatch
    participant RX as Webhook receiver (ts/ or python/)
    participant L as Local ledger

    App->>GW: POST /v1/chat/completions (VK secret, user: end-user id)
    GW-->>App: response + X-LangWatch-Gateway-Request-Id
    LW->>RX: POST batch {gateway.request.completed} signed t=,v1=
    RX->>RX: verify HMAC over raw body (5 min tolerance)
    RX->>L: ingest (dedup by event id)
    Note over LW,RX: a request whose confirmation never arrived is delivered<br/>as gateway.request.settled with null cost; if the real completion<br/>arrives later it SUPERSEDES the settled row: replace, never sum

    App->>GW: chat until the tenant's $5 hard cap is crossed
    GW-->>App: 402 {code: budget_exceeded, budget_scope, budget_id}
    LW->>RX: gateway.budget.threshold_crossed, then gateway.budget.breached
    Note over App: budget_scope tells the app whether to say<br/>"your allowance ran out" (attributed_user)<br/>or "your organization's cap ran out" (virtual_key)

    App->>LW: POST /api/gateway/v1/budgets/:id/reset  (period close)
    Note over LW: reset moves the MANUAL window boundary;<br/>recorded spend and emitted events are immutable
    App->>GW: traffic admits again
```

## Running it

You need a LangWatch instance (any: local dev, self-hosted, or cloud) and an
org API key with gateway permissions.

```bash
cp .env.example .env      # fill in LANGWATCH_API_KEY and the URLs
pnpm install

# 1. register the webhook receivers as endpoints, once each:
pnpm provision:ts -- --register-webhook http://localhost:4101/webhooks/langwatch
#    put the returned secret in TS_WEBHOOK_SECRET in .env
python python/provision.py --register-webhook http://localhost:4102/webhooks/langwatch
#    put the returned secret in PY_WEBHOOK_SECRET in .env

# 2. seed two fictional tenants (ACME Corp, Globex Inc):
pnpm seed

# 3. run everything:
pnpm dev                  # the app shell on :4100
pnpm receiver:ts          # TS receiver on :4101
pip install -r python/requirements.txt
python python/receiver.py # Python receiver on :4102
```

Open http://localhost:4100, pick ACME Corp, and chat. Watch both receiver
terminals: every request lands in both ledgers, signed and deduped.

### Reconciling

```bash
pnpm reconcile:ts         # or: python python/reconcile.py
```

Exit code 0 means every virtual key's local totals match LangWatch's
checksums for the last 24 hours. Delete a row from `ts/ledger.sqlite` and run
it again to watch the cursor diff name exactly the missing request id.

### The edges worth trying

- **Breach**: chat until the hard cap trips. The UI distinguishes "your
  allowance" from "your organization's cap" using the 402's `budget_scope`.
- **Period close**: the "Close billing period" button resets the MANUAL
  window; traffic admits again, the ledger keeps every recorded row.
- **Tamper**: `curl -X POST localhost:4101/webhooks/langwatch -d '{}'` and
  watch the receiver reject the unsigned body.

## The rules this code follows

Worth internalizing before you adapt it:

1. **Verify the raw bytes.** The HMAC covers the exact body received. Parse
   after verification, never before.
2. **Dedup by `event_id`.** Delivery is at-least-once; ingest must be
   idempotent. Event ids are stable across retries and replays.
3. **Completed supersedes settled.** Replace, never sum, joined on
   `gateway_request_id`.
4. **Money is integer nano-USD.** Sum integers; round exactly once at
   invoice time. Never parse floats for money.
5. **Checksums before walks.** One `spend-summaries` call reconciles the
   common case; the cursor walk is only for divergence.
6. **Answer 2xx only after durable ingest.** A failed database write should
   fail the delivery so LangWatch retries it.

## License

MIT. All tenant names fictional.
