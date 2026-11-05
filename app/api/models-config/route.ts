import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
}

export async function GET() {
  if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") return NextResponse.json({ error: "Configure providers, plugins and skills on the Brain Hosts; Web-local resource settings are unavailable in managed mode" }, { status: 409 });

  return NextResponse.json(readModelsJson());
}

export async function PUT(req: Request) {
  if (process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS || process.env.ULTRON_MANAGED_BRAIN === "1") return NextResponse.json({ error: "Configure providers, plugins and skills on the Brain Hosts; Web-local resource settings are unavailable in managed mode" }, { status: 409 });

  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsJson(body);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
