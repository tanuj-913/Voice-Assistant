import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appError, fromPromise, okAsync, type AppResultAsync } from '@assistant/core';
import {
  ProviderStatus,
  SynthesisResult,
  type LanguageCode,
  type AssistantVoiceProfile,
  type SynthesisRequest,
} from '@assistant/schemas';
import { applyAssistantVoice } from '../assistant.js';
import { detectSpeechLocale } from '../language.js';
import { VoiceCatalogue } from './catalogue.js';
import type { TextToSpeechProvider } from '../types.js';

const run = promisify(execFile);

/**
 * Text to speech using the macOS `say` binary.
 *
 * Exists so Assistant has a voice with no API key, no network, and no model
 * download — speech should not be a feature you have to sign up for. Sarvam
 * sounds considerably better and covers all eleven languages, so it takes
 * precedence whenever a key is configured.
 */

export interface SayTtsOptions {
  assistant?: AssistantVoiceProfile;
  /** Words per minute. macOS default is ~175; slightly quicker suits a cartoon. */
  rate?: number;
}

export class SayTtsProvider implements TextToSpeechProvider {
  readonly name = 'macos-say' as const;
  readonly requiresNetwork = false;

  readonly #assistant: AssistantVoiceProfile | undefined;
  readonly #rate: number;
  #catalogue: VoiceCatalogue | null = null;

  constructor(options: SayTtsOptions = {}) {
    this.#assistant = options.assistant;
    this.#rate = options.rate ?? 190;
  }

  synthesize(request: SynthesisRequest): AppResultAsync<SynthesisResult> {
    const startedAt = performance.now();

    return fromPromise(this.#speak(request), 'say_synthesis_failed').map((wav) =>
      SynthesisResult.parse({
        audio: {
          data: wav.toString('base64'),
          sampleRate: 22050,
          channels: 1,
          encoding: 'wav',
        },
        provider: 'macos-say',
        durationMs: Math.round(performance.now() - startedAt),
        // `say` shells out and pitch-shifts in one pass, so there is no honest
        // request/transform split to report — null says that rather than
        // attributing the whole cost to one of them.
        timings: null,
      }),
    );
  }

  async #speak(request: SynthesisRequest): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-say-'));
    const rawPath = join(dir, 'raw.wav');

    try {
      const voice = await this.#resolveVoice(request.text, request.language);

      await run(
        'say',
        [
          '-v',
          voice,
          '-r',
          String(this.#rate),
          '-o',
          rawPath,
          // LEI16 gives a plain 16-bit PCM WAV rather than the default AIFF,
          // so it can go straight into rubberband and out to the browser.
          '--data-format=LEI16@22050',
          // `--` stops flag parsing: text starting with `-` must not become an
          // option, and this text comes from a language model.
          '--',
          request.text,
        ],
        { timeout: 30_000 },
      );

      const raw = await readFile(rawPath);
      const profile = request.assistant ?? this.#assistant;
      if (!profile?.enabled) return raw;

      return await applyAssistantVoice(raw, profile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Picks the voice by looking at the text Assistant is about to say.
   *
   * The `language` on the request is only a hint — it reflects what Sarvam
   * heard, which is limited to Indian languages. If the user asks "how do you
   * say hello in Spanish" and Assistant answers in Spanish, the Spanish voice
   * should read it, and no amount of hinting from the input side knows that.
   */
  async #resolveVoice(text: string, hint: LanguageCode): Promise<string> {
    this.#catalogue ??= await VoiceCatalogue.load();

    const detected = detectSpeechLocale(text, hint.replace('-', '_'));
    const voice = this.#catalogue.resolve(detected.locale);
    if (voice) return voice.name;

    // No voice for that language on this machine. Indian English is the least
    // wrong option: it will mispronounce, but it will still speak.
    return this.#catalogue.resolve('en_IN')?.name ?? 'Samantha';
  }

  /** Languages this machine can actually speak. */
  async supportedLocales(): Promise<string[]> {
    this.#catalogue ??= await VoiceCatalogue.load();
    return this.#catalogue.locales;
  }

  health(): AppResultAsync<ProviderStatus> {
    return fromPromise(VoiceCatalogue.load(), 'say_unavailable')
      .map((catalogue) =>
        ProviderStatus.parse({
          name: 'macos-say',
          available: catalogue.size > 0,
          lastCheckedAt: new Date().toISOString(),
          error: null,
        }),
      )
      .orElse(() =>
        okAsync(
          ProviderStatus.parse({
            name: 'macos-say',
            available: false,
            lastCheckedAt: new Date().toISOString(),
            error: appError('say_unavailable', 'The macOS `say` command is not available'),
          }),
        ),
      );
  }
}
