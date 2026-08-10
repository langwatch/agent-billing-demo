/**
 * Register the app shells' own webhook endpoints and store their signing
 * secrets.
 *
 * Each shell receives its billing events in-process, so each one needs an
 * endpoint pointing at itself: the TypeScript app on APP_PORT and the python
 * app on APP_PY_PORT. Both are registered in one run:
 *
 *   pnpm setup:webhook
 *
 * Re-running is safe: an endpoint already registered for the same URL has its
 * secret rolled, which is also how you recover from a lost secret. The secrets
 * are written into `.env` as APP_WEBHOOK_SECRET and PY_APP_WEBHOOK_SECRET, and
 * printed so you can store them wherever your deployment keeps secrets.
 */
import "../app/src/env.js";
import { webhooks } from "../app/src/langwatch.js";
import { writeEnv } from "./env-file.js";

const BILLING_EVENTS = [
  "gateway.request.completed",
  "gateway.request.settled",
  "gateway.budget.threshold_crossed",
  "gateway.budget.breached",
  "gateway.virtual_key.disabled",
  "gateway.virtual_key.enabled",
];

/**
 * The receivers this repository runs, each with the variable its shell reads
 * its secret from. A shell that is not running still gets an endpoint, which
 * costs nothing and means starting it later needs no second setup step.
 */
const RECEIVERS = [
  {
    shell: "TypeScript app",
    url: `${process.env.APP_PUBLIC_URL ?? `http://localhost:${process.env.APP_PORT ?? "4100"}`}/webhooks/langwatch`,
    envKey: "APP_WEBHOOK_SECRET",
  },
  {
    shell: "python app",
    url: `${process.env.APP_PY_PUBLIC_URL ?? `http://localhost:${process.env.APP_PY_PORT ?? "4200"}`}/webhooks/langwatch`,
    envKey: "PY_APP_WEBHOOK_SECRET",
  },
];

if (!process.env.LANGWATCH_API_KEY) {
  console.error("LANGWATCH_API_KEY is not set. Fill in .env first.");
  process.exit(1);
}

// One listing covers every receiver, so registering both shells is one read
// plus the writes each of them needs.
const endpoints = await webhooks.list();

for (const receiver of RECEIVERS) {
  const existing = endpoints.find((endpoint) => endpoint.url === receiver.url);
  const result = existing
    ? await webhooks.rollSecret(existing.id)
    : // Endpoint bodies are the wire shape: lowercase snake, in and out.
      await webhooks.create({ url: receiver.url, enabled_events: BILLING_EVENTS });

  if (existing) {
    // Rolling only replaces the secret, so make sure the event list and the
    // status are what this app expects even if the endpoint predates it.
    await webhooks.update(existing.id, {
      enabled_events: BILLING_EVENTS,
      status: "active",
    });
    // The secret just replaced stays valid for a day, and deliveries in flight
    // are signed with both. Keeping it lets the receiver verify either one
    // instead of refusing everything signed a moment before the roll.
    const outgoing = process.env[receiver.envKey];
    if (outgoing) writeEnv(`${receiver.envKey}_PREVIOUS`, outgoing);
  }

  writeEnv(receiver.envKey, result.secret);

  console.log(
    `${existing ? "Rolled the secret for" : "Registered"} ${receiver.url}\n` +
      `  shell:    ${receiver.shell}\n` +
      `  endpoint: ${result.id}\n` +
      `  events:   ${BILLING_EVENTS.join(", ")}\n` +
      `  secret:   stored in .env as ${receiver.envKey}\n`,
  );
}

console.log("Restart the app shells so they pick their secrets up.");
