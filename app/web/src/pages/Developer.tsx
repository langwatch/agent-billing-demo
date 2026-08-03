import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiFailure,
  type BillingEventView,
  type CustomerSummary,
} from "../api";
import { EventLog } from "../components/EventLog";
import { Shell } from "../components/Shell";
import { Badge, Card, ErrorNote, Spinner } from "../components/ui";
import { useLiveFeed } from "../liveFeed";
import { useSession } from "../session";

/**
 * The developer view. The audience for this product reads JSON, so the raw
 * envelopes stay one click away, next to the three calls that make the
 * whole integration.
 */
export function Developer() {
  const { customerId } = useSession();
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [events, setEvents] = useState<BillingEventView[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const { frames, revision } = useLiveFeed();

  const active = useMemo(
    () => customers.find((customer) => customer.id === customerId) ?? null,
    [customers, customerId],
  );

  const load = useCallback(async () => {
    try {
      const [customerBody, eventBody] = await Promise.all([
        api.get<{ customers: CustomerSummary[] }>("/api/customers"),
        api.get<{ events: BillingEventView[] }>("/api/events?limit=60"),
      ]);
      setCustomers(customerBody.customers);
      setEvents(eventBody.events);
    } catch (error) {
      setFailure(
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "Could not load the developer view."),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (revision === 0) return;
    if (frames.some((frame) => frame.kind === "billing_event")) void load();
  }, [revision, frames, load]);

  const keyPlaceholder = active
    ? `$${active.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_VK_SECRET`
    : "$TENANT_VK_SECRET";

  return (
    <Shell customers={customers} activeCustomer={active}>
      <div className="mx-auto max-w-7xl space-y-6">
        {failure && <ErrorNote error={failure} />}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            title="The request path"
            subtitle="The tenant's virtual key plus one attribution field"
          >
            <Snippet
              code={`curl $LANGWATCH_GATEWAY_URL/v1/chat/completions \\
  -H "Authorization: Bearer ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "hello"}],
    "user": "owner@workspace.example"
  }'`}
            />
            <p className="mt-3 text-xs text-slate-500">
              The response carries{" "}
              <code className="font-mono">X-LangWatch-Gateway-Request-Id</code>, the
              same id that keys every billing event below.
            </p>
          </Card>

          <Card
            title="The billing webhook"
            subtitle="Verify the raw bytes, dedup by envelope id, answer 2xx after the write"
          >
            <Snippet
              code={`POST /webhooks/langwatch
X-LangWatch-Delivery-Id: <delivery id>
X-LangWatch-Signature: t=<unix>,v1=<hex hmac sha256>[,v1=<previous>]

{"batch": [
  {"id": "<request id>:completed",
   "type": "gateway.request.completed",
   "schema_version": "1",
   "data": {"gateway_request_id": "...",
            "virtual_key_id": "vk_...",
            "end_user_id": "owner@workspace.example",
            "cost": {"nano_usd": 5100},
            "usage": {"input_tokens": 26, "output_tokens": 2}}}
]}`}
            />
            <p className="mt-3 text-xs text-slate-500">
              The HMAC covers{" "}
              <code className="font-mono">{"`${t}.${rawBody}`"}</code>. Parse after
              verifying, never before. While a secret is rotating,{" "}
              <code className="font-mono">v1</code> repeats once per valid secret
              and any match accepts. The delivery id names the whole batch, so
              dedup on each envelope&rsquo;s own{" "}
              <code className="font-mono">id</code>.
            </p>
          </Card>
        </div>

        <Card
          title="Billing event stream"
          subtitle="Every envelope this app has ingested, expandable to raw JSON"
          action={
            <Badge tone={events && events.length > 0 ? "brand" : "neutral"}>
              {events?.length ?? 0} events
            </Badge>
          }
        >
          {events === null ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Loading events
            </div>
          ) : (
            <EventLog
              events={events}
              showCustomer
              className="max-h-[32rem]"
              emptyHint="No events ingested yet. Send a chat message and one lands here within a second."
            />
          )}
        </Card>
      </div>
    </Shell>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <pre className="scroll-slim overflow-x-auto rounded-lg bg-slate-900 px-4 py-3 font-mono text-[11px] leading-relaxed text-slate-200">
      {code}
    </pre>
  );
}
