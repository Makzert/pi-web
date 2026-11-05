import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
      const { brainHostClient, brainErrorResponse } = await import("@/lib/brain-host");
      try { return NextResponse.json({ success: true, data: await brainHostClient().command(id, body) }); }
      catch (error) { return brainErrorResponse(error); }
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    // Do not cold-start a replacement to execute an earlier runtime's recall.
    if (body.type === "clear_queue" && body.expectedRuntimeId !== undefined) {
      return NextResponse.json({ error: "Queue runtime no longer exists; recall outcome is unknown", code: "QUEUE_INSTANCE_CHANGED" }, { status: 409 });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error), code: (error as { code?: string })?.code }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
      const { brainHostClient, brainState, brainErrorResponse } = await import("@/lib/brain-host");
      try { const client = brainHostClient(); const state = new URL(_req.url).searchParams.has("queue") ? brainState(await client.view(id)) : await client.state(id);
        return NextResponse.json({ running: true, state }); }
      catch (error) { return brainErrorResponse(error); }
    }
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
