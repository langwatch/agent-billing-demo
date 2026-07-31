import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../app/src/db.js";
import { provisionTenant } from "../ts/src/provision.js";

/**
 * Seed two fictional tenants, each with a user and an agent, provisioning
 * each one on LangWatch exactly like the signup flow does. Run once after
 * `pnpm install`; needs LANGWATCH_API_KEY in the environment.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const db = openDb(path.join(here, "..", "app", "app.sqlite"));

const TENANTS = [
  {
    name: "ACME Corp",
    user: "wile@acme.example",
    agent: { name: "Support Bot", model: "openai/gpt-4o-mini" },
  },
  {
    name: "Globex Inc",
    user: "hank@globex.example",
    agent: { name: "Sales Bot", model: "openai/gpt-4o-mini" },
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
  const customer = db
    .prepare(
      `INSERT INTO customers (name, virtual_key_id, virtual_key_secret, hard_cap_budget_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      tenant.name,
      provisioned.virtualKeyId,
      provisioned.virtualKeySecret,
      provisioned.hardCapBudgetId,
    );
  db.prepare("INSERT INTO users (customer_id, email) VALUES (?, ?)").run(
    customer.lastInsertRowid,
    tenant.user,
  );
  db.prepare(
    "INSERT INTO agents (customer_id, name, system_prompt, model) VALUES (?, ?, ?, ?)",
  ).run(
    customer.lastInsertRowid,
    tenant.agent.name,
    "You are a helpful assistant. Keep answers short.",
    tenant.agent.model,
  );
  console.log(
    `Seeded ${tenant.name}: VK ${provisioned.virtualKeyId}, hard cap ${provisioned.hardCapBudgetId}`,
  );
}
