import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

function setup(t, clear) {
  let subscriber;
  const queue = { steering: ["old"], followUp: [] };
  const inner = { sessionId: crypto.randomUUID(), isStreaming: false, isCompacting: false, isBashRunning: false,
    getSteeringMessages: () => queue.steering, getFollowUpMessages: () => queue.followUp,
    subscribe: handler => { subscriber = handler; return () => {}; }, dispose() {},
    clearQueueCommitted: async operationId => clear(queue, () => subscriber({ type: "queue_update", ...queue }), operationId),
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());
  return { inner, wrapper, queue, command: { type: "clear_queue", operationId: "op", timestamp: 1, expectedRuntimeId: wrapper.getQueueSnapshot().runtimeId } };
}

test("same-ID recalls share execution and replay original text without clearing new inputs", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { wrapper, queue, command } = setup(t, async (queue, emit) => {
    calls++;
    const result = { steering: [...queue.steering], followUp: [] };
    queue.steering = [];
    emit();
    await gate;
    return result;
  });
  const first = wrapper.send(command);
  const retry = wrapper.send(command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper.isRunning(), true, "pending recall protects idle reclamation");
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, retry]);
  assert.deepEqual(a, b);
  assert.deepEqual(a.steering, ["old"]);
  assert.equal(Object.isFrozen(a.queue), true);
  queue.steering = ["new"];
  assert.deepEqual((await wrapper.send(command)).steering, ["old"]);
  assert.deepEqual(queue.steering, ["new"]);
  assert.equal(calls, 1);
  assert.equal(wrapper.isRunning(), false);
});

test("ordinary unknown cannot execute again; runtime mismatch rejects before effects", async t => {
  let calls = 0;
  const { wrapper, queue, command } = setup(t, async queue => {
    calls++; queue.steering = []; throw new Error("failure after clearing");
  });
  await assert.rejects(wrapper.send(command), { code: "QUEUE_RECALL_UNKNOWN" });
  queue.steering = ["new"];
  await assert.rejects(wrapper.send(command), { code: "QUEUE_RECALL_UNKNOWN" });
  await assert.rejects(wrapper.send({ ...command, operationId: "other", expectedRuntimeId: "old-runtime" }), { code: "QUEUE_INSTANCE_CHANGED" });
  assert.equal(calls, 1);
  assert.deepEqual(queue.steering, ["new"]);
});

test("managed unconfirmed clear is retryable under its original ID", async t => {
  let calls = 0;
  const { wrapper, inner, command } = setup(t, async () => {
    if (++calls === 1) throw Object.assign(new Error("receipt unknown"), { code: "STAGE_COMMIT_UNAVAILABLE" });
    return { steering: ["original receipt"], followUp: [] };
  });
  inner._managedQueueActive = true;
  await assert.rejects(wrapper.send(command), { code: "QUEUE_RECALL_RETRYABLE" });
  assert.equal(wrapper.isRunning(), true);
  assert.deepEqual((await wrapper.send(command)).steering, ["original receipt"]);
  assert.equal(calls, 2);
});

test("failed browser subscriber cannot change a clear result or block other subscribers", async t => {
  const { wrapper, command } = setup(t, async (queue, emit) => {
    const result = { steering: queue.steering, followUp: [] };
    queue.steering = []; emit(); return result;
  });
  let brokenCalls = 0;
  wrapper.onEvent(() => { brokenCalls++; throw new Error("closed stream"); });
  const updates = [];
  wrapper.onEvent(event => updates.push(event));
  const before = wrapper.getQueueSnapshot();
  const result = await wrapper.send(command);
  assert.deepEqual(result.steering, ["old"]);
  assert.equal(updates[0].queue, result.queue);
  assert.ok(result.queue.revision > before.revision);
  assert.deepEqual(before.steering, ["old"]);
  assert.equal(brokenCalls, 1);
});
