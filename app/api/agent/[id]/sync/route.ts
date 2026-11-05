import { NextResponse } from "next/server";
import { statSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

type SessionRevision = { lastEntryId: string | null; modifiedMs: number; size: number };

function readRevision(filePath: string): SessionRevision {
  const manager = SessionManager.open(filePath);
  const entries = manager.getEntries() as Array<{ id?: string }>;
  let modifiedMs = 0;
  let size = 0;
  try {
    const stat = statSync(filePath);
    modifiedMs = stat.mtimeMs;
    size = stat.size;
  } catch { /* keep zero for a concurrently removed file */ }
  return {
    lastEntryId: entries.length ? String(entries[entries.length - 1]?.id ?? "") || null : null,
    modifiedMs,
    size,
  };
}

function sameRevision(a: SessionRevision | null, b: SessionRevision): boolean {
  return Boolean(a)
    && a!.lastEntryId === b.lastEntryId
    && a!.modifiedMs === b.modifiedMs
    && a!.size === b.size;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") {
      const { brainHostClient, brainErrorResponse } = await import("@/lib/brain-host");
      try { const state = await brainHostClient().state(id); const revision = { lastEntryId: `brain-${state.index}`, modifiedMs: state.index, size: state.index };
        const since = new URL(req.url).searchParams.get("since");
        return NextResponse.json({ sessionId: id, changed: since !== JSON.stringify(revision), revision, running: true, state });
      } catch (error) { return brainErrorResponse(error); }
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const revision = readRevision(filePath);
    let session = getRpcSession(id);
    const wake = new URL(req.url).searchParams.get("wake") === "1";
    if ((!session || !session.isAlive()) && wake) {
      ({ session } = await startRpcSession(id, filePath, undefined));
    }

    let state: unknown;
    const running = Boolean(session?.isAlive());
    if (running) {
      try { state = await session!.send({ type: "get_state" }); } catch { /* runtime may disappear during wake */ }
    }

    let since: SessionRevision | null = null;
    const rawSince = new URL(req.url).searchParams.get("since");
    if (rawSince) {
      try {
        const parsed = JSON.parse(rawSince);
        if (parsed && typeof parsed === "object") {
          since = {
            lastEntryId: parsed.lastEntryId == null ? null : String(parsed.lastEntryId),
            modifiedMs: Number(parsed.modifiedMs),
            size: Number(parsed.size),
          };
        }
      } catch { /* malformed cursor means changed=true */ }
    }

    return NextResponse.json({
      sessionId: id,
      changed: !sameRevision(since, revision),
      revision,
      running,
      ...(state !== undefined ? { state } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
