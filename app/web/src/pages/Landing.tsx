import { Link } from "react-router-dom";
import { Badge } from "../components/ui";

/**
 * The front door. A fictional agent platform has to look like one before
 * anybody believes the billing behind it, so this is a plain marketing page
 * that ends in the sign-up form.
 */
export function Landing() {
  return (
    <div className="min-h-full bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            A
          </span>
          <span className="text-sm font-semibold text-slate-900">ACME Agents</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            to="/admin"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 sm:block"
          >
            Owner console
          </Link>
          <Link
            to="/signup"
            className="rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
          >
            Start free
          </Link>
        </nav>
      </header>

      <section className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-40 h-96 bg-gradient-to-b from-brand-50 to-transparent"
        />
        <div className="relative mx-auto max-w-3xl px-6 pt-16 pb-20 text-center">
          <Badge tone="brand">Agents for every team</Badge>
          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            Ship AI agents your whole company can use
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg text-slate-600">
            Create an agent, give it a prompt, and let your team talk to it.
            Spend is capped per company and per seat, so nobody has to guess
            what a conversation costs.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              to="/signup"
              className="w-full rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-700 sm:w-auto"
            >
              Create your workspace
            </Link>
            <Link
              to="/signin"
              className="w-full rounded-lg px-5 py-3 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 transition hover:bg-slate-50 sm:w-auto"
            >
              Sign in
            </Link>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            No card needed. Every workspace starts with a $5 cap.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-6 sm:grid-cols-3">
          <Feature
            title="Agents in a minute"
            body="Name it, write the system prompt, pick a model. It is ready to talk."
          />
          <Feature
            title="Caps you can see"
            body="A live meter shows spend against your cap while the conversation happens."
          />
          <Feature
            title="Per seat allowances"
            body="Every teammate gets their own monthly allowance, so one heavy user cannot drain the company budget."
          />
        </div>

        <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 px-6 py-8 text-center">
          <p className="text-sm font-medium text-slate-700">
            Metering, budgets and billing events are handled by the LangWatch AI
            Gateway.
          </p>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500">
            This app carries no metering code of its own. Sign-up mints a virtual
            key and its budgets over the LangWatch REST API, chat rides the
            gateway on that key, and signed webhook events drive every meter you
            see.
          </p>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-500">
        ACME Agents is a fictional product used to demonstrate the LangWatch
        billing platform.
      </footer>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 text-sm text-slate-600">{body}</p>
    </div>
  );
}
