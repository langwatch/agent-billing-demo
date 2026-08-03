import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "./env.js";
import {
  openDb,
  type Agent,
  type AppUser,
  type BillingEvent,
  type Customer,
  type Message,
} from "./db.js";
import {
  ApiError,
  badRequest,
  conflict,
  isUniqueViolation,
  notFound,
  sendError,
  upstreamError,
} from "./errors.js";
import { LiveFeed } from "./events.js";
import { MODELS, metaString, readGatewayFailure, streamChatAsTenant } from "./gateway.js";
import {
  CAPS,
  provisionTenant,
  receiverStatus,
  resetBudget,
  setBudgetLimit,
  virtualKeys,
} from "./langwatch.js";
import { nanoToUsd, nanoToUsdOrNull } from "./money.js";
import { loadBudgetsOrDegrade, loadSeatSpend, usageFor } from "./usage.js";
import {
  DELIVERY_ID_HEADER,
  ingestEnvelope,
  verifySignature,
  type Envelope,
} from "./webhooks.js";

/**
 * ACME Agents: a small agent-platform SaaS that meters and rebills its
 * customers through the LangWatch AI Gateway, with no metering code of its
 * own. Signing up provisions a real virtual key and real budgets, chat
 * rides the gateway on that key, and the meters are driven by the signed
 * billing webhooks this same process receives.
 */
const PORT = Number(process.env.APP_PORT ?? 4100);
const WEBHOOK_SECRET = process.env.APP_WEBHOOK_SECRET ?? "";
const PUBLIC_URL = process.env.APP_PUBLIC_URL ?? `http://localhost:${PORT}`;
const RECEIVER_URL = `${PUBLIC_URL}/webhooks/langwatch`;
const HISTORY_LIMIT = 20;

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(path.join(here, "..", "app.sqlite"));
const feed = new LiveFeed();
const app = express();

// ── The webhook route reads raw bytes; everything else is JSON ──────────
// The signature covers the exact body received, so it has to be captured
// before any parser can re-encode it.

app.post(
  "/webhooks/langwatch",
  express.raw({ type: "*/*", limit: "2mb" }),
  (req, res) => {
    const rawBody = req.body as Buffer;
    if (
      !verifySignature({
        rawBody,
        signatureHeader: req.header("X-LangWatch-Signature"),
        secret: WEBHOOK_SECRET,
      })
    ) {
      console.warn("[webhook] rejected: bad or missing signature");
      return res.status(401).json({
        error: { code: "invalid_signature", message: "Signature check failed." },
      });
    }

    let batch: Envelope[];
    try {
      batch = (JSON.parse(rawBody.toString("utf8")) as { batch?: Envelope[] }).batch ?? [];
    } catch {
      return res.status(400).json({
        error: { code: "invalid_payload", message: "Body is not a JSON batch." },
      });
    }

    // Answer 2xx only after the batch is durably stored: a failed write has
    // to fail the delivery so LangWatch retries it.
    let ingested = 0;
    for (const envelope of batch) {
      const { outcome, row } = ingestEnvelope(db, envelope);
      if (outcome !== "ingested" || !row) continue;
      ingested += 1;
      feed.publish({ kind: "billing_event", event: presentEvent(row) });
    }
    // The delivery id correlates this log line with the delivery log on the
    // LangWatch side. It identifies the DELIVERY, which carries the whole
    // batch, so dedup stays on the envelope ids handled above.
    const deliveryId = req.header(DELIVERY_ID_HEADER) ?? "unknown";
    console.log(
      `[webhook] delivery ${deliveryId}: ${batch.length} delivered, ${ingested} new`,
    );
    res.json({ received: batch.length, ingested });
  },
);

app.use(express.json());

// ── Sign-up ─────────────────────────────────────────────────────────────

app.post("/api/customers", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      throw badRequest("name_required", "Enter a company name to continue.");
    }
    if (name.length > 60) {
      throw badRequest("name_too_long", "Company names are limited to 60 characters.");
    }

    // Look before minting: a name collision must never leave an orphan
    // virtual key behind on the platform.
    const existing = db
      .prepare("SELECT id, name FROM customers WHERE name = ? COLLATE NOCASE")
      .get(name) as { id: number; name: string } | undefined;
    if (existing) {
      throw conflict(
        "customer_exists",
        `A workspace named ${existing.name} already exists.`,
        "Open it instead, or pick a different name.",
        { existing },
      );
    }

    let provisioned;
    try {
      provisioned = await provisionTenant(name);
    } catch (error) {
      throw upstreamError("provision the workspace", error);
    }

    const seatEmail = seatEmailFor(req.body?.email, name);
    let customerId: number;
    try {
      const insert = db.transaction(() => {
        const now = new Date().toISOString();
        const inserted = db
          .prepare(
            `INSERT INTO customers (
               name, virtual_key_id, virtual_key_secret, hard_cap_budget_id,
               soft_cap_budget_id, per_user_budget_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            name,
            provisioned.virtualKeyId,
            provisioned.virtualKeySecret,
            provisioned.hardCapBudgetId,
            provisioned.softCapBudgetId,
            provisioned.perUserBudgetId,
            now,
          );
        const id = Number(inserted.lastInsertRowid);
        db.prepare(
          "INSERT INTO seats (customer_id, email, created_at) VALUES (?, ?, ?)",
        ).run(id, seatEmail, now);
        return id;
      });
      customerId = insert();
    } catch (error) {
      // Two sign-ups raced for the same name. The key minted a moment ago
      // has no owner, so hand it back rather than leaking it.
      await virtualKeys
        .revoke(provisioned.virtualKeyId)
        .catch((revokeError) =>
          console.error("[langwatch:revoke-orphan]", revokeError),
        );
      if (isUniqueViolation(error, "customers.name")) {
        const winner = db
          .prepare("SELECT id, name FROM customers WHERE name = ? COLLATE NOCASE")
          .get(name) as { id: number; name: string } | undefined;
        throw conflict(
          "customer_exists",
          `A workspace named ${name} already exists.`,
          "Open it instead, or pick a different name.",
          winner ? { existing: winner } : undefined,
        );
      }
      throw error;
    }

    const customer = customerSummary(customerId);
    feed.publish({ kind: "customer_created", customer: { ...customer } });
    res.status(201).json({
      customer,
      provisioned: {
        virtual_key_id: provisioned.virtualKeyId,
        hard_cap_usd: Number(CAPS.hardUsd),
        soft_cap_usd: Number(CAPS.softUsd),
        per_seat_cap_usd: Number(CAPS.perSeatUsd),
      },
    });
  } catch (error) {
    sendError(res, error, "signup");
  }
});

app.get("/api/customers", (_req, res) => {
  try {
    res.json({ customers: allCustomerSummaries() });
  } catch (error) {
    sendError(res, error, "list-customers");
  }
});

app.get("/api/customers/:customerId", (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    res.json({
      customer: customerSummary(customer.id),
      seats: db
        .prepare("SELECT id, email FROM seats WHERE customer_id = ? ORDER BY id")
        .all(customer.id),
      agents: db
        .prepare(
          `SELECT id, name, model, system_prompt, created_at
           FROM agents WHERE customer_id = ? ORDER BY id`,
        )
        .all(customer.id),
    });
  } catch (error) {
    sendError(res, error, "workspace");
  }
});

// ── Seats and agents ────────────────────────────────────────────────────

app.post("/api/customers/:customerId/seats", (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) {
      throw badRequest("email_invalid", "Enter a valid email address for the seat.");
    }
    try {
      const inserted = db
        .prepare("INSERT INTO seats (customer_id, email, created_at) VALUES (?, ?, ?)")
        .run(customer.id, email, new Date().toISOString());
      res.status(201).json({ seat: { id: Number(inserted.lastInsertRowid), email } });
    } catch (error) {
      if (isUniqueViolation(error, "seats.email")) {
        throw conflict("seat_exists", `${email} already has a seat here.`);
      }
      throw error;
    }
  } catch (error) {
    sendError(res, error, "add-seat");
  }
});

app.post("/api/customers/:customerId/agents", (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const name = String(req.body?.name ?? "").trim();
    if (!name) throw badRequest("name_required", "Give the agent a name.");
    const model = String(req.body?.model ?? MODELS[0]);
    if (!MODELS.includes(model as (typeof MODELS)[number])) {
      throw badRequest("model_unsupported", `${model} is not available on this plan.`);
    }
    const systemPrompt = String(
      req.body?.system_prompt ?? "You are a concise, helpful assistant.",
    );
    const now = new Date().toISOString();
    const inserted = db
      .prepare(
        `INSERT INTO agents (customer_id, name, system_prompt, model, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(customer.id, name, systemPrompt, model, now);
    res.status(201).json({
      agent: {
        id: Number(inserted.lastInsertRowid),
        name,
        model,
        system_prompt: systemPrompt,
        created_at: now,
      },
    });
  } catch (error) {
    sendError(res, error, "create-agent");
  }
});

app.get("/api/customers/:customerId/agents/:agentId/messages", (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const agent = requireAgent(req.params.agentId, customer.id);
    res.json({
      messages: db
        .prepare(
          `SELECT id, role, content, gateway_request_id, created_at
           FROM messages WHERE agent_id = ? ORDER BY id`,
        )
        .all(agent.id),
    });
  } catch (error) {
    sendError(res, error, "messages");
  }
});

// ── Chat: the request path ──────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  let streaming = false;
  try {
    const agentId = Number(req.body?.agent_id);
    const seatId = Number(req.body?.seat_id);
    const message = String(req.body?.message ?? "").trim();
    if (!message) throw badRequest("message_required", "Type a message first.");

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
      | Agent
      | undefined;
    if (!agent) throw notFound("agent_not_found", "That agent no longer exists.");
    const seat = db.prepare("SELECT * FROM seats WHERE id = ?").get(seatId) as
      | AppUser
      | undefined;
    if (!seat || seat.customer_id !== agent.customer_id) {
      throw notFound("seat_not_found", "That seat does not belong to this workspace.");
    }
    const customer = db
      .prepare("SELECT * FROM customers WHERE id = ?")
      .get(agent.customer_id) as Customer;

    const history = db
      .prepare(
        `SELECT role, content FROM messages WHERE agent_id = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(agent.id, HISTORY_LIMIT) as Array<{ role: "user" | "assistant"; content: string }>;

    let answer = "";
    const meta = await streamChatAsTenant({
      virtualKeySecret: customer.virtual_key_secret,
      model: agent.model,
      systemPrompt: agent.system_prompt,
      history: [
        ...history.reverse().map((row) => ({ role: row.role, content: row.content })),
        { role: "user" as const, content: message },
      ],
      endUserId: seat.email,
      onDelta: (delta) => {
        if (!streaming) {
          startEventStream(res);
          streaming = true;
        }
        answer += delta;
        writeFrame(res, { type: "delta", text: delta });
      },
    });

    // The exchange is stored once the gateway has answered. A rejected
    // request leaves no trace in the transcript, so a customer who was
    // blocked by a cap does not come back to a conversation containing
    // messages that were never delivered.
    const stored = db.transaction(() => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO messages (agent_id, customer_id, user_id, role, content, created_at)
         VALUES (?, ?, ?, 'user', ?, ?)`,
      ).run(agent.id, customer.id, seat.id, message, now);
      return db
        .prepare(
          `INSERT INTO messages (
             agent_id, customer_id, user_id, role, content, gateway_request_id, created_at
           ) VALUES (?, ?, ?, 'assistant', ?, ?, ?)`,
        )
        .run(agent.id, customer.id, seat.id, answer, meta.gatewayRequestId, now);
    })();

    feed.publish({
      kind: "chat_request",
      customer_id: customer.id,
      gateway_request_id: meta.gatewayRequestId,
    });

    if (!streaming) startEventStream(res);
    writeFrame(res, {
      type: "done",
      message_id: Number(stored.lastInsertRowid),
      content: answer,
      gateway_request_id: meta.gatewayRequestId,
      input_tokens: meta.inputTokens,
      output_tokens: meta.outputTokens,
    });
    res.end();
  } catch (error) {
    const failure = chatFailure(error);
    if (!streaming) {
      return sendError(res, failure, "chat");
    }
    // Tokens were already on the wire, so the failure has to ride the same
    // stream. The browser renders it as the error state either way.
    writeFrame(res, { type: "error", error: failure.body().error });
    res.end();
  }
});

/**
 * Budget breaches come back from the gateway as 402 with machine-readable
 * meta saying WHICH cap ran out: `budget_scope: "attributed_user"` is this
 * seat's allowance, `"virtual_key"` is the whole workspace's cap. That
 * distinction is the difference between "you hit your limit" and "your
 * company hit its limit", so it survives all the way to the screen.
 *
 * Scope kinds and windows are lowercase snake on the wire, so the branch
 * below matches one spelling and does not normalize anything first.
 */
function chatFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const details = readGatewayFailure(error);
  if (details?.code === "budget_exceeded") {
    const scope = metaString(details.meta, "budget_scope");
    const perSeat = scope === "attributed_user";
    return new ApiError(
      402,
      "budget_exceeded",
      perSeat
        ? "You have used up your personal AI allowance for this period."
        : "Your workspace has reached its AI budget for this period.",
      perSeat
        ? "Your allowance resets at the start of next month."
        : "An admin can close the billing period to admit traffic again.",
      {
        budget_scope: scope,
        budget_id: metaString(details.meta, "budget_id"),
        budget_window: metaString(details.meta, "budget_window"),
      },
    );
  }
  if (details?.code === "end_user_required") {
    return new ApiError(
      400,
      "end_user_required",
      "This workspace requires every request to be attributed to a seat.",
      "Pick a seat before sending.",
    );
  }
  if (details) {
    console.error("[gateway]", details);
    return new ApiError(
      502,
      details.code,
      "The model gateway refused this request.",
      details.message,
    );
  }
  return upstreamError("reach the model gateway", error);
}

function startEventStream(res: Response) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function writeFrame(res: Response, frame: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

// ── Usage, events and the live feed ─────────────────────────────────────

app.get("/api/customers/:customerId/usage", async (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const { data, degraded } = await loadBudgetsOrDegrade();
    const seatSpend = await loadSeatSpend(data);
    res.json(
      usageFor(db, {
        virtualKeyId: customer.virtual_key_id,
        seats: seatEmails(customer.id),
        budgetData: data,
        seatSpend,
        degraded,
      }),
    );
  } catch (error) {
    sendError(res, error, "usage");
  }
});

app.get("/api/customers/:customerId/billing-events", (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    res.json({
      events: recentEvents(limitOf(req, 25), customer.virtual_key_id),
    });
  } catch (error) {
    sendError(res, error, "billing-events");
  }
});

app.get("/api/events", (req, res) => {
  try {
    res.json({ events: recentEvents(limitOf(req, 50)) });
  } catch (error) {
    sendError(res, error, "events");
  }
});

app.get("/api/events/stream", (_req, res) => {
  feed.subscribe(res);
});

// ── Owner console ───────────────────────────────────────────────────────

app.get("/api/admin/overview", async (_req, res) => {
  try {
    const { data, degraded } = await loadBudgetsOrDegrade();
    const seatSpend = await loadSeatSpend(data);
    const customers = allCustomerSummaries();
    const rows = customers.map((customer) => ({
      customer,
      usage: usageFor(db, {
        virtualKeyId: customer.virtual_key_id,
        seats: seatEmails(customer.id),
        budgetData: data,
        seatSpend,
        degraded,
      }),
    }));

    const eventCount = db
      .prepare("SELECT COUNT(*) AS count FROM billing_events")
      .get() as { count: number };
    const lastEvent = db
      .prepare("SELECT received_at FROM billing_events ORDER BY received_at DESC LIMIT 1")
      .get() as { received_at: string } | undefined;

    let receiver = {
      registered: false,
      url: RECEIVER_URL,
      events_ingested: eventCount.count,
      last_event_at: lastEvent?.received_at ?? null,
      status: null as string | null,
      last_success_at: null as string | null,
    };
    try {
      const status = await receiverStatus(RECEIVER_URL);
      receiver = {
        ...receiver,
        registered: status.registered,
        status: status.status,
        last_success_at: status.lastSuccessAt,
      };
    } catch (error) {
      console.error("[langwatch:webhooks.list]", error);
    }

    // Totalled over the nano-USD integers and converted once: adding the
    // per-tenant dollar figures instead would drift from the platform's own
    // total by a little more with every tenant.
    const totalNanoUsd = rows.reduce(
      (sum, row) => sum + row.usage.ledger.cost_nano_usd,
      0,
    );
    res.json({
      customers: rows,
      totals: {
        customers: rows.length,
        requests: rows.reduce((sum, row) => sum + row.usage.ledger.requests, 0),
        cost_nano_usd: totalNanoUsd,
        cost_usd: nanoToUsd(totalNanoUsd),
        events: eventCount.count,
      },
      receiver,
      degraded,
    });
  } catch (error) {
    sendError(res, error, "admin-overview");
  }
});

/**
 * Close a billing period. Reset moves the manual window's boundary; it
 * never mutates recorded spend, so the ledger and every emitted event stay
 * immutable and reconciliation is unaffected by a period close.
 */
app.post("/api/customers/:customerId/close-period", async (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const target = String(req.body?.budget ?? "all");
    // Closing a period moves the manual window boundary. The per-seat
    // allowance rides a month window and rolls over on its own, so it is
    // deliberately left alone: closing the company's books does not hand
    // every employee a fresh personal allowance.
    const caps = (await customerBudgets(customer)).filter(
      (budget) =>
        budget.window === "manual" &&
        (target === "all" ||
          (target === "hard" ? budget.on_breach === "block" : budget.on_breach === "warn")),
    );
    if (caps.length === 0) {
      throw notFound(
        "budget_not_found",
        "This workspace has no manual-window cap to reset.",
      );
    }

    const reset: string[] = [];
    for (const budget of caps) {
      try {
        await resetBudget(budget.id, "ACME Agents period close");
        reset.push(budget.on_breach === "block" ? "hard cap" : "soft cap");
        feed.publish({
          kind: "budget_reset",
          customer_id: customer.id,
          budget: budget.name,
        });
      } catch (error) {
        throw upstreamError(`reset ${budget.name}`, error);
      }
    }
    res.json({ reset, customer_id: customer.id });
  } catch (error) {
    sendError(res, error, "close-period");
  }
});

/**
 * Move a customer's cap. The owner console uses this to put a workspace on
 * a different plan; the platform keeps the window and the recorded spend,
 * so raising a limit admits traffic again with the books intact.
 */
app.post("/api/customers/:customerId/budgets/:budgetId/limit", async (req, res) => {
  try {
    const customer = requireCustomer(req.params.customerId);
    const budgetId = String(req.params.budgetId);
    const owned = await customerBudgets(customer);
    if (!owned.some((budget) => budget.id === budgetId)) {
      throw notFound("budget_not_found", "That cap does not belong to this workspace.");
    }
    const limit = Number(req.body?.limit_usd);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw badRequest("limit_invalid", "Enter a limit greater than zero.");
    }
    try {
      // The limit crosses as a decimal string, which is how the API takes an
      // amount; what comes back is read as the canonical integer.
      const updated = await setBudgetLimit(budgetId, limit.toFixed(6));
      res.json({
        budget_id: updated.id,
        limit_nano_usd: updated.limit_nano_usd,
        limit_usd: nanoToUsdOrNull(updated.limit_nano_usd),
      });
    } catch (error) {
      throw upstreamError("update the cap", error);
    }
  } catch (error) {
    sendError(res, error, "set-cap");
  }
});

app.get("/api/health", async (_req, res) => {
  const health = {
    app: "ok",
    webhook_secret: WEBHOOK_SECRET ? "configured" : "missing",
    receiver_url: RECEIVER_URL,
    langwatch: "unknown" as string,
  };
  try {
    await loadBudgetsOrDegrade().then((result) => {
      health.langwatch = result.degraded ? "degraded" : "ok";
    });
  } catch {
    health.langwatch = "unreachable";
  }
  res.json(health);
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * The caps that apply to a workspace, resolved from the platform rather
 * than from the ids stored at sign-up. Budgets live on LangWatch, so the
 * platform is the source of truth: a cap added or replaced there is
 * managed here too, and a workspace provisioned by an earlier revision
 * still gets every one of its caps reset.
 */
async function customerBudgets(customer: Customer) {
  const { data } = await loadBudgetsOrDegrade();
  if (!data) {
    throw upstreamError("read this workspace's caps", new Error("budgets unavailable"));
  }
  const perKey = data.perKey.get(customer.virtual_key_id) ?? [];
  const template = data.perSeatTemplate.get(customer.virtual_key_id);
  return template ? [...perKey, template] : perKey;
}

function requireCustomer(raw: string | undefined): Customer {
  const customer = db
    .prepare("SELECT * FROM customers WHERE id = ?")
    .get(Number(raw)) as Customer | undefined;
  if (!customer) {
    throw notFound("customer_not_found", "That workspace does not exist.");
  }
  return customer;
}

function requireAgent(raw: string | undefined, customerId: number): Agent {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(Number(raw)) as
    | Agent
    | undefined;
  if (!agent || agent.customer_id !== customerId) {
    throw notFound("agent_not_found", "That agent does not exist in this workspace.");
  }
  return agent;
}

function customerSummary(id: number) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.virtual_key_id, c.created_at,
              (SELECT COUNT(*) FROM agents WHERE customer_id = c.id) AS agent_count,
              (SELECT COUNT(*) FROM seats WHERE customer_id = c.id) AS seat_count
       FROM customers c WHERE c.id = ?`,
    )
    .get(id) as {
    id: number;
    name: string;
    virtual_key_id: string;
    created_at: string;
    agent_count: number;
    seat_count: number;
  };
}

function allCustomerSummaries() {
  return db
    .prepare(
      `SELECT c.id, c.name, c.virtual_key_id, c.created_at,
              (SELECT COUNT(*) FROM agents WHERE customer_id = c.id) AS agent_count,
              (SELECT COUNT(*) FROM seats WHERE customer_id = c.id) AS seat_count
       FROM customers c ORDER BY c.id`,
    )
    .all() as ReturnType<typeof customerSummary>[];
}

function seatEmails(customerId: number): string[] {
  return (
    db
      .prepare("SELECT email FROM seats WHERE customer_id = ?")
      .all(customerId) as Array<{ email: string }>
  ).map((row) => row.email);
}

function limitOf(req: Request, fallback: number) {
  const parsed = Number(req.query.limit);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : fallback;
}

const customerNameByKey = () =>
  new Map(
    (
      db.prepare("SELECT name, virtual_key_id FROM customers").all() as Array<{
        name: string;
        virtual_key_id: string;
      }>
    ).map((row) => [row.virtual_key_id, row.name] as const),
  );

function recentEvents(limit: number, virtualKeyId?: string) {
  const rows = virtualKeyId
    ? (db
        .prepare(
          `SELECT * FROM billing_events WHERE virtual_key_id = ?
           ORDER BY received_at DESC, rowid DESC LIMIT ?`,
        )
        .all(virtualKeyId, limit) as BillingEvent[])
    : (db
        .prepare(
          "SELECT * FROM billing_events ORDER BY received_at DESC, rowid DESC LIMIT ?",
        )
        .all(limit) as BillingEvent[]);
  const names = customerNameByKey();
  return rows.map((row) => presentEvent(row, names));
}

function presentEvent(row: BillingEvent, names = customerNameByKey()) {
  const payload = JSON.parse(row.payload) as {
    data?: { error?: { class?: string } | null };
  };
  return {
    event_id: row.event_id,
    type: row.type,
    gateway_request_id: row.gateway_request_id,
    virtual_key_id: row.virtual_key_id,
    customer_name: row.virtual_key_id ? (names.get(row.virtual_key_id) ?? null) : null,
    end_user_id: row.end_user_id,
    model: row.model,
    status: row.status,
    // A rejected request bills nothing, so the reason it was rejected is
    // the only useful figure on that row.
    error_class: payload.data?.error?.class ?? null,
    cost_nano_usd: row.cost_nano_usd,
    cost_usd: nanoToUsdOrNull(row.cost_nano_usd),
    occurred_at: row.occurred_at,
    received_at: row.received_at,
    payload: payload as unknown,
  };
}

/** The first seat: the address given at sign-up, or one derived from the name. */
function seatEmailFor(raw: unknown, companyName: string): string {
  const provided = String(raw ?? "").trim().toLowerCase();
  if (provided.includes("@")) return provided;
  const slug =
    companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "workspace";
  return `owner@${slug}.example`;
}

// ── Static hosting for the browser app ──────────────────────────────────

const webRoot = path.join(here, "..", "web", "dist");
if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  // Client-side routes resolve to the same document; the API and the
  // webhook route are already matched above.
  app.get(/^\/(?!api\/|webhooks\/).*/, (_req, res) => {
    res.sendFile(path.join(webRoot, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(503)
      .type("text/plain")
      .send("The browser app is not built yet. Run: pnpm --filter @acme/app build");
  });
}

app.listen(PORT, () => {
  console.log(`ACME Agents running on ${PUBLIC_URL}`);
  if (!WEBHOOK_SECRET) {
    console.warn(
      "APP_WEBHOOK_SECRET is not set: billing events will be rejected.\n" +
        "Register this app's receiver and store the secret:\n" +
        "  pnpm --filter @acme/app exec tsx ../scripts/register-app-webhook.ts",
    );
  }
});
