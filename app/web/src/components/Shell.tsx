import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import type { CustomerSummary } from "../api";
import { useLiveFeed } from "../liveFeed";
import { useSession } from "../session";
import { Avatar, Badge, cx } from "./ui";

/**
 * The application chrome: a fixed sidebar, a topbar that carries the
 * signed-in customer, and the page underneath. The owner console reuses it
 * with `owner` set, which is the only visual difference between the tenant
 * product and the behind-the-scenes view.
 */
export function Shell({
  customers,
  activeCustomer,
  owner,
  children,
}: {
  customers: CustomerSummary[];
  activeCustomer: CustomerSummary | null;
  owner?: boolean;
  children: ReactNode;
}) {
  const { connected } = useLiveFeed();

  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col bg-slate-900 lg:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
            A
          </span>
          <span className="text-sm font-semibold text-white">ACME Agents</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4">
          <SideLink to="/app" label="Workspace" icon={<IconGrid />} />
          <SideLink to="/developer" label="Developer" icon={<IconCode />} />
          <p className="px-3 pt-6 pb-2 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
            Platform owner
          </p>
          <SideLink to="/admin" label="Owner console" icon={<IconShield />} />
        </nav>

        <div className="border-t border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                connected ? "animate-pulse-dot bg-emerald-400" : "bg-slate-600",
              )}
            />
            {connected ? "Billing feed live" : "Billing feed offline"}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-slate-500">
            Metering, budgets and billing events by the LangWatch AI Gateway.
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white lg:hidden">
              A
            </span>
            {owner ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  SaaS owner console
                </p>
                <p className="truncate text-xs text-slate-500">
                  Every customer, their caps and their spend
                </p>
              </div>
            ) : activeCustomer ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">
                  {activeCustomer.name}
                </p>
                <p className="truncate font-mono text-xs text-slate-500">
                  {activeCustomer.virtual_key_id}
                </p>
              </div>
            ) : (
              <p className="text-sm font-semibold text-slate-900">ACME Agents</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            {owner && <Badge tone="amber">Internal view</Badge>}
            <CustomerSwitcher customers={customers} active={activeCustomer} />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

function SideLink({
  to,
  label,
  icon,
}: {
  to: string;
  label: string;
  icon: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
          isActive
            ? "bg-slate-800 text-white"
            : "text-slate-400 hover:bg-slate-800/60 hover:text-white",
        )
      }
    >
      <span className="h-4 w-4">{icon}</span>
      {label}
    </NavLink>
  );
}

function CustomerSwitcher({
  customers,
  active,
}: {
  customers: CustomerSummary[];
  active: CustomerSummary | null;
}) {
  const [open, setOpen] = useState(false);
  const { signIn, signOut } = useSession();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-slate-100"
      >
        {active ? (
          <Avatar name={active.name} />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 3h6v6H3V3Zm8 0h6v6h-6V3ZM3 11h6v6H3v-6Zm8 0h6v6h-6v-6Z" />
            </svg>
          </span>
        )}
        <span className="hidden max-w-32 truncate font-medium text-slate-700 sm:inline">
          {active?.name ?? "Open a workspace"}
        </span>
        <svg className="h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="animate-rise absolute right-0 z-30 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <p className="px-4 pt-3 pb-2 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
            Switch account
          </p>
          <ul className="scroll-slim max-h-72 overflow-y-auto pb-1">
            {customers.map((customer) => (
              <li key={customer.id}>
                <button
                  type="button"
                  onClick={() => {
                    signIn(customer.id);
                    setOpen(false);
                    navigate("/app");
                  }}
                  className={cx(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50",
                    active?.id === customer.id && "bg-brand-50/60",
                  )}
                >
                  <Avatar name={customer.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {customer.name}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {customer.agent_count} agents, {customer.seat_count} seats
                    </span>
                  </span>
                  {active?.id === customer.id && (
                    <svg
                      className="h-4 w-4 text-brand-600"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.704 5.29a.75.75 0 0 1 .006 1.06l-7.5 7.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.97 2.97 6.97-6.97a.75.75 0 0 1 1.054.006Z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-2 border-t border-slate-100 p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/signup");
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-50"
            >
              New account
            </button>
            <button
              type="button"
              onClick={() => {
                signOut();
                setOpen(false);
                navigate("/");
              }}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M3 3h6v6H3V3Zm8 0h6v6h-6V3ZM3 11h6v6H3v-6Zm8 0h6v6h-6v-6Z" />
    </svg>
  );
}

function IconCode() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L.97 10.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function IconShield() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path
        fillRule="evenodd"
        d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.09.56.135 1.135.135 1.72 0 5.062-3.345 9.343-7.943 10.757a.53.53 0 0 1-.316 0C5.174 16.474 1.83 12.193 1.83 7.13c0-.585.045-1.16.135-1.72A.5.5 0 0 1 2.444 4.986a11.947 11.947 0 0 0 7.217-2.749Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
