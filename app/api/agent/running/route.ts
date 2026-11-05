import { NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
    const { brainHostClient, brainErrorResponse } = await import("@/lib/brain-host");
    try { return NextResponse.json({ runningSessionIds: (await brainHostClient().listing()).runningSessionIds }, { headers: { "Cache-Control": "no-store" } }); }
    catch (error) { return brainErrorResponse(error); }
  }
  return NextResponse.json(
    { runningSessionIds: getRunningRpcSessionIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
