/**
 * Register the app's own webhook endpoint and store its signing secret.
 *
 * The demo app receives its billing events in-process, so it needs one
 * endpoint pointing at itself. Run this once per environment:
 *
 *   pnpm setup:webhook
 *
 * Re-running is safe: an endpoint already registered for the same URL has
 * its secret rolled, which is also how you recover from a lost secret. The
 * secret is written into `.env` as APP_WEBHOOK_SECRET, and printed so you
 * can store it wherever your deployment keeps secrets.
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

const port = process.env.APP_PORT ?? "4100";
const publicUrl = process.env.APP_PUBLIC_URL ?? `http://localhost:${port}`;
const url = `${publicUrl}/webhooks/langwatch`;

if (!process.env.LANGWATCH_API_KEY) {
  console.error("LANGWATCH_API_KEY is not set. Fill in .env first.");
  process.exit(1);
}

const existing = (await webhooks.list()).find((endpoint) => endpoint.url === url);
const result = existing
  ? await webhooks.rollSecret(existing.id)
  : // Endpoint bodies are the wire shape: lowercase snake, in and out.
    await webhooks.create({ url, enabled_events: BILLING_EVENTS });

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
  const outgoing = process.env.APP_WEBHOOK_SECRET;
  if (outgoing) writeEnv("APP_WEBHOOK_SECRET_PREVIOUS", outgoing);
}

writeEnv("APP_WEBHOOK_SECRET", result.secret);

console.log(
  `${existing ? "Rolled the secret for" : "Registered"} ${url}\n` +
    `  endpoint: ${result.id}\n` +
    `  events:   ${BILLING_EVENTS.join(", ")}\n` +
    `  secret:   stored in .env as APP_WEBHOOK_SECRET\n\n` +
    "Restart the app so it picks the secret up.",
);
