import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import { readFileSync } from "node:fs";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, tsconfigPaths: true, jsx: {runtime: "automatic"} });
const { BrainHostClient, brainContext, brainSessionData, brainPeerUrls } = await jiti.import("./brain-host.ts");
const { BrainPreviewFence } = await jiti.import("./brain-preview.ts");
const { brainEventResponse } = await jiti.import("./brain-stream.ts");
const { findResultReference } = await jiti.import("../components/PersistentResult.tsx");

function leadership(name) { return { clusterId: name, replicaId: "r", term: 2, protocolVersion: 2, capabilities: ["host-activation-v1"], activation: { clusterId: name, replicaId: "r", activationIndex: 1 } }; }
function view() {
  const user = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "node_exec", arguments: { cmd: "echo hi" } }], timestamp: 2 };
  return { sessionId: "s", branchId: "main", index: 5, config: { cwd: "/remote/project", model: { id: "model", provider: "provider" }, thinkingLevel: "off" },
    leadership: leadership("new"), history: { head: 5, entries: [user, assistant] },
    queue: { head: 5, steer: [], followUp: [] }, runtime: { isStreaming: true, activeTools: ["node_exec"] },
    stages: [{ stage: { stageId: "take", kind: "queue_take" }, receipt: { index: 4, queueEffect: { kind: "take", items: [{ itemId: "input", message: user }] } } },
      { stage: { stageId: "assistant", kind: "assistant_message", historyDelta: assistant }, receipt: { index: 5 } }] };
}
test("managed client discovers the leader host and forwards stable admission identity", async () => {
  const calls = [];
  const client = new BrainHostClient({ baseUrl: "http://follower", token: "private-token", fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.authorization, "Bearer private-token");
    if (url === "http://follower/health") return Response.json({ executable: false, leaderHostUrl: "http://leader" });
    if (url === "http://leader/health") return Response.json({ executable: true, leadership: leadership("new") });
    assert.equal(url, "http://leader/sessions/s/input");
    return Response.json({ accepted: true }, { status: 202 });
  } });
  await client.command("s", { type: "follow_up", message: "same", operationId: "stable-input", timestamp: 123 });
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { text: "same", operationId: "stable-input", timestamp: 123, lane: "followUp" });
  assert.equal(calls.filter(call => call.init.method === "POST").length, 1);
});
test("authoritative context preserves IDs without inventing missing tool results", () => {
  const snapshot = view(); const context = brainContext(snapshot);
  assert.deepEqual(context.entryIds, [JSON.stringify(["queue","take", "input"]), JSON.stringify(["stage","assistant"])]);
  assert.equal(context.messages.length, 2);
  assert.equal(context.messages[1].content[0].toolCallId, "call");
  assert.equal(snapshot.history.entries[1].content[0].id, "call");
  assert.equal(brainSessionData(snapshot).filePath, "brain:s");
});
test("discovered peer hints survive loss of the configured seed without replaying a POST", async () => {
  let firstAlive = true; let posts = 0;
  const fetchImpl = async (url, init) => {
    if (url.startsWith("http://seed-failover") && !firstAlive) throw new TypeError("offline");
    if (url === "http://seed-failover/health") return Response.json({ executable: true, leadership: leadership("first"), peerHostUrls: ["http://peer-failover"] });
    if (url === "http://peer-failover/health") return Response.json({ executable: true, leadership: leadership("second") });
    if (init.method === "POST") posts++;
    return Response.json({ accepted: true });
  };
  const before = new BrainHostClient({ baseUrl: "http://seed-failover", fetchImpl });
  await before.leader(); firstAlive = false;
  const after = new BrainHostClient({ baseUrl: "http://seed-failover", fetchImpl });
  const leader = await after.leader(); assert.equal(leader.url, "http://peer-failover");
  await after.command("s", { type: "steer", message: "hello", operationId: "one" });
  assert.equal(posts, 1);
  assert.deepEqual(brainPeerUrls('["http://one","http://two"]'), ["http://one", "http://two"]);
  assert.throws(() => brainPeerUrls('["ok",3]'), /Invalid BRAIN_HOST_URLS/);
});
test("running and state polling avoid full recovery payloads", async () => {
  const paths = [];
  const client = new BrainHostClient({ baseUrl: "http://small-poll", fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    if (url.endsWith("/health")) return Response.json({ executable: true, leadership: leadership("leader") });
    if (url.endsWith("/sessions")) return Response.json({ sessions: [{ sessionId: "s", config: { cwd: "/context" }, runtime: { isStreaming: true }, summary: { messageCount: 2, firstMessage: "hello", created: 1, modified: 2 } }] });
    if (url.endsWith("/sessions/s/state")) return Response.json({ sessionId: "s", index: 10, config: {}, runtime: { isStreaming: true } });
    assert.fail(`unexpected full view ${url}`);
  } });
  const listing = await client.listing(); assert.deepEqual(listing.runningSessionIds, ["s"]);
  assert.equal(listing.sessions[0].firstMessage, "hello");
  assert.equal((await client.state("s")).isStreaming, true);
  assert.ok(!paths.includes("/sessions/s"));
});
test("preview fence rejects old leadership, duplicate sequence and retired generations", () => {
  const fence = new BrainPreviewFence(); fence.reset("new");
  assert.equal(fence.accept({ leadership: "old", sequence: 99, generationId: "old" }), false);
  assert.equal(fence.accept({ leadership: "new", sequence: 1, generationId: "g1" }), true);
  assert.equal(fence.accept({ leadership: "new", sequence: 1, generationId: "g1" }), false);
  assert.equal(fence.accept({ leadership: "new", sequence: 2, generationId: "g2" }), true);
  assert.equal(fence.accept({ leadership: "new", sequence: 3, generationId: "g1" }), false);
});
test("remote SSE resets confirmed history, keeps preview updates at the same index and drops duplicate formal messages", async () => {
  const events = [
    { type: "message_end", sessionId: "s", leadership: "new:r:1", sequence: 1, generationId: "g", index: 5, messageId: "assistant", message: { role: "assistant", content: [] } },
    { type: "message_update", sessionId: "s", leadership: "old", sequence: 100, generationId: "old", index: 5 },
    { type: "message_update", sessionId: "s", leadership: "new:r:1", sequence: 2, generationId: "g", index: 5, messageId: "assistant", message: { role: "assistant", content: [{ type: "text", text: "preview" }] } },
    { type: "message_end", sessionId: "s", leadership: "new:r:1", sequence: 3, generationId: "g", index: 6, messageId: "accepted", message: { role: "assistant", content: [{ type: "text", text: "accepted" }] } },
  ];
  const client = new BrainHostClient({ baseUrl: "http://leader", fetchImpl: async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")) });
  client.leader = async () => ({ url: "http://leader", health: { executable: true, leadership: leadership("new") } });
  client.at = async () => view();
  const abort = new AbortController();
  const response = brainEventResponse(new Request("http://web/events", { signal: abort.signal }), "s", client);
  const reader = response.body.getReader(); const received = [];
  while (received.length < 4) { const next = await reader.read(); received.push(JSON.parse(new TextDecoder().decode(next.value).slice(6))); }
  assert.deepEqual(received.map(event => event.type), ["connected", "brain_reset", "message_update", "message_end"]);
  assert.equal(received[2].message.content[0].text, "preview");
  abort.abort(); await reader.cancel();
});
test("result links accept only an explicit persistent Node reference", () => {
  assert.deepEqual(findResultReference({ resultRef: { node: "node", id: "result" } }), { node: "node", id: "result" });
  assert.equal(findResultReference({ resultRef: { id: "result" } }), null);
  assert.equal(findResultReference(null, "ordinary output"), null);
});
test("managed existing-session route never starts a local SDK runtime", async () => {
  const source = readFileSync(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let starts = 0; const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    if (name === "next/server") return { NextResponse: { json: value => Response.json(value) } };
    if (name === "@/lib/rpc-manager") return { startRpcSession() { starts++; throw Error("local startup"); } };
    if (name === "@/lib/session-reader") return { resolveSessionPath() { throw Error("local file lookup"); } };
    if (name === "@/lib/brain-host") return { brainHostClient: () => ({ command: async () => ({ accepted: true }) }), brainErrorResponse: error => { throw error; } };
    throw Error(name);
  }, module, module.exports);
  const previous = process.env.BRAIN_HOST_URL; process.env.BRAIN_HOST_URL = "http://leader";
  try {
    const response = await module.exports.POST(new Request("http://web/agent/s", { method: "POST", body: JSON.stringify({ type: "prompt", message: "hello" }) }), { params: Promise.resolve({ id: "s" }) });
    assert.equal(response.status, 200); assert.equal(starts, 0);
  } finally { if (previous === undefined) delete process.env.BRAIN_HOST_URL; else process.env.BRAIN_HOST_URL = previous; }
});
test("managed provider test cannot invoke a model from the Web process", async () => {
  const source = readFileSync(new URL("../app/api/models-config/test/route.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let calls = 0; const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    if (name === "next/server") return { NextResponse: { json: (value, options) => Response.json(value, options) } };
    if (name === "@earendil-works/pi-ai/compat") return { completeSimple() { calls++; throw Error("model invoked"); } };
    if (name === "@earendil-works/pi-coding-agent") return { ModelRuntime: { create() { calls++; throw Error("local runtime created"); } } };
    return {};
  }, module, module.exports);
  const previous = process.env.BRAIN_HOST_URLS; process.env.BRAIN_HOST_URLS = '["http://remote"]';
  try { const response = await module.exports.POST(new Request("http://web/test", { method: "POST", body: "{}" })); assert.equal(response.status, 409); assert.equal(calls, 0); }
  finally { if (previous === undefined) delete process.env.BRAIN_HOST_URLS; else process.env.BRAIN_HOST_URLS = previous; }
});

test("batch messages sharing a stage/index survive SSE and same-message retransmission is deduplicated", async () => {
 const events=[
  {type:"message_end",sessionId:"s",leadership:"new:r:1",sequence:1,index:6,stageId:"batch",messageId:JSON.stringify(["queue","batch","a"]),message:{role:"user",content:"a"}},
  {type:"message_end",sessionId:"s",leadership:"new:r:1",sequence:2,index:6,stageId:"batch",messageId:JSON.stringify(["queue","batch","b"]),message:{role:"user",content:"b"}},
  {type:"message_end",sessionId:"s",leadership:"new:r:1",sequence:3,index:6,stageId:"batch",messageId:JSON.stringify(["queue","batch","a"]),message:{role:"user",content:"a"}},
 ];
 const client=new BrainHostClient({baseUrl:"http://leader",fetchImpl:async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""))});
 client.leader=async()=>({url:"http://leader",health:{executable:true,leadership:leadership("new")}});client.at=async()=>view();
 const abort=new AbortController();const response=brainEventResponse(new Request("http://web/events",{signal:abort.signal}),"s",client);
 const reader=response.body.getReader();const received=[];
 while(received.length<4){const part=await reader.read();received.push(JSON.parse(new TextDecoder().decode(part.value).slice(6)));}
 abort.abort();await reader.cancel();
 assert.deepEqual(received.filter(event=>event.type==="message_end").map(event=>event.message.content),["a","b"]);
 const snapshot=view();snapshot.history.entries=[events[0].message,events[1].message];snapshot.stages=[{stage:{stageId:"batch",kind:"queue_take"},receipt:{index:6,queueEffect:{kind:"take",items:[{itemId:"a",message:events[0].message},{itemId:"b",message:events[1].message}]}}}];
 assert.deepEqual(brainContext(snapshot).entryIds,events.slice(0,2).map(event=>event.messageId));
});

for(const completed of [false,true])test(`snapshot fences buffered previews by session branch head (completed=${completed})`,async()=>{
 const snapshot=view();snapshot.index=100;snapshot.history.head=completed?6:5;
 const events=[{type:"message_update",sessionId:"s",leadership:"new:r:1",sequence:1,generationId:"g",index:5,message:{role:"assistant",content:[{type:"text",text:"preview"}]}},{type:"agent_settled",sessionId:"s",leadership:"new:r:1",sequence:2,index:completed?6:5}];
 const client=new BrainHostClient({baseUrl:"http://leader",fetchImpl:async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""))});
 client.leader=async()=>({url:"http://leader",health:{executable:true,leadership:leadership("new")}});client.at=async()=>snapshot;
 const abort=new AbortController();const response=brainEventResponse(new Request("http://web/events",{signal:abort.signal}),"s",client);const reader=response.body.getReader();const received=[];
 while(!received.some(event=>event.type==="prompt_done")){const next=await reader.read();received.push(JSON.parse(new TextDecoder().decode(next.value).slice(6)));}
 abort.abort();await reader.cancel();assert.equal(received.some(event=>event.type==="message_update"),!completed);
});
test("formal message identity namespaces cannot collide between queue items and literal stage IDs",()=>{
 const snapshot=view();const queueId=JSON.stringify(["queue","take","item"]);
 snapshot.history.entries=[{role:"user",content:"one"},{role:"user",content:"two"}];snapshot.stages=[{stage:{stageId:"take",kind:"queue_take"},receipt:{index:5,queueEffect:{kind:"take",items:[{itemId:"item",message:snapshot.history.entries[0]}]}}},{stage:{stageId:queueId,kind:"user_message",historyDelta:snapshot.history.entries[1]},receipt:{index:6}}];
 const ids=brainContext(snapshot).entryIds;assert.notEqual(ids[0],ids[1]);
});

test("session snapshots and state share branchHead even when other sessions advance the FSM",async()=>{
 const v=view();v.index=100;v.viewStamp={sessionId:"s",activationId:"new:r:1",branchHead:5,runtimeSeq:7};
 const d=brainSessionData(v);assert.equal(d.revision.lastEntryId,"brain-5");assert.deepEqual(d.viewStamp,v.viewStamp);assert.deepEqual(d.state.viewStamp,v.viewStamp);
 const client=new BrainHostClient({baseUrl:"http://view-stamp",fetchImpl:async url=>url.endsWith("/health")?Response.json({executable:true,leadership:leadership("new")}):Response.json({sessionId:"s",index:5,viewStamp:v.viewStamp,config:{},runtime:{isStreaming:false}})});
 assert.deepEqual((await client.state("s")).viewStamp,v.viewStamp);
});

test("snapshot runtime sequence excludes buffered lifecycle events at the same head",async()=>{
 const snapshot=view();snapshot.viewStamp={sessionId:"s",activationId:"new:r:1",branchHead:5,runtimeSeq:10};snapshot.runtime.isStreaming=false;
 const events=[{type:"agent_start",sequence:9},{type:"agent_settled",sequence:11}].map(event=>({...event,sessionId:"s",leadership:"new:r:1",index:5}));
 const client=new BrainHostClient({baseUrl:"http://leader",fetchImpl:async()=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""))});
 client.leader=async()=>({url:"http://leader",health:{executable:true,leadership:leadership("new")}});client.at=async()=>snapshot;
 const abort=new AbortController(),response=brainEventResponse(new Request("http://web/events",{signal:abort.signal}),"s",client),reader=response.body.getReader(),received=[];
 while(!received.some(event=>event.type==="prompt_done")){const next=await reader.read();received.push(JSON.parse(new TextDecoder().decode(next.value).slice(6)));}
 abort.abort();await reader.cancel();assert.equal(received.some(event=>event.type==="agent_start"),false);
});
