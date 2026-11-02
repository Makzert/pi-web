import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const draftStore = await jiti.import("../lib/draft-store.ts");
const imageHelpers = await jiti.import("../lib/image-attachments.ts");
const fuzzy = await jiti.import("../lib/file-fuzzy.ts");

// Execute the real component callbacks with deterministic hook state; DOM,
// networking effects and file reading are the only simulated boundaries.
let active;
const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const hooks = {
  ...React,
  useId() { const index = active.cursor++; return `editor-${active.id}-${index}`; },
  useRef(initial) { const index = active.cursor++; return active.slots[index] ??= { current: initial }; },
  useState(initial) {
    const owner = active, index = owner.cursor++;
    if (!(index in owner.slots)) owner.slots[index] = typeof initial === "function" ? initial() : initial;
    return [owner.slots[index], value => { owner.slots[index] = typeof value === "function" ? value(owner.slots[index]) : value; }];
  },
  useMemo(fn, deps) {
    const index = active.cursor++, previous = active.slots[index];
    if (!previous || !depsEqual(previous.deps, deps)) active.slots[index] = { deps, value: fn() };
    return active.slots[index].value;
  },
  useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
  useEffect() { active.cursor++; },
  useLayoutEffect(fn, deps) {
    const index = active.cursor++, previous = active.slots[index];
    if (!previous || !depsEqual(previous.deps, deps)) active.layouts.push(fn);
    active.slots[index] = { deps };
  },
  useSyncExternalStore(_subscribe, get) { active.cursor++; return get(); },
  useImperativeHandle(ref, create) { active.cursor++; if (ref) ref.current = create(); },
};
const source = ts.transpileModule(readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", source)(specifier => {
  if (specifier === "react") return { ...hooks, default: hooks, __esModule: true };
  if (specifier === "@/lib/draft-store") return draftStore;
  if (specifier === "@/lib/image-attachments") return imageHelpers;
  if (specifier === "@/lib/file-fuzzy") return fuzzy;
  if (specifier === "./FileIcons") return { FolderIcon: () => null, getFileIcon: () => null };
  if (specifier === "@/hooks/useIsMobile") return { useIsMobile: () => false };
  if (specifier === "@/hooks/useI18n") return { useI18n: () => ({ t: key => key }) };
  return require(specifier);
}, module, module.exports);
const { ChatInput } = module.exports;

function browserGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
}

function find(node, type) {
  if (!node || typeof node !== "object") return;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result; }
}
let nextId = 0;
function editor(key) {
  const owner = { id: ++nextId, cursor: 0, slots: [], layouts: [], ref: { current: null } };
  const render = (draftKey = key) => {
    key = draftKey;
    active = owner; owner.cursor = 0; owner.layouts = [];
    let tree = ChatInput.render({ draftKey, onSend() {}, isStreaming: false, modelList: [], modelNames: {} }, owner.ref);
    const layouts = owner.layouts;
    layouts.forEach(fn => fn());
    active = owner; owner.cursor = 0; owner.layouts = [];
    tree = ChatInput.render({ draftKey, onSend() {}, isStreaming: false, modelList: [], modelNames: {} }, owner.ref);
    return find(tree, "textarea");
  };
  return { render, ref: owner.ref, type(value) { render().props.onChange({ target: { value, selectionStart: value.length } }); } };
}

test("actual ChatInput follows store recalls, later editing and clear without an old effect writeback", t => {
  browserGlobal(t, "requestAnimationFrame", fn => { fn(); return 1; });
  const first = editor("editor-old"), second = editor("editor-new");
  first.type("typing"); second.type("other chat");
  draftStore.restoreRecallOnce("editor-old", "recall", ["returned"]);
  assert.equal(first.render().props.value, "returned\n\ntyping");
  assert.equal(second.render().props.value, "other chat");
  first.type("edited restored text");
  assert.equal(draftStore.getDraft("editor-old").value, "edited restored text");
  draftStore.clearDraft("editor-old");
  draftStore.restoreRecallOnce("editor-old", "recall", ["returned"]);
  assert.equal(first.render().props.value, "");
});

test("promotion retains newly typed text and redirects an earlier FileReader to the real session", async t => {
  const readers = [];
  class Reader { readAsDataURL() { readers.push(this); } }
  browserGlobal(t, "FileReader", Reader);
  const first = editor("new:/draft-promotion");
  first.type("typed during first request");
  first.ref.current.addImages([{ type: "image/png", size: 3 }]);
  assert.equal(readers.length, 1);
  assert.equal(first.render("real-promoted-session").props.value, "typed during first request");
  readers[0].result = "data:image/png;base64,AQID";
  readers[0].onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(draftStore.getDraft("real-promoted-session").images, [{ data: "AQID", mimeType: "image/png" }]);
  assert.equal(draftStore.getDraft("new:/draft-promotion"), null);
  const later = editor("new:/draft-promotion");
  assert.equal(later.render().props.value, "", "reusing the cwd does not alias the old session");
});
