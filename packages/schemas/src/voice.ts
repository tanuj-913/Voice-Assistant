import { z } from 'zod';
import { AppError, LanguageCode, LanguageSelection, PcmAudio } from './common.js';

/**
 * Sarvam contracts.
 *
 * NOTE: parameter ranges below mirror Sarvam's published limits at time of
 * writing. They are enforced client-side so a bad value fails locally with a
 * useful message instead of as an opaque 400 from the API.
 */

// `saarika:v2` is deprecated; `saaras:v3-realtime` supports streaming.
export const SarvamSttModel = z.enum(['saarika:v2.5', 'saaras:v3', 'saaras:v3-realtime']);
export type SarvamSttModel = z.infer<typeof SarvamSttModel>;

// bulbul:v2 was deprecated and now returns HTTP 400.
export const SarvamTtsModel = z.enum(['bulbul:v3']);
export type SarvamTtsModel = z.infer<typeof SarvamTtsModel>;

/**
 * Bulbul v3 speakers. The v2 names (anushka, manisha, vidya…) are rejected
 * outright by v3, so this list is not merely a preference — using the old
 * names fails the request with HTTP 400 and Assistant silently loses its voice.
 */
export const SarvamSpeaker = z.enum([
  'priya',
  'ritu',
  'neha',
  'pooja',
  'simran',
  'kavya',
  'ishita',
  'shreya',
  'roopa',
  'tanya',
  'aditya',
  'ashutosh',
  'rahul',
  'rohan',
  'amit',
  'dev',
  'ratan',
  'varun',
  'manan',
  'sumit',
  'kabir',
  'aayan',
  'shubh',
  'advait',
  'anand',
  'tarun',
]);
export type SarvamSpeaker = z.infer<typeof SarvamSpeaker>;

export const SarvamTtsOptions = z.object({
  model: SarvamTtsModel.default('bulbul:v3'),
  speaker: SarvamSpeaker.default('priya'),
  targetLanguageCode: LanguageCode,
  /**
   * Below 1 is slower, above 1 is faster.
   *
   * `pitch` and `loudness` are deliberately absent: bulbul:v3 rejects both
   * with HTTP 400, and sending them silently breaks all speech. Nothing is
   * lost — the Assistant voice comes from the rubberband shift applied after
   * synthesis, not from Sarvam.
   */
  pace: z.number().min(0.3).max(3).default(1),
  speechSampleRate: z.union([z.literal(8000), z.literal(16000), z.literal(22050)]).default(22050),
  /** Sarvam normalises code-mixed English numerals/entities when enabled. */
  enablePreprocessing: z.boolean().default(true),
});
export type SarvamTtsOptions = z.infer<typeof SarvamTtsOptions>;

/**
 * The Assistant layer. Sarvam gives us a clean, natural voice; this is the
 * post-processing that turns it cartoonish.
 *
 * Deliberately a formant-preserving pitch shift over a normal TTS voice
 * rather than a clone of any copyrighted character performance.
 */
export const AssistantVoiceProfile = z.object({
  enabled: z.boolean().default(true),
  /** Semitones up. ~5-7 reads as "cartoon mouse" without going full chipmunk. */
  pitchShiftSemitones: z.number().min(0).max(12).default(6),
  /**
   * When false, formants scale with pitch — the spectrum shifts as a whole, so
   * the speaker sounds physically smaller. That is what makes a cartoon voice
   * read as a small character rather than an adult singing higher, so it is
   * the default here.
   */
  preserveFormants: z.boolean().default(false),
  /** Above 1 speeds delivery up. Adds energy; 1.0 keeps Sarvam's timing. */
  tempoRatio: z.number().min(0.7).max(1.5).default(1.06),
  /** Brightness lift in dB around 4kHz, for presence. */
  presenceBoostDb: z.number().min(0).max(9).default(3),
});
export type AssistantVoiceProfile = z.infer<typeof AssistantVoiceProfile>;

export const TranscriptionRequest = z.object({
  audio: PcmAudio,
  language: LanguageSelection.default('auto'),
  /** Translate to English as part of transcription (Sarvam STT-translate). */
  translateToEnglish: z.boolean().default(false),
});
export type TranscriptionRequest = z.infer<typeof TranscriptionRequest>;

export const TranscriptionResult = z.object({
  text: z.string(),
  detectedLanguage: LanguageCode.nullable(),
  /** Null when the provider does not report confidence. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  provider: z.enum(['sarvam', 'whisper-local']),
  durationMs: z.number().nonnegative(),
});
export type TranscriptionResult = z.infer<typeof TranscriptionResult>;

export const SynthesisRequest = z.object({
  text: z.string().min(1).max(2500),
  language: LanguageCode.default('en-IN'),
  assistant: AssistantVoiceProfile.optional(),
});
export type SynthesisRequest = z.infer<typeof SynthesisRequest>;

/**
 * Where the time inside one synthesis actually went.
 *
 * `durationMs` alone says a clip took 1.8s without saying whether that was the
 * network or the voice conversion — and those have completely different fixes.
 * Splitting them is the difference between "move TTS local" and "give RVC more
 * headroom".
 */
export const SynthesisTimings = z.object({
  /** Time in the provider's own request(s) — the network, for Sarvam. */
  requestMs: z.number().nonnegative(),
  /** Time converting the clip into Assistant's voice. 0 when no transform is configured. */
  transformMs: z.number().nonnegative(),
  /** True when the audio came from the phrase cache and nothing was synthesised. */
  cached: z.boolean(),
});
export type SynthesisTimings = z.infer<typeof SynthesisTimings>;

export const SynthesisResult = z.object({
  audio: PcmAudio,
  provider: z.enum(['sarvam', 'macos-say']),
  durationMs: z.number().nonnegative(),
  /**
   * Nullable rather than required: clips cached before this field existed
   * still parse, and a provider that cannot break its own time down should say
   * so rather than invent a split.
   */
  timings: SynthesisTimings.nullable().default(null),
});
export type SynthesisResult = z.infer<typeof SynthesisResult>;

/** Provider health, so the brain can decide online vs offline per call. */
export const ProviderStatus = z.object({
  name: z.enum(['sarvam', 'whisper-local', 'macos-say', 'ollama']),
  available: z.boolean(),
  lastCheckedAt: z.iso.datetime({ offset: true }),
  error: AppError.nullable().default(null),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const WakeWordEvent = z.object({
  keyword: z.literal('hey-assistant'),
  confidence: z.number().min(0).max(1),
  detectedAt: z.iso.datetime({ offset: true }),
});
export type WakeWordEvent = z.infer<typeof WakeWordEvent>;
