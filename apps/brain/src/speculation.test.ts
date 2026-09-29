import { describe, expect, it, vi } from 'vitest';
import { SpeculationStore, type Speculation } from './speculation.js';

function fake(overrides: Partial<Speculation> = {}) {
  return {
    result: Promise.resolve(null),
    abort: vi.fn(),
    startedAt: Date.now(),
    ...overrides,
  } satisfies Speculation;
}

describe('SpeculationStore', () => {
  it('hands over a stored speculation once', () => {
    const store = new SpeculationStore();
    const speculation = fake();
    store.put('a', speculation);

    expect(store.claim('a')).toBe(speculation);
    // A transcript must build exactly one turn. A second claim would mean two
    // turns from one recording.
    expect(store.claim('a')).toBeNull();
  });

  it('returns null for an id it never had', () => {
    expect(new SpeculationStore().claim('nope')).toBeNull();
  });

  /**
   * The call the whole design rests on. An uncancelled run holds whisper's
   * single slot, so the utterance the user is actually waiting on queues
   * behind a result nobody will read.
   */
  it('aborts the run when the user carries on talking', () => {
    const store = new SpeculationStore();
    const speculation = fake();
    store.put('a', speculation);

    expect(store.cancel('a')).toBe(true);
    expect(speculation.abort).toHaveBeenCalledOnce();
    // Cancelled means gone: a later utterance must not pick up a transcript of
    // a recording that turned out to be half a sentence.
    expect(store.claim('a')).toBeNull();
  });

  it('reports cancelling something that is not there', () => {
    expect(new SpeculationStore().cancel('gone')).toBe(false);
  });

  it('does not abort a speculation that was claimed', () => {
    const store = new SpeculationStore();
    const speculation = fake();
    store.put('a', speculation);
    store.claim('a');

    store.cancelAll();

    expect(speculation.abort).not.toHaveBeenCalled();
  });

  /**
   * An utterance that never arrives — the tab closed, the mic stopped — would
   * otherwise leave a whisper run going against nothing.
   */
  it('aborts and drops speculations nobody claimed', () => {
    const store = new SpeculationStore({ ttlMs: 50 });
    const stale = fake({ startedAt: Date.now() - 1_000 });
    store.put('old', stale);

    // Any operation sweeps; this one also proves the fresh entry survives.
    store.put('new', fake());

    expect(stale.abort).toHaveBeenCalledOnce();
    expect(store.claim('old')).toBeNull();
    expect(store.claim('new')).not.toBeNull();
  });

  it('abandons everything on cancelAll', () => {
    const store = new SpeculationStore();
    const one = fake();
    const two = fake();
    store.put('1', one);
    store.put('2', two);

    store.cancelAll();

    expect(one.abort).toHaveBeenCalledOnce();
    expect(two.abort).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });
});
