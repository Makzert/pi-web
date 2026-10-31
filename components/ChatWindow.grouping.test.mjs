import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let fixture;
const nothing = () => null;
// Exercise the actual ChatWindow, MessageView and stateful process disclosure.
// Only unrelated browser hooks/composer/markdown/media implementations are stubbed.
const stubs = {
  "@/hooks/useKeyboardShortcuts": { registerAbortHandler() {} },
  "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
  "@/hooks/useAgentSession": { useAgentSession: () => fixture },
  "@/hooks/useAudio": { useAudio: () => ({ soundEnabled: false, playDoneSound() {} }) },
  "@/hooks/useDragDrop": { useDragDrop: () => ({ isDragOver: false }) },
  "@/hooks/useIsMobile": { useIsMobile: () => true },
  "./ChatInput": { ChatInput: nothing },
  "./ChatMinimap": { ChatMinimap: nothing, useMessageRefs: () => ({ current: [] }) },
  "./ExtensionStatusBar": { ExtensionStatusBar: nothing },
  "./VideoPreview": { VideoPreview: ({ src }) => React.createElement("video", { src }) },
  "./MarkdownBody": { MarkdownBody: ({ children }) => React.createElement("div", null, children) },
};
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const loaded = { exports: {} };
  cache.set(file, loaded);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  });
  function localRequire(specifier) {
    if (specifier === "react" && ["ChatWindow.tsx", "MessageView.tsx"].some((name) => file === join(project, "components", name))) {
      return { ...React, useState(initial) {
        const [value, update] = React.useState(initial);
        // Exercise closed and opened disclosures using the actual components.
        const expanded = file.endsWith("/ChatWindow.tsx") ? fixture.expandedProcesses : fixture.expandedMessageDetails;
        return [expanded && initial === false ? true : value, update];
      } };
    }
    if (stubs[specifier]) return stubs[specifier];
    if (specifier.startsWith("@/") || specifier.startsWith(".")) {
      const base = specifier.startsWith("@/")
        ? join(project, specifier.slice(2)) : resolve(dirname(file), specifier);
      const target = [".ts", ".tsx", ".js", ""].map((ext) => base + ext).find(existsSync);
      assert.ok(target, `Missing fixture dependency: ${specifier}`);
      return load(target);
    }
    return require(specifier);
  }
  new Function("require", "module", "exports", outputText)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
const { ChatWindow } = load(join(project, "components/ChatWindow.tsx"));

function text(value, phase) {
  return { type: "text", text: value, ...(phase ? {
    textSignature: JSON.stringify({ v: 1, id: `msg-${value}`, phase }),
  } : {}) };
}
function assistant(content, extra = {}) {
  return { role: "assistant", provider: "test", model: "fixture", stopReason: "stop", content, ...extra };
}
function tool(name = "node_edit", id = "call-1") {
  return { type: "toolCall", toolCallId: id, toolName: name, input: { node: "fixture", path: "/fixture/file.png" } };
}
function receipt(customType = "node-bg-result", display = true) {
  return { role: "custom", customType, display, content: "RAW_RECEIPT" };
}
const user = { role: "user", content: "USER_REQUEST" };
const work = () => assistant([{ type: "thinking", thinking: "internal reasoning", deferred: true }, tool()]);
function render(messages, overrides = {}) {
  fixture = {
    messages, entryIds: messages.map((_, index) => `entry-${index}`),
    streamState: { isStreaming: false, streamingMessage: null },
    agentRunning: false, bashRunning: false, isNew: false, loading: false, error: null,
    notices: [], extensionWidgets: [], extensionStatuses: new Map(),
    extensionDialog: null, extensionCustomUi: null, modelNames: {}, modelList: [],
    modelThinkingLevels: {}, modelThinkingLevelMaps: {}, displayModel: null,
    queuedMessages: [], sessionStats: null,
    sessionIdRef: { current: "fixture" }, messagesEndRef: { current: null },
    scrollContainerRef: { current: null }, lastUserMsgRef: { current: null },
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(ChatWindow, {
    session: { id: "fixture", cwd: "/fixture" }, newSessionCwd: null,
  }));
}
function assertFolded(html) {
  assert.doesNotMatch(html, /i18n\.thinking|node_edit|RAW_RECEIPT|COMMENTARY/);
  assert.match(html, /aria-expanded="false"/);
}

for (const customType of ["node-bg-result", "node-worker-result", "node-worker-input-required"]) {
  for (const display of [true, false]) {
    test(`folds mixed-phase work and ${customType} (display=${display}), not either answer`, () => {
      const messages = [
        user, assistant([text("COMMENTARY", "commentary")]), work(),
        { role: "toolResult", toolCallId: "call-1", content: [text("tool success")] },
        assistant([text("MAIN_ANSWER", "final_answer")]), receipt(customType, display),
        assistant([{ type: "thinking", thinking: "follow-up reasoning", deferred: true }]),
        assistant([text("SUPPLEMENT_ANSWER", "final_answer")]),
      ];
      for (const history of [messages, JSON.parse(JSON.stringify(messages))]) {
        const html = render(history);
        assertFolded(html);
        assert.match(html, /MAIN_ANSWER/);
        assert.match(html, /SUPPLEMENT_ANSWER/);
        assert.ok(html.indexOf("MAIN_ANSWER") < html.indexOf("SUPPLEMENT_ANSWER"));
        assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 2);
      }
    });
  }
}

test("a receipt without an assistant follow-up is still folded", () => {
  assertFolded(render([user, assistant([text("MAIN_ANSWER", "final_answer")]), receipt()]));
});

test("legacy answers remain visible on both sides of a late event", () => {
  const html = render([user, work(), assistant([text("MAIN_ANSWER")]), receipt(), work(), assistant([text("SUPPLEMENT_ANSWER")])]);
  assertFolded(html);
  assert.match(html, /MAIN_ANSWER/);
  assert.match(html, /SUPPLEMENT_ANSWER/);
});

test("process-only completion does not leak thinking and tools", () => {
  assertFolded(render([user, assistant([text("COMMENTARY", "commentary")]), work()]));
});

test("running mixed-phase work stays visible until a formal answer arrives", () => {
  const messages = [user, assistant([text("COMMENTARY", "commentary")]), work()];
  const active = render(messages, { agentRunning: true });
  assert.match(active, /COMMENTARY/);
  assert.match(active, /i18n\.thinking/);
  assert.match(active, /node_edit/);
  assertFolded(render(messages));
});

test("a live receipt run does not reopen an earlier completed process group", () => {
  const messages = [user, work(), assistant([text("MAIN_ANSWER", "final_answer")]), receipt(), work()];
  const html = render(messages, { agentRunning: true });
  assert.match(html, /MAIN_ANSWER/);
  assert.match(html, /RAW_RECEIPT/);
  assert.equal((html.match(/i18n\.thinking/g) ?? []).length, 1);
  assert.equal((html.match(/node_edit/g) ?? []).length, 1);
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 1);
});

test("multiple native answers within one message remain ordered and visible", () => {
  const html = render([user, assistant([
    text("COMMENTARY", "commentary"), text("MAIN_ANSWER", "final_answer"),
    { type: "thinking", thinking: "more reasoning", deferred: true },
    text("COMMENTARY", "commentary"), text("SUPPLEMENT_ANSWER", "final_answer"),
  ])]);
  assertFolded(html);
  assert.match(html, /MAIN_ANSWER/);
  assert.match(html, /SUPPLEMENT_ANSWER/);
});

test("a commentary-only provider failure remains visible outside process details", () => {
  const html = render([user, assistant([text("COMMENTARY", "commentary")], {
    stopReason: "error", errorMessage: "FIXTURE_PROVIDER_ERROR",
  })]);
  assertFolded(html);
  assert.match(html, /role="alert"/);
  assert.match(html, /FIXTURE_PROVIDER_ERROR/);
});

test("legacy progress text does not prematurely collapse a running turn", () => {
  const messages = [user, work(), assistant([text("LEGACY_PROGRESS")])];
  const html = render(messages, { agentRunning: true });
  assert.match(html, /i18n\.thinking/);
  assert.match(html, /node_edit/);
  assert.match(html, /LEGACY_PROGRESS/);
  assert.doesNotMatch(render(messages), /i18n\.thinking|node_edit/);
});

test("a legacy provider error after earlier text is not hidden", () => {
  const html = render([user, assistant([text("PARTIAL_RESPONSE")]), assistant([], {
    stopReason: "error", errorMessage: "FIXTURE_PROVIDER_ERROR",
  })]);
  assert.match(html, /PARTIAL_RESPONSE/);
  assert.match(html, /role="alert"/);
  assert.match(html, /FIXTURE_PROVIDER_ERROR/);
});

test("opening process details reveals the original receipts and tool messages", () => {
  const messages = [user, assistant([text("COMMENTARY", "commentary")]), work(),
    assistant([text("MAIN_ANSWER", "final_answer")]), receipt(), work(),
    assistant([text("SUPPLEMENT_ANSWER", "final_answer")])];
  assertFolded(render(messages));
  const opened = render(messages, { expandedProcesses: true });
  for (const content of ["COMMENTARY", "node_edit", "RAW_RECEIPT", "MAIN_ANSWER", "SUPPLEMENT_ANSWER"]) {
    assert.ok(opened.includes(content), `missing original content: ${content}`);
  }
  assert.equal((opened.match(/aria-expanded="true"/g) ?? []).length, 2);
});

test("user messages and compaction summaries stay outside process disclosures", () => {
  const html = render([user, work(), { role: "custom", customType: "compaction", content: "COMPACTION_SUMMARY" },
    work(), assistant([text("MAIN_ANSWER", "final_answer")]),
    { role: "user", content: "NEXT_REQUEST" }, work()]);
  assertFolded(html);
  assert.match(html, /USER_REQUEST/);
  assert.match(html, /COMPACTION_SUMMARY/);
  assert.match(html, /MAIN_ANSWER/);
  assert.match(html, /NEXT_REQUEST/);
});

for (const customType of ["ultron-direct", "extension-warning"]) {
  for (const display of [true, undefined]) {
    test(`visible custom ${customType} (display=${display}) is not process output`, () => {
      const message = { role: "custom", customType, display, content: "VISIBLE_EXTENSION_REPLY" };
      for (const messages of [[user, message], [user, assistant([text("MAIN_ANSWER", "final_answer")]), message]]) {
        const html = render(messages);
        assert.match(html, /VISIBLE_EXTENSION_REPLY/);
        assert.doesNotMatch(html, /chat\.processDetails/);
      }
    });
  }
}

test("hidden custom technical messages remain inside completed process details", () => {
  const messages = [user, { role: "custom", customType: "technical-trace", display: false, content: "HIDDEN_TRACE" }];
  const html = render(messages);
  assert.doesNotMatch(html, /HIDDEN_TRACE/);
  assert.match(html, /chat\.processDetails/);
  assert.match(render(messages, { expandedProcesses: true }), /HIDDEN_TRACE/);
});

for (const [successfulName, failedName] of [["node_image", "node_video"], ["node_video", "node_image"]]) {
  for (const failedFirst of [false, true]) {
    test(`mixed media keeps ${failedName} failure beside ${successfulName} success (failedFirst=${failedFirst})`, () => {
      const makeCall = (name, id) => ({ ...tool(name, id), input: {
        node: "fixture", path: name === "node_image" ? "/fixture/image.png" : "/fixture/video.mp4",
      } });
      const success = makeCall(successfulName, "success");
      const failure = makeCall(failedName, "failure");
      const calls = failedFirst ? [failure, success] : [success, failure];
      const messages = [user, assistant([{ type: "thinking", thinking: "media work", deferred: true }, ...calls, tool()]),
        { role: "toolResult", toolCallId: "success", content: [], details: {
          mediaType: successfulName === "node_image" ? "image" : "video",
          mediaUrl: successfulName === "node_image" ? "/fixture/image.png" : "/fixture/video.mp4",
        } },
        { role: "toolResult", toolCallId: "failure", isError: true, content: [text("FAILED_MEDIA_DETAIL")] },
        assistant([text("MAIN_ANSWER", "final_answer")]),
      ];
      const html = render(messages);
      assertFolded(html);
      const tag = successfulName === "node_image" ? "<img " : "<video ";
      assert.ok(html.includes(tag), "successful preview is missing");
      assert.ok(html.includes(failedName), "failed tool disclosure is missing");
      assert.equal(html.indexOf(failedName) < html.indexOf(tag), failedFirst, "media call order changed");
      const opened = render(messages, { expandedMessageDetails: true });
      assert.match(opened, /FAILED_MEDIA_DETAIL/);
    });
  }
}

test("a media result without a supported preview retains its tool disclosure", () => {
  const messages = [user, assistant([
    { ...tool("node_image", "image"), input: { node: "fixture", path: "/fixture/image.png" } },
    { ...tool("node_video_model", "metadata"), input: { node: "fixture", path: "/fixture/no-extension" } }, tool(),
  ]), { role: "toolResult", toolCallId: "metadata", content: [text("METADATA_ONLY_RESULT")] },
  assistant([text("MAIN_ANSWER", "final_answer")])];
  const html = render(messages);
  assert.match(html, /<img /);
  assert.match(html, /node_video_model/);
  assert.match(render(messages, { expandedMessageDetails: true }), /METADATA_ONLY_RESULT/);
});

test("successful image/video previews preserve the order of tool calls", () => {
  const html = render([user, assistant([
    tool("node_image", "image"),
    { ...tool("node_video", "video"), input: { node: "fixture", path: "/fixture/video.mp4" } }, tool(),
  ]), assistant([text("MAIN_ANSWER", "final_answer")])]);
  assert.ok(html.includes("<img ") && html.includes("<video "));
  assert.ok(html.indexOf("<img ") < html.indexOf("<video "));
});

for (const name of ["node_image", "node_video"]) {
  for (const stopReason of ["stop", "error"]) {
    for (const tail of ["single-preview", "preview-then-failure", "failure-then-preview", "trailing-process"]) {
      test(`media message metadata renders once (${name}, ${stopReason}, ${tail})`, () => {
        const preview = { ...tool(name, "metadata-preview"), input: {
          node: "fixture", path: name === "node_image" ? "/fixture/image.png" : "/fixture/video.mp4",
        } };
        const failed = { ...tool(name === "node_image" ? "node_video" : "node_image", "failed-preview"), input: {
          node: "fixture", path: name === "node_image" ? "/fixture/failed.mp4" : "/fixture/failed.png",
        } };
        const calls = tail === "failure-then-preview" ? [failed, preview]
          : tail === "preview-then-failure" ? [preview, failed]
            : tail === "trailing-process" ? [preview, tool()] : [preview];
        const messages = [user, assistant([
          { type: "thinking", thinking: "reasoning", deferred: true }, ...calls,
        ], {
          stopReason, errorMessage: stopReason === "error" ? "MEDIA_PROVIDER_FAILURE" : undefined,
          usage: { input: 731, output: 953, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1731 } },
        }),
        { role: "toolResult", toolCallId: "metadata-preview", content: [], details: {
          mediaType: name === "node_image" ? "image" : "video", mediaUrl: preview.input.path,
        } },
        { role: "toolResult", toolCallId: "failed-preview", isError: true, content: [text("MEDIA_TOOL_FAILED_DETAIL")] },
        assistant([text("RECOVERED_ANSWER")])];
        const before = JSON.stringify(messages);
        const closed = render(messages);
        assert.match(closed, /RECOVERED_ANSWER/);
        assert.doesNotMatch(closed, /i18n\.thinking/);
        const opened = render(messages, { expandedProcesses: true, expandedMessageDetails: true });
        assert.equal((opened.match(/731 in/g) ?? []).length, 1, "usage input missing or duplicated");
        assert.equal((opened.match(/953 out/g) ?? []).length, 1, "usage output missing or duplicated");
        assert.equal((opened.match(/\$0\.1731/g) ?? []).length, 1, "message cost missing or duplicated");
        assert.equal((opened.match(/MEDIA_PROVIDER_FAILURE/g) ?? []).length, stopReason === "error" ? 1 : 0);
        const tag = name === "node_image" ? /<img /g : /<video /g;
        assert.equal((opened.match(tag) ?? []).length, 1, "media preview duplicated");
        if (tail.includes("failure")) assert.match(opened, /MEDIA_TOOL_FAILED_DETAIL/);
        if (tail !== "trailing-process") assert.equal((closed.match(/731 in/g) ?? []).length, 1);
        assert.equal(JSON.stringify(messages), before, "presentation mutated persisted metadata");
      });
    }
  }
}

test("native answer metadata remains single when a message mixes commentary, media and final text", () => {
  const messages = [user, assistant([
    text("COMMENTARY", "commentary"), tool("node_image", "native-image"), text("MAIN_ANSWER", "final_answer"),
  ], { stopReason: "error", errorMessage: "NATIVE_PROVIDER_FAILURE",
    usage: { input: 731, output: 953, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1731 } },
  })];
  const html = render(messages, { expandedProcesses: true });
  assert.equal((html.match(/731 in/g) ?? []).length, 1);
  assert.equal((html.match(/NATIVE_PROVIDER_FAILURE/g) ?? []).length, 1);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.match(html, /MAIN_ANSWER/);
});

test("user-facing media remains visible while surrounding thinking and tools fold", () => {
  const media = [
    { ...tool("node_video", "video"), input: { node: "fixture", path: "/fixture/video.mp4" } },
    { ...tool("node_image", "image"), input: { node: "fixture", path: "/fixture/image.png" } },
  ];
  const html = render([user,
    assistant([{ type: "thinking", thinking: "before media", deferred: true }, tool(), ...media, tool("node_edit", "after")]),
    assistant([text("MAIN_ANSWER", "final_answer")]),
  ]);
  assertFolded(html);
  assert.match(html, /<video /);
  assert.match(html, /<img /);
  assert.match(html, /MAIN_ANSWER/);
});
