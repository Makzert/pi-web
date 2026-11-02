import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { recallQueue, getRecallFailure, abandonUnknownRecall } = await jiti.import("./queue-recall.ts");
const { getDraft, clearDraft, updateDraft } = await jiti.import("./draft-store.ts");

function receipt(sid, command, text = "old") {
  return { operationId: command.operationId, steering: [text], followUp: [],
    queue: { sessionId: sid, runtimeId: command.expectedRuntimeId, revision: 1, steering: [], followUp: [] } };
}

test("recall survives view replacement, restores original draft and shares duplicate clicks", async t => {
  const sid = crypto.randomUUID();
  updateDraft("new-session", () => ({ value: "new session typing", images: [] }));
  let resolve;
  const gate = new Promise(r => { resolve = r; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const command = JSON.parse(init.body);
    await gate;
    return new Response(JSON.stringify({ data: receipt(sid, command) }));
  });
  const a = recallQueue(sid, "runtime");
  const b = recallQueue(sid, "runtime");
  assert.equal(a, b);
  resolve();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(getDraft(sid).value, "old");
  assert.equal(getDraft("new-session").value, "new session typing");
});

test("lost HTTP response retries the same identity; an instance change needs explicit abandonment", async t => {
  const sid = crypto.randomUUID();
  const commands = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const command = JSON.parse(init.body); commands.push(command);
    if (commands.length === 1) throw new TypeError("reply lost");
    return new Response(JSON.stringify({ data: receipt(sid, command) }));
  });
  await assert.rejects(recallQueue(sid, "runtime"), /reply lost/);
  await recallQueue(sid, "runtime");
  assert.deepEqual(commands[0], commands[1]);
  clearDraft(sid);

  const unknownSid = crypto.randomUUID();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "gone", code: "QUEUE_INSTANCE_CHANGED" }), { status: 409 }));
  await assert.rejects(recallQueue(unknownSid, "old-runtime"), /gone/);
  assert.ok(getRecallFailure(unknownSid));
  await assert.rejects(recallQueue(unknownSid, "new-runtime"), /gone/);
  abandonUnknownRecall(unknownSid);
  assert.equal(getRecallFailure(unknownSid), undefined);
});
