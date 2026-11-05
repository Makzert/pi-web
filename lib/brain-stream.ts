import { brainHostClient, brainActivationId, brainQueue, brainSessionData, brainState, type BrainHostClient, type BrainView, type BrainLeadership } from "./brain-host";
import { BrainPreviewFence } from "./brain-preview";

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish(); });
}
/** Reconnect to the verified leader and reset old previews from a confirmed view.
 * A shared server-only token never reaches EventSource or the browser. */
export function brainEventResponse(request: Request, sessionId: string, client: BrainHostClient = brainHostClient()): Response {
  const lifetime = new AbortController();
  let active: AbortController | undefined;
  const stop = () => { lifetime.abort(); active?.abort(); };
  request.signal.addEventListener("abort", stop, { once: true });
  if (request.signal.aborted) stop();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const emit = (event: unknown) => { if (!lifetime.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      void (async () => {
        while (!lifetime.signal.aborted) {
          active = new AbortController();
          let monitor: ReturnType<typeof setInterval> | undefined;
          let monitoring = false;
          try {
            const leader = await client.leader(active.signal);
            const token = brainActivationId(leader.health.leadership);
            if (!token) throw new Error("leader credential unavailable");
            const connection = active;
            const upstream = await client.fetchImpl(`${leader.url}/events`, { headers: client.headers(), signal: connection.signal, cache: "no-store" });
            if (!upstream.ok || !upstream.body) throw new Error(`Brain event stream HTTP ${upstream.status}`);
            // Open the feed before the snapshot. Buffered message_end frames are
            // fenced against its index below, closing the subscribe/read gap.
            emit({ type: "connected", sessionId, managedBrain: true });
            const view = await client.at<BrainView>(leader.url, `/sessions/${encodeURIComponent(sessionId)}`, { signal: connection.signal });
            if (brainActivationId(view.leadership) !== token) throw new Error("leadership changed during snapshot");
            emit({ type: "brain_reset", sessionId, leadership: token, data: brainSessionData(view), state: brainState(view), queue: brainQueue(view) });
            const fence = new BrainPreviewFence(); fence.reset(token);
            const formalMessages = new Set(brainSessionData(view).context.entryIds);
            monitor = setInterval(() => {
              if (monitoring) return;
              monitoring = true;
              void client.at<{ executable: boolean; leadership?: BrainLeadership }>(leader.url, "/health", { signal: AbortSignal.timeout(2000) })
                .then(health => { if (!health.executable || brainActivationId(health.leadership) !== token) connection.abort(); })
                .catch(() => connection.abort()).finally(() => { monitoring = false; });
            }, 1000);
            const reader = upstream.body.getReader();
            let buffered = "";
            const decoder = new TextDecoder();
            try {
              while (!connection.signal.aborted && !lifetime.signal.aborted) {
                const part = await reader.read(); if (part.done) break;
                buffered += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
                let boundary: number;
                while ((boundary = buffered.indexOf("\n\n")) >= 0) {
                  const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
                  const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                  if (!data) continue;
                  const event = JSON.parse(data) as Record<string, unknown>;
                  if (event.sessionId !== sessionId || !fence.accept(event)) continue;
                  const transient = ["agent_start","turn_start","message_start","message_update","tool_execution_start","tool_execution_update"].includes(String(event.type));
                  if (transient && typeof event.index === "number" && event.index < view.history.head) continue;
                  if (event.type === "message_end") {
                    if (typeof event.messageId !== "string") throw new Error("formal message identity missing");
                    if ((typeof event.index === "number" && event.index <= view.index) || formalMessages.has(event.messageId)) continue;
                    formalMessages.add(event.messageId);
                  }
                  // The snapshot already contains runtime/queue effects before
                  // its capture. Replaying buffered lifecycle frames could undo it.
                  if (event.type !== "message_end" && view.viewStamp && typeof event.sequence === "number" && event.sequence <= view.viewStamp.runtimeSeq) continue;
                  if (event.type === "message_update") delete event.assistantMessageEvent;
                  if (event.type === "queue_update" && typeof event.index === "number") event.queue = { sessionId, runtimeId: token, revision: event.index,
                    steering: Array.isArray(event.steering) ? event.steering : [], followUp: Array.isArray(event.followUp) ? event.followUp : [] };
                  emit(event);
                  if (event.type === "agent_settled") emit({ type: "prompt_done", sessionId, leadership: token });
                }
              }
            } finally { await reader.cancel().catch(() => {}); }
          } catch { /* A disconnect changes no accepted history; reconnect below. */ }
          finally { if (monitor) clearInterval(monitor); active?.abort(); }
          if (!lifetime.signal.aborted) { emit({ type: "brain_disconnect", sessionId }); await pause(500, lifetime.signal); }
        }
      })().finally(() => { request.signal.removeEventListener("abort", stop); try { controller.close(); } catch { /* canceled */ } });
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
