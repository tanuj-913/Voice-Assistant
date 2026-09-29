import { describe, expect, it } from 'vitest';
import { SerialQueue } from './serialise.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SerialQueue', () => {
  it('never runs two tasks at once', async () => {
    const queue = new SerialQueue();
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        queue.run(async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await tick(10);
          concurrent -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
    expect(concurrent).toBe(0);
    expect(queue.busy).toBe(false);
  });

  it('runs every task, in the order submitted', async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        queue.run(async () => {
          await tick(5);
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps running after a task fails', async () => {
    const queue = new SerialQueue();

    // A whisper process exiting non-zero must not wedge the microphone.
    const failed = queue.run(() => Promise.reject(new Error('whisper exited 1')));
    const after = queue.run(() => Promise.resolve('ok'));

    await expect(failed).rejects.toThrow('whisper exited 1');
    await expect(after).resolves.toBe('ok');
    expect(queue.busy).toBe(false);
  });
});

/**
 * The cancellable slot, added for speculative transcription.
 *
 * Firing a transcription early — at ~200 ms of silence rather than the full
 * 850 ms hold — is only a win if a wrong guess costs nothing. Without this, a
 * speculation the user invalidated by carrying on talking still holds the
 * queue's only slot, and the utterance they are actually waiting on queues
 * behind a result nobody will ever read.
 */
describe('SerialQueue cancellation', () => {
  it('never starts a task aborted while it was still waiting', async () => {
    const queue = new SerialQueue();
    const ran: string[] = [];
    let releaseFirst = (): void => {
      // Replaced synchronously by the promise below; never actually called.
    };
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      ran.push('first');
      await blocked;
    });

    const controller = new AbortController();
    const speculative = queue.run(
      () => {
        ran.push('speculative');
        return Promise.resolve('should never happen');
      },
      { signal: controller.signal },
    );
    const real = queue.run(() => {
      ran.push('real');
      return Promise.resolve('transcript');
    });

    // The user carried on talking while the speculation was still queued.
    controller.abort();
    releaseFirst();

    await expect(speculative).rejects.toThrow();
    await expect(real).resolves.toBe('transcript');
    await first;

    // The whole point: the abandoned task cost the real one nothing.
    expect(ran).toEqual(['first', 'real']);
  });

  it('hands the signal to a task that did start, so it can stop itself', async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    let started = false;

    const running = queue.run(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          started = true;
          signal?.addEventListener('abort', () => {
            reject(new Error('killed'));
          });
        }),
      { signal: controller.signal },
    );

    // The gate runs on a microtask, so aborting synchronously would test the
    // waiting case instead — which is the test above.
    await Promise.resolve();
    expect(started).toBe(true);
    controller.abort();

    // Killed by its own handler, not refused by the gate: this is a whisper
    // process being stopped mid-run rather than one that never started.
    await expect(running).rejects.toThrow('killed');
  });

  it('frees the slot when a task is abandoned', async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();
    controller.abort();

    await expect(
      queue.run(() => Promise.resolve('x'), { signal: controller.signal }),
    ).rejects.toThrow();

    // A leaked slot would wedge the microphone for the rest of the session.
    expect(queue.depth).toBe(0);
    await expect(queue.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('leaves tasks with no signal exactly as they were', async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    await Promise.all([
      queue.run(() => {
        order.push(1);
        return Promise.resolve();
      }),
      queue.run(() => {
        order.push(2);
        return Promise.resolve();
      }),
      queue.run(() => {
        order.push(3);
        return Promise.resolve();
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });
});

/**
 * The mistrigger case, measured.
 *
 * The task board's condition for shipping speculative transcription was that
 * a wrong guess must not cost more than a right one saves. A guess is wrong
 * whenever the user pauses mid-sentence and carries on, which is often — so
 * the question is not whether mistriggers happen but what they cost the
 * utterance behind them.
 *
 * Timing rather than ordering, because ordering alone would pass even if the
 * real utterance sat through the whole abandoned run.
 */
describe('what a wrong guess costs the utterance behind it', () => {
  const TRANSCRIPTION_MS = 120;

  it('costs the real utterance nothing when the speculation is dropped', async () => {
    const queue = new SerialQueue();
    const controller = new AbortController();

    // Fired at 250ms of silence, on the guess that the user had stopped.
    const speculative = queue.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('half a');
          }, TRANSCRIPTION_MS);
        }),
      { signal: controller.signal },
    );

    // They carried on talking, so the guess is void.
    controller.abort();
    await expect(speculative).rejects.toThrow();

    // The utterance the user is actually waiting on.
    const startedAt = performance.now();
    await queue.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('half a sentence');
          }, TRANSCRIPTION_MS);
        }),
    );
    const waited = performance.now() - startedAt;

    // Its own transcription and nothing more. Before the cancellable slot this
    // would have been roughly twice TRANSCRIPTION_MS, and the speculation
    // would have been a way of making the microphone slower.
    expect(waited).toBeLessThan(TRANSCRIPTION_MS * 1.8);
  });

  it('is the queue, not the caller, that has to enforce this', async () => {
    const queue = new SerialQueue();
    // The same sequence with no signal — what the old behaviour did, kept as
    // the contrast that gives the number above its meaning.
    const startedAt = performance.now();
    void queue.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('stale');
          }, TRANSCRIPTION_MS);
        }),
    );
    await queue.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve('real');
          }, TRANSCRIPTION_MS);
        }),
    );

    expect(performance.now() - startedAt).toBeGreaterThan(TRANSCRIPTION_MS * 1.5);
  });
});
