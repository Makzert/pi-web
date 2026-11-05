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
    root: codingRoot,
    file: "dist/core/sdk.d.ts",
    patch: "coding-agent-sdk-types.patch",
    before: "328f7291c7b69fd32f3fcc8f120ab4593b10405f69bd0034265ac089de8e4ea4",
    after: "04e29b7513d9fce0a27a7f79cfbb2ada23884ff800beced4c13b6435125d7129",
    previous: { hash: "0881ee521cb9ced048eabac2828966d01b00b87eada3ccbb7d30a378dbf6389b", patch: "previous/coding-agent-sdk-types.patch" },
  },
  {
    root: agentRoot,
    file: "dist/agent.js",
    patch: "agent-core.patch",
    before: "d84351e451b9fef40fe2532c446aca90d26a4be9038b2d77d3d45dd6eab21d41",
    after: "69016238f134cc1e6926c22fb4d7d045cd809ee40beeede66f119a754ef9d214",
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
    after: "c69fe3208ce7a0e8f90a0c8e5b5fb5119be3c6c7140862eecfc1d10145939104",
    previous: { hash: "b41aa5eaf8c05edbc7eb7c75674f856751b1381d04aef5a2d5b0c3522a040c8f", patch: "previous/agent-loop.patch" },
  },
  {
    root: codingRoot,
    file: "dist/core/agent-session.js",
    patch: "coding-agent-session.patch",
    before: "9f065b4a277857db100e3277c4d18316c89cd46b11f6ba8140122f19efbe47c4",
    after: "943e3a2418e6753761aa96dab871fdf81ae5353311f9921891665dbdbca6dd22",
    previous: { hash: "c6b8a56e947fb14d9e439ec0f8f76dad80eeb68b416c74d73c11cef0fb21abdf", patch: "previous/coding-agent-session.patch" },
  },
  {
    root: codingRoot,
    file: "dist/core/agent-session.d.ts",
    patch: "coding-agent-session-types.patch",
    before: "0a40118419785cacb7d2aa9d41a8cf60131ad76fc147bccf6a628b5e8c88fec6",
    after: "2daa730c889eede129fc11f86ea51151d3b4232d9ef071c30f95e37507e45554",
  },
  {
    root: codingRoot,
    file: "dist/core/sdk.js",
    patch: "coding-agent-sdk.patch",
    before: "225053853f1a0bee80419001e24cb6676b43cb5cc8f111d60770641bff4370be",
    after: "149fa59049a490a42d89c49320de46c17523c839a06f5f7c2603d7043dd14d35",
    previous: { hash: "96c87c08cd8068441d32aacdc0ab23881254de56ec2dfba8e62f927b20adcc16", patch: "previous/coding-agent-sdk.patch" },
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
    after: "b5377c97ae6e967ed21c845f835d97164cf2da7d33d28a27376a37437e0edb15",
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
  let source = readFileSync(path, "utf8");
  let hash = sha256(source);
  if (hash === item.after) continue;
  if (item.previous && hash === item.previous.hash) {
    const previous = readFileSync(join(here, "sdk-patches", item.previous.patch), "utf8");
    const reversed = previous.split("\n").map((line) => {
      const hunk = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@(.*)$/.exec(line);
      if (hunk) return `@@ -${hunk[3]}${hunk[4] ?? ""} +${hunk[1]}${hunk[2] ?? ""} @@${hunk[5]}`;
      if (line.startsWith("---") || line.startsWith("+++")) return line;
      if (line.startsWith("+")) return `-${line.slice(1)}`;
      if (line.startsWith("-")) return `+${line.slice(1)}`;
      return line;
    }).join("\n");
    source = applyUnifiedPatch(source, reversed);
    if (sha256(source) !== item.before && sha256(source.replace(/\n$/, "")) === item.before) source = source.replace(/\n$/, "");
    hash = sha256(source);
  }
  if (hash !== item.before) throw new Error(`unrecognized SDK file ${path}; refuse to patch`);
  const patched = applyUnifiedPatch(source, readFileSync(join(here, "sdk-patches", item.patch), "utf8"));
  if (sha256(patched) !== item.after) throw new Error(`patched SDK hash mismatch for ${path}`);
  writeFileSync(path, patched);
}

// The event inbox is a fork-owned module, not an edit to a vendor file.
const eventsSource = readFileSync(join(here, "sdk-additions", "session-events.js"), "utf8");
const eventsTarget = join(codingRoot, "dist", "core", "session-events.js");
if (existsSync(eventsTarget) && ![sha256(eventsSource), "39957b25b9a2ef24d098ef350829f1a504657dd5ef0925414da2f02ace1e49be", "3595f8796cba9ceec6ccccd7684b3dafabaceced52aa3f619555280544085e3d"].includes(sha256(readFileSync(eventsTarget, "utf8")))) {
  throw new Error(`unrecognized session event module ${eventsTarget}; run npm ci to refresh the pinned SDK`);
}
writeFileSync(eventsTarget, eventsSource);

console.log(`Ultron Pi SDK fork verified for ${projectRoot}`);
