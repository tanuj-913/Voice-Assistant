import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromPromise, okAsync, type AppResultAsync } from '@assistant/core';
import { SynthesisResult, type ProviderStatus, type SynthesisRequest } from '@assistant/schemas';
import type { TextToSpeechProvider } from './types.js';

/**
 * Disk cache for synthesised speech, wrapped around any TTS provider.
 *
 * Most of what a voice assistant says is a fixed string. The tool renderers
 * emit "Paused.", "Playing.", "Volume set to 40 percent." — the same bytes
 * every time, yet each one costs a network round trip to Sarvam plus a voice
 * conversion, together well over a second. Cached, they are a file read.
 *
 * This sits above the conversion, so what is stored is the finished audio in
 * the trained voice, not the raw synthesis. That means the key has to include
 * everything that would change the sound — checkpoint, index rate, pitch — or
 * a settings change would silently keep serving the old voice. `variant`
 * carries that; get it wrong and the bug is inaudible until someone notices
 * Assistant never changed.
 *
 * Only exact repeats hit. "It's 5:40 PM." is a different string every minute
 * and will always miss, which is correct.
 */
export interface PhraseCacheOptions {
  /** Directory for the audio. Created on demand. */
  dir: string;
  /**
   * Anything that changes how the voice sounds. Include the checkpoint, index
   * rate and pitch — not the text, which is hashed separately.
   */
  variant: string;
  /** Called on each lookup, so hit rate can be logged. */
  onLookup?: (hit: boolean, text: string) => void;
}

function keyFor(text: string, language: string, variant: string): string {
  return createHash('sha256').update(`${variant} ${language} ${text}`).digest('hex');
}

export function withPhraseCache(
  provider: TextToSpeechProvider,
  options: PhraseCacheOptions,
): TextToSpeechProvider {
  const { dir, variant, onLookup } = options;
  let ready: Promise<void> | null = null;
  const ensureDir = () => (ready ??= mkdir(dir, { recursive: true }).then(() => undefined));

  return {
    name: provider.name,
    requiresNetwork: provider.requiresNetwork,
    health: (): AppResultAsync<ProviderStatus> => provider.health(),

    synthesize(request: SynthesisRequest): AppResultAsync<SynthesisResult> {
      const path = join(dir, `${keyFor(request.text, request.language, variant)}.json`);

      const startedAt = performance.now();

      return fromPromise(
        (async () => {
          await ensureDir();
          try {
            const cached = SynthesisResult.parse(JSON.parse(await readFile(path, 'utf8')));
            onLookup?.(true, request.text);
            // The stored timings describe the synthesis that happened once,
            // possibly days ago. Reporting them now would put a 950 ms Sarvam
            // call in the trace of a turn that only read a file — the exact
            // measurement mistake this field exists to prevent.
            return {
              hit: true as const,
              value: {
                ...cached,
                durationMs: Math.round(performance.now() - startedAt),
                timings: { requestMs: 0, transformMs: 0, cached: true },
              },
            };
          } catch {
            // Absent, unreadable or written by an older schema — all mean miss.
            onLookup?.(false, request.text);
            return { hit: false as const, value: null };
          }
        })(),
        'phrase_cache_read_failed',
      ).andThen((lookup) => {
        if (lookup.hit) return okAsync(lookup.value);
        return provider.synthesize(request).andThen((result) =>
          fromPromise(
            writeFile(path, JSON.stringify(result), 'utf8')
              .then(() => result)
              // A cache that cannot write must not break speech.
              .catch(() => result),
            'phrase_cache_write_failed',
          ),
        );
      });
    },
  };
}
