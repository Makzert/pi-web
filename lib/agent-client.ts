// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

export class AgentCommandError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // An operation ID alone does not make a POST idempotent: ordinary SDK
  // queues do not persist receipts. Surface unknown outcomes instead of
  // transparently repeating an input or canceling a newer queue entry.
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: string; code?: string };
  if (!res.ok || body.error) {
    throw new AgentCommandError(body.error ?? `HTTP ${res.status}`, body.code);
  }
  return body.data as T;
}
