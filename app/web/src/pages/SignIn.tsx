import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiFailure, type CustomerSummary } from "../api";
import { Avatar, EmptyState, ErrorNote, Spinner } from "../components/ui";
import { useSession } from "../session";

/**
 * Signing in stands in for the identity provider a real product would have:
 * pick the workspace and the dashboard, chat and meters all swap to it.
 */
export function SignIn() {
  const [customers, setCustomers] = useState<CustomerSummary[] | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const { signIn } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    api
      .get<{ customers: CustomerSummary[] }>("/api/customers")
      .then((body) => setCustomers(body.customers))
      .catch((error) =>
        setFailure(
          error instanceof ApiFailure
            ? error
            : new ApiFailure(0, "unexpected_error", "Could not load workspaces."),
        ),
      );
  }, []);

  return (
    <div className="flex min-h-full flex-col bg-white">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            A
          </span>
          <span className="text-sm font-semibold text-slate-900">ACME Agents</span>
        </Link>
        <Link
          to="/signup"
          className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          Create a workspace
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 pt-6 pb-16">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Sign in
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Choose the workspace you want to open.
          </p>

          <div className="mt-8">
            {failure ? (
              <ErrorNote error={failure} />
            ) : customers === null ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner /> Loading workspaces
              </div>
            ) : customers.length === 0 ? (
              <EmptyState
                title="No workspaces yet"
                body="Create the first one and the platform provisions its gateway key and caps."
                action={
                  <Link
                    to="/signup"
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
                  >
                    Create workspace
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
                {customers.map((customer) => (
                  <li key={customer.id}>
                    <button
                      type="button"
                      onClick={() => {
                        signIn(customer.id);
                        navigate("/app");
                      }}
                      className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
                    >
                      <Avatar name={customer.name} className="h-9 w-9" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {customer.name}
                        </span>
                        <span className="block truncate font-mono text-xs text-slate-500">
                          {customer.virtual_key_id}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-400">
                        {customer.agent_count} agents
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
