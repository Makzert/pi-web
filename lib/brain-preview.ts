/** A preview belongs to one leadership and generation. Accepted history is
 * replaced by the authoritative reset; these cursors only fence temporary UI. */
export class BrainPreviewFence {
  private leadership?: string;
  private sequence = 0;
  private generation?: string;
  private retired = new Set<string>();
  reset(leadership: string): void { this.leadership = leadership; this.sequence = 0; this.generation = undefined; this.retired.clear(); }
  accept(event: Record<string, unknown>): boolean {
    if (event.leadership !== this.leadership) return false;
    if (typeof event.sequence !== "number" || event.sequence <= this.sequence) return false;
    const generation = typeof event.generationId === "string" ? event.generationId : undefined;
    if (generation && this.retired.has(generation)) return false;
    if (generation && generation !== this.generation) { if (this.generation) this.retired.add(this.generation); this.generation = generation; }
    this.sequence = event.sequence;
    return true;
  }
}
