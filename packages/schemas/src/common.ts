import { z } from 'zod';

/**
 * Branded ID types. Prevents passing a ConversationId where a MessageId is
 * expected — a class of bug that string-typed IDs make invisible.
 */
// The type parameter appears only in the return type, which is the whole
// point: it is what makes ConversationId and MessageId incompatible.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const brandedId = <B extends string>() => z.uuid().brand<B>();

export const ConversationId = brandedId<'ConversationId'>();
export const MessageId = brandedId<'MessageId'>();
export const ToolCallId = brandedId<'ToolCallId'>();
export const TurnId = brandedId<'TurnId'>();

export type ConversationId = z.infer<typeof ConversationId>;
export type MessageId = z.infer<typeof MessageId>;
export type ToolCallId = z.infer<typeof ToolCallId>;
export type TurnId = z.infer<typeof TurnId>;

/**
 * Languages Sarvam supports, as BCP-47 codes. `en-IN` is included because
 * Indian English is a distinct acoustic model from `en-US`.
 */
export const LanguageCode = z.enum([
  'en-IN',
  'hi-IN',
  'bn-IN',
  'gu-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN',
]);
export type LanguageCode = z.infer<typeof LanguageCode>;

export const LANGUAGE_LABELS: Readonly<Record<LanguageCode, string>> = Object.freeze({
  'en-IN': 'English',
  'hi-IN': 'हिन्दी',
  'bn-IN': 'বাংলা',
  'gu-IN': 'ગુજરાતી',
  'kn-IN': 'ಕನ್ನಡ',
  'ml-IN': 'മലയാളം',
  'mr-IN': 'मराठी',
  'od-IN': 'ଓଡ଼ିଆ',
  'pa-IN': 'ਪੰਜਾਬੀ',
  'ta-IN': 'தமிழ்',
  'te-IN': 'తెలుగు',
});

/** `auto` lets Sarvam detect the language rather than us asserting one. */
export const LanguageSelection = z.union([z.literal('auto'), LanguageCode]);
export type LanguageSelection = z.infer<typeof LanguageSelection>;

export const Timestamp = z.iso.datetime({ offset: true });
export type Timestamp = z.infer<typeof Timestamp>;

/**
 * Serializable error shape. Errors cross process boundaries (brain -> UI,
 * tool -> brain) so they cannot be Error instances.
 */
export const AppError = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  /** Whether retrying the same operation could plausibly succeed. */
  retryable: z.boolean().default(false),
  cause: z.string().optional(),
});
export type AppError = z.infer<typeof AppError>;

export const PcmAudio = z.object({
  /** Base64-encoded PCM or WAV payload. */
  data: z.base64(),
  sampleRate: z.union([
    z.literal(8000),
    z.literal(16000),
    z.literal(22050),
    z.literal(24000),
    z.literal(44100),
  ]),
  channels: z.literal(1).describe('Mono only — all STT/TTS paths here are single-channel'),
  encoding: z.enum(['wav', 'pcm_s16le']),
});
export type PcmAudio = z.infer<typeof PcmAudio>;
