import assert from "node:assert/strict";
import test from "node:test";
import { streamReducer } from "./stream-state.ts";

test("an interrupted token preview is replaced by regeneration from the last boundary", () => {
  let state = { isStreaming: false, streamingMessage: null };
  state = streamReducer(state, { type: "start" });
  state = streamReducer(state, { type: "update", message: { role: "assistant", content: [{ type: "text", text: "old partial" }] } });
  assert.equal(state.streamingMessage?.content?.[0]?.text, "old partial");
  state = streamReducer(state, { type: "end" });
  assert.equal(state.streamingMessage, null);
  state = streamReducer(state, { type: "start" });
  state = streamReducer(state, { type: "update", message: { role: "assistant", content: [{ type: "text", text: "new answer" }] } });
  assert.equal(state.streamingMessage?.content?.[0]?.text, "new answer");
});
