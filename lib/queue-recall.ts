import { sendAgentCommand, AgentCommandError } from "./agent-client";
import { restoreRecallOnce } from "./draft-store";
import { isQueueSnapshot, type RecallReceipt } from "./queue-state";

type Operation = { operationId: string; timestamp: number; runtimeId: string; pending?: Promise<RecallReceipt>; terminal?: Error };
// Survives ChatWindow remounts, just like the per-session drafts.
const operations = new Map<string, Operation>();

export function getRecallFailure(sessionId: string): Error | undefined { return operations.get(sessionId)?.terminal; }

/** Only an explicit user decision may abandon an unknown earlier operation. */
export function abandonUnknownRecall(sessionId: string): void {
  const operation = operations.get(sessionId);
  if (operation?.terminal && !operation.pending) operations.delete(sessionId);
}

export function recallQueue(sessionId: string, runtimeId: string): Promise<RecallReceipt> {
  let operation = operations.get(sessionId);
  if (operation?.pending) return operation.pending;
  if (operation?.terminal) return Promise.reject(operation.terminal);
  if (operation && operation.runtimeId !== runtimeId) {
    operation.terminal = new AgentCommandError("The recall outcome belongs to an earlier runtime; it was not executed again", "QUEUE_INSTANCE_CHANGED");
    return Promise.reject(operation.terminal);
  }
  if (!operation) {
    operation = { operationId: crypto.randomUUID(), timestamp: Date.now(), runtimeId };
    operations.set(sessionId, operation);
  }
  const current = operation;
  const pending = sendAgentCommand<RecallReceipt>(sessionId, {
    type: "clear_queue", operationId: current.operationId, timestamp: current.timestamp, expectedRuntimeId: current.runtimeId,
  }).then(receipt => {
    if (receipt.operationId !== current.operationId || !isQueueSnapshot(receipt.queue)
      || receipt.queue.sessionId !== sessionId || receipt.queue.runtimeId !== current.runtimeId
      || !Array.isArray(receipt.steering) || !receipt.steering.every(text => typeof text === "string")
      || !Array.isArray(receipt.followUp) || !receipt.followUp.every(text => typeof text === "string")) {
      throw new AgentCommandError("Invalid recall receipt; outcome is unknown", "QUEUE_RECALL_UNKNOWN");
    }
    restoreRecallOnce(sessionId, receipt.operationId, [...receipt.steering, ...receipt.followUp]);
    operations.delete(sessionId);
    return receipt;
  }).catch(error => {
    if (error instanceof AgentCommandError && ["QUEUE_RECALL_UNKNOWN", "QUEUE_INSTANCE_CHANGED"].includes(error.code ?? "")) {
      current.terminal = error;
    }
    throw error;
  }).finally(() => { current.pending = undefined; });
  current.pending = pending;
  return pending;
}
