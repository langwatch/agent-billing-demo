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
 * Where deliveries go: an HTTPS route each shell hosts, or an Amazon SQS queue
 * each shell drains. `DEMO_TRANSPORT` picks, and the queue URLs come from
 * APP_QUEUE_URL and APP_PY_QUEUE_URL.
 */
const TRANSPORT = process.env.DEMO_TRANSPORT ?? "http";
if (TRANSPORT !== "http" && TRANSPORT !== "sqs") {
  console.error(`DEMO_TRANSPORT=${TRANSPORT} is not a transport; use http or sqs.`);
  process.exit(1);
}

/**
 * The receivers this repository runs, each with the variable its shell reads
 * its secret from. A shell that is not running still gets an endpoint, which
 * costs nothing and means starting it later needs no second setup step.
 */
const RECEIVERS = [
  {
    shell: "TypeScript app",
    url: `${process.env.APP_PUBLIC_URL ?? `http://localhost:${process.env.APP_PORT ?? "4100"}`}/webhooks/langwatch`,
    queueUrl: process.env.APP_QUEUE_URL ?? "",
    envKey: "APP_WEBHOOK_SECRET",
  },
  {
    shell: "python app",
    url: `${process.env.APP_PY_PUBLIC_URL ?? `http://localhost:${process.env.APP_PY_PORT ?? "4200"}`}/webhooks/langwatch`,
    queueUrl: process.env.APP_PY_QUEUE_URL ?? "",
    envKey: "PY_APP_WEBHOOK_SECRET",
  },
];

/**
 * How LangWatch proves it may WRITE to the queue.
 *
 * This is not the same credential the consumers read with. The consumers run
 * here and use the usual AWS chain; LangWatch runs somewhere else and needs
 * an identity of its own. A role to assume is the better answer, because
 * nothing long-lived is stored and the trust policy stays yours to revoke.
 *
 * Only a deployment that has turned ambient credentials on can take a queue
 * with no credentials at all, and no shared deployment does: on that path
 * one tenant could name another tenant's queue. So a queue endpoint against
 * LangWatch Cloud always carries one of these two.
 */
function queueCredentials() {
  const roleArn = process.env.DEMO_SQS_ROLE_ARN ?? "";
  const externalId = process.env.DEMO_SQS_EXTERNAL_ID ?? "";
  const accessKeyId = process.env.DEMO_SQS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.DEMO_SQS_SECRET_ACCESS_KEY ?? "";

  if (roleArn) {
    return {
      role_arn: roleArn,
      ...(externalId ? { external_id: externalId } : {}),
    };
  }
  if (accessKeyId && secretAccessKey) {
    return { access_key_id: accessKeyId, secret_access_key: secretAccessKey };
  }
  return null;
}

/** The address this run registers, and the shape the create body takes. */
function destinationOf(receiver: (typeof RECEIVERS)[number]) {
  if (TRANSPORT !== "sqs") {
    return { address: receiver.url, body: { url: receiver.url } };
  }
  if (!receiver.queueUrl) {
    console.error(
      `DEMO_TRANSPORT=sqs but the ${receiver.shell} has no queue URL. ` +
        "Set APP_QUEUE_URL and APP_PY_QUEUE_URL in .env.",
    );
    process.exit(1);
  }
  const credentials = queueCredentials();
  if (!credentials) {
    console.error(
      "DEMO_TRANSPORT=sqs needs credentials LangWatch can write the queue with. " +
        "Set DEMO_SQS_ROLE_ARN (and DEMO_SQS_EXTERNAL_ID) for a role to assume, " +
        "or DEMO_SQS_ACCESS_KEY_ID with DEMO_SQS_SECRET_ACCESS_KEY.",
    );
    process.exit(1);
  }
  return {
    address: receiver.queueUrl,
    body: {
      destination_kind: "sqs" as const,
      sqs: { queue_url: receiver.queueUrl, ...credentials },
    },
  };
}

if (!process.env.LANGWATCH_API_KEY) {
  console.error("LANGWATCH_API_KEY is not set. Fill in .env first.");
  process.exit(1);
}

// One listing covers every receiver, so registering both shells is one read
// plus the writes each of them needs.
const endpoints = await webhooks.list();

for (const receiver of RECEIVERS) {
  const { address, body } = destinationOf(receiver);
  // Match on whichever address this endpoint actually carries. Matching on
  // `url` alone would never find a queue endpoint, so every run would mint
  // another one.
  const existing = endpoints.find(
    (endpoint) => (endpoint.sqs?.queue_url ?? endpoint.url) === address,
  );
  const result = existing
    ? await webhooks.rollSecret(existing.id)
    : // Endpoint bodies are the wire shape: lowercase snake, in and out.
      await webhooks.create({ ...body, enabled_events: BILLING_EVENTS });

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
    `${existing ? "Rolled the secret for" : "Registered"} ${address}\n` +
      `  shell:    ${receiver.shell}\n` +
      `  endpoint: ${result.id}\n` +
      `  events:   ${BILLING_EVENTS.join(", ")}\n` +
      `  secret:   stored in .env as ${receiver.envKey}\n`,
  );
}

console.log("Restart the app shells so they pick their secrets up.");
