/**
 * Minimal typed event emitter.
 *
 * Node's EventEmitter is string-keyed and untyped; this keeps the discriminated
 * union from @assistant/schemas intact end to end, so subscribing to an event that
 * does not exist is a compile error.
 */
export type Listener<E> = (event: E) => void;

export class TypedEmitter<E extends { type: string }> {
  readonly #listeners = new Set<Listener<E>>();

  on(listener: Listener<E>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: E): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failing subscriber must not stall the pipeline or block peers.
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }

  clear(): void {
    this.#listeners.clear();
  }
}
