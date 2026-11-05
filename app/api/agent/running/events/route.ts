import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
    const { brainHostClient } = await import("@/lib/brain-host");
    const client = brainHostClient(); let cleanup = () => {};
    const stream = new ReadableStream({ start(controller) {
      const encoder = new TextEncoder(); let closed = false; let busy = false;
      const poll = async () => { if (closed || busy) return; busy = true; try { const { runningSessionIds } = await client.listing(); if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "running", runningSessionIds })}\n\n`)); } catch { /* preserve last confirmed running view while disconnected */ } finally { busy = false; } };
      const timer = setInterval(() => { void poll(); }, 2500);
      cleanup = () => { if (closed) return; closed = true; clearInterval(timer); req.signal.removeEventListener("abort", cleanup); try { controller.close(); } catch {} };
      req.signal.addEventListener("abort", cleanup, { once: true }); if (req.signal.aborted) cleanup(); else void poll();
    }, cancel() { cleanup(); } });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions((ids) => {
        try {
          encode({ type: "running", runningSessionIds: ids });
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds() });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
