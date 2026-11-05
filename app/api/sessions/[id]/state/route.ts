import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
      const { brainHostClient, brainErrorResponse } = await import("@/lib/brain-host");
      try { return NextResponse.json({ running: true, state: await brainHostClient().state(id) }); } catch (error) { return brainErrorResponse(error); }
    }
    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) return NextResponse.json({ running: false });

    const state = await rpc.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
