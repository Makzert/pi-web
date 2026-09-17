import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

function phased(text, phase) {
  return { type: "text", text, textSignature: JSON.stringify({ v: 1, id: `msg-${text}`, phase }) };
}

test("reads native phases without interpreting opaque signatures or body text", async () => {
  const { getTextPhase } = await loadSubject();
  assert.equal(getTextPhase(phased("working", "commentary")), "commentary");
  assert.equal(getTextPhase(phased("done", "final_answer")), "final_answer");
  for (const textSignature of [undefined, "opaque", "{", "null", '{"phase":"commentary"}',
    '{"v":2,"id":"x","phase":"commentary"}', '{"v":1,"id":"x","phase":"unknown"}']) {
    assert.equal(getTextPhase({ type: "text", text: 'phase="commentary"', textSignature }), undefined);
  }
});

test("preserves the order of commentary and multiple answers within one Pi message", async () => {
  const { getPhasedAssistantParts } = await loadSubject();
  const message = assistant([
    phased("checking", "commentary"), phased("conclusion", "final_answer"),
    phased("checking background result", "commentary"), phased("correction", "final_answer"),
  ]);
  const parts = getPhasedAssistantParts(message);
  assert.deepEqual(parts.map((part) => [part.kind, part.blocks.map((b) => b.text)]), [
    ["process", ["checking"]], ["answer", ["conclusion"]],
    ["process", ["checking background result"]], ["answer", ["correction"]],
  ]);
  assert.deepEqual(getPhasedAssistantParts(JSON.parse(JSON.stringify(message))), parts);
});

test("background follow-up cannot absorb an earlier classified conclusion", async () => {
  const { findLegacyGroupEnd, hasAssistantPhase, getPhasedAssistantParts } = await loadSubject();
  const messages = [
    { role: "user", content: "run the task" },
    assistant([{ type: "text", text: "legacy progress" }]),
    assistant([phased("original conclusion", "final_answer")]),
    { role: "custom", customType: "node-bg-result", display: true, content: "done" },
    assistant([phased("background acknowledgement", "commentary")]),
    assistant([phased("supplement", "final_answer")]),
  ];
  assert.equal(findLegacyGroupEnd(messages.slice(0, 3), 0), 2);
  assert.equal(findLegacyGroupEnd(messages, 0), 2);
  const answers = messages.filter(hasAssistantPhase).flatMap(getPhasedAssistantParts)
    .filter((part) => part.kind === "answer").flatMap((part) => part.blocks.map((b) => b.text));
  assert.deepEqual(answers, ["original conclusion", "supplement"]);
  messages[3] = { ...messages[3], customType: "node-worker-input-required", display: false };
  assert.equal(findLegacyGroupEnd(messages, 0), 2);
});

test("unclassified histories retain user and compaction boundaries", async () => {
  const { findLegacyGroupEnd, hasAssistantPhase } = await loadSubject();
  const messages = [
    { role: "user", content: "question" }, assistant([{ type: "text", text: "answer" }]),
    { role: "custom", customType: "compaction", content: "summary" },
    assistant([{ type: "text", text: "continued" }]), { role: "user", content: "next" },
  ];
  assert.equal(messages.some(hasAssistantPhase), false);
  assert.equal(findLegacyGroupEnd(messages, 0), 2);
  assert.equal(findLegacyGroupEnd(messages, 2), 4);
});

test("mixed messages keep unknown text and visual results visible while folding tools and thinking", async () => {
  const { getPhasedAssistantParts } = await loadSubject();
  const parts = getPhasedAssistantParts(assistant([
    { type: "thinking", thinking: "", deferred: true },
    phased("working", "commentary"),
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "unclassified answer" },
    { type: "toolCall", toolCallId: "call-2", toolName: "node_image", input: {} },
    { type: "image", source: { type: "url", url: "/image.png" } },
  ]));
  assert.deepEqual(parts.map((part) => [part.kind, part.blocks.map((b) => b.type)]), [
    ["process", ["thinking", "text", "toolCall"]], ["answer", ["text", "toolCall", "image"]],
  ]);
});

test("commentary-only failures keep a visible error without inventing an answer", async () => {
  const { getPhasedAssistantParts } = await loadSubject();
  const message = assistant([phased("working", "commentary")]);
  assert.deepEqual(getPhasedAssistantParts(message).map((part) => part.kind), ["process"]);
  assert.deepEqual(getPhasedAssistantParts({ ...message, stopReason: "error", errorMessage: "offline" }), [
    { kind: "process", blocks: message.content }, { kind: "answer", blocks: [] },
  ]);
});
