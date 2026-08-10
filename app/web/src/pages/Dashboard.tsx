import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  ApiFailure,
  type Agent,
  type BillingEventView,
  type ChatMessage,
  type CustomerSummary,
  type UsageView,
  type WorkspaceView,
} from "../api";
import { EventLog } from "../components/EventLog";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { UsageMeter } from "../components/UsageMeter";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorNote,
  Field,
  inputClass,
  Spinner,
} from "../components/ui";
import { useLiveFeed } from "../liveFeed";
import { useSession } from "../session";

const MODELS = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini (fast, cheap)" },
  { id: "openai/gpt-4o", label: "GPT-4o (most capable)" },
  { id: "anthropic/claude-3-5-haiku-latest", label: "Claude 3.5 Haiku" },
];

interface PendingMessage {
  role: "assistant";
  content: string;
  streaming: true;
}

export function Dashboard() {
  const { customerId, signIn } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { frames, revision } = useLiveFeed();

  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [events, setEvents] = useState<BillingEventView[]>([]);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const [activeAgentId, setActiveAgentId] = useState<number | null>(null);
  const [activeSeatId, setActiveSeatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatFailure, setChatFailure] = useState<ApiFailure | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);

  const activeCustomer = useMemo(
    () => customers.find((customer) => customer.id === customerId) ?? null,
    [customers, customerId],
  );
  const activeAgent = useMemo(
    () => workspace?.agents.find((agent) => agent.id === activeAgentId) ?? null,
    [workspace, activeAgentId],
  );

  // ── Loading ───────────────────────────────────────────────────────────

  const loadCustomers = useCallback(async () => {
    const body = await api.get<{ customers: CustomerSummary[] }>("/api/customers");
    setCustomers(body.customers);
    return body.customers;
  }, []);

  const loadUsage = useCallback(async (id: number) => {
    setUsageLoading(true);
    try {
      const [usageBody, eventsBody] = await Promise.all([
        api.get<UsageView>(`/api/customers/${id}/usage`),
        api.get<{ events: BillingEventView[] }>(
          `/api/customers/${id}/billing-events?limit=25`,
        ),
      ]);
      setUsage(usageBody);
      setEvents(eventsBody.events);
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!customerId) {
      navigate("/signin", { replace: true });
      return;
    }
    let cancelled = false;
    setWorkspace(null);
    setUsage(null);
    setEvents([]);
    setMessages([]);
    setPending(null);
    setChatFailure(null);
    setLoadFailure(null);

    (async () => {
      try {
        const list = await loadCustomers();
        if (cancelled) return;
        if (!list.some((customer) => customer.id === customerId)) {
          // The stored workspace is gone; fall back to the first one.
          if (list.length > 0) signIn(list[0]!.id);
          else navigate("/signup", { replace: true });
          return;
        }
        const view = await api.get<WorkspaceView>(`/api/customers/${customerId}`);
        if (cancelled) return;
        setWorkspace(view);
        setActiveAgentId(view.agents[0]?.id ?? null);
        setActiveSeatId(view.seats[0]?.id ?? null);
        await loadUsage(customerId);
      } catch (error) {
        if (cancelled) return;
        setLoadFailure(
          error instanceof ApiFailure
            ? error
            : new ApiFailure(0, "unexpected_error", "Could not load the workspace."),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [customerId, loadCustomers, loadUsage, navigate, signIn]);

  // A signed billing event for this tenant means the meter is stale.
  const virtualKeyId = activeCustomer?.virtual_key_id;
  useEffect(() => {
    if (!customerId || !virtualKeyId || revision === 0) return;
    const relevant = frames.some(
      (frame) =>
        frame.kind === "billing_event" &&
        frame.event?.virtual_key_id === virtualKeyId,
    );
    if (relevant) void loadUsage(customerId);
  }, [revision, customerId, virtualKeyId, frames, loadUsage]);

  // ── Messages ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!activeAgentId || !customerId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ messages: ChatMessage[] }>(
        `/api/customers/${customerId}/agents/${activeAgentId}/messages`,
      )
      .then((body) => {
        if (!cancelled) setMessages(body.messages);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeAgentId, customerId]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  async function createAgent(input: {
    name: string;
    system_prompt: string;
    model: string;
  }) {
    if (!customerId) return;
    const body = await api.post<{ agent: Agent }>(
      `/api/customers/${customerId}/agents`,
      input,
    );
    setWorkspace((current) =>
      current ? { ...current, agents: [...current.agents, body.agent] } : current,
    );
    setActiveAgentId(body.agent.id);
    setCreatingAgent(false);
    toast.success(`${body.agent.name} is live`, `Running on ${body.agent.model}.`);
    void loadCustomers();
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeAgentId || !activeSeatId || !customerId) return;
    setDraft("");
    setChatFailure(null);
    setSending(true);
    setMessages((current) => [
      ...current,
      {
        id: -Date.now(),
        role: "user",
        content: text,
        gateway_request_id: null,
        created_at: new Date().toISOString(),
      },
    ]);
    setPending({ role: "assistant", content: "", streaming: true });

    try {
      await streamChat({
        agentId: activeAgentId,
        seatId: activeSeatId,
        message: text,
        onDelta: (delta) =>
          setPending((current) =>
            current ? { ...current, content: current.content + delta } : current,
          ),
        onDone: (final) => {
          setPending(null);
          setMessages((current) => [
            ...current.filter((message) => message.id > 0 || message.role === "user"),
            {
              id: final.message_id,
              role: "assistant",
              content: final.content,
              gateway_request_id: final.gateway_request_id,
              created_at: new Date().toISOString(),
            },
          ]);
        },
      });
    } catch (error) {
      setPending(null);
      // The message was never delivered, so take it back out of the
      // transcript and hand the text back for a retry.
      setMessages((current) => current.filter((message) => message.id > 0));
      setDraft(text);
      const failure =
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "The message could not be sent.");
      setChatFailure(failure);
      if (failure.code === "budget_exceeded") {
        // The 402 names the cap that ran out. A cap on the workspace's own
        // project stops everyone here, so the toast says so instead of
        // leaving the reader to guess whose budget it was.
        const scope = (failure.details as { budget_scope?: string } | undefined)
          ?.budget_scope;
        toast.error(
          scope === "project" ? "Workspace budget reached" : "Budget reached",
          failure.message,
        );
      } else {
        toast.error("Message failed", failure.message);
      }
    } finally {
      setSending(false);
      if (customerId) void loadUsage(customerId);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Shell customers={customers} activeCustomer={activeCustomer}>
      {loadFailure ? (
        <ErrorNote
          error={loadFailure}
          action={
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        />
      ) : !workspace ? (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading workspace
        </div>
      ) : (
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-1">
              <Card
                title="Agents"
                subtitle={`${workspace.agents.length} in this workspace`}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => setCreatingAgent((value) => !value)}
                  >
                    {creatingAgent ? "Cancel" : "New agent"}
                  </Button>
                }
                bodyClassName="space-y-3"
              >
                {creatingAgent && (
                  <AgentForm
                    onCancel={() => setCreatingAgent(false)}
                    onCreate={createAgent}
                  />
                )}
                {workspace.agents.length === 0 && !creatingAgent ? (
                  <EmptyState
                    title="No agents yet"
                    body="Create one to start a conversation. It takes a name, a prompt and a model."
                    action={
                      <Button onClick={() => setCreatingAgent(true)}>
                        Create your first agent
                      </Button>
                    }
                  />
                ) : (
                  <ul className="space-y-1.5">
                    {workspace.agents.map((agent) => (
                      <li key={agent.id}>
                        <button
                          type="button"
                          onClick={() => setActiveAgentId(agent.id)}
                          className={cx(
                            "w-full rounded-lg px-3 py-2.5 text-left transition",
                            agent.id === activeAgentId
                              ? "bg-brand-50 ring-1 ring-inset ring-brand-200"
                              : "hover:bg-slate-50",
                          )}
                        >
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {agent.name}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-xs text-slate-500">
                            {agent.model}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Seats"
                subtitle="Every request is billed to the seat that made it"
              >
                <ul className="space-y-1.5">
                  {workspace.seats.map((seat) => (
                    <li key={seat.id}>
                      <button
                        type="button"
                        onClick={() => setActiveSeatId(seat.id)}
                        className={cx(
                          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition",
                          seat.id === activeSeatId
                            ? "bg-slate-100 font-medium text-slate-900"
                            : "text-slate-600 hover:bg-slate-50",
                        )}
                      >
                        <span className="truncate">{seat.email}</span>
                        {seat.id === activeSeatId && <Badge tone="brand">you</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>

            <Card
              className="flex h-[32rem] flex-col lg:col-span-2"
              bodyClassName="flex min-h-0 flex-1 flex-col p-0"
              title={activeAgent ? activeAgent.name : "Chat"}
              subtitle={
                activeAgent
                  ? `${activeAgent.model} via the LangWatch gateway`
                  : "Create an agent to start talking"
              }
              action={
                activeAgent && (
                  <Badge tone="neutral" className="font-mono">
                    {workspace.seats.find((seat) => seat.id === activeSeatId)?.email ??
                      "no seat"}
                  </Badge>
                )
              }
            >
              <div
                ref={transcriptRef}
                className="scroll-slim min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4"
              >
                {messages.length === 0 && !pending ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="max-w-xs text-center text-sm text-slate-500">
                      {activeAgent
                        ? "Say something. Every reply is metered against this workspace's cap."
                        : "No agent selected."}
                    </p>
                  </div>
                ) : (
                  <>
                    {messages.map((message) => (
                      <Bubble key={message.id} message={message} />
                    ))}
                    {pending && (
                      <Bubble
                        message={{
                          id: 0,
                          role: "assistant",
                          content: pending.content,
                          gateway_request_id: null,
                          created_at: new Date().toISOString(),
                        }}
                        streaming
                      />
                    )}
                  </>
                )}
              </div>

              {chatFailure && (
                <div className="px-5 pb-3">
                  <ErrorNote error={chatFailure} />
                </div>
              )}

              <div className="border-t border-slate-100 px-5 py-3">
                <form
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    rows={1}
                    value={draft}
                    disabled={!activeAgent || sending}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={
                      activeAgent ? "Message your agent" : "Create an agent first"
                    }
                    className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-lg border-0 bg-white px-3 py-2 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:bg-slate-50"
                  />
                  <Button
                    type="submit"
                    loading={sending}
                    disabled={!activeAgent || !draft.trim()}
                  >
                    Send
                  </Button>
                </form>
              </div>
            </Card>
          </div>

          <UsageMeter usage={usage} loading={usageLoading} />

          <Card
            title="Billing events"
            subtitle="Signed webhook deliveries for this workspace, newest first"
            action={<Badge tone="neutral">developer view</Badge>}
          >
            <EventLog
              events={events}
              className="max-h-72"
              emptyHint="No events yet. Send a message and the gateway will bill it here within a second."
            />
          </Card>
        </div>
      )}
    </Shell>
  );
}

function Bubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming?: boolean;
}) {
  const mine = message.role === "user";
  return (
    <div className={cx("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cx("max-w-[80%]", mine && "text-right")}>
        <div
          className={cx(
            "inline-block rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap",
            mine
              ? "bg-brand-600 text-white"
              : "bg-slate-100 text-slate-800",
          )}
        >
          {message.content}
          {streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse-dot rounded-sm bg-slate-400" />
          )}
        </div>
        {message.gateway_request_id && (
          <p className="mt-1 font-mono text-[10px] text-slate-400">
            {message.gateway_request_id}
          </p>
        )}
      </div>
    </div>
  );
}

function AgentForm({
  onCreate,
  onCancel,
}: {
  onCreate: (input: {
    name: string;
    system_prompt: string;
    model: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("You are a concise, helpful assistant.");
  const [model, setModel] = useState(MODELS[0]!.id);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  return (
    <form
      className="space-y-3 rounded-lg bg-slate-50 p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setFailure(null);
        try {
          await onCreate({ name: name.trim(), system_prompt: prompt, model });
        } catch (error) {
          setFailure(
            error instanceof ApiFailure
              ? error
              : new ApiFailure(0, "unexpected_error", "Could not create the agent."),
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <Field label="Name" error={failure?.message}>
        <input
          className={inputClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Support triage"
          autoFocus
          required
        />
      </Field>
      <Field label="System prompt">
        <textarea
          className={cx(inputClass, "min-h-20 resize-y")}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>
      <Field label="Model">
        <select
          className={inputClass}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {MODELS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex gap-2">
        <Button type="submit" loading={pending}>
          Create agent
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The chat response is a Server-Sent Event stream so tokens appear as the
 * model produces them. A failure arrives as an `error` frame carrying the
 * same `{code, message, hint}` the REST endpoints use, which is how a
 * budget breach becomes a sentence instead of a stack trace.
 */
async function streamChat(params: {
  agentId: number;
  seatId: number;
  message: string;
  onDelta: (delta: string) => void;
  onDone: (final: {
    message_id: number;
    content: string;
    gateway_request_id: string | null;
  }) => void;
}) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: params.agentId,
      seat_id: params.seatId,
      message: params.message,
    }),
  });

  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; hint?: string };
    } | null;
    throw new ApiFailure(
      response.status,
      body?.error?.code ?? "unexpected_error",
      body?.error?.message ?? "The agent could not be reached.",
      body?.error?.hint,
    );
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let failure: ApiFailure | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((part) => part.startsWith("data:"));
      if (!line) continue;
      const frame = JSON.parse(line.slice(5).trim()) as {
        type: "delta" | "done" | "error";
        text?: string;
        message_id?: number;
        content?: string;
        gateway_request_id?: string | null;
        error?: { code: string; message: string; hint?: string };
      };
      if (frame.type === "delta" && frame.text) params.onDelta(frame.text);
      if (frame.type === "done") {
        params.onDone({
          message_id: frame.message_id ?? Date.now(),
          content: frame.content ?? "",
          gateway_request_id: frame.gateway_request_id ?? null,
        });
      }
      if (frame.type === "error" && frame.error) {
        failure = new ApiFailure(
          402,
          frame.error.code,
          frame.error.message,
          frame.error.hint,
        );
      }
    }
  }

  if (failure) throw failure;
}
