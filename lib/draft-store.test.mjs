import assert from "node:assert/strict";
import test from "node:test";
import { getDraft, getDraftSnapshot, updateDraft, clearDraft, restoreRecallOnce, subscribeDraft } from "./draft-store.ts";

test("recall merges into its original draft, retains images and notifies with the dedupe fact already applied", () => {
  const key = "recall-original";
  updateDraft(key, () => ({ value: "typing", images: [{ data: "AQID", mimeType: "image/png" }] }));
  let notifications = 0;
  const unsubscribe = subscribeDraft(key, () => {
    notifications++;
    restoreRecallOnce(key, "op", ["recalled"]);
  });
  restoreRecallOnce(key, "op", ["recalled"]);
  assert.equal(notifications, 1);
  assert.deepEqual(getDraft(key), { value: "recalled\n\ntyping", images: [{ data: "AQID", mimeType: "image/png" }] });
  unsubscribe();
  updateDraft(key, draft => ({ ...draft, value: draft.value + " edited" }));
  assert.equal(getDraft(key).value, "recalled\n\ntyping edited");
  clearDraft(key);
  restoreRecallOnce(key, "op", ["recalled"]);
  assert.equal(getDraft(key), null, "clearing/sending does not erase recall dedupe");
});

test("switching editors has no whole-draft writeback and unrelated drafts stay independent", () => {
  updateDraft("old", () => ({ value: "old", images: [] }));
  updateDraft("new", () => ({ value: "new", images: [] }));
  const oldRender = getDraftSnapshot("old");
  restoreRecallOnce("old", "op-old", ["returned later"]);
  assert.equal(oldRender.value, "old");
  assert.equal(getDraftSnapshot("old").value, "returned later\n\nold");
  assert.equal(getDraftSnapshot("new").value, "new");
  assert.equal(getDraftSnapshot("old"), getDraftSnapshot("old"), "external-store snapshots are stable");
});
