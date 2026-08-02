import type { Response } from "express";

/**
 * A tiny in-process fan-out for Server-Sent Events. The owner console and
 * the developer panel subscribe to it, so a billing event that lands on the
 * webhook route is on screen in the same breath it is written to the
 * database. One process, one broadcaster; a real deployment would put a
 * message bus here.
 */
export type LiveEvent =
  | { kind: "billing_event"; event: Record<string, unknown> }
  | { kind: "customer_created"; customer: Record<string, unknown> }
  | { kind: "budget_reset"; customer_id: number; budget: string }
  | { kind: "chat_request"; customer_id: number; gateway_request_id: string | null };

export class LiveFeed {
  private subscribers = new Set<Response>();

  subscribe(res: Response) {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(`: connected\n\n`);
    this.subscribers.add(res);

    // Proxies drop idle streams; a comment every 25s keeps them open.
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    res.on("close", () => {
      clearInterval(heartbeat);
      this.subscribers.delete(res);
    });
  }

  publish(event: LiveEvent) {
    const frame = `data: ${JSON.stringify({
      ...event,
      published_at: new Date().toISOString(),
    })}\n\n`;
    for (const subscriber of this.subscribers) {
      subscriber.write(frame);
    }
  }

  get subscriberCount() {
    return this.subscribers.size;
  }
}
