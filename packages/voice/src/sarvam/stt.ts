import { errAsync, okAsync, type AppResultAsync } from '@assistant/core';
import {
  LanguageCode,
  ProviderStatus,
  type TranscriptionRequest,
  TranscriptionResult,
} from '@assistant/schemas';
import { z } from 'zod';
import type { SpeechToTextProvider } from '../types.js';
import { missingKeyError, type SarvamClient, SarvamRequestId } from './client.js';

/** Saarika response. `language_code` is absent when detection is disabled. */
const SarvamSttResponse = z.object({
  request_id: SarvamRequestId,
  transcript: z.string(),
  language_code: z.string().nullish(),
});

export interface SarvamSttOptions {
  client: SarvamClient | null;
  model?: 'saarika:v2.5' | 'saaras:v3' | 'saaras:v3-realtime';
}

export class SarvamSttProvider implements SpeechToTextProvider {
  readonly name = 'sarvam' as const;
  readonly requiresNetwork = true;

  readonly #client: SarvamClient | null;
  readonly #model: string;

  constructor(options: SarvamSttOptions) {
    this.#client = options.client;
    this.#model = options.model ?? 'saarika:v2.5';
  }

  transcribe(request: TranscriptionRequest): AppResultAsync<TranscriptionResult> {
    const client = this.#client;
    if (!client) return errAsync(missingKeyError());

    const startedAt = performance.now();
    const form = new FormData();

    const bytes = Buffer.from(request.audio.data, 'base64');
    form.append(
      'file',
      new Blob([bytes], { type: request.audio.encoding === 'wav' ? 'audio/wav' : 'audio/L16' }),
      'utterance.wav',
    );
    form.append('model', this.#model);
    // 'unknown' is Sarvam's opt-in language auto-detection.
    form.append('language_code', request.language === 'auto' ? 'unknown' : request.language);

    const endpoint = request.translateToEnglish ? '/speech-to-text-translate' : '/speech-to-text';

    return client.postForm(endpoint, form, SarvamSttResponse).map((response) => {
      const detected = LanguageCode.safeParse(response.language_code);
      return TranscriptionResult.parse({
        text: response.transcript,
        detectedLanguage: detected.success ? detected.data : null,
        // Saarika does not return a confidence score.
        confidence: null,
        provider: 'sarvam',
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  }

  health(): AppResultAsync<ProviderStatus> {
    const base = {
      name: 'sarvam' as const,
      lastCheckedAt: new Date().toISOString(),
    };
    if (!this.#client) {
      return okAsync(ProviderStatus.parse({ ...base, available: false, error: missingKeyError() }));
    }
    return okAsync(ProviderStatus.parse({ ...base, available: true, error: null }));
  }
}
