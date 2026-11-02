import assert from "node:assert/strict";
import test from "node:test";
import { QueueSnapshotTracker } from "./queue-state.ts";

const snapshot = (runtimeId, revision, steering = []) => ({ sessionId: "s", runtimeId, revision, steering, followUp: [] });

test("late clear/get_state snapshots cannot overwrite a newer event", () => {
  const tracker = new QueueSnapshotTracker("s");
  tracker.accept(snapshot("a", 1), true);
  const read = tracker.capture();
  tracker.accept(snapshot("a", 3, ["new"]));
  assert.equal(tracker.accept(snapshot("a", 2), false), false);
  assert.equal(tracker.accept(snapshot("a", 1), true, read), false);
  assert.equal(tracker.absent(read), false);
  assert.deepEqual(tracker.snapshot.steering, ["new"]);
});

test("only a current handshake adopts a runtime; old reads/absences cannot switch it back", () => {
  const tracker = new QueueSnapshotTracker("s");
  tracker.accept(snapshot("a", 7), true);
  const old = tracker.capture();
  assert.equal(tracker.accept(snapshot("b", 0)), false);
  assert.equal(tracker.accept(snapshot("b", 0, ["new runtime"]), true), true);
  assert.equal(tracker.accept(snapshot("a", 99), true, old), false);
  assert.equal(tracker.accept(snapshot("a", 99), true), false);
  assert.equal(tracker.absent(old), false);
  assert.equal(tracker.accept({ ...snapshot("b", 1), sessionId: "other" }), false);
  assert.equal(tracker.snapshot.runtimeId, "b");
});

test("absence retires a runtime, and an idle HTTP snapshot can initialize without SSE", () => {
  const tracker = new QueueSnapshotTracker("s");
  const initial = tracker.capture();
  assert.equal(tracker.accept(snapshot("a", 0, ["idle"]), true, initial), true);
  assert.equal(tracker.absent(tracker.capture()), true);
  assert.equal(tracker.accept(snapshot("a", 4), true), false);
  assert.equal(tracker.accept(snapshot("b", 0), true, tracker.capture()), true);
});
