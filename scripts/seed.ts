import path from "node:path";
import { fileURLToPath } from "node:url";
import "../app/src/env.js";
import { openDb } from "../app/src/db.js";
import { provisionTenant } from "../app/src/langwatch.js";

/**
 * Seed two fictional tenants, each with a seat and an agent, provisioning
 * each one on LangWatch exactly like sign-up does. Run once after
 * `pnpm install`; needs LANGWATCH_API_KEY in the environment.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(path.join(here, "..", "app", "app.sqlite"));

const TENANTS = [
  {
    name: "ACME Corp",
    seat: "wile@acme.example",
    agent: { name: "Support Bot", model: "openai/gpt-5-mini" },
  },
  {
    name: "Globex Inc",
    seat: "hank@globex.example",
    agent: { name: "Sales Bot", model: "openai/gpt-5-mini" },
  },
];

for (const tenant of TENANTS) {
  const existing = db
    .prepare("SELECT id FROM customers WHERE name = ?")
    .get(tenant.name);
  if (existing) {
    console.log(`${tenant.name} already seeded; skipping.`);
    continue;
  }
  const provisioned = await provisionTenant(tenant.name);
  const now = new Date().toISOString();
  const customer = db
    .prepare(
      `INSERT INTO customers (
         name, virtual_key_id, virtual_key_secret, hard_cap_budget_id,
         soft_cap_budget_id, per_user_budget_id, langwatch_project_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      tenant.name,
      provisioned.virtualKeyId,
      provisioned.virtualKeySecret,
      provisioned.hardCapBudgetId,
      provisioned.softCapBudgetId,
      provisioned.perUserBudgetId,
      provisioned.projectId ?? "",
      now,
    );
  const customerId = Number(customer.lastInsertRowid);
  db.prepare(
    "INSERT INTO seats (customer_id, email, created_at) VALUES (?, ?, ?)",
  ).run(customerId, tenant.seat, now);
  db.prepare(
    `INSERT INTO agents (customer_id, name, system_prompt, model, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    customerId,
    tenant.agent.name,
    "You are a helpful assistant. Keep answers short.",
    tenant.agent.model,
    now,
  );
  console.log(
    `Seeded ${tenant.name}: VK ${provisioned.virtualKeyId}, hard cap ${provisioned.hardCapBudgetId}` +
      (provisioned.projectId ? `, project ${provisioned.projectId}` : ""),
  );
}
