export interface BrainViewStamp {
  sessionId: string;
  activationId: string;
  branchHead: number;
  runtimeSeq: number;
}
export interface ViewRead { sessionId: string; epoch: number; activationEpoch: number }

/** One admission boundary for HTTP snapshots, state reads and SSE resets.
 * Formal messages advance an observation watermark, never the installed cut.
 */
export class BrainViewAdmission {
  private stamp?: BrainViewStamp;
  private activationEpoch = 0;
  private retired = new Set<string>();
  private observedHead = 0;
  private ids = new Set<string>();
  capture(sessionId: string, epoch: number): ViewRead { return { sessionId, epoch, activationEpoch: this.activationEpoch }; }
  managed(sessionId: string): boolean { return this.stamp?.sessionId === sessionId; }
  private valid(value?: BrainViewStamp): value is BrainViewStamp {
    return !!value && typeof value.activationId === "string" && !!value.activationId && typeof value.sessionId === "string"
      && Number.isSafeInteger(value.branchHead) && value.branchHead >= 0 && Number.isSafeInteger(value.runtimeSeq) && value.runtimeSeq >= 0;
  }
  admit(kind: "snapshot" | "state", sid: string, epoch: number, value: BrainViewStamp | undefined, managed: boolean, read?: ViewRead, ids: string[] = []): "accept" | "drop" | "refresh" {
    if (read && (read.sessionId !== sid || read.epoch !== epoch || read.activationEpoch !== this.activationEpoch)) return "drop";
    if (!managed && !value && !this.managed(sid)) return "accept";
    if (!this.valid(value) || value.sessionId !== sid) return "drop";
    const previous = this.stamp?.sessionId === sid ? this.stamp : undefined;
    const changed = previous && previous.activationId !== value.activationId;
    if (this.retired.has(value.activationId)) return "drop";
    if (changed) {
      // Activation indices are committed Raft indices and cannot go backwards.
      const oldIndex = Number(previous.activationId.slice(previous.activationId.lastIndexOf(":") + 1));
      const newIndex = Number(value.activationId.slice(value.activationId.lastIndexOf(":") + 1));
      if (Number.isSafeInteger(oldIndex) && Number.isSafeInteger(newIndex) && newIndex <= oldIndex) return "drop";
      if (kind === "state") return "refresh";
    }
    const observed = previous ? this.observedHead : 0;
    if (value.branchHead < Math.max(previous?.branchHead ?? 0, observed)) return "drop";
    if (kind === "state" && (!previous || value.branchHead !== previous.branchHead)) return "refresh";
    if (previous && !changed && value.runtimeSeq < previous.runtimeSeq) return "drop";
    if (!previous || changed) {
      if (previous) this.retired.add(previous.activationId);
      this.activationEpoch++;
    }
    this.stamp = { ...value };
    if (kind === "snapshot") { this.observedHead = value.branchHead; this.ids = new Set(ids); }
    return "accept";
  }
  observeRuntime(sid: string, activationId: unknown, sequence: unknown): boolean {
    if (!this.managed(sid)) return true;
    if (activationId !== this.stamp!.activationId) return false;
    if (typeof sequence === "number" && Number.isSafeInteger(sequence)) this.stamp!.runtimeSeq = Math.max(this.stamp!.runtimeSeq, sequence);
    return true;
  }
  message(sid: string, index: number, id: string): boolean {
    const installed = this.stamp?.sessionId === sid ? this.stamp.branchHead : 0;
    if (index < Math.max(installed, this.observedHead) || this.ids.has(id)) return false;
    this.observedHead = Math.max(this.observedHead, index); this.ids.add(id);
    return true;
  }
}
