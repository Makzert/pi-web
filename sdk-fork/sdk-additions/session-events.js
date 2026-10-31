// Ultron session events: durable admission is separate from Agent execution.
// This module is installed beside agent-session.js by apply-sdk-fork.mjs.
import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";

const JOURNAL = "ultron-session-event";
const TYPES = new Set(["node-bg-result", "node-worker-result", "node-worker-input-required"]);
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
function hash(value) {
    const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canonical(v[k])])) : v;
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function eventId(message) { return message?.details?.deliveryId; }
export function eventBatchSize(items) {
    let bytes = 0, count = 0;
    for (const item of items) {
        const size = Buffer.byteLength(JSON.stringify(item.message));
        if (count >= 16 || count > 0 && bytes + size > 32768) break;
        bytes += size; count++;
    }
    return count;
}

export class SessionEvents {
    constructor(host) {
        this.host = host;
        this.pending = new Map();
        this.accepted = new Map();
        this.inflight = new Set();
        this.taken = new Map();
        this.waiter = null;
        this.ready = false;
        this.closed = false;
        this.paused = false;
        this.scheduled = false;
        this.boundaryReady = false;
        this.epoch = 0;
        this.waitSerial = 0;
        this.runtimeId = randomUUID();
        this.poison = null;
        this.restoreLocal();
    }
    restoreLocal() {
        this.pending.clear(); this.accepted.clear(); this.inflight.clear(); this.taken.clear();
        const consumed = new Set();
        // Keep deduplication across branches/compaction: these are delivery facts,
        // not a re-execution of the task associated with an old branch.
        for (const entry of this.host.sessionManager.getEntries()) {
            if (entry.type === "custom" && entry.customType === JOURNAL && entry.data?.version === 1) {
                const { deliveryId, inputHash, message } = entry.data;
                if (typeof deliveryId === "string" && typeof inputHash === "string" && message) {
                    this.accepted.set(deliveryId, inputHash);
                    this.pending.set(deliveryId, message);
                }
            }
            if (entry.type === "custom_message" && eventId(entry)) consumed.add(eventId(entry));
        }
        for (const id of consumed) this.pending.delete(id);
    }
    async flushLocal() {
        const manager = this.host.sessionManager;
        if (!manager.isPersisted()) return;
        // Pi defers custom-only sessions until an assistant exists. Admission
        // must persist even when the first message is a background event.
        if (!manager.flushed) { manager._rewriteFile(); manager.flushed = true; }
        const file = manager.getSessionFile();
        const fd = await open(file, "r");
        try { await fd.sync(); } finally { await fd.close(); }
    }
    failStorage(error) {
        this.paused = true;
        this.poison = error instanceof Error ? error : new Error(String(error));
        this.poison.code = "SESSION_EVENT_STORAGE_UNAVAILABLE";
        throw this.poison;
    }
    check() {
        if (this.closed) throw new Error("session event runtime is closed");
        if (this.poison) throw this.poison;
    }
    receipt(id) { return { sessionId: this.host.sessionId, deliveryId: id, accepted: true }; }
    async post(input) {
        this.check();
        const id = eventId(input);
        if (typeof id !== "string" || !id || !TYPES.has(input.customType)) throw new Error("unsupported session event or missing deliveryId");
        const snapshot = JSON.parse(JSON.stringify({ customType: input.customType, content: input.content ?? [], display: input.display, details: input.details }));
        const inputHash = hash(snapshot);
        const epoch = this.epoch;
        const result = await this.host._serializeQueueMutation(async () => {
            this.check();
            if (epoch !== this.epoch) throw new Error("stale session event admission");
            const operationId = `${this.host.sessionId}:queue:${id}`;
            if (this.host._managedQueueActive) {
                // Lookup the original finalized payload before invoking hooks on
                // a retry. A crash must not cause a nondeterministic rewrite.
                const prior = await this.host._extensionRunner.emitStageCommit({ type: "stage_commit", phase: "event_lookup", operationId });
                if (prior) {
                    const { role: _role, timestamp: _timestamp, ...legacy } = prior.message;
                    const priorHash = prior.admissionInput ?? hash(legacy);
                    if (priorHash !== inputHash) throw new Error("deliveryId reused with different event content");
                    await this.host._refreshCommittedQueueView();
                    return this.receipt(id);
                }
            } else if (this.accepted.has(id)) {
                if (this.accepted.get(id) !== inputHash) throw new Error("deliveryId reused with different event content");
                return this.receipt(id);
            }
            const cached = this.host._managedQueueActive ? this.host._pendingEnqueues.get(operationId) : undefined;
            if (cached && cached.admissionInput !== inputHash) throw new Error("deliveryId reused with different event content");
            const message = cached?.message ?? await this.host._finalizeQueuedMessage({ role: "custom", customType: snapshot.customType,
                content: snapshot.content ?? [], display: snapshot.display, details: snapshot.details,
                timestamp: Number.isSafeInteger(snapshot.details?.deliveryTimestamp) ? snapshot.details.deliveryTimestamp : Date.now() });
            if (eventId(message) !== id) throw new Error("message hook changed the session event identity");
            if (this.host._managedQueueActive) {
                this.host._pendingEnqueues.set(operationId, { lane: "events", message, admissionInput: inputHash });
                const receipt = await this.host._extensionRunner.emitStageCommit({ type: "stage_commit", phase: "queue_enqueue",
                    lane: "events", message, operationId, admissionInput: inputHash });
                this.host._applyCommittedQueueReceipt(receipt, (view) => view.events.push({ itemId: operationId, message }), operationId);
            } else {
                try {
                    this.host.sessionManager.appendCustomEntry(JOURNAL, { version: 1, deliveryId: id, inputHash, message });
                    await this.flushLocal();
                } catch (error) { this.failStorage(error); }
                this.accepted.set(id, inputHash); this.pending.set(id, message);
            }
            this.paused = false;
            return this.receipt(id);
        });
        this.signal(); this.poke();
        return result;
    }
    hasPending() {
        if ([...this.taken.keys()].some((id) => !this.inflight.has(id))) return true;
        return this.host._managedQueueActive ? Boolean(this.host._committedQueueView?.events?.length)
            : [...this.pending.keys()].some((id) => !this.inflight.has(id));
    }
    signal() {
        if (!this.waiter) return;
        if (this.host.getSteeringMessages().length) this.waiter.finish("user_input");
        else if (this.hasPending()) this.waiter.finish("event");
    }
    wait(timeoutMs, signal) {
        try {
            this.check();
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_WAIT_MS) throw new Error("timeoutMs must be a positive integer no greater than 86400000");
            if (!this.host.isStreaming) throw new Error("session_wait requires an active Agent run");
            if (this.waiter) throw new Error("this session already has an active wait");
            if (signal?.aborted) throw new Error("session wait aborted");
        } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const waitId = `${this.host.sessionId}:wait:${this.runtimeId}:${++this.waitSerial}`;
            const timer = setTimeout(() => finish("timeout"), timeoutMs);
            const abort = () => finish("aborted");
            const finish = (reason) => {
                if (this.waiter?.waitId !== waitId) return;
                this.waiter = null; clearTimeout(timer); signal?.removeEventListener("abort", abort);
                if (reason !== "aborted") this.boundaryReady = true;
                this.host._emit({ type: "session_wait_end", waitId, reason });
                if (reason === "aborted") reject(new Error("session wait aborted"));
                else resolve({ reason, waitedMs: Math.max(0, Date.now() - startedAt) });
            };
            this.waiter = { waitId, startedAt, deadlineAt: startedAt + timeoutMs, finish };
            signal?.addEventListener("abort", abort, { once: true });
            this.host._emit({ type: "session_wait_start", ...this.state() });
            if (signal?.aborted) abort(); else this.signal();
        });
    }
    state() {
        if (!this.waiter) return null;
        const { waitId, startedAt, deadlineAt } = this.waiter;
        return { waitId, startedAt, deadlineAt };
    }
    async take(mode) {
        if (mode === "boundary" && !this.boundaryReady) return [];
        this.check();
        if (this.paused) return [];
        if (this.host._managedQueueActive) {
            let messages = [...this.taken].filter(([id]) => !this.inflight.has(id)).map(([, message]) => message);
            if (!messages.length) messages = await this.host._takeQueuedMessages("events");
            for (const message of messages) {
                const id = eventId(message);
                if (id) { this.taken.set(id, message); this.inflight.add(id); }
                this.host._acceptedQueuedMessages.add(message);
            }
            this.boundaryReady = false;
            return messages;
        }
        return this.host._serializeQueueMutation(async () => {
            const items = [...this.pending].filter(([id]) => !this.inflight.has(id)).map(([id, message]) => ({ itemId: id, message }));
            const batch = items.slice(0, eventBatchSize(items));
            for (const item of batch) {
                this.inflight.add(item.itemId);
                this.host._acceptedQueuedMessages.add(item.message);
            }
            this.boundaryReady = false;
            return batch.map((item) => item.message);
        });
    }
    async consumed(message) {
        const id = eventId(message);
        if (!id) return;
        if (this.pending.has(id)) {
            try { await this.flushLocal(); } catch (error) { this.failStorage(error); }
            this.pending.delete(id);
        }
        this.taken.delete(id); this.inflight.delete(id);
    }
    settled() { this.inflight.clear(); }
    markReady() { this.ready = true; this.paused = false; this.signal(); this.poke(); }
    poke() {
        if (!this.ready || this.closed || this.paused || this.poison || this.scheduled || this.host.isStreaming || this.host.isCompacting || this.host.isBashRunning || !this.hasPending()) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (!this.ready || this.closed || this.paused || this.host.isStreaming || !this.hasPending()) return;
            // Reserve this session before any await. A user prompt can queue,
            // but cannot start a second Agent while admission/take is in flight.
            this.host._isAgentRunActive = true;
            void (async () => {
                let started = false;
                try {
                    let messages, lane;
                    if (this.host.getSteeringMessages().length) {
                        lane = "steer";
                        messages = await this.host.agent.drainQueuedMessages(this.host.agent.steeringQueue, lane);
                    } else {
                        lane = "events"; messages = await this.take("idle");
                    }
                    if (this.closed || this.paused) return;
                    if (messages.length) { started = true; await this.host._runAgentPrompt(messages, lane); }
                } catch (error) {
                    // Infrastructure failure is not permission to spin, drop
                    // the event, or invoke the model with uncommitted input.
                    this.paused = true;
                    this.host._extensionRunner.emitError({ extensionPath: "<session-events>", event: "post_event", error: error instanceof Error ? error.message : String(error) });
                } finally {
                    if (!started) await this.host._emitAgentSettled();
                }
            })();
        });
    }
    async repairInterruptedWait() {
        const branch = this.host.sessionManager.getBranch();
        const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
        const calls = assistant?.message.content?.filter((block) => block.type === "toolCall") ?? [];
        if (calls.length !== 1 || calls[0].name !== "session_wait") return;
        const id = calls[0].id;
        if (branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)) return;
        // A JS promise cannot survive restart. Close only our side-effect-free
        // wait call; never synthesize results for arbitrary Node tool calls.
        const message = { role: "toolResult", toolCallId: id, toolName: "session_wait",
            content: [{ type: "text", text: "The previous session_wait was interrupted by host restart. No background job was canceled or restarted. Pending events will be delivered before the next model request." }],
            details: { reason: "interrupted", waitedMs: 0 }, isError: false, timestamp: assistant.message.timestamp };
        await this.host._extensionRunner.emitStageCommit({ type: "stage_commit", phase: "wait_interrupted", toolCallId: id, message });
        this.host.sessionManager.appendMessage(message);
        await this.flushLocal();
        this.host.agent.state.messages.push(message);
        this.host._emit({ type: "message_start", message });
        this.host._emit({ type: "message_end", message });
    }
    async migrate() {
        await this.repairInterruptedWait();
        if (this.host._managedQueueActive) {
            const view = await this.host._readCommittedQueue();
            const ids = view.followUp.filter((item) => item.message.role === "custom" && TYPES.has(item.message.customType)).map((item) => item.itemId);
            if (ids.length) {
                const operationId = `${this.host.sessionId}:migrate-events:${hash(ids)}`;
                await this.host._extensionRunner.emitStageCommit({ type: "stage_commit", phase: "queue_migrate_events", itemIds: ids, operationId });
                await this.host._refreshCommittedQueueView();
            }
        } else {
            const queue = this.host.agent.followUpQueue;
            const legacy = queue.messages.filter((message) => message.role === "custom" && TYPES.has(message.customType) && eventId(message));
            for (const message of legacy) {
                const { role: _role, timestamp: _timestamp, ...input } = message;
                await this.post(input);
                queue.messages = queue.messages.filter((item) => item !== message);
            }
        }
    }
    stop() {
        this.paused = true; this.boundaryReady = false;
        this.waiter?.finish("aborted");
    }
    suspend() {
        this.ready = false; this.epoch++;
        this.stop();
    }
    dispose() { this.suspend(); this.closed = true; }
}
