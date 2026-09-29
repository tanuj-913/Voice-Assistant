import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errAsync, okAsync } from '@assistant/core';
import { ProviderStatus, SynthesisResult, type SynthesisRequest } from '@assistant/schemas';
import type { TextToSpeechProvider } from './types.js';
import { withPhraseCache } from './phrase-cache.js';

function result(text: string) {
  return SynthesisResult.parse({
    audio: {
      data: Buffer.from(text).toString('base64'),
      sampleRate: 22050,
      channels: 1,
      encoding: 'wav',
    },
    provider: 'sarvam',
    durationMs: 1,
  });
}

function fakeProvider() {
  const calls: string[] = [];
  const provider: TextToSpeechProvider = {
    name: 'sarvam',
    requiresNetwork: true,
    synthesize(request: SynthesisRequest) {
      calls.push(request.text);
      return okAsync(result(request.text));
    },
    health: () =>
      okAsync(
        ProviderStatus.parse({
          name: 'sarvam',
          available: true,
          lastCheckedAt: new Date().toISOString(),
        }),
      ),
  };
  return { provider, calls };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phrase-cache-'));
});

describe('withPhraseCache', () => {
  it('synthesises once and serves the repeat from disk', async () => {
    const { provider, calls } = fakeProvider();
    const cached = withPhraseCache(provider, { dir, variant: 'v1' });
    const request: SynthesisRequest = { text: 'Paused.', language: 'en-IN' };

    const first = await cached.synthesize(request);
    const second = await cached.synthesize(request);

    // The point of the whole thing: one round trip, two answers.
    expect(calls).toEqual(['Paused.']);
    // The audio must be identical; the timings must not be — see below.
    expect(first._unsafeUnwrap().audio).toEqual(second._unsafeUnwrap().audio);
    expect(first._unsafeUnwrap().provider).toBe(second._unsafeUnwrap().provider);
  });

  /**
   * A cache hit that replayed the stored timings would put the original 950 ms
   * Sarvam call into the trace of a turn that only read a file — and the cache
   * would look like it had saved nothing. The one number a hit can honestly
   * report is its own.
   */
  it('reports a hit as cached rather than replaying the original timings', async () => {
    const slow: TextToSpeechProvider = {
      name: 'sarvam',
      requiresNetwork: true,
      synthesize: (request: SynthesisRequest) =>
        okAsync({
          ...result(request.text),
          durationMs: 950,
          timings: { requestMs: 700, transformMs: 250, cached: false },
        }),
      health: () =>
        okAsync(
          ProviderStatus.parse({
            name: 'sarvam',
            available: true,
            lastCheckedAt: new Date().toISOString(),
          }),
        ),
    };
    const cached = withPhraseCache(slow, { dir, variant: 'v1' });
    const request: SynthesisRequest = { text: 'Paused.', language: 'en-IN' };

    const miss = await cached.synthesize(request);
    const hit = await cached.synthesize(request);

    expect(miss._unsafeUnwrap().timings).toEqual({
      requestMs: 700,
      transformMs: 250,
      cached: false,
    });
    expect(hit._unsafeUnwrap().timings).toEqual({ requestMs: 0, transformMs: 0, cached: true });
    // A file read, not a network call — the assertion that makes the cache's
    // benefit visible in the trace instead of having to be taken on trust.
    expect(hit._unsafeUnwrap().durationMs).toBeLessThan(950);
  });

  it('still parses clips cached before timings existed', async () => {
    const { provider, calls } = fakeProvider();
    const cached = withPhraseCache(provider, { dir, variant: 'v1' });
    const request: SynthesisRequest = { text: 'Playing.', language: 'en-IN' };

    await cached.synthesize(request);
    const [file] = await readdir(dir);
    const stored = JSON.parse(await readFile(join(dir, file ?? ''), 'utf8')) as Record<
      string,
      unknown
    >;
    delete stored.timings;
    await writeFile(join(dir, file ?? ''), JSON.stringify(stored), 'utf8');

    const again = await cached.synthesize(request);

    // Served from disk, not re-synthesised: an older entry is still good audio.
    expect(calls).toHaveLength(1);
    expect(again._unsafeUnwrap().timings).toEqual({ requestMs: 0, transformMs: 0, cached: true });
  });

  it('keeps languages apart', async () => {
    const { provider, calls } = fakeProvider();
    const cached = withPhraseCache(provider, { dir, variant: 'v1' });

    await cached.synthesize({ text: 'Paused.', language: 'en-IN' });
    await cached.synthesize({ text: 'Paused.', language: 'hi-IN' });

    expect(calls).toHaveLength(2);
  });

  /**
   * The failure this guards against is silent: change the checkpoint or the
   * pitch, and without the variant in the key Assistant keeps speaking in the old
   * voice from cache and nothing looks wrong.
   */
  it('misses when the voice settings change', async () => {
    const { provider, calls } = fakeProvider();
    const request: SynthesisRequest = { text: 'Paused.', language: 'en-IN' };

    await withPhraseCache(provider, { dir, variant: 'epoch175-idx0.5-pitch0' }).synthesize(request);
    await withPhraseCache(provider, { dir, variant: 'epoch175-idx0.5-pitch5' }).synthesize(request);

    expect(calls).toHaveLength(2);
  });

  it('reports hits and misses', async () => {
    const { provider } = fakeProvider();
    const seen: { hit: boolean; text: string }[] = [];
    const cached = withPhraseCache(provider, {
      dir,
      variant: 'v1',
      onLookup: (hit, text) => seen.push({ hit, text }),
    });

    await cached.synthesize({ text: 'Playing.', language: 'en-IN' });
    await cached.synthesize({ text: 'Playing.', language: 'en-IN' });

    expect(seen).toEqual([
      { hit: false, text: 'Playing.' },
      { hit: true, text: 'Playing.' },
    ]);
  });

  it('re-synthesises rather than trusting a corrupt entry', async () => {
    const { provider, calls } = fakeProvider();
    const cached = withPhraseCache(provider, { dir, variant: 'v1' });
    const request: SynthesisRequest = { text: 'Stopped.', language: 'en-IN' };

    await cached.synthesize(request);
    const [file] = await readdir(dir);
    await writeFile(join(dir, file ?? ''), 'not json at all', 'utf8');

    const again = await cached.synthesize(request);
    expect(calls).toHaveLength(2);
    expect(again.isOk()).toBe(true);
  });

  it('does not cache a failed synthesis', async () => {
    const failing: TextToSpeechProvider = {
      name: 'sarvam',
      requiresNetwork: true,
      synthesize: () => errAsync({ code: 'sarvam_down', message: 'no', retryable: true }),
      health: () =>
        okAsync(
          ProviderStatus.parse({
            name: 'sarvam',
            available: false,
            lastCheckedAt: new Date().toISOString(),
          }),
        ),
    };
    const cached = withPhraseCache(failing, { dir, variant: 'v1' });

    expect((await cached.synthesize({ text: 'Paused.', language: 'en-IN' })).isErr()).toBe(true);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('passes health through untouched', async () => {
    const { provider } = fakeProvider();
    const spy = vi.spyOn(provider, 'health');
    await withPhraseCache(provider, { dir, variant: 'v1' }).health();
    expect(spy).toHaveBeenCalledOnce();
  });
});
