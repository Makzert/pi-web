import { brainErrorResponse, brainHostClient, managedBrainWeb } from "@/lib/brain-host";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!managedBrainWeb()) return Response.json({ error: "Remote result paging requires managed Brain mode" }, { status: 409 });
  try {
    const { id } = await params;
    const input = await request.json() as Record<string, unknown>;
    if (typeof input.node !== "string" || typeof input.resultId !== "string") return Response.json({ error: "node and resultId are required" }, { status: 400 });
    if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) return Response.json({ error: "Invalid offset" }, { status: 400 });
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 1024)) return Response.json({ error: "Page limit must be between 1 and 1024 bytes" }, { status: 400 });
    const value = await brainHostClient().request(`/sessions/${encodeURIComponent(id)}/result`, { method: "POST", body: JSON.stringify({ node: input.node, resultId: input.resultId, section: input.section ?? "payload", offset: input.offset ?? 0, limit: input.limit ?? 1024 }) });
    return Response.json(value);
  } catch (error) { return brainErrorResponse(error); }
}
