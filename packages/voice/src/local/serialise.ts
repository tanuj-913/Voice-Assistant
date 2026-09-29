/**
 * Runs tasks one at a time, in the order they arrive.
 *
 * Built for the always-on microphone path. Each whisper run loads the model
 * into its own process — 1.6 GB for large-v3-turbo — and utterances arrive
 * faster than they transcribe. Left unbounded this reached five concurrent
 * processes and enough resident memory to evict the 19 GB LLM, after which
 * every model call paid ~130s to page it back in and turns stopped completing.
 *
 * Implemented as a promise chain rather than a wake-up flag. The first attempt
 * used a single `resolve` slot that each waiter overwrote, which livelocked
 * with two waiters and deadlocked outright with three: every waiter but one
 * ended up awaiting a promise whose resolver had been discarded.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** Number of tasks running or waiting. */
  get depth(): number {
    return this.#depth;
  }

  get busy(): boolean {
    return this.#depth > 0;
  }

  /** Resolves once everything queued so far has finished. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  /**
   * `signal` makes a queued task abandonable.
   *
   * Without it, speculative work is strictly worse than no speculative work.
   * A transcription fired early on a guess that turns out wrong is still
   * holding the queue's only slot when the real utterance arrives, so the turn
   * the user is actually waiting on queues behind a result nobody will read —
   * and on a mistrigger that costs more than the speculation ever saves.
   *
   * Two distinct cases, and the first is the one that matters: a task aborted
   * while still *waiting* never runs at all, so it costs nothing. A task
   * already running is asked to stop via the same signal, which it honours
   * only as far as its own work allows.
   */
  run<T>(
    task: (signal?: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const { signal } = options;
    this.#depth += 1;

    const gated = (): Promise<T> => {
      // Checked at the moment the slot opens, not when the task was queued:
      // between those two points is exactly when a speculation is superseded.
      if (signal?.aborted === true) {
        return Promise.reject(new DOMException('Superseded before it started', 'AbortError'));
      }
      return task(signal);
    };

    // Chained off the tail with the same handler for both outcomes, so one
    // task failing does not stop the queue: without this a single whisper
    // crash would wedge the microphone permanently.
    const result = this.#tail.then(gated, gated);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );

    return result.finally(() => {
      this.#depth -= 1;
    });
  }
}
