import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { childLogger } from '@assistant/core';
import type { LanguageCode, AssistantVoiceProfile } from '@assistant/schemas';
import {
  applyAssistantVoice,
  checkAssistantVoiceTooling,
  checkRvcServer,
  createRvcTransform,
  withPhraseCache,
  SarvamClient,
  SarvamSttProvider,
  SarvamTtsProvider,
  SayTtsProvider,
  WhisperSttProvider,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
} from '@assistant/voice';
import type { Env } from '@assistant/schemas';

const log = childLogger('voice');

/**
 * Short-lived store for synthesised speech.
 *
 * The UI fetches each clip once, immediately, then it is dropped. Keeping the
 * audio out of the event stream keeps that stream small and ordered.
 */
export class SpeechStore {
  readonly #clips = new Map<string, { wav: Buffer; createdAt: number }>();
  readonly #ttlMs = 120_000;

  put(wav: Buffer): string {
    this.#evictExpired();
    const id = randomUUID();
    this.#clips.set(id, { wav, createdAt: Date.now() });
    return id;
  }

  /**
   * Returns a clip, leaving it in place until it expires.
   *
   * Originally this deleted on first read, which broke the moment two clients
   * were listening: whichever fetched first got the audio and everyone else
   * got a 404. That is not a hypothetical — an open browser tab and a second
   * client is the normal case during development, and a reconnecting tab
   * re-requesting its clip would have hit it too. The TTL already bounds
   * memory, so single-use bought nothing.
   */
  get(id: string): Buffer | undefined {
    this.#evictExpired();
    return this.#clips.get(id)?.wav;
  }

  #evictExpired(): void {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [id, clip] of this.#clips) {
      if (clip.createdAt < cutoff) this.#clips.delete(id);
    }
  }
}

export interface VoiceStack {
  /**
   * Small, fast recogniser used only for live partial transcripts. Null when
   * its model is absent — partials then simply do not appear, which degrades
   * the feedback rather than the assistant.
   */
  partialStt: WhisperSttProvider | null;
  /** Null only when neither whisper nor Sarvam is available. */
  stt: SpeechToTextProvider | null;
  /** Never null — `say` guarantees Assistant can always speak. */
  tts: TextToSpeechProvider;
  speech: SpeechStore;
  /** Whether Sarvam is configured, i.e. whether voice *input* works. */
  configured: boolean;
  ttsProvider: 'sarvam' | 'macos-say';
  sttProvider: 'whisper-local' | 'sarvam' | null;
}

export async function buildVoiceStack(
  config: Env,
  assistantProfile: AssistantVoiceProfile,
): Promise<VoiceStack> {
  const speech = new SpeechStore();

  // Check the transform binaries once at boot rather than failing mid-sentence.
  const tooling = await checkAssistantVoiceTooling();
  if (!tooling.rubberband || !tooling.ffmpeg) {
    log.warn(
      { tooling },
      'rubberband or ffmpeg missing — Assistant voice transform disabled, using the plain voice',
    );
  }
  const canTransform = tooling.rubberband && tooling.ffmpeg;

  // Voice conversion, when the trained model is being served. Probed here for
  // the same reason as the binaries above: a missing converter should be a
  // line in the boot log, not a surprise in the middle of a sentence.
  const rvc = config.RVC_ENABLED
    ? // Started concurrently with the brain, so give it time to warm rather
      // than demoting the session on a race it was always going to lose.
      await checkRvcServer(config.RVC_BASE_URL, fetch, { attempts: 20, delayMs: 1000 })
    : { available: false, model: null };
  if (config.RVC_ENABLED && !rvc.available) {
    log.warn(
      { endpoint: config.RVC_BASE_URL },
      'RVC_ENABLED but no converter is listening — falling back to the pitch-shifted voice',
    );
  } else if (rvc.available) {
    log.info({ model: rvc.model, indexRate: config.RVC_INDEX_RATE }, 'voice conversion on');
  }

  // Conversion replaces the pitch shift rather than stacking on it: a
  // formant-shifted cartoon voice is a poor thing to convert, and the trained
  // voice is the point.
  const profile =
    canTransform && !rvc.available ? assistantProfile : { ...assistantProfile, enabled: false };

  const transform = rvc.available
    ? createRvcTransform({
        endpoint: config.RVC_BASE_URL,
        indexRate: config.RVC_INDEX_RATE,
        onFallback: (reason) => {
          log.warn({ reason }, 'voice conversion skipped, speaking the unconverted clip');
        },
      })
    : profile.enabled
      ? (audio: Buffer) => applyAssistantVoice(audio, profile)
      : null;

  // Always available: no key, no network, no model download. Speech should not
  // be something you have to sign up for.
  const localTts = new SayTtsProvider({ assistant: profile });

  // On-device speech recognition. Preferred by default: no key, and no audio
  // leaves the machine.
  const whisper = new WhisperSttProvider({
    modelPath: config.WHISPER_MODEL_PATH,
    binary: config.WHISPER_BINARY,
    ...(config.WHISPER_SERVER_ENABLED ? { serverUrl: config.WHISPER_SERVER_URL } : {}),
  });
  const whisperHealth = await whisper.health();
  const whisperReady = whisperHealth.isOk() && whisperHealth.value.available;

  const fast = new WhisperSttProvider({
    modelPath: config.WHISPER_FAST_MODEL_PATH,
    binary: config.WHISPER_BINARY,
    // Partials must not queue up behind each other; a slow one is worthless
    // because a newer snapshot has already superseded it.
    timeoutMs: 8_000,
  });
  const fastHealth = await fast.health();
  const partialStt = fastHealth.isOk() && fastHealth.value.available ? fast : null;
  if (!partialStt) {
    log.warn(
      { model: config.WHISPER_FAST_MODEL_PATH },
      'no fast whisper model — live partial transcripts disabled',
    );
  }

  const preferLocal =
    config.STT_PROVIDER === 'local' ||
    (config.STT_PROVIDER === 'auto' && whisperReady) ||
    !config.SARVAM_API_KEY;

  if (!config.SARVAM_API_KEY) {
    if (whisperReady) {
      log.info({ model: config.WHISPER_MODEL_PATH }, 'speech recognition: on-device whisper');
    } else {
      log.warn('No speech recognition available — whisper model missing and SARVAM_API_KEY unset');
    }
    return {
      stt: whisperReady ? whisper : null,
      partialStt,
      tts: localTts,
      speech,
      configured: whisperReady,
      ttsProvider: 'macos-say',
      sttProvider: whisperReady ? 'whisper-local' : null,
    };
  }

  const client = new SarvamClient({
    apiKey: config.SARVAM_API_KEY,
    baseUrl: config.SARVAM_BASE_URL,
  });

  const stt = preferLocal && whisperReady ? whisper : new SarvamSttProvider({ client });
  log.info({ stt: stt.name, tts: 'sarvam' }, 'speech recognition and synthesis ready');

  const sarvamTts = new SarvamTtsProvider({
    client,
    // Per-phrase delivery: each sentence gets its own pace and pitch so the
    // reply has a contour instead of one flat shift.
    assistant: profile,
    ...(transform ? { transform } : {}),
  });

  /**
   * Most of what Assistant says is a fixed sentence from a tool renderer —
   * "Paused.", "Volume set to 40 percent." — and each one otherwise costs a
   * network round trip plus a voice conversion. The variant key carries
   * everything that changes how the voice sounds, so switching checkpoint,
   * index rate or pitch invalidates the cache instead of silently serving the
   * old voice.
   */
  const variant = rvc.available
    ? `rvc:${rvc.model ?? 'unknown'}:idx${String(config.RVC_INDEX_RATE)}`
    : `shift:${profile.enabled ? String(profile.pitchShiftSemitones) : 'off'}`;

  return {
    stt,
    partialStt,
    sttProvider: stt.name === 'whisper-local' ? 'whisper-local' : 'sarvam',
    tts: withPhraseCache(sarvamTts, {
      dir: join(process.cwd(), '.cache', 'speech'),
      variant,
      onLookup: (hit, text) => {
        if (hit) log.info({ chars: text.length }, 'speech served from cache');
      },
    }),
    speech,
    configured: true,
    ttsProvider: 'sarvam',
  };
}

export type { LanguageCode };
