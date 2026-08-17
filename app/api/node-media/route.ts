import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isApiRequestAllowed } from "@/lib/request-security";

interface NodeConfig {
  name: string;
  url: string;
  token: string;
}

type RemoteResponse = Record<string, unknown>;

const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const REMOTE_CHUNK_BYTES = 2 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 120_000;

function configPathCandidates(): string[] {
  return [
    process.env.PI_NODES_CONFIG,
    `${homedir()}/.pi/agent/nodes.json`,
  ].filter((value): value is string => Boolean(value));
}

function getNode(name: string): NodeConfig | null {
  for (const configPath of configPathCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { nodes?: NodeConfig[] };
      const node = parsed.nodes?.find((candidate) => candidate.name === name);
      if (node?.url && node.token) return node;
    } catch {
      // Try the next configured location.
    }
  }
  return null;
}

async function callNode(node: NodeConfig, pathname: string, body: unknown): Promise<RemoteResponse> {
  const response = await fetch(`${node.url}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${node.token}`,
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: RemoteResponse;
  try {
    const value: unknown = JSON.parse(text);
    parsed = typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as RemoteResponse
      : { error: text.slice(0, 500) };
  } catch {
    parsed = { error: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`remote node HTTP ${response.status}: ${typeof parsed.error === "string" ? parsed.error : text.slice(0, 200)}`);
  }
  return parsed;
}

function mimeTypeForPath(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  const extension = dot > slash ? filePath.slice(dot).toLowerCase() : "";
  return MEDIA_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function isSupportedMediaPath(filePath: string): boolean {
  return mimeTypeForPath(filePath) !== "application/octet-stream";
}

function directMediaUrls(ticketResult: RemoteResponse): string[] {
  const ticket = typeof ticketResult.ticket === "string" ? ticketResult.ticket : "";
  if (!ticket) return [];
  const addresses = Array.isArray(ticketResult.addresses)
    ? ticketResult.addresses.filter((address): address is string => typeof address === "string" && /^https?:\/\//i.test(address))
    : [];
  return addresses.map((address) => `${address.replace(/\/+$/, "")}/media?ticket=${encodeURIComponent(ticket)}`);
}

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(value: string | null, total: number): ByteRange | null {
  if (!value) return { start: 0, end: total - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(total - suffixLength, 0);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? total - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

function contentDisposition(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const fileName = filePath.slice(slash + 1).replace(/[\"\\\r\n]/g, "_") || "media";
  return `inline; filename="${fileName}"`;
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const nodeName = typeof input.node === "string" ? input.node.trim() : "";
  const remotePath = typeof input.path === "string" ? input.path : "";
  const node = getNode(nodeName);
  if (!node || !remotePath) {
    return NextResponse.json({ error: "Unknown node or missing path" }, { status: 400 });
  }
  if (!isSupportedMediaPath(remotePath)) {
    return NextResponse.json({ error: "Unsupported media format" }, { status: 415 });
  }

  const proxyMediaUrl = `/api/node-media?node=${encodeURIComponent(nodeName)}&path=${encodeURIComponent(remotePath)}`;
  let ticketResult: RemoteResponse = {};
  try {
    ticketResult = await callNode(node, "/media/ticket", { path: remotePath });
  } catch {
    // The node-agent may not implement /media/ticket (older versions). The
    // same-origin proxy below streams via /transfer/download and needs no
    // ticket, so degrade gracefully to the proxy instead of failing the play.
    ticketResult = {};
  }
  const mediaCandidates = [...new Set([...directMediaUrls(ticketResult), proxyMediaUrl])];
  return NextResponse.json({
    mediaUrl: mediaCandidates[0],
    mediaCandidates,
    proxyMediaUrl,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const nodeName = request.nextUrl.searchParams.get("node")?.trim() ?? "";
  const remotePath = request.nextUrl.searchParams.get("path") ?? "";
  const node = getNode(nodeName);
  if (!node || !remotePath) {
    return NextResponse.json({ error: "Unknown node or missing path" }, { status: 400 });
  }
  if (!isSupportedMediaPath(remotePath)) {
    return NextResponse.json({ error: "Unsupported media format" }, { status: 415 });
  }

  let downloadId = "";
  let closed = false;
  const closeRemote = async () => {
    if (closed || !downloadId) return;
    closed = true;
    try {
      await callNode(node, "/transfer/download/close", { downloadId });
    } catch {
      // The node expires abandoned transfers; do not mask a finished stream.
    }
  };

  try {
    const transfer = await callNode(node, "/transfer/download/start", { path: remotePath });
    downloadId = String(transfer.downloadId ?? "");
    const total = Number(transfer.totalBytes);
    if (!downloadId || !Number.isSafeInteger(total) || total <= 0) {
      await closeRemote();
      return NextResponse.json({ error: "Remote file has invalid transfer metadata" }, { status: 502 });
    }

    const range = parseRange(request.headers.get("range"), total);
    if (!range) {
      await closeRemote();
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
      });
    }

    let cursor = range.start;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cursor > range.end) {
          await closeRemote();
          controller.close();
          return;
        }
        try {
          const size = Math.min(REMOTE_CHUNK_BYTES, range.end - cursor + 1);
          const chunk = await callNode(node, "/transfer/download/chunk", {
            downloadId,
            offset: cursor,
            size,
          });
          const data = Buffer.from(String(chunk.data ?? ""), "base64");
          const actualOffset = Number(chunk.offset);
          if (actualOffset !== cursor || data.length <= 0 || data.length > size) {
            throw new Error(`invalid remote chunk at ${cursor}`);
          }
          cursor += data.length;
          controller.enqueue(new Uint8Array(data));
        } catch (error) {
          await closeRemote();
          controller.error(error);
        }
      },
      async cancel() {
        await closeRemote();
      },
    });

    const partial = range.start !== 0 || range.end !== total - 1;
    return new Response(body, {
      status: partial ? 206 : 200,
      headers: {
        "Content-Type": mimeTypeForPath(remotePath),
        "Content-Length": String(range.end - range.start + 1),
        "Accept-Ranges": "bytes",
        ...(partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${total}` } : {}),
        "Content-Disposition": contentDisposition(remotePath),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    await closeRemote();
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
