import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type Agent, type AppUser, type Customer } from "./db.js";
import { chatAsTenant } from "./gateway.js";

/**
 * The ACME Agents app shell: a deliberately small agent-platform SaaS.
 * Customers sign up, add users, create agents, and chat. Every chat call
 * goes through the LangWatch gateway on the customer's virtual key with
 * the end user attributed, which is what makes metering, budgets, and
 * billing events work with no metering code in this app at all.
 */
const PORT = Number(process.env.APP_PORT ?? 4100);
const BASE_URL = process.env.LANGWATCH_BASE_URL ?? "http://localhost:5560";
const API_KEY = process.env.LANGWATCH_API_KEY ?? "";
const PROJECT_ID = process.env.LANGWATCH_PROJECT_ID ?? "";

const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(path.join(here, "..", "app.sqlite"));
const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "..", "public")));

// ── Signup: create the customer AND provision it on LangWatch ───────────

app.post("/api/customers", async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  // Provisioning is the same four calls documented in ts/src/provision.ts;
  // inlined here so signup is one readable handler.
  const post = async (p: string, body: unknown) => {
    const r = await fetch(`${BASE_URL}${p}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(PROJECT_ID ? { "X-Project-Id": PROJECT_ID } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`${p} answered ${r.status}: ${await r.text()}`);
    return r.json();
  };

  try {
    const minted = (await post("/api/gateway/v1/virtual-keys", {
      name,
      description: `Tenant key for ${name} (acme-agents signup)`,
    })) as { virtual_key: { id: string }; secret: string };
    const vkId = minted.virtual_key.id;

    const hardCap = (await post("/api/gateway/v1/budgets", {
      scope: { kind: "VIRTUAL_KEY", virtual_key_id: vkId },
      name: `${name} hard cap`,
      window: "MANUAL",
      limit_usd: "5.00",
      on_breach: "BLOCK",
    })) as { budget: { id: string } };

    await post("/api/gateway/v1/budgets", {
      scope: { kind: "VIRTUAL_KEY", virtual_key_id: vkId },
      name: `${name} soft cap`,
      window: "MANUAL",
      limit_usd: "2.50",
      on_breach: "WARN",
    });

    await post("/api/gateway/v1/budgets", {
      scope: { kind: "ATTRIBUTED_USER", anchor_virtual_key_id: vkId },
      name: `${name} per-user allowance`,
      window: "MONTH",
      limit_usd: "1.00",
      on_breach: "BLOCK",
    });

    const inserted = db
      .prepare(
        `INSERT INTO customers (name, virtual_key_id, virtual_key_secret, hard_cap_budget_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(name, vkId, minted.secret, hardCap.budget.id);
    res.status(201).json({ id: inserted.lastInsertRowid, name, virtual_key_id: vkId });
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
});

app.get("/api/customers", (_req, res) => {
  const rows = db
    .prepare("SELECT id, name, virtual_key_id FROM customers ORDER BY id")
    .all();
  res.json({ customers: rows });
});

// ── Users and agents: plain CRUD, nothing LangWatch-specific ────────────

app.post("/api/customers/:customerId/users", (req, res) => {
  const email = String(req.body.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  const inserted = db
    .prepare("INSERT INTO users (customer_id, email) VALUES (?, ?)")
    .run(Number(req.params.customerId), email);
  res.status(201).json({ id: inserted.lastInsertRowid, email });
});

app.post("/api/customers/:customerId/agents", (req, res) => {
  const inserted = db
    .prepare(
      "INSERT INTO agents (customer_id, name, system_prompt, model) VALUES (?, ?, ?, ?)",
    )
    .run(
      Number(req.params.customerId),
      String(req.body.name ?? "Assistant"),
      String(req.body.system_prompt ?? "You are a helpful assistant."),
      String(req.body.model ?? "openai/gpt-4o-mini"),
    );
  res.status(201).json({ id: inserted.lastInsertRowid });
});

app.get("/api/customers/:customerId/overview", (req, res) => {
  const customerId = Number(req.params.customerId);
  const users = db
    .prepare("SELECT id, email FROM users WHERE customer_id = ?")
    .all(customerId);
  const agents = db
    .prepare("SELECT id, name, model FROM agents WHERE customer_id = ?")
    .all(customerId);
  res.json({ users, agents });
});

// ── Chat: the request path ──────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  const { agent_id, user_id, message } = req.body as {
    agent_id: number;
    user_id: number;
    message: string;
  };
  const agent = db
    .prepare("SELECT * FROM agents WHERE id = ?")
    .get(agent_id) as Agent | undefined;
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(user_id) as AppUser | undefined;
  if (!agent || !user) return res.status(404).json({ error: "unknown agent or user" });
  const customer = db
    .prepare("SELECT * FROM customers WHERE id = ?")
    .get(agent.customer_id) as Customer;

  try {
    const reply = await chatAsTenant({
      virtualKeySecret: customer.virtual_key_secret,
      model: agent.model,
      systemPrompt: agent.system_prompt,
      userMessage: String(message ?? ""),
      endUserId: user.email,
    });
    res.json(reply);
  } catch (error: unknown) {
    // Budget breaches come back as 402 with machine-readable meta that
    // says WHICH cap ran out: `budget_scope: "attributed_user"` is this
    // user's allowance, `budget_scope: "virtual_key"` is the whole
    // tenant's cap. Surface the distinction; it is the difference between
    // "you hit your limit" and "your organization hit its limit".
    const details = extractGatewayError(error);
    if (details?.code === "budget_exceeded") {
      const scope = details.meta?.budget_scope;
      return res.status(402).json({
        error:
          scope === "attributed_user"
            ? "You have used up your personal AI allowance for this period."
            : "Your organization's AI budget is exhausted for this period.",
        code: details.code,
        budget_scope: scope ?? null,
        budget_id: details.meta?.budget_id ?? null,
      });
    }
    if (details?.code === "end_user_required") {
      return res.status(400).json({
        error: "This platform requires end-user attribution on every call.",
        code: details.code,
      });
    }
    res.status(502).json({ error: String(error) });
  }
});

/**
 * ai-sdk wraps provider errors; the gateway's error body rides on
 * `responseBody` as JSON: `{error: {code, message, ...meta}}` style. Parse
 * defensively and return null for anything unrecognized.
 */
function extractGatewayError(
  error: unknown,
): { code: string; meta?: Record<string, string> } | null {
  if (typeof error !== "object" || error === null) return null;
  const body = Reflect.get(error, "responseBody");
  if (typeof body !== "string") return extractGatewayError(Reflect.get(error, "cause"));
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const inner = (parsed.error ?? parsed) as Record<string, unknown>;
    const code = inner.code ?? inner.type;
    if (typeof code !== "string") return null;
    // The machine-readable detail (budget_scope, budget_id, ...) rides
    // under error.meta on the gateway's wire.
    const meta: Record<string, string> = {};
    const metaSource =
      typeof inner.meta === "object" && inner.meta !== null ? inner.meta : inner;
    for (const [key, value] of Object.entries(metaSource)) {
      if (typeof value === "string") meta[key] = value;
    }
    return { code, meta };
  } catch {
    return null;
  }
}

// ── Billing period close: the reset button ──────────────────────────────

app.post("/api/customers/:customerId/close-period", async (req, res) => {
  const customer = db
    .prepare("SELECT * FROM customers WHERE id = ?")
    .get(Number(req.params.customerId)) as Customer | undefined;
  if (!customer) return res.status(404).json({ error: "unknown customer" });

  // Reset moves the MANUAL window's boundary. It never mutates recorded
  // spend: the ledger and every emitted event stay immutable, which is
  // why reconciliation is unaffected by period closes.
  const r = await fetch(
    `${BASE_URL}/api/gateway/v1/budgets/${customer.hard_cap_budget_id}/reset`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(PROJECT_ID ? { "X-Project-Id": PROJECT_ID } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "acme-agents period close" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!r.ok) {
    return res.status(502).json({ error: `reset answered ${r.status}` });
  }
  res.json({ closed: true });
});

app.listen(PORT, () => {
  console.log(`ACME Agents running on http://localhost:${PORT}`);
});
