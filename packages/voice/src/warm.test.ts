import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '@assistant/core';
import { ProviderStatus, SynthesisResult, type SynthesisRequest } from '@assistant/schemas';
import type { TextToSpeechProvider } from './types.js';
import { COMMON_PHRASES, warmPhraseCache } from './warm.js';

function clip(text: string, cached: boolean) {
  return SynthesisResult.parse({
    audio: {
      data: Buffer.from(text).toString('base64'),
      sampleRate: 22050,
      channels: 1,
      encoding: 'wav',
    },
    provider: 'sarvam',
    durationMs: cached ? 3 : 950,
    timings: { requestMs: cached ? 0 : 700, transformMs: cached ? 0 : 250, cached },
  });
}

/** Reports a hit for anything it has already been asked for, like the real cache. */
function fakeCachedTts() {
  const calls: string[] = [];
  const seen = new Set<string>();
  const tts: TextToSpeechProvider = {
    name: 'sarvam',
    requiresNetwork: true,
    synthesize(request: SynthesisRequest) {
      calls.push(request.text);
      const hit = seen.has(request.text);
      seen.add(request.text);
      return okAsync(clip(request.text, hit));
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
  return { tts, calls };
}

describe('warmPhraseCache', () => {
  it('synthesises each phrase once and reports the second run as already warm', async () => {
    const { tts, calls } = fakeCachedTts();
    const phrases = ['Paused.', 'Playing.'];

    const first = await warmPhraseCache(tts, { phrases });
    const second = await warmPhraseCache(tts, { phrases });

    expect(first).toMatchObject({ synthesised: 2, cached: 0, failed: 0, aborted: false });
    // The steady state: a warmed boot does no network work at all.
    expect(second).toMatchObject({ synthesised: 0, cached: 2, failed: 0 });
    expect(calls).toHaveLength(4);
  });

  /**
   * Sarvam being unreachable at boot is a normal condition — no key, no
   * network, or simply down. Warming is an optimisation, and an optimisation
   * that stops Assistant from starting has cost more than it ever saved.
   */
  it('survives a provider that fails on every phrase', async () => {
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

    const result = await warmPhraseCache(failing, { phrases: ['Paused.', 'Playing.'] });

    expect(result).toMatchObject({ synthesised: 0, failed: 2 });
  });

  /**
   * The trap this whole design exists to avoid. Voice conversion runs on one
   * local server: a warm clip converting while someone is waiting to be
   * answered delays the answer, which is the same mistake as letting a
   * speculative transcription take the whisper queue's only slot.
   */
  it('waits rather than competing with a live turn', async () => {
    const { tts, calls } = fakeCachedTts();
    let busy = true;

    const warming = warmPhraseCache(tts, {
      phrases: ['Paused.', 'Playing.'],
      isBusy: () => busy,
      pollMs: 5,
    });

    // Long enough that an unguarded implementation would have finished.
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(0);

    busy = false;
    const result = await warming;

    expect(result.synthesised).toBe(2);
  });

  it('stops immediately when aborted', async () => {
    const { tts, calls } = fakeCachedTts();
    const controller = new AbortController();
    controller.abort();

    const result = await warmPhraseCache(tts, {
      phrases: COMMON_PHRASES,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('gives up waiting when aborted mid-turn', async () => {
    const { tts } = fakeCachedTts();
    const controller = new AbortController();

    const warming = warmPhraseCache(tts, {
      phrases: ['Paused.'],
      isBusy: () => true,
      pollMs: 5,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 15);

    // The assertion is that this resolves at all: a busy-wait with no exit is
    // a hung process on shutdown.
    await expect(warming).resolves.toMatchObject({ aborted: true });
  });

  it('reports every phrase as it goes', async () => {
    const { tts } = fakeCachedTts();
    const seen: [string, string][] = [];

    await warmPhraseCache(tts, {
      phrases: ['Paused.'],
      onPhrase: (text, outcome) => seen.push([text, outcome]),
    });

    expect(seen).toEqual([['Paused.', 'synthesised']]);
  });
});

/**
 * Warming a sentence no tool says any more is worse than not warming at all:
 * it spends the round trips and fills the disk with audio nobody will ever ask
 * for, and nothing about it looks broken. This is the only thing standing
 * between the list and that silent rot.
 */
describe('COMMON_PHRASES', () => {
  it('only contains sentences a tool or the orchestrator still speaks', async () => {
    const roots = [
      join(import.meta.dirname, '..', '..', 'tools', 'src'),
      join(import.meta.dirname, '..', '..', '..', 'apps', 'brain', 'src'),
    ];

    const sources: string[] = [];
    async function collect(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist') await collect(path);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          sources.push(await readFile(path, 'utf8'));
        }
      }
    }
    await Promise.all(roots.map(collect));
    const haystack = sources.join('\n');

    const orphaned = COMMON_PHRASES.filter((phrase) => !haystack.includes(`'${phrase}'`));
    expect(orphaned).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(COMMON_PHRASES).size).toBe(COMMON_PHRASES.length);
  });
});
