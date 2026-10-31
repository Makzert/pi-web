import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, replaceUserMessageText } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, options = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...options }),
    ),
  );
}

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("custom assistant block content shares the normal metadata frame and undefined falls back", () => {
  const message = {
    role: "assistant", provider: "test", model: "fixture", stopReason: "error",
    errorMessage: "CUSTOM_RENDER_PROVIDER_ERROR",
    usage: { input: 731, output: 953, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1731 } },
    content: [{ type: "text", text: "DEFAULT_TEXT_CONTENT" },
      { type: "toolCall", toolCallId: "image", toolName: "node_image", input: {} }],
  };
  const html = renderMessage(message, { renderAssistantBlock: (block) => block.type === "toolCall"
    ? React.createElement("div", null, "CUSTOM_MEDIA_CONTENT") : undefined });
  assert.match(html, /DEFAULT_TEXT_CONTENT/);
  assert.equal((html.match(/CUSTOM_MEDIA_CONTENT/g) ?? []).length, 1);
  assert.equal((html.match(/CUSTOM_RENDER_PROVIDER_ERROR/g) ?? []).length, 1);
  assert.equal((html.match(/731 in/g) ?? []).length, 1);
  assert.equal((html.match(/\$0\.1731/g) ?? []).length, 1);
});

test("memo comparison invalidates a changed assistant block renderer", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "same message" }] };
  const before = { message, renderAssistantBlock: () => "before" };
  assert.equal(MessageView.compare(before, before), true);
  assert.equal(MessageView.compare(before, { ...before, renderAssistantBlock: () => "after" }), false);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});
