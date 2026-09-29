import { appError, fromPromise, parseWith, type AppResultAsync } from '@assistant/core';
import { z } from 'zod';

/**
 * Thin Sarvam HTTP client.
 *
 * Responses are Zod-parsed rather than cast, so an API shape change surfaces
 * as a clear validation error at the boundary instead of `undefined` reaching
 * the audio pipeline.
 */
export interface SarvamClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export class SarvamClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: SarvamClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl.replace(/\/$/, '');
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  postJson<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
  ): AppResultAsync<z.output<S>> {
    return this.#send(path, schema, {
      method: 'POST',
      headers: {
        'api-subscription-key': this.#apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  postForm<S extends z.ZodType>(
    path: string,
    form: FormData,
    schema: S,
  ): AppResultAsync<z.output<S>> {
    return this.#send(path, schema, {
      method: 'POST',
      // Content-Type is omitted deliberately: fetch must set the multipart
      // boundary itself.
      headers: { 'api-subscription-key': this.#apiKey },
      body: form,
    });
  }

  #send<S extends z.ZodType>(
    path: string,
    schema: S,
    init: RequestInit,
  ): AppResultAsync<z.output<S>> {
    const url = `${this.#baseUrl}${path}`;

    return fromPromise(
      (async () => {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `Sarvam ${path} responded ${String(response.status)}: ${detail.slice(0, 300)}`,
          );
        }
        return await response.json();
      })(),
      'sarvam_request_failed',
      // 5xx and timeouts are worth retrying; 4xx is a bug in our request.
      { retryable: true },
    ).andThen((json) => parseWith(schema, json, 'sarvam_response_invalid'));
  }
}

/** Sarvam echoes a request id on every response; useful for support tickets. */
export const SarvamRequestId = z.string().nullish();

export function missingKeyError() {
  return appError('sarvam_key_missing', 'SARVAM_API_KEY is not configured', { retryable: false });
}
