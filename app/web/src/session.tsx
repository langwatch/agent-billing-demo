import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Who is signed in. A production app would put a real identity provider
 * here; the demo keeps the signed-in customer in local storage so the
 * dashboard, the chat and the usage meter all read one source of truth and
 * every one of them swaps the moment the customer changes.
 */
const STORAGE_KEY = "acme-agents.customer-id";

interface SessionApi {
  customerId: number | null;
  signIn: (customerId: number) => void;
  signOut: () => void;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [customerId, setCustomerId] = useState<number | null>(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  });

  const signIn = useCallback((next: number) => {
    window.localStorage.setItem(STORAGE_KEY, String(next));
    setCustomerId(next);
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setCustomerId(null);
  }, []);

  // Keep two open tabs in agreement about who is signed in.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const parsed = event.newValue ? Number(event.newValue) : Number.NaN;
      setCustomerId(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(
    () => ({ customerId, signIn, signOut }),
    [customerId, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside a SessionProvider");
  return session;
}
