import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export async function GET() {
  try {
    if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
      const { brainHostClient, brainErrorResponse } = await import("@/lib/brain-host");
      try { return NextResponse.json({ ...await brainHostClient().listing(), managedBrain: true }); }
      catch (error) { return brainErrorResponse(error); }
    }
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
