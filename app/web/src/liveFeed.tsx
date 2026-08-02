import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * One EventSource for the whole app, fanned out through context. The server
 * pushes a frame the instant a signed billing webhook is ingested, which is
 * what makes the usage meters and the owner console move on their own
 * rather than waiting for a poll.
 */
export interface LiveFrame {
  kind: "billing_event" | "customer_created" | "budget_reset" | "chat_request";
  published_at: string;
  event?: {
    event_id: string;
    type: string;
    virtual_key_id: string | null;
    customer_name: string | null;
    end_user_id: string | null;
    model: string | null;
    cost_usd: number | null;
    gateway_request_id: string | null;
    occurred_at: string;
    payload: unknown;
  };
  customer?: Record<string, unknown>;
  customer_id?: number;
  budget?: string;
  gateway_request_id?: string | null;
}

interface LiveFeedApi {
  frames: LiveFrame[];
  connected: boolean;
  /** Bumped on every frame, so effects can depend on "something happened". */
  revision: number;
}

const LiveFeedContext = createContext<LiveFeedApi>({
  frames: [],
  connected: false,
  revision: 0,
});

const MAX_FRAMES = 120;

export function LiveFeedProvider({ children }: { children: ReactNode }) {
  const [frames, setFrames] = useState<LiveFrame[]>([]);
  const [connected, setConnected] = useState(false);
  const revision = useRef(0);
  const [revisionState, setRevisionState] = useState(0);

  useEffect(() => {
    const source = new EventSource("/api/events/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      try {
        const frame = JSON.parse(message.data) as LiveFrame;
        setFrames((current) => [frame, ...current].slice(0, MAX_FRAMES));
        revision.current += 1;
        setRevisionState(revision.current);
      } catch {
        // A malformed frame is not worth breaking the stream over.
      }
    };
    return () => source.close();
  }, []);

  const value = useMemo(
    () => ({ frames, connected, revision: revisionState }),
    [frames, connected, revisionState],
  );
  return <LiveFeedContext.Provider value={value}>{children}</LiveFeedContext.Provider>;
}

export function useLiveFeed(): LiveFeedApi {
  return useContext(LiveFeedContext);
}
