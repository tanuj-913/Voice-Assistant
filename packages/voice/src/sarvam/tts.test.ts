import { describe, expect, it } from 'vitest';
import { fromPromise } from '@assistant/core';
import { SarvamTtsProvider } from './tts.js';
import type { SarvamClient } from './client.js';

/**
 * A clip is one base64 WAV; nothing here decodes it, so any bytes will do.
 */
const CLIP = Buffer.from('fake-wav').toString('base64');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stands in for the real client. `postJson` is the only method the provider
 * reaches for, so the cast is narrow rather than a pretence at implementing
 * the class.
 */
function stubClient(delayMs: number): SarvamClient {
  return {
    postJson: () =>
      fromPromise(
        sleep(delayMs).then(() => ({ request_id: 'req-1', audios: [CLIP] })),
        'sarvam_stub_failed',
      ),
  } as unknown as SarvamClient;
}

describe('SarvamTtsProvider timings', () => {
  /**
   * The whole point of the split. A 1.8s clip tells you nothing actionable;
   * "1.2s network, 0.6s conversion" and "0.2s network, 1.6s conversion" have
   * completely different fixes, and before this the trace could not tell them
   * apart.
   */
  it('separates the network round trip from the voice conversion', async () => {
    const provider = new SarvamTtsProvider({
      client: stubClient(60),
      transform: async (audio: Buffer) => {
        await sleep(120);
        return audio;
      },
    });

    const result = await provider.synthesize({ text: 'Paused.', language: 'en-IN' });
    const timings = result._unsafeUnwrap().timings;

    expect(timings).not.toBeNull();
    // Generous bounds: this asserts the two stages are attributed to the right
    // buckets, not that the machine hit a stopwatch target.
    expect(timings?.requestMs).toBeGreaterThanOrEqual(50);
    expect(timings?.requestMs).toBeLessThan(120);
    expect(timings?.transformMs).toBeGreaterThanOrEqual(100);
    expect(timings?.cached).toBe(false);
  });

  /**
   * With no converter running, every millisecond belongs to Sarvam. Reporting
   * a non-zero transform here would send someone optimising a stage that does
   * not exist.
   */
  it('reports no transform time when nothing converts the clip', async () => {
    const provider = new SarvamTtsProvider({ client: stubClient(40) });

    const result = await provider.synthesize({ text: 'Playing.', language: 'en-IN' });
    const timings = result._unsafeUnwrap().timings;

    expect(timings?.transformMs).toBeLessThan(20);
    expect(timings?.requestMs).toBeGreaterThanOrEqual(30);
  });

  it('keeps the parts within the whole', async () => {
    const provider = new SarvamTtsProvider({
      client: stubClient(30),
      transform: async (audio: Buffer) => {
        await sleep(30);
        return audio;
      },
    });

    const value = (
      await provider.synthesize({ text: 'Stopped.', language: 'en-IN' })
    )._unsafeUnwrap();

    // Rounding can put the sum a millisecond either side, so this checks the
    // two stages account for the whole rather than demanding exact equality.
    const sum = (value.timings?.requestMs ?? 0) + (value.timings?.transformMs ?? 0);
    expect(Math.abs(sum - value.durationMs)).toBeLessThanOrEqual(2);
  });
});
