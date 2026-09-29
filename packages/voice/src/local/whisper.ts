import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SerialQueue } from './serialise.js';
import { appError, fromPromise, okAsync, type AppResultAsync } from '@assistant/core';
import {
  type LanguageCode,
  ProviderStatus,
  TranscriptionResult,
  type TranscriptionRequest,
} from '@assistant/schemas';
import type { SpeechToTextProvider } from '../types.js';

const run = promisify(execFile);

/**
 * Speech recognition using whisper.cpp, entirely on-device.
 *
 * This exists so Assistant can hear without an API key and without any audio
 * leaving the machine. It also removes the need for a separate wake-word
 * engine: voice activity detection already gates capture to actual speech, so
 * the transcript itself can be checked for the wake phrase.
 *
 * Model size is not a detail here. Measured on this machine against the same
 * three utterances:
 *
 *   base   English perfect; Hindi came back in Urdu script; Telugu in Tamil.
 *   small  English perfect; Hindi correct; Telugu collapsed into repeated
 *          garbage characters.
 *
 * Small multilingual models confuse related Indic languages, so anything below
 * large is unusable for this assistant regardless of how fast it is.
 */

/** Maps whisper's ISO-639-1 output to the app's language codes. */
const WHISPER_TO_LANGUAGE: Readonly<Record<string, LanguageCode>> = {
  en: 'en-IN',
  hi: 'hi-IN',
  bn: 'bn-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  mr: 'mr-IN',
  or: 'od-IN',
  pa: 'pa-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};

/**
 * whisper-server reports `"language":"english"` where whisper-cli's JSON
 * reports `"en"`. Same engine, different field, so the server path needs this
 * extra hop before WHISPER_TO_LANGUAGE can be applied.
 */
const WHISPER_NAME_TO_ISO: Readonly<Record<string, string>> = {
  english: 'en',
  hindi: 'hi',
  bengali: 'bn',
  gujarati: 'gu',
  kannada: 'kn',
  malayalam: 'ml',
  marathi: 'mr',
  oriya: 'or',
  odia: 'or',
  punjabi: 'pa',
  tamil: 'ta',
  telugu: 'te',
};

export interface WhisperOptions {
  /** Path to a ggml model file. */
  modelPath: string;
  /** Binary name; Homebrew installs `whisper-cli`. */
  binary?: string;
  /** Threads to use. Defaults to a sensible share of the machine. */
  threads?: number;
  timeoutMs?: number;
  /**
   * A resident whisper-server to use instead of spawning the CLI.
   *
   * Measured on this machine, 2026-09-06, alternating runs
   * against the same 2.1 s clip, same model, same thread count:
   * **whisper-cli median 789 ms, whisper-server median 626 ms** — a ~165 ms
   * saving in steady state.
   *
   * The first figures taken for this were 2,076-2,502 ms for the CLI, which
   * would have made it a 1.5 s win. That was a cold Metal shader cache: once
   * macOS has cached the compiled library, repeated whisper-cli runs are far
   * cheaper. The server's real advantages are the steady 165 ms and that it
   * pays the cold compile **once at start-up** rather than on the first
   * utterance after any eviction, where the CLI costs ~2 s.
   *
   * Falls back to the CLI whenever the server does not answer, because a
   * slower reply is better than no reply.
   */
  serverUrl?: string;
}

export class WhisperSttProvider implements SpeechToTextProvider {
  readonly name = 'whisper-local' as const;
  readonly requiresNetwork = false;

  readonly #modelPath: string;
  readonly #binary: string;
  readonly #threads: number;
  readonly #timeoutMs: number;
  readonly #serverUrl: string | null;
  /** Set once the server has failed, so every later turn stops paying the probe. */
  #serverDown = false;

  /** One whisper-cli at a time; see SerialQueue for why. */
  readonly #queue = new SerialQueue();

  constructor(options: WhisperOptions) {
    this.#modelPath = options.modelPath;
    this.#binary = options.binary ?? 'whisper-cli';
    this.#threads = options.threads ?? 6;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#serverUrl = options.serverUrl?.replace(/\/$/, '') ?? null;
  }

  /**
   * `signal` abandons the run.
   *
   * Used by speculative transcription: a clip transcribed early on the guess
   * that the user has stopped talking is worthless the moment they carry on,
   * and leaving it in the queue would delay the real utterance behind it.
   * Aborting before the slot opens costs nothing at all; aborting mid-run
   * kills the whisper process rather than waiting out a result nobody wants.
   */
  transcribe(
    request: TranscriptionRequest,
    options: { signal?: AbortSignal } = {},
  ): AppResultAsync<TranscriptionResult> {
    const startedAt = performance.now();

    return fromPromise(
      this.#queue.run((signal) => this.#run(request, signal), options),
      'whisper_failed',
    ).map(({ text, language }) =>
      TranscriptionResult.parse({
        text,
        detectedLanguage: language,
        // whisper.cpp does not expose a usable confidence score in this mode.
        confidence: null,
        provider: 'whisper-local',
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
  }

  async #run(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; language: LanguageCode | null }> {
    if (this.#serverUrl !== null && !this.#serverDown) {
      let viaServer: { text: string; language: LanguageCode | null } | null = null;
      try {
        viaServer = await this.#runServer(request, signal);
      } catch (error) {
        // An abort is the caller changing its mind, not the server failing.
        // Falling through would both mark the server down for the rest of the
        // session and then run the CLI on a clip nobody wants any more.
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
      if (viaServer !== null) return viaServer;
      // One failure is enough to stop trying: the server is either up for the
      // session or it is not, and probing it per utterance would add the very
      // latency this exists to remove.
      this.#serverDown = true;
    }
    return this.#runCli(request, signal);
  }

  /** POSTs the clip to a resident whisper-server. Returns null if it cannot. */
  async #runServer(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; language: LanguageCode | null } | null> {
    const wav = Buffer.from(request.audio.data, 'base64');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    // verbose_json rather than json: the plain form omits the detected
    // language, and that language decides which voice answers.
    form.append('response_format', 'verbose_json');
    form.append('language', request.language === 'auto' ? 'auto' : request.language.slice(0, 2));
    if (request.translateToEnglish) form.append('translate', 'true');

    const response = await fetch(`${this.#serverUrl ?? ''}/inference`, {
      method: 'POST',
      body: form,
      // Both reasons to stop: the deadline, and the caller having given up.
      signal:
        signal === undefined
          ? AbortSignal.timeout(this.#timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const record = body as { text?: unknown; language?: unknown };
    if (typeof record.text !== 'string') return null;

    const name = typeof record.language === 'string' ? record.language.toLowerCase() : '';
    const iso = WHISPER_NAME_TO_ISO[name] ?? (name.length === 2 ? name : '');
    return {
      text: record.text.trim(),
      language: WHISPER_TO_LANGUAGE[iso] ?? null,
    };
  }

  async #runCli(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; language: LanguageCode | null }> {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-whisper-'));
    const wavPath = join(dir, 'utterance.wav');

    try {
      await writeFile(wavPath, Buffer.from(request.audio.data, 'base64'));

      const args = [
        '-m',
        this.#modelPath,
        '-f',
        wavPath,
        '-t',
        String(this.#threads),
        // JSON output carries the detected language, which the plain text
        // output does not — and that language decides the reply voice.
        '-oj',
        '-of',
        join(dir, 'out'),
        '-l',
        request.language === 'auto' ? 'auto' : request.language.slice(0, 2),
        '-np',
      ];
      if (request.translateToEnglish) args.push('-tr');

      // `signal` kills the child. A whisper process left running after its
      // result stopped mattering is 1.6 GB and a CPU core spent on nothing —
      // on this machine that is enough to page the language model out.
      await run(this.#binary, args, {
        timeout: this.#timeoutMs,
        ...(signal ? { signal } : {}),
      });

      const raw = await readFile(join(dir, 'out.json'), 'utf8');
      return parseWhisperJson(raw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  health(): AppResultAsync<ProviderStatus> {
    const base = { name: 'whisper-local' as const, lastCheckedAt: new Date().toISOString() };

    return fromPromise(
      (async () => {
        await access(this.#modelPath);
        await run(this.#binary, ['--help'], { timeout: 10_000 }).catch(() => undefined);
        return true;
      })(),
      'whisper_unavailable',
    )
      .map(() => ProviderStatus.parse({ ...base, available: true, error: null }))
      .orElse(() =>
        okAsync(
          ProviderStatus.parse({
            ...base,
            available: false,
            error: appError(
              'whisper_unavailable',
              `whisper.cpp or its model is missing (${this.#modelPath})`,
            ),
          }),
        ),
      );
  }
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: { text?: string }[];
}

export function parseWhisperJson(raw: string): { text: string; language: LanguageCode | null } {
  const parsed = JSON.parse(raw) as WhisperJson;

  const text = (parsed.transcription ?? [])
    .map((segment) => segment.text ?? '')
    .join('')
    .trim();

  const code = parsed.result?.language;
  const language = code ? (WHISPER_TO_LANGUAGE[code] ?? null) : null;

  return { text, language };
}
