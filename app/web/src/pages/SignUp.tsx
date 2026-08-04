import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiFailure, type CustomerSummary } from "../api";
import { useToast } from "../components/Toast";
import { Button, Field, inputClass } from "../components/ui";
import { useSession } from "../session";

/**
 * Sign-up is the moment the billing platform gets provisioned: one POST
 * creates the workspace, mints its virtual key, and attaches its three
 * budgets. The form's only jobs are to say what is happening, land the
 * customer inside their dashboard, and turn a name collision into an
 * offer rather than an error.
 */
interface SignUpResponse {
  customer: CustomerSummary;
  provisioned: {
    virtual_key_id: string;
    hard_cap_usd: number;
    soft_cap_usd: number;
    per_seat_cap_usd: number;
    /** Where the monthly allowance's cycle starts counting from. */
    cycle_anchor_at: string;
    /** True when the platform handed back an earlier signup's resources. */
    replayed: boolean;
  };
}

export function SignUp() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const { signIn } = useSession();
  const navigate = useNavigate();
  const toast = useToast();

  const existingId = Number(
    (failure?.details as { existing?: { id?: number } } | undefined)?.existing?.id ??
      Number.NaN,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(null);
    setPending(true);
    try {
      const result = await api.post<SignUpResponse>("/api/customers", {
        name,
        email: email.trim() || undefined,
      });
      signIn(result.customer.id);
      // A double-submitted form asks the platform for the same resources
      // under the same idempotency key, so the second attempt reconnects the
      // workspace instead of minting a second key. Saying so beats a second
      // identical success message the customer cannot tell apart.
      toast.success(
        `${result.customer.name} is ready`,
        result.provisioned.replayed
          ? "This workspace was already provisioned, so we reconnected it to the same gateway key."
          : `Virtual key provisioned with a $${result.provisioned.hard_cap_usd.toFixed(2)} cap and a $${result.provisioned.per_seat_cap_usd.toFixed(2)} monthly allowance per seat, starting today.`,
      );
      navigate("/app");
    } catch (error) {
      const apiFailure =
        error instanceof ApiFailure
          ? error
          : new ApiFailure(0, "unexpected_error", "Sign-up failed.");
      setFailure(apiFailure);
      if (apiFailure.code !== "customer_exists") {
        toast.error("Could not create the workspace", apiFailure.message);
      }
    } finally {
      setPending(false);
    }
  }

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
          to="/signin"
          className="text-sm font-medium text-slate-600 transition hover:text-slate-900"
        >
          Sign in
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 pt-6 pb-16">
        <div className="w-full max-w-md">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Create your workspace
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            We mint a dedicated gateway key for your company and cap it before
            the first message goes out.
          </p>

          <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
            <Field
              label="Company name"
              hint="This is the name on your workspace and on your invoices."
              error={
                failure && failure.code !== "customer_exists" ? failure.message : undefined
              }
            >
              <input
                className={inputClass}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (failure) setFailure(null);
                }}
                placeholder="Northwind Trading"
                autoFocus
                required
              />
            </Field>

            <Field
              label="Your work email"
              hint="Becomes the first seat. Every request is attributed to a seat, which is how per-person allowances work."
            >
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.example"
              />
            </Field>

            {failure?.code === "customer_exists" && (
              <div className="rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
                <p className="text-sm font-medium text-amber-900">
                  {failure.message}
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  {failure.hint ?? "Pick another name, or open the existing one."}
                </p>
                {Number.isFinite(existingId) && (
                  <button
                    type="button"
                    onClick={() => {
                      signIn(existingId);
                      navigate("/app");
                    }}
                    className="mt-2 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-amber-900 ring-1 ring-inset ring-amber-300 transition hover:bg-amber-100"
                  >
                    Open {name.trim()} instead
                  </button>
                )}
              </div>
            )}

            <Button type="submit" loading={pending} className="w-full py-2.5">
              {pending ? "Provisioning your gateway key" : "Create workspace"}
            </Button>

            <p className="text-center text-xs text-slate-500">
              Creates a real virtual key, a $5.00 hard cap, a $2.50 warning
              threshold and a $1.00 monthly allowance per seat.
            </p>
          </form>
        </div>
      </main>
    </div>
  );
}
