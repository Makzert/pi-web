import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sendAgentCommand } from "./agent-client.ts";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("same-ID direct prompt retry waits for committed user-message admission", async () => {
  let options;
  let finish;
  let calls = 0;
  const inner = {
    isBashRunning: false,
    isStreaming: false,
    prompt(_message, receivedOptions) {
      calls++;
      options = receivedOptions;
      receivedOptions.preflightResult(true);
      return new Promise((resolve) => { finish = resolve; });
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  const command = { type: "prompt", message: "hello", operationId: "prompt-1", timestamp: 7 };
  let settled = 0;
  const first = wrapper.send(command).then(() => { settled++; });
  await new Promise((resolve) => setImmediate(resolve));
  const retry = wrapper.send(command).then(() => { settled++; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(settled, 0);
  options.acceptedResult(true);
  await Promise.all([first, retry]);
  assert.equal(settled, 2);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  wrapper.destroy();
});

async function realSession(t, extensionFactories = []) {
  const directory = await mkdtemp(join(tmpdir(), "ultron-rpc-admission-"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  // External authentication and model I/O are the only mocked boundaries.
  modelRuntime.checkAuth = async () => "test-key";
  const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "", extensionFactories });
  await resourceLoader.reload();
  const model = { id: "admission-test", name: "Admission Test", api: "openai-completions", provider: "admission-test",
    baseUrl: "https://invalid.local", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096 };
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, modelRuntime,
    resourceLoader, sessionManager: SessionManager.create(directory, join(directory, "sessions")), model, tools: [] });
  const contexts = [];
  session.agent.streamFunction = (_model, context) => {
    contexts.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "accepted input" }], api: model.api,
      provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  };
  await session.bindExtensions({ mode: "rpc" });
  const wrapper = new AgentSessionWrapper(session);
  t.after(async () => { await session.abort(); wrapper.destroy(); await rm(directory, { recursive: true, force: true }); });
  return { session, wrapper, contexts };
}

test("a lost ordinary steer response leaves exactly one input queued", async (t) => {
  const { session, wrapper } = await realSession(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    await wrapper.send(JSON.parse(init.body));
    if (++requests === 1) throw new TypeError("response lost");
    return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
  });
  await assert.rejects(sendAgentCommand(session.sessionId,
    { type: "steer", message: "urgent", operationId: "steer-1", timestamp: 7 }), /response lost/);
  assert.deepEqual([...session.getSteeringMessages()], ["urgent"]);
  assert.equal(requests, 1);
});

test("a lost ordinary clear response cannot transparently cancel a newer input", async (t) => {
  const { session, wrapper } = await realSession(t);
  await session.steer("original input");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const data = await wrapper.send(JSON.parse(init.body));
    if (++requests === 1) {
      await session.steer("newer input");
      throw new TypeError("clear response lost");
    }
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
  await assert.rejects(sendAgentCommand(session.sessionId,
    { type: "clear_queue", operationId: "clear-1", timestamp: 8 }), /clear response lost/);
  assert.deepEqual([...session.getSteeringMessages()], ["newer input"]);
  assert.equal(requests, 1);
});

test("queued input cannot become a fresh prompt after an extension handles preflight", { timeout: 2000 }, async (t) => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  let handled = 0;
  const { wrapper, contexts } = await realSession(t, [(pi) => pi.on("input", async () => {
    handled++;
    entered();
    await blocked;
    return { action: "handled" };
  })]);
  const first = wrapper.send({ type: "prompt", message: "extension input", streamingBehavior: "followUp", operationId: "extension-1" });
  await started;
  const second = wrapper.send({ type: "prompt", message: "queued input", streamingBehavior: "followUp", operationId: "extension-2" });
  const rejected = assert.rejects(second, /previous prompt did not start an agent run/);
  release();
  await Promise.all([first, rejected]);
  assert.equal(handled, 1);
  assert.equal(contexts.length, 0);
});

for (const streamingBehavior of ["steer", "followUp"]) {
  test(`concurrent same-ID ${streamingBehavior} submissions on an idle session share admission`, { timeout: 2000 }, async (t) => {
    const { session, wrapper, contexts } = await realSession(t);
    const command = { type: "prompt", message: "one input", streamingBehavior, operationId: "cold-1", timestamp: 10 };
    await Promise.all(Array.from({ length: 4 }, () => wrapper.send(command)));
    await session.waitForIdle();
    assert.deepEqual(session.messages.filter((message) => message.role === "user").map((message) => message.content),
      [[{ type: "text", text: "one input" }]]);
    assert.equal(contexts.length, 1);
    await assert.rejects(wrapper.send({ ...command, message: "changed input" }), /reused for different input/);
    await wrapper.send({ ...command, message: "next input", operationId: "cold-2", timestamp: 11 });
    await session.waitForIdle();
    assert.equal(session.messages.filter((message) => message.role === "user").length, 2);
  });
}

test("prompt admission serialization does not hold the session until model completion", { timeout: 2000 }, async (t) => {
  const { session, wrapper } = await realSession(t);
  let finish;
  session.agent.streamFunction = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    let finished = false;
    finish = () => {
      if (finished) return;
      finished = true;
      options?.signal?.removeEventListener("abort", finish);
      stream.push({ type: "done", reason: "stop", message: {
        role: "assistant", content: [{ type: "text", text: "finished" }], api: "openai-completions", provider: "admission-test",
        model: "admission-test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 20,
      } });
    };
    options?.signal?.addEventListener("abort", finish, { once: true });
    if (options?.signal?.aborted) finish();
    return stream;
  };
  try {
    await wrapper.send({ type: "prompt", message: "first", operationId: "first", timestamp: 12 });
    await wrapper.send({ type: "prompt", message: "queued", streamingBehavior: "followUp", operationId: "queued", timestamp: 13 });
    assert.equal(session.isStreaming, true);
    assert.deepEqual([...session.getFollowUpMessages()], ["queued"]);
  } finally {
    finish?.();
    await session.abort();
  }
});
