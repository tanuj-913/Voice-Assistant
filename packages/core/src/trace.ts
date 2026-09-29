/**
 * Stage timing for a single turn.
 *
 * Every latency claim made about this system so far has been guesswork or a
 * stopwatch around the whole turn, which hides where the time actually goes —
 * and on a machine that swaps, the same request can take 20s or 111s with no
 * visible difference. A turn needs to say, in one log line, how long it spent
 * transcribing, routing, waiting on the model, running tools and synthesising.
 *
 * Marks are monotonic and relative to the turn's start, so they survive the
 * clock changing under them. `durations` reports the gap between consecutive
 * marks, which is what you want when reading a pipeline; `sinceStart` reports
 * cumulative time, which is what you want for "when did the user hear
 * something".
 */
export interface TraceSpan {
  /** Milliseconds from the turn's start to this mark. */
  at: number;
  /** Milliseconds since the previous mark. */
  delta: number;
}

export class Trace {
  readonly #started: number;
  readonly #marks: { name: string; at: number }[] = [];

  constructor(private readonly label: string) {
    this.#started = performance.now();
  }

  /**
   * Records a stage boundary. Repeating a name is allowed — a turn can call
   * the model more than once, and each pass deserves its own mark.
   */
  mark(name: string): void {
    this.#marks.push({ name, at: performance.now() - this.#started });
  }

  /** Total elapsed so far. */
  get elapsed(): number {
    return Math.round(performance.now() - this.#started);
  }

  /** The first time a given mark was recorded, or null if it never was. */
  at(name: string): number | null {
    const found = this.#marks.find((m) => m.name === name);
    return found ? Math.round(found.at) : null;
  }

  /**
   * One flat object per turn, shaped for a structured log line: each stage
   * with when it happened and how long it took.
   */
  spans(): Record<string, TraceSpan> {
    const out: Record<string, TraceSpan> = {};
    let previous = 0;
    let seen = 0;
    for (const { name, at } of this.#marks) {
      // A repeated stage gets a numbered suffix rather than overwriting, so a
      // two-model-call turn shows both.
      let key = name;
      if (key in out) {
        seen += 1;
        key = `${name}_${String(seen + 1)}`;
      }
      out[key] = { at: Math.round(at), delta: Math.round(at - previous) };
      previous = at;
    }
    return out;
  }

  /** Ready to hand straight to the logger. */
  summary(): { turn: string; totalMs: number; stages: Record<string, TraceSpan> } {
    return { turn: this.label, totalMs: this.elapsed, stages: this.spans() };
  }
}
