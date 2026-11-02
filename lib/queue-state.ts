/** Web presentation ordering, independent of the Brain commit head. */
export interface QueueSnapshot {
  readonly sessionId: string;
  readonly runtimeId: string;
  readonly revision: number;
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export interface RecallReceipt {
  operationId: string;
  steering: string[];
  followUp: string[];
  queue: QueueSnapshot;
}

export interface QueueReadTicket { epoch: number; revision: number; }

export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  const q = value as QueueSnapshot | undefined;
  return Boolean(q && typeof q.sessionId === "string" && typeof q.runtimeId === "string"
    && Number.isSafeInteger(q.revision) && q.revision >= 0
    && Array.isArray(q.steering) && q.steering.every(item => typeof item === "string")
    && Array.isArray(q.followUp) && q.followUp.every(item => typeof item === "string"));
}

/** One tracker per mounted session view. Only connected/sync may adopt a runtime. */
export class QueueSnapshotTracker {
  snapshot: QueueSnapshot | null = null;
  private epoch = 0;
  private retired = new Set<string>();
  readonly sessionId: string;
  constructor(sessionId: string) { this.sessionId = sessionId; }

  capture(): QueueReadTicket { return { epoch: this.epoch, revision: this.snapshot?.revision ?? -1 }; }

  accept(value: unknown, authoritative = false, ticket?: QueueReadTicket): boolean {
    if (!isQueueSnapshot(value) || value.sessionId !== this.sessionId) return false;
    if (ticket && ticket.epoch !== this.epoch) return false;
    if (this.snapshot?.runtimeId !== value.runtimeId) {
      if (!authoritative || this.retired.has(value.runtimeId)) return false;
      if (this.snapshot) this.retired.add(this.snapshot.runtimeId);
      this.epoch++;
    } else if (value.revision <= this.snapshot.revision) return false;
    this.snapshot = { ...value, steering: [...value.steering], followUp: [...value.followUp] };
    return true;
  }

  absent(ticket: QueueReadTicket): boolean {
    if (ticket.epoch !== this.epoch || ticket.revision !== (this.snapshot?.revision ?? -1)) return false;
    if (this.snapshot) this.retired.add(this.snapshot.runtimeId);
    this.snapshot = null;
    this.epoch++;
    return true;
  }
}
