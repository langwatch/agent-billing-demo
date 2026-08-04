/**
 * The browser side of the API contract. Every failure the server returns
 * has the shape `{error: {code, message, hint}}`, so the UI can branch on a
 * stable code and always has a sentence it can show a person. Nothing here
 * ever renders a raw exception.
 */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiFailure(
      0,
      "network_error",
      "Cannot reach the ACME Agents server.",
      "Check that the app is running on its port.",
    );
  }

  const text = await response.text();
  const body = text ? safeJson(text) : null;

  if (!response.ok) {
    const error = (body as { error?: Record<string, unknown> } | null)?.error;
    throw new ApiFailure(
      response.status,
      typeof error?.code === "string" ? error.code : "unexpected_error",
      typeof error?.message === "string"
        ? error.message
        : `The server answered ${response.status}.`,
      typeof error?.hint === "string" ? error.hint : undefined,
      error?.details as Record<string, unknown> | undefined,
    );
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};

// ── Wire types ──────────────────────────────────────────────────────────

export interface CustomerSummary {
  id: number;
  name: string;
  virtual_key_id: string;
  created_at: string;
  agent_count: number;
  seat_count: number;
}

export interface Seat {
  id: number;
  email: string;
}

export interface Agent {
  id: number;
  name: string;
  model: string;
  system_prompt: string;
  created_at: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  gateway_request_id: string | null;
  created_at: string;
}

export interface BudgetView {
  id: string;
  name: string;
  scope: string;
  window: string;
  on_breach: string;
  /** Canonical integer figures, nano-USD. Null when the platform has none. */
  limit_nano_usd: number | null;
  spend_nano_usd: number | null;
  /** Display figures, already converted server-side. Null stays null. */
  limit_usd: number | null;
  spend_usd: number | null;
  percent: number | null;
  /** The cycle this figure covers, exactly as the platform enforces it. */
  current_period_started_at: string;
  resets_at: string;
  /** Set when the cycle is anchored to the workspace's own start instant. */
  cycle_anchor_at: string | null;
  end_user_id?: string | null;
}

export interface LedgerTotals {
  requests: number;
  cost_nano_usd: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  awaiting_cost: number;
  by_seat: Array<{
    end_user_id: string;
    requests: number;
    cost_nano_usd: number;
    cost_usd: number;
  }>;
}

export interface UsageView {
  virtual_key_id: string;
  budgets: BudgetView[];
  per_user_budgets: BudgetView[];
  ledger: LedgerTotals;
  primary: BudgetView | null;
  source: "langwatch" | "ledger";
  degraded: string | null;
}

export interface WorkspaceView {
  customer: CustomerSummary;
  seats: Seat[];
  agents: Agent[];
}

export interface BillingEventView {
  event_id: string;
  type: string;
  gateway_request_id: string | null;
  virtual_key_id: string | null;
  customer_name: string | null;
  end_user_id: string | null;
  model: string | null;
  status: string | null;
  error_class: string | null;
  cost_usd: number | null;
  occurred_at: string;
  received_at: string;
  payload: unknown;
}

export interface AdminCustomerRow {
  customer: CustomerSummary;
  usage: UsageView;
}

export interface AdminOverview {
  customers: AdminCustomerRow[];
  totals: {
    customers: number;
    requests: number;
    cost_usd: number;
    events: number;
  };
  receiver: {
    registered: boolean;
    url: string;
    events_ingested: number;
    last_event_at: string | null;
  };
}
