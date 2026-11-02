import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";

function route(path, rpc) {
  const output = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    if (name === "@/lib/rpc-manager") return rpc;
    if (name === "@/lib/session-reader") return { resolveSessionPath: async () => "/test/session" };
    if (name === "next/server") return { NextResponse: { json: (data, options) => new Response(JSON.stringify(data), options) } };
    throw new Error(name);
  }, module, module.exports);
  return module.exports;
}

test("SSE connects with an authoritative queue snapshot and cleans up cancellation exactly once", async () => {
  let listener, removed = 0;
  const queue = { sessionId: "s", runtimeId: "r", revision: 2, steering: ["pending"], followUp: [] };
  const session = { isAlive: () => true, getQueueSnapshot: () => queue,
    onEvent: fn => { listener = fn; return () => { removed++; }; } };
  const { GET } = route("../app/api/agent/[id]/events/route.ts", { getRpcSession: () => session });
  const controller = new AbortController();
  const response = await GET(new Request("http://test/events", { signal: controller.signal }), { params: Promise.resolve({ id: "s" }) });
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(JSON.parse(initial.slice(6)), { type: "connected", sessionId: "s", queue });
  await reader.cancel();
  controller.abort();
  assert.equal(removed, 1);
  assert.doesNotThrow(() => listener({ type: "queue_update", queue }));
});

test("an old-runtime recall cannot cold-start a new wrapper and execute again", async () => {
  let starts = 0;
  const { POST } = route("../app/api/agent/[id]/route.ts", { getRpcSession: () => null,
    startRpcSession: async () => { starts++; throw new Error("must not start"); } });
  const response = await POST(new Request("http://test/agent/s", {
    method: "POST", body: JSON.stringify({ type: "clear_queue", operationId: "op", expectedRuntimeId: "old" }),
  }), { params: Promise.resolve({ id: "s" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "QUEUE_INSTANCE_CHANGED");
  assert.equal(starts, 0);
});
