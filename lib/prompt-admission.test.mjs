import assert from "node:assert/strict";
import test from "node:test";
import { waitForQueuedPromptAdmission } from "./prompt-admission.ts";

test("queued input waits for the first prompt to enter its agent run", async () => {
  let release;
  let streaming = false;
  const preflight = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const admission = waitForQueuedPromptAdmission(true, () => streaming, preflight).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  streaming = true;
  release(true);
  assert.equal(await admission, true);
});

test("queued input is rejected if the first prompt fails preflight", async () => {
  await assert.rejects(waitForQueuedPromptAdmission(true, () => false, Promise.resolve(false)),
    /previous prompt did not start/);
});
