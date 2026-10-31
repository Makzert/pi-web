import assert from "node:assert/strict";
import test from "node:test";
import { sendAgentCommand } from "./agent-client.ts";

for (const command of [
  { type: "steer", message: "go" },
  { type: "follow_up", message: "next" },
  { type: "clear_queue" },
  { type: "prompt", message: "next", streamingBehavior: "followUp" },
]) {
  test(`${command.type} does not transparently retry an unknown transport outcome`, async (t) => {
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      requests.push(JSON.parse(init.body));
      throw new TypeError("response lost after acceptance");
    });
    await assert.rejects(sendAgentCommand("session-1", { ...command, operationId: "op-1", timestamp: 123 }), /response lost/);
    assert.equal(requests.length, 1);
  });
}

test("an unknown commit receipt is surfaced without assuming server idempotency", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(JSON.stringify({ error: "stage op-2 has no confirmed commit receipt" }), { status: 500 });
  });
  await assert.rejects(sendAgentCommand("session-1", { type: "clear_queue", operationId: "op-2" }), /no confirmed commit receipt/);
  assert.equal(requests, 1);
});

test("explicit caller retries preserve the supplied operation identity", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) throw new TypeError("response lost");
    return new Response(JSON.stringify({ success: true, data: null }), { status: 200 });
  });
  const command = { type: "prompt", message: "next", streamingBehavior: "followUp", operationId: "op-prompt", timestamp: 125 };
  await assert.rejects(sendAgentCommand("session-1", command), /response lost/);
  await sendAgentCommand("session-1", command);
  assert.deepEqual(requests, [command, command]);
});
