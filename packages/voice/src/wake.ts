/**
 * Wake word detection over transcribed speech.
 *
 * There is no separate always-on classifier here. Voice activity detection
 * already gates capture to real speech, and whisper already transcribes it, so
 * the wake word is a check on the text rather than a second model listening in
 * parallel. That costs more CPU per utterance than a dedicated engine, but it
 * needs no API key, has no licence expiry, and reuses machinery that is
 * already correct.
 *
 * Matching has to be forgiving. Whisper renders the same two words as "Hey
 * Assistant", "hey asistant", "Hi Assistant", "hey, assistant!" and occasionally
 * "a assistant", and a user who has to say it exactly right will conclude the
 * feature is broken.
 */

/**
 * Spellings whisper actually produces for the name.
 *
 * Override with WAKE_WORD_VARIANTS (comma separated) to give the assistant a
 * different name without touching this file. Include the misrenderings whisper
 * produces for whatever name you choose, not just its correct spelling — the
 * transcript is what gets matched, and whisper rarely spells a name the way you
 * would.
 */
const DEFAULT_NAME_VARIANTS = ['assistant', 'asistant', 'assistent', 'assistante', 'sistant'];

const NAME_VARIANTS =
  typeof process !== 'undefined' && process.env?.WAKE_WORD_VARIANTS
    ? process.env.WAKE_WORD_VARIANTS.split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_NAME_VARIANTS;

/** Greetings that may precede the name. */
const GREETINGS = ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'a', 'ay', 'hay'];

export interface WakeResult {
  /** Whether the wake phrase was found. */
  readonly detected: boolean;
  /**
   * What the user said after the wake phrase, if anything. Empty means they
   * said only the wake word and are waiting to be acknowledged.
   */
  readonly command: string;
}

const NOT_DETECTED: WakeResult = { detected: false, command: '' };

/**
 * Looks for the wake phrase at the start of an utterance.
 *
 * Anchored to the beginning on purpose: matching anywhere would trigger on
 * "I was telling Assistant about it", and an assistant that interrupts when its
 * name comes up in conversation is worse than one that occasionally misses.
 */
export function detectWakeWord(transcript: string): WakeResult {
  const words = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return NOT_DETECTED;

  // "hey assistant ..." — greeting followed by the name.
  const [first, second] = words;
  if (first && second && GREETINGS.includes(first) && NAME_VARIANTS.includes(second)) {
    return { detected: true, command: rebuild(transcript, words.slice(2)) };
  }

  // Bare "assistant, ..." is also natural once the user is used to it.
  if (first && NAME_VARIANTS.includes(first)) {
    return { detected: true, command: rebuild(transcript, words.slice(1)) };
  }

  return NOT_DETECTED;
}

/**
 * Recovers the original casing and punctuation of the command.
 *
 * The match runs on a normalised copy, but the model should receive what the
 * user actually said — "Open Safari" reads better than "open safari".
 */
function rebuild(original: string, remainingWords: string[]): string {
  if (remainingWords.length === 0) return '';

  const firstWord = remainingWords[0];
  if (!firstWord) return '';

  // Find where the command starts in the untouched transcript.
  const index = original.toLowerCase().indexOf(firstWord);
  const command = index >= 0 ? original.slice(index) : remainingWords.join(' ');

  return command.replace(/^[\s,.:;!?-]+/, '').trim();
}

/**
 * How long Assistant stays awake after answering.
 *
 * Requiring the wake word for every follow-up makes conversation stilted —
 * "Hey Assistant, what's the weather" / "Hey Assistant, and tomorrow?" — so a short
 * window lets the next sentence through without it.
 */
export const FOLLOW_UP_WINDOW_MS = 15_000;

/**
 * Answering the consent card out loud.
 *
 * The card is the last thing between the model and something irreversible, and
 * until now the only way to answer it was a mouse — which is a strange demand
 * from an assistant you talk to across the room. Requested by the user on
 * 2026-09-03: "keep a voice command too... if I say allow, it should send".
 *
 * Deliberately not a model call. This decides whether an action happens, and
 * the one thing the PRD is absolute about is that the model cannot grant
 * itself permission. A fixed vocabulary matched on the *whole* utterance
 * cannot be talked into anything.
 *
 * Whole-utterance only, for the same reason the fast path is: "no, message
 * Rahul instead" contains "no" and is not an answer to the question. If it is
 * not plainly yes or plainly no, it is treated as a new request and the card
 * stays up.
 */
export type SpokenDecision = 'approve' | 'deny';

const APPROVE = new Set([
  'yes',
  'yeah',
  'yep',
  'yup',
  'ok',
  'okay',
  'allow',
  'allow it',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'go ahead',
  'do it',
  'send it',
  'send',
  'sure',
  'please do',
  'accept',
  // Hindi and Hinglish, spoken as often as the English here.
  'haan',
  'han',
  'haan karo',
  'kar do',
  'karo',
  'theek hai',
  'thik hai',
  'ha',
]);

const DENY = new Set([
  'no',
  'nope',
  'nah',
  'deny',
  'denied',
  'cancel',
  'cancel it',
  'stop',
  'reject',
  'do not',
  "don't",
  'dont',
  'never mind',
  'nevermind',
  'forget it',
  'leave it',
  'nahi',
  'nahin',
  'mat karo',
  'rehne do',
]);

/**
 * Returns null for anything that is not plainly one or the other — including
 * silence, a new request, or a sentence that merely contains "yes".
 */
export function matchSpokenDecision(transcript: string): SpokenDecision | null {
  const cleaned = transcript
    .toLowerCase()
    .replace(/[.,!?;:"'’]/g, '')
    .replace(/\b(assistant|hey assistant|please)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return null;
  if (APPROVE.has(cleaned)) return 'approve';
  if (DENY.has(cleaned)) return 'deny';
  return null;
}
