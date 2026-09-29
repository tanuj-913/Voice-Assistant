import { appError, errAsync, fromPromise, okAsync, type AppResultAsync } from '@assistant/core';
import {
  ProviderStatus,
  SarvamTtsOptions,
  type SynthesisRequest,
  SynthesisResult,
} from '@assistant/schemas';
import { z } from 'zod';
import type { AssistantVoiceProfile } from '@assistant/schemas';
import { renderPhrases } from '../assistant.js';
import { DEFAULT_PROSODY, toPhrases, type ProsodyProfile } from '../prosody.js';
import type { TextToSpeechProvider } from '../types.js';
import { missingKeyError, type SarvamClient, SarvamRequestId } from './client.js';

/** Bulbul returns one base64 WAV per input chunk. */
const SarvamTtsResponse = z.object({
  request_id: SarvamRequestId,
  audios: z.array(z.string()).min(1),
});

export interface SarvamTtsProviderOptions {
  client: SarvamClient | null;
  defaults?: Partial<z.input<typeof SarvamTtsOptions>>;
  /** Applied after synthesis to give Sarvam's voice its cartoon character. */
  transform?: (audio: Buffer) => Promise<Buffer>;
  /**
   * Per-phrase delivery. When set, the reply is split and each phrase is
   * synthesised and pitched separately, which is what makes it sound like a
   * character rather than a voice with a filter on it.
   */
  prosody?: ProsodyProfile | null;
  assistant?: AssistantVoiceProfile;
}

export class SarvamTtsProvider implements TextToSpeechProvider {
  readonly name = 'sarvam' as const;
  readonly requiresNetwork = true;

  readonly #client: SarvamClient | null;
  readonly #defaults: Partial<z.input<typeof SarvamTtsOptions>>;
  readonly #transform: ((audio: Buffer) => Promise<Buffer>) | undefined;
  readonly #prosody: ProsodyProfile | null;
  readonly #assistant: AssistantVoiceProfile | undefined;

  constructor(options: SarvamTtsProviderOptions) {
    this.#client = options.client;
    this.#defaults = options.defaults ?? {};
    this.#transform = options.transform;
    this.#prosody = options.prosody === undefined ? DEFAULT_PROSODY : options.prosody;
    this.#assistant = options.assistant;
  }

  synthesize(request: SynthesisRequest): AppResultAsync<SynthesisResult> {
    const client = this.#client;
    if (!client) return errAsync(missingKeyError());

    const startedAt = performance.now();

    const optionsParsed = SarvamTtsOptions.safeParse({
      ...this.#defaults,
      targetLanguageCode: request.language,
    });
    if (!optionsParsed.success) {
      return errAsync(
        appError('sarvam_tts_options_invalid', optionsParsed.error.issues[0]?.message ?? 'invalid'),
      );
    }
    const options = optionsParsed.data;
    const profile = request.assistant ?? this.#assistant;
    const phrases = this.#prosody ? toPhrases(request.text, this.#prosody) : [];

    // Single-pass path: no prosody configured, or nothing to split.
    if (phrases.length < 2 || !profile?.enabled) {
      return this.#speakOnce(client, request.text, options, startedAt);
    }

    return fromPromise(
      (async () => {
        // Synthesised concurrently. Sequential calls would multiply latency by
        // the number of phrases, which is exactly the wrong trade for speech.
        const requestStarted = performance.now();
        const clips = await Promise.all(
          phrases.map(async (phrase) => {
            const wav = await this.#requestAudio(client, phrase.text, {
              ...options,
              pace: phrase.pace,
            });
            return { wav, pitch: phrase.pitch };
          }),
        );
        // Wall time, not summed: the requests overlap, and the caller waits for
        // the slowest, not the total.
        const requestMs = performance.now() - requestStarted;

        const transformStarted = performance.now();
        const audio = await renderPhrases(clips, profile);
        return { audio, requestMs, transformMs: performance.now() - transformStarted };
      })(),
      'sarvam_prosody_failed',
      { retryable: true },
    ).map(({ audio, requestMs, transformMs }) =>
      SynthesisResult.parse({
        audio: {
          data: audio.toString('base64'),
          sampleRate: options.speechSampleRate,
          channels: 1,
          encoding: 'wav',
        },
        provider: 'sarvam',
        durationMs: Math.round(performance.now() - startedAt),
        timings: {
          requestMs: Math.round(requestMs),
          transformMs: Math.round(transformMs),
          cached: false,
        },
      }),
    );
  }

  /** One request, one clip — used when there is nothing to shape. */
  #speakOnce(
    client: SarvamClient,
    text: string,
    options: z.output<typeof SarvamTtsOptions>,
    startedAt: number,
  ): AppResultAsync<SynthesisResult> {
    // Captured between the two stages rather than measured inside each, because
    // the transform only starts once the request has resolved.
    let requestMs = 0;

    return fromPromise(this.#requestAudio(client, text, options), 'sarvam_request_failed', {
      retryable: true,
    })
      .andThen((raw) => {
        requestMs = performance.now() - startedAt;
        const transform = this.#transform;
        return transform ? fromPromise(transform(raw), 'assistant_transform_failed') : okAsync(raw);
      })
      .map((audio) =>
        SynthesisResult.parse({
          audio: {
            data: audio.toString('base64'),
            sampleRate: options.speechSampleRate,
            channels: 1,
            encoding: 'wav',
          },
          provider: 'sarvam',
          durationMs: Math.round(performance.now() - startedAt),
          timings: {
            requestMs: Math.round(requestMs),
            // Everything after the request resolved: the voice conversion, or
            // nothing at all when no transform is configured.
            transformMs: Math.round(performance.now() - startedAt - requestMs),
            cached: false,
          },
        }),
      );
  }

  async #requestAudio(
    client: SarvamClient,
    text: string,
    options: z.output<typeof SarvamTtsOptions>,
  ): Promise<Buffer> {
    const result = await client.postJson(
      '/text-to-speech',
      {
        text,
        target_language_code: options.targetLanguageCode,
        speaker: options.speaker,
        pace: options.pace,
        speech_sample_rate: options.speechSampleRate,
        enable_preprocessing: options.enablePreprocessing,
        model: options.model,
      },
      SarvamTtsResponse,
    );

    if (result.isErr()) throw new Error(result.error.message);
    const first = result.value.audios[0];
    if (first === undefined) throw new Error('Sarvam returned no audio');
    return Buffer.from(first, 'base64');
  }

  health(): AppResultAsync<ProviderStatus> {
    const base = { name: 'sarvam' as const, lastCheckedAt: new Date().toISOString() };
    if (!this.#client) {
      return okAsync(ProviderStatus.parse({ ...base, available: false, error: missingKeyError() }));
    }
    return okAsync(ProviderStatus.parse({ ...base, available: true, error: null }));
  }
}
