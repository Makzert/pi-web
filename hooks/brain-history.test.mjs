import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(path) {
 const mod={exports:{}};
 const compiled=ts.transpileModule(readFileSync(new URL(path,import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function("module","exports",compiled)(mod,mod.exports);return mod.exports;
}
const {BrainViewAdmission}=loadModule("../lib/brain-view-admission.ts");
const {QueueSnapshotTracker}=loadModule("../lib/queue-state.ts");

// Drive the real hook callbacks with controlled response delivery; no browser
// timing or copied snapshot reducer is involved.
function harness(sendAgentCommand) {
  const source=readFileSync(new URL("./useAgentSession.ts",import.meta.url),"utf8");
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const states=[];
  const react={useState(initial){const cell={value:typeof initial==="function"?initial():initial};states.push(cell);return [cell.value,value=>{cell.value=typeof value==="function"?value(cell.value):value;}];},useRef(current){return {current};},useCallback(fn){return fn;},useMemo(fn){return fn();},useEffect(){},useLayoutEffect(){},useReducer(_reducer,initial){return [initial,()=>{}];}};
  const imports={react,"@/lib/normalize":{normalizeToolCalls:value=>value},"@/lib/agent-client":{sendAgentCommand},"@/lib/queue-state":{QueueSnapshotTracker},"@/lib/queue-recall":{},"@/lib/tool-presets":{},"@/lib/stream-state":{streamReducer:()=>{}},"@/lib/brain-view-admission":{BrainViewAdmission}};
  const mod={exports:{}};
  new Function("require","module","exports",compiled)(name=>{if(!(name in imports))throw Error(name);return imports[name];},mod,mod.exports);
  const hook=mod.exports.useAgentSession({session:{id:"s"},newSessionCwd:null});
  return {event:event=>hook.handleAgentEventRef.current(event),data:()=>states[0].value,messages:()=>states[4].value,ids:()=>states[5].value,prompt:()=>states[21].value,thinking:()=>states[18].value,changeThinking:hook.handleThinkingLevelChange};
}
function snapshot(index,messages=[{role:"user",content:"accepted"}]) {return {sessionId:"s",managedBrain:true,viewStamp:{sessionId:"s",activationId:"cluster:r:1",branchHead:index,runtimeSeq:index},leafId:`m${index}`,revision:{lastEntryId:`brain-${index}`,modifiedMs:index,size:index},context:{messages,entryIds:messages.map((_,i)=>`m${i}`),thinkingLevel:"off",model:null}};}

test("an old HTTP history response and old reset cannot roll back a newer confirmed cut",async()=>{
  const h=harness(),original=globalThis.fetch;let release;
  globalThis.fetch=async url=>String(url).startsWith("/api/sessions/")?new Promise(resolve=>{release=()=>resolve(Response.json(snapshot(10)));}):Response.json({running:true,state:{isStreaming:true}});
  try {
    h.event({type:"agent_start"});h.event({type:"agent_end"});assert.equal(typeof release,"function");
    const messages=[{role:"user",content:"accepted"},{role:"assistant",content:[{type:"text",text:"new-confirmed"}]}];
    h.event({type:"brain_reset",data:snapshot(20,messages),state:{isStreaming:false}});
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.data().revision.modifiedMs,20);assert.equal(h.messages().length,2);
    h.event({type:"brain_reset",data:snapshot(15),state:{isStreaming:false}});
    assert.equal(h.data().revision.modifiedMs,20);assert.equal(h.messages().length,2);
  } finally {globalThis.fetch=original;}
});

test("formal batch messages at one index stay distinct and fence an older HTTP response",async()=>{
  const h=harness(),original=globalThis.fetch;let release;
  globalThis.fetch=async url=>String(url).startsWith("/api/sessions/")?new Promise(resolve=>{release=()=>resolve(Response.json(snapshot(20)));}):Response.json({running:true,state:{isStreaming:true}});
  try {
    h.event({type:"brain_reset",data:snapshot(20),state:{isStreaming:false}});
    h.event({type:"agent_start"});h.event({type:"agent_end"});
    for (const id of ["batch-one","batch-two","batch-one"]) h.event({type:"message_end",sessionId:"s",index:21,messageId:id,message:{role:"assistant",content:[{type:"text",text:id}]}});
    assert.equal(h.messages().length,3);assert.deepEqual(h.ids(),["m0","batch-one","batch-two"]);
    release();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.messages().length,3);
  } finally {globalThis.fetch=original;}
});

function state(head,seq,prompt,activation="cluster:r:1") {return {managedBrain:true,viewStamp:{sessionId:"s",activationId:activation,branchHead:head,runtimeSeq:seq},systemPrompt:prompt,isStreaming:false};}

test("a delayed agent_end state read cannot overwrite the newer reset's prompt",async()=>{
 const h=harness(),original=globalThis.fetch;let release;
 globalThis.fetch=async url=>String(url).includes("/state")?new Promise(resolve=>{release=()=>resolve(Response.json({running:true,state:state(10,11,"old")}));}):Response.json(snapshot(10));
 try {
  h.event({type:"agent_start"});h.event({type:"agent_end"});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,"function");
  h.event({type:"brain_reset",data:snapshot(20),state:state(20,20,"new")});
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.data().revision.modifiedMs,20);assert.equal(h.prompt(),"new");
 } finally {globalThis.fetch=original;}
});

test("a newer runtime reset at the same branch head fences older state",async()=>{
 const h=harness(),original=globalThis.fetch;let release;
 h.event({type:"brain_reset",data:snapshot(10),state:state(10,10,"initial")});
 globalThis.fetch=async url=>String(url).includes("/state")?new Promise(resolve=>{release=()=>resolve(Response.json({running:true,state:state(10,11,"old")}));}):Response.json({...snapshot(10),viewStamp:state(10,11).viewStamp});
 try {
  h.event({type:"agent_start"});h.event({type:"agent_end"});await new Promise(resolve=>setImmediate(resolve));
  h.event({type:"brain_reset",data:{...snapshot(10),viewStamp:state(10,12).viewStamp},state:state(10,12,"new")});
  release();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.prompt(),"new");
 } finally {globalThis.fetch=original;}
});

test("view admission separates formal observation from full snapshots and fences activation/session lifetimes",()=>{
 const a=new BrainViewAdmission();const stamp=(head,seq,activation="cluster:r:1")=>state(head,seq,"",activation).viewStamp;
 assert.equal(a.admit("snapshot","s",0,stamp(10,1),true,undefined,["one"]),"accept");
 assert.equal(a.message("s",11,"batch-a"),true);assert.equal(a.message("s",11,"batch-b"),true);assert.equal(a.message("s",11,"batch-a"),false);
 assert.equal(a.admit("state","s",0,stamp(11,2),true),"refresh");
 assert.equal(a.admit("snapshot","s",0,stamp(10,3),true),"drop");
 assert.equal(a.admit("snapshot","s",0,stamp(11,4),true,undefined,["one","batch-a","batch-b"]),"accept");
 const old=a.capture("s",0);
 assert.equal(a.admit("snapshot","s",0,stamp(11,1,"cluster:r:2"),true),"accept");
 assert.equal(a.admit("state","s",0,stamp(11,5),true,old),"drop");
 assert.equal(a.admit("snapshot","s",0,stamp(11,100),true),"drop");
 assert.equal(a.admit("state","s",1,stamp(11,2,"cluster:r:2"),true,a.capture("s",0)),"drop");
 assert.equal(a.admit("state","s",1,undefined,true),"drop");
 assert.equal(a.admit("state","s",1,{...stamp(11,2,"cluster:r:2"),sessionId:"other"},true),"drop");
});


test("configuration completion refreshes one stamped view and fences reads started before its ACK",async()=>{
 let ack;const h=harness(()=>new Promise(resolve=>{ack=resolve;})),original=globalThis.fetch;let release,head=10;
 globalThis.fetch=async url=>String(url).includes("/state")?new Promise(resolve=>{release=()=>resolve(Response.json({running:true,state:{...state(10,11,"old"),thinkingLevel:"low"}}));}):Response.json({...snapshot(head),state:{...state(head,head,"current"),thinkingLevel:head===20?"high":"low"}});
 try {
  h.event({type:"brain_reset",data:snapshot(10),state:{...state(10,10,"initial"),thinkingLevel:"low"}});
  h.event({type:"agent_start"});h.event({type:"agent_end"});await new Promise(resolve=>setImmediate(resolve));
  const change=h.changeThinking("high");head=20;ack();await change;
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.data().revision.modifiedMs,20);assert.equal(h.thinking(),"high");assert.equal(h.prompt(),"current");
 } finally {globalThis.fetch=original;}
});

test("state ahead of the installed head refreshes history/config together",async()=>{
 const h=harness(),original=globalThis.fetch;let reads=0,release;
 h.event({type:"brain_reset",data:snapshot(10),state:state(10,10,"old")});
 globalThis.fetch=async url=>{
  if(String(url).includes("/state"))return Response.json({running:true,state:state(20,21,"future")});
  if(++reads===1)return Response.json(snapshot(10));
  return new Promise(resolve=>{release=()=>resolve(Response.json({...snapshot(20),viewStamp:state(20,22).viewStamp,state:state(20,22,"complete")}));});
 };
 try {
  h.event({type:"agent_start"});h.event({type:"agent_end"});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof release,"function");assert.equal(h.prompt(),"old");assert.equal(h.data().revision.modifiedMs,10);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.prompt(),"complete");assert.equal(h.data().revision.modifiedMs,20);
 } finally {globalThis.fetch=original;}
});
