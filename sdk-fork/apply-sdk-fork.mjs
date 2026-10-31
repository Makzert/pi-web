/** Apply Ultron's narrowly scoped Pi 0.84.2 fork after npm installs the pinned packages. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(process.argv[2] ?? join(here, ".."));
// Resolve from this package so the same installer works with a hoisted npm
// dependency as well as a checkout-local node_modules directory.
const codingRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const nestedAgentRoot = join(codingRoot, "node_modules", "@earendil-works", "pi-agent-core");
let topAgentRoot;
try {
  topAgentRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-agent-core"))));
} catch {
  topAgentRoot = join(projectRoot, "node_modules", "@earendil-works", "pi-agent-core");
}
const agentRoot = existsSync(join(nestedAgentRoot, "package.json"))
  ? nestedAgentRoot : topAgentRoot;

const patches = [
  {
    root: agentRoot,
    file: "dist/agent.js",
    patch: "agent-core.patch",
    before: "d84351e451b9fef40fe2532c446aca90d26a4be9038b2d77d3d45dd6eab21d41",
    after: "dfae230805999ae8f12a53765da81bcf54d19686496d5b784188f265a3a35d10",
  },
  {
    root: agentRoot,
    file: "dist/agent.d.ts",
    patch: "agent-core-types.patch",
    before: "7caf774e58b6ceab9e4629bde58b9ab332a30278142af5a3e99b316be26030a9",
    after: "be1517d101838917094fe248cf7a247087adcfc3712527310aea232b2f652929",
  },
  {
    root: agentRoot,
    file: "dist/types.d.ts",
    patch: "agent-types.patch",
    before: "70c8fb25d1497ab5ddeb35e0e97c54f77eb8a0374a0b4b2e57725ebb4071cea3",
    after: "16250e966f1ef852323d327827a3def367f351dfa6ad1d934389493e2c211908",
  },
  {
    root: agentRoot,
    file: "dist/agent-loop.js",
    patch: "agent-loop.patch",
    before: "43cc779ddaf90df41768d3d2d0f7d7ba8b8bce7bedc9dc6062ca8b4de84ae880",
    after: "3b26d32c6843a662116c4a132e715d9dc3fe65560a3b1bfd8e0e78bb9ac5f126",
  },
  {
    root: codingRoot,
    file: "dist/core/agent-session.js",
    patch: "coding-agent-session.patch",
    before: "9f065b4a277857db100e3277c4d18316c89cd46b11f6ba8140122f19efbe47c4",
    after: "6adf215cc97ee917bb87c9b51923cac317e441de30fedb56b87c3d28b32565ba",
  },
  {
    root: codingRoot,
    file: "dist/core/agent-session.d.ts",
    patch: "coding-agent-session-types.patch",
    before: "0a40118419785cacb7d2aa9d41a8cf60131ad76fc147bccf6a628b5e8c88fec6",
    after: "92003a562e572c60d3da04d762591cb3a222727d9680687218413abf7489243a",
  },
  {
    root: codingRoot,
    file: "dist/core/sdk.js",
    patch: "coding-agent-sdk.patch",
    before: "225053853f1a0bee80419001e24cb6676b43cb5cc8f111d60770641bff4370be",
    after: "065e84393fb4fd3dd3a078aa2927be5acf8c85e2e2c90219a8b549c7edc82f27",
  },
  {
    root: codingRoot,
    file: "dist/core/extensions/loader.js",
    patch: "coding-agent-loader.patch",
    before: "0fd56e37765a0e436d8f55d7ca8c76ab933c41e1bd4974a5fe2cbba690cde900",
    after: "78a72ae1040781406a5c127a275da502db1b6b94ea57b40beac8c16f73012ce4",
  },
  {
    root: codingRoot,
    file: "dist/core/extensions/types.d.ts",
    patch: "coding-agent-types.patch",
    before: "f2c7df6c808598794ef528d758ea18891828b6d97251a20ea74d92108e63d645",
    after: "5e2af66c80df602aa6078c651051f76d6239132c788b36112e9d4d708f144976",
  },
  {
    root: codingRoot,
    file: "dist/core/extensions/runner.js",
    patch: "coding-agent-runner.patch",
    before: "b39d59b8f86693b9aca15f13e14f367fce9a0ad8ed7ce9ad17950906f226951d",
    after: "f1712f80bef39d3b331de448bc4da426079216bfadc313d28bed993d6306caf5",
  },
];
// npm may install both a direct pi-agent-core dependency and a nested copy for
// pi-coding-agent. Both must obey the same message-acceptance barrier.
if (agentRoot !== topAgentRoot && existsSync(join(topAgentRoot, "package.json"))) {
  patches.push(...patches.filter((item) => item.root === agentRoot).map((item) => ({ ...item, root: topAgentRoot })));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyUnifiedPatch(source, patchText) {
  const original = source.replace(/\n$/, "").split("\n");
  const lines = patchText.replace(/\n$/, "").split("\n");
  const output = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!match) continue;
    const start = Number(match[1]) - 1;
    if (start < cursor) throw new Error("overlapping SDK patch hunks");
    output.push(...original.slice(cursor, start));
    cursor = start;
    while (++i < lines.length && !lines[i].startsWith("@@ ")) {
      const line = lines[i];
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const content = line.slice(1);
      if (marker === " " || marker === "-") {
        if (original[cursor] !== content) throw new Error(`SDK patch context mismatch at original line ${cursor + 1}`);
        cursor++;
      }
      if (marker === " " || marker === "+") output.push(content);
      if (![" ", "-", "+"].includes(marker)) throw new Error(`unsupported SDK patch line: ${line}`);
    }
    i--;
  }
  output.push(...original.slice(cursor));
  return `${output.join("\n")}\n`;
}

for (const item of patches) {
  const version = JSON.parse(readFileSync(join(item.root, "package.json"), "utf8")).version;
  if (version !== "0.84.2") throw new Error(`Ultron SDK fork requires Pi 0.84.2, found ${version} in ${item.root}`);
  const path = join(item.root, item.file);
  const source = readFileSync(path, "utf8");
  const hash = sha256(source);
  if (hash === item.after) continue;
  if (hash !== item.before) throw new Error(`unrecognized SDK file ${path}; refuse to patch`);
  const patched = applyUnifiedPatch(source, readFileSync(join(here, "sdk-patches", item.patch), "utf8"));
  if (sha256(patched) !== item.after) throw new Error(`patched SDK hash mismatch for ${path}`);
  writeFileSync(path, patched);
}

// The event inbox is a fork-owned module, not an edit to a vendor file.
const eventsSource = readFileSync(join(here, "sdk-additions", "session-events.js"), "utf8");
const eventsTarget = join(codingRoot, "dist", "core", "session-events.js");
if (existsSync(eventsTarget) && sha256(readFileSync(eventsTarget, "utf8")) !== sha256(eventsSource)) {
  throw new Error(`unrecognized session event module ${eventsTarget}; run npm ci to refresh the pinned SDK`);
}
writeFileSync(eventsTarget, eventsSource);

console.log(`Ultron Pi SDK fork verified for ${projectRoot}`);
