import { randomUUID } from "node:crypto";
import type { AgentMessage, SessionContext, SessionInfo } from "./types";
import type { BrainViewStamp } from "./brain-view-admission";

export interface BrainLeadership { clusterId?: string; replicaId?: string; term?: number; index?: number; protocolVersion?: number; capabilities?: string[]; activation?: { clusterId: string; replicaId: string; activationIndex: number; retired?: boolean }; }
export function brainActivationId(leadership?: BrainLeadership): string | undefined { const a=leadership?.activation; return a && !a.retired ? `${a.clusterId}:${a.replicaId}:${a.activationIndex}` : undefined; }
type Message = Record<string, unknown> & { role?: string; content?: unknown; timestamp?: number };
export interface BrainView {
  viewStamp?: BrainViewStamp;
  sessionId: string;
  branchId: string;
  index: number;
  config: Record<string, unknown>;
  history: { head: number; entries: Message[] };
  stages: Array<{ stage: { stageId: string; kind: string; historyDelta?: Message }; receipt: { index: number; queueEffect?: { kind: string; items?: Array<{ itemId: string; message: Message }> } } }>;
  queue: { head: number; steer: Array<{ message: Message }>; followUp: Array<{ message: Message }>; events?: unknown[] };
  leadership: BrainLeadership;
  runtime?: { isStreaming?: boolean; recovering?: boolean; model?: Record<string, unknown>; thinkingLevel?: string; activeTools?: string[] };
}
interface BrainHealth { executable: boolean; activationId?: string; leadership?: BrainLeadership; leaderHostUrl?: string; peerHostUrls?: string[] }
interface BrainClientOptions { baseUrl: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number; peerUrls?: string[] }
interface BrainListedSession { sessionId: string; branchId?: string; config: Record<string, unknown>; runtime?: { isStreaming?: boolean; recovering?: boolean }; summary?: { messageCount?: number; firstMessage?: string; created?: unknown; modified?: unknown } }
declare global { var __brainWebPeerHints: Map<string, { urls: string[]; last?: string }> | undefined; }
function peerHints(base: string) { const cache = globalThis.__brainWebPeerHints ??= new Map(); if (!cache.has(base)) cache.set(base, { urls: [] }); return cache.get(base)!; }
export class BrainHostError extends Error {
  constructor(message: string, readonly status = 503, readonly code = "BRAIN_UNAVAILABLE") { super(message); }
}
export function managedBrainWeb(): boolean { return Boolean(process.env.BRAIN_HOST_URL || process.env.BRAIN_HOST_URLS) || process.env.ULTRON_MANAGED_BRAIN === "1"; }
export function brainPeerUrls(value?: string): string[] {
  if (!value) return [];
  let peers: unknown;
  try { peers = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",").map(url => url.trim()).filter(Boolean); }
  catch { throw new BrainHostError("Invalid BRAIN_HOST_URLS", 500); }
  if (!Array.isArray(peers) || peers.some(url => typeof url !== "string" || !url)) throw new BrainHostError("Invalid BRAIN_HOST_URLS", 500);
  return peers;
}
export function brainHostClient(): BrainHostClient {
  const peers = brainPeerUrls(process.env.BRAIN_HOST_URLS);
  const baseUrl = process.env.BRAIN_HOST_URL ?? peers[0];
  if (!baseUrl) throw new BrainHostError("BRAIN_HOST_URL is required in managed mode");
  return new BrainHostClient({ baseUrl, token: process.env.BRAIN_HOST_TOKEN, peerUrls: peers });
}

export class BrainHostClient {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  constructor(readonly options: BrainClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new BrainHostError("Invalid Brain host URL");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }
  headers(): Record<string, string> { return { "content-type": "application/json", ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) }; }
  async at<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${base.replace(/\/$/, "")}${path}`, { ...init, headers: { ...this.headers(), ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs), cache: "no-store" });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new BrainHostError(String(value.error ?? `Brain HTTP ${response.status}`), response.status, value.code);
    return value as T;
  }
  async leader(signal?: AbortSignal): Promise<{ url: string; health: BrainHealth }> {
    const base = this.options.baseUrl.replace(/\/$/, "");
    const hints = peerHints(base);
    const candidates = [...(hints.last ? [hints.last] : []), base, ...(this.options.peerUrls ?? []), ...hints.urls];
    const visited = new Set<string>();
    while (candidates.length && visited.size < 8) {
      const url = candidates.shift()!.replace(/\/$/, "");
      if (visited.has(url)) continue;
      visited.add(url);
      let health: BrainHealth;
      try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) continue;
        health = await this.at<BrainHealth>(url, "/health", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
      } catch (error) { if (signal?.aborted) throw error; continue; }
      hints.urls = [...new Set([...hints.urls, url, ...(health.peerHostUrls ?? []), ...(health.leaderHostUrl ? [health.leaderHostUrl] : [])])];
      if (health.executable && health.leadership?.protocolVersion === 2 && health.leadership.capabilities?.includes("host-activation-v1") && brainActivationId(health.leadership)) { hints.last = url; return { url, health }; }
      if (health.leaderHostUrl) candidates.unshift(health.leaderHostUrl);
      candidates.push(...(health.peerHostUrls ?? []));
    }
    throw new BrainHostError("Brain leader is not ready");
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> { const leader = await this.leader(); return this.at<T>(leader.url, path, init); }
  view(id: string): Promise<BrainView> { return this.request(`/sessions/${encodeURIComponent(id)}`); }
  async state(id: string) {
    const item = await this.request<{ sessionId: string; index: number; viewStamp?: BrainViewStamp; config: Record<string, unknown>; runtime?: BrainView["runtime"]; queue?: unknown }>(`/sessions/${encodeURIComponent(id)}/state`);
    return { sessionId: item.sessionId, index: item.index, viewStamp: item.viewStamp, model: browserModel(item.runtime?.model ?? item.config.model),
      thinkingLevel: item.runtime?.thinkingLevel ?? item.config.thinkingLevel, systemPrompt: item.config.systemPrompt ?? "",
      isStreaming: Boolean(item.runtime?.isStreaming), isPromptRunning: Boolean(item.runtime?.recovering),
      isCompacting: false, isBashRunning: false, managedBrain: true, activeTools: item.runtime?.activeTools ?? item.config.tools ?? [],
      ...(item.queue ? { queue: item.queue } : {}) };
  }
  async listing(): Promise<{ sessions: SessionInfo[]; runningSessionIds: string[] }> {
    const { sessions } = await this.request<{ sessions: BrainListedSession[] }>("/sessions");
    const infos = await Promise.all(sessions.map(async item => item.summary ? {
      path: `brain:${item.sessionId}`, id: item.sessionId, cwd: String(item.config.cwd ?? "/"), name: typeof item.config.name === "string" ? item.config.name : undefined,
      created: brainDate(item.summary.created), modified: brainDate(item.summary.modified), messageCount: item.summary.messageCount ?? 0,
      firstMessage: item.summary.firstMessage || "(no messages)",
    } : brainSessionData(await this.view(item.sessionId)).info));
    return { sessions: infos, runningSessionIds: sessions.filter(item => item.runtime?.isStreaming || item.runtime?.recovering).map(item => item.sessionId) };
  }
  async list(): Promise<SessionInfo[]> {
    return (await this.listing()).sessions;
  }
  async listViews(): Promise<BrainView[]> {
    const { sessions } = await this.request<{ sessions: Array<{ sessionId: string; config: Record<string, unknown> }> }>("/sessions");
    return Promise.all(sessions.map(item => this.view(item.sessionId)));
  }
  async command(id: string, command: Record<string, unknown>): Promise<unknown> {
    const path = `/sessions/${encodeURIComponent(id)}`;
    switch (command.type) {
      case "prompt": case "steer": case "follow_up": {
        if (typeof command.message !== "string") throw new BrainHostError("message is required", 400);
        return this.request(`${path}/input`, { method: "POST", body: JSON.stringify({ text: command.message,
          operationId: typeof command.operationId === "string" ? command.operationId : randomUUID(), timestamp: command.timestamp,
          lane: command.type === "follow_up" || command.streamingBehavior === "followUp" ? "followUp" : "steer", images: command.images }) });
      }
      case "abort": return this.request(`${path}/abort`, { method: "POST", body: "{}" });
      case "resume_queue": return this.request(`${path}/resume`, { method: "POST", body: "{}" });
      case "get_state": return this.state(id);
      case "get_messages": return { messages: brainContext(await this.view(id)).messages };
      case "get_tools": { const state = await this.state(id); return (state.activeTools as string[]).map(name => ({ name, description: "Brain Node tool", active: true })); }
      case "get_commands": return { commands: [] };
      case "get_last_assistant_text": { const view = await this.view(id); const last = [...view.history.entries].reverse().find(message => message.role === "assistant"); return { text: last ? messageText(last) : "" }; }
      case "set_model": { const result = await this.request<{ model?: unknown }>(`${path}/config`, { method: "POST", body: JSON.stringify({ modelRef: { provider: command.provider, id: command.modelId } }) }); return browserModel(result.model); }
      case "set_thinking_level": await this.request(`${path}/config`, { method: "POST", body: JSON.stringify({ thinkingLevel: command.level }) }); return null;
      case "set_tools": await this.request(`${path}/config`, { method: "POST", body: JSON.stringify({ tools: remoteToolNames(command.toolNames) }) }); return null;
      case "clear_queue": {
        const view = await this.view(id);
        const original = view.stages.find(item => item.stage.stageId === command.operationId);
        if (command.expectedRuntimeId !== undefined && command.expectedRuntimeId !== brainQueue(view).runtimeId && !original) throw new BrainHostError("Brain leadership changed; refresh the queue before recalling", 409, "QUEUE_INSTANCE_CHANGED");
        const operationId = command.operationId ?? randomUUID();
        const result = await this.request<Record<string, unknown>>(`${path}/clear-queue`, { method: "POST", body: JSON.stringify({ operationId }) });
        return { ...result, operationId, queue: brainQueue(await this.view(id)) };
      }
      default: throw new BrainHostError(`Command ${String(command.type)} is unavailable in managed Brain mode`, 409, "BRAIN_UNSUPPORTED_COMMAND");
    }
  }
}
export function remoteToolNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string")) throw new BrainHostError("Invalid tool names", 400);
  const names: Record<string, string> = { bash: "node_exec", read: "node_read", edit: "node_edit", write: "node_write", grep: "node_list", find: "node_list", ls: "node_list" };
  return [...new Set(value.map(name => names[name] ?? name))];
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
}
function normalizedMessage(message: Message): AgentMessage {
  const copy = structuredClone(message);
  if (Array.isArray(copy.content)) copy.content = copy.content.map(part => part?.type === "toolCall"
    ? { ...part, toolCallId: part.toolCallId ?? part.id, toolName: part.toolName ?? part.name, input: part.input ?? part.arguments ?? {} } : part);
  return copy as unknown as AgentMessage;
}
export function brainContext(view: BrainView): SessionContext {
  const ids: string[] = [];
  for (const committed of view.stages) {
    if (committed.stage.historyDelta !== undefined) ids.push(JSON.stringify(["stage",committed.stage.stageId]));
    if (committed.receipt.queueEffect?.kind === "take") for (const item of committed.receipt.queueEffect.items ?? []) ids.push(JSON.stringify(["queue",committed.stage.stageId, item.itemId]));
  }
  const model = view.runtime?.model ?? view.config.model as Record<string, unknown> | undefined;
  return { messages: view.history.entries.map(normalizedMessage), entryIds: view.history.entries.map((_, index) => ids[index] ?? `brain-${view.history.head}-${index}`),
    model: model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, modelId: model.id } : null,
    thinkingLevel: view.runtime?.thinkingLevel ?? String(view.config.thinkingLevel ?? "off") };
}
export function brainQueue(view: BrainView) {
  return { sessionId: view.sessionId, runtimeId: brainActivationId(view.leadership) ?? `brain-term-${view.leadership.term}`, revision: view.queue.head,
    steering: view.queue.steer.filter(item => item.message.role === "user").map(item => messageText(item.message)),
    followUp: view.queue.followUp.filter(item => item.message.role === "user").map(item => messageText(item.message)) };
}
export function brainState(view: BrainView) {
  const queue = brainQueue(view);
  return { sessionId: view.sessionId, viewStamp: view.viewStamp, model: browserModel(view.runtime?.model ?? view.config.model), thinkingLevel: view.runtime?.thinkingLevel ?? view.config.thinkingLevel,
    isStreaming: Boolean(view.runtime?.isStreaming), isPromptRunning: Boolean(view.runtime?.recovering), isCompacting: false, isBashRunning: false,
    systemPrompt: view.config.systemPrompt ?? "", activeTools: view.runtime?.activeTools ?? view.config.tools ?? [], queue, queuedMessages: { steering: queue.steering, followUp: queue.followUp },
    leadership: brainActivationId(view.leadership), managedBrain: true };
}
function browserModel(value: unknown): { id?: string; provider?: string; name?: string; contextWindow?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  return { ...(typeof model.id === "string" ? { id: model.id } : {}), ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
    ...(typeof model.name === "string" ? { name: model.name } : {}), ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}) };
}
function brainDate(value: unknown): string { const time = Number(value ?? 0); const parsed = new Date(Number.isFinite(time) ? time : 0); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString(); }
export function brainSessionData(view: BrainView) {
  const context = brainContext(view);
  const created = brainDate(view.history.entries.find(message => typeof message.timestamp === "number")?.timestamp);
  const modified = brainDate(view.history.entries.at(-1)?.timestamp);
  const info: SessionInfo = { path: `brain:${view.sessionId}`, id: view.sessionId, cwd: String(view.config.cwd ?? "/"), name: typeof view.config.name === "string" ? view.config.name : undefined,
    created, modified, messageCount: context.messages.length, firstMessage: messageText(view.history.entries.find(message => message.role === "user") ?? {}).slice(0, 200) || "(no messages)" };
  return { sessionId: view.sessionId, viewStamp: view.viewStamp, state: brainState(view), filePath: info.path, info, context, tree: [], queue: brainQueue(view), leafId: context.entryIds.at(-1) ?? null,
    revision: { lastEntryId: `brain-${view.history.head}`, modifiedMs: view.history.head, size: view.history.head }, managedBrain: true };
}
export function brainErrorResponse(error: unknown): Response {
  return Response.json({ error: error instanceof Error ? error.message : String(error), code: error instanceof BrainHostError ? error.code : "BRAIN_UNAVAILABLE" },
    { status: error instanceof BrainHostError ? error.status : 503 });
}
