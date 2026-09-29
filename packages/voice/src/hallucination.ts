/**
 * Filters Whisper's hallucinations.
 *
 * Given silence, breathing, a cough or room noise, Whisper does not return an
 * empty string — it confidently returns a short, plausible phrase. The set is
 * remarkably consistent across users because these come from its training data,
 * which was heavily subtitled video: "Thank you.", "Thanks for watching!",
 * "Gracias.", "Obrigado.", music glyphs, subtitle credits.
 *
 * Observed live in this app: a single listening session produced "Obrigado",
 * "Gracias", "- Thank you.", "- Awesome.", "- Hi." and a line of Korean, none
 * of which were spoken. Each became a turn, and each new turn cancelled the
 * one before it, so the assistant spent the whole session aborting itself.
 *
 * The cost of a false negative here is a wasted LLM turn and a spoken reply to
 * something nobody said. The cost of a false positive is one ignored utterance
 * the user can simply repeat. That asymmetry justifies filtering aggressively.
 */

/** Phrases Whisper emits for non-speech, normalised to lowercase. */
const ARTIFACTS = new Set([
  'thank you',
  'thank you.',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'thank you very much',
  'thanks',
  'bye',
  'bye.',
  'you',
  'yeah',
  'okay',
  'ok',
  'hi',
  'hello',
  'oh',
  'uh',
  'um',
  'hmm',
  'mm',
  'awesome',
  'gracias',
  'obrigado',
  'obrigada',
  'merci',
  'danke',
  'grazie',
  'subtitles by the amara.org community',
  'subs by',
  'transcription by',
  'please subscribe',
  'like and subscribe',
  'see you next time',
  'the end',
  'to be continued',
  'applause',
  'music',
  'laughter',
]);

/**
 * Openings that begin a hallucinated pleasantry. Deliberately short and
 * high-signal: a genuine command almost never opens this way, and when it does
 * ("thanks, now open Safari") the user simply repeats it.
 */
const ARTIFACT_PREFIXES = [
  'thank you',
  'thanks for',
  'thanks so much',
  'subtitles by',
  'subtitled by',
  'transcribed by',
  'please subscribe',
];

/** Lines that are only punctuation, music glyphs or bracketed stage direction. */
const NON_LEXICAL = /^[\s.,!?;:\-–—_*"'`~♪♫()[\]{}]*$/u;
const BRACKETED = /^[([{][^)\]}]*[)\]}]$/u;

export interface UtteranceCheck {
  /** Whole-utterance duration, used to reject text that is too long for it. */
  durationMs: number;
}

export interface HallucinationVerdict {
  readonly isHallucination: boolean;
  readonly reason: string | null;
}

const ACCEPTED: HallucinationVerdict = { isHallucination: false, reason: null };

export function detectHallucination(
  transcript: string,
  { durationMs }: UtteranceCheck,
): HallucinationVerdict {
  const text = transcript.trim();

  if (text.length === 0) {
    return { isHallucination: true, reason: 'empty transcript' };
  }

  if (NON_LEXICAL.test(text) || BRACKETED.test(text)) {
    return { isHallucination: true, reason: 'no lexical content' };
  }

  // Strip leading subtitle dashes and trailing punctuation before matching.
  const normalised = text
    .toLowerCase()
    .replace(/^[-–—\s]+/, '')
    .replace(/[.!?…]+$/, '')
    .trim();

  if (ARTIFACTS.has(normalised)) {
    return { isHallucination: true, reason: `known artifact: "${normalised}"` };
  }

  // Matched as families rather than exact strings: Whisper produces endless
  // variations ("thank you", "thank you so much", "thanks for watching"), and
  // enumerating every one is a losing game. Density checks do not catch these
  // because the phrases are long enough to look plausible.
  if (ARTIFACT_PREFIXES.some((prefix) => normalised.startsWith(prefix))) {
    return { isHallucination: true, reason: `artifact family: "${normalised}"` };
  }

  // A real utterance produces roughly 8-25 characters per second of speech.
  // Far below that means Whisper filled silence with a stock phrase; far above
  // means it looped, which it also does on degenerate input.
  const seconds = durationMs / 1000;
  if (seconds >= 1) {
    const charsPerSecond = text.length / seconds;
    if (charsPerSecond < 2.2) {
      return {
        isHallucination: true,
        reason: `too little text for ${seconds.toFixed(1)}s of audio`,
      };
    }
    if (charsPerSecond > 55) {
      return { isHallucination: true, reason: 'implausibly dense output (looping)' };
    }
  }

  if (isRepetitionLoop(text)) {
    return { isHallucination: true, reason: 'repeated token loop' };
  }

  return ACCEPTED;
}

/**
 * Detects Whisper's degenerate repeat, where it emits the same token over and
 * over — the failure seen on out-of-distribution audio.
 */
function isRepetitionLoop(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;

  const unique = new Set(words);
  return unique.size / words.length < 0.34;
}
