import { childLogger } from '@assistant/core';
import type { TranscriptionResult } from '@assistant/schemas';

const log = childLogger('speculation');

/**
 * Transcriptions started before the user had finished being silent.
 *
 * The microphone waits 850 ms of silence before deciding an utterance is over,
 * and only then does whisper start — so a fast-path command pays the hold and
 * the transcription back to back. Firing the transcription at ~200 ms instead
 * overlaps the two, and by the time the utterance is confirmed the words are
 * usually already there.
 *
 * The bet is that the last 650 ms of an utterance that ended in silence
 * contains no speech. That is true by construction: the utterance was accepted
 * *because* the silence continued. If speech resumes, the guess is wrong and
 * the run is abandoned — which is the only reason this is safe to do at all,
 * and why `SerialQueue` had to learn to drop an abandoned task rather than
 * make the real utterance wait behind it.
 *
 * Entries are short-lived by design. A speculation is either claimed by the
 * utterance that follows it within a second or so, or it is stale.
 */

export interface Speculation {
  /** Resolves to the transcript, or null if the run was abandoned or failed. */
  readonly result: Promise<TranscriptionResult | null>;
  /** Abandons the run — the user carried on talking. */
  abort: () => void;
  readonly startedAt: number;
}

/** Long enough to cover the hold plus a slow transcription, short enough to stay small. */
const TTL_MS = 15_000;

export class SpeculationStore {
  readonly #pending = new Map<string, Speculation>();
  readonly #ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.#ttlMs = options.ttlMs ?? TTL_MS;
  }

  get size(): number {
    return this.#pending.size;
  }

  put(id: string, speculation: Speculation): void {
    this.#evictExpired();
    this.#pending.set(id, speculation);
  }

  /**
   * Hands over a speculation and removes it.
   *
   * Removed on claim rather than on expiry alone: a transcript must be used by
   * exactly one utterance, and a second claim on the same id would mean two
   * turns built from one recording.
   */
  claim(id: string): Speculation | null {
    this.#evictExpired();
    const found = this.#pending.get(id);
    if (!found) return null;
    this.#pending.delete(id);
    return found;
  }

  /** The user carried on talking: abandon the run and forget it. */
  cancel(id: string): boolean {
    const found = this.#pending.get(id);
    if (!found) return false;
    this.#pending.delete(id);
    found.abort();
    return true;
  }

  /** Abandons everything — on shutdown, or when the microphone stops. */
  cancelAll(): void {
    for (const id of [...this.#pending.keys()]) this.cancel(id);
  }

  #evictExpired(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [id, speculation] of this.#pending) {
      if (speculation.startedAt < cutoff) {
        this.#pending.delete(id);
        // Expiry means nobody ever claimed it, which means the utterance never
        // arrived. Leaving the run going would hold the whisper queue against
        // an utterance that is never coming.
        speculation.abort();
        log.debug({ id }, 'speculation expired unclaimed');
      }
    }
  }
}
