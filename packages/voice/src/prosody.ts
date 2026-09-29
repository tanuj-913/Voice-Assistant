/**
 * Splits a reply into phrases and gives each one its own delivery.
 *
 * A single pitch shift applied to a whole sentence produces a flat voice in a
 * costume. Character comes from *variation* — a greeting that jumps, a
 * statement that settles, a question that lifts at the end. Voice actors do
 * this instinctively; synthesis has to be told.
 *
 * Each phrase is synthesised and shifted separately, then concatenated, so the
 * pitch contour across a sentence is shaped rather than constant.
 */

export interface Phrase {
  readonly text: string;
  /** Speech rate for this phrase. Above 1 is quicker. */
  readonly pace: number;
  /** Semitones to shift this phrase, relative to the base voice. */
  readonly pitch: number;
}

export interface ProsodyProfile {
  /** Centre pitch in semitones; phrases deviate around it. */
  readonly basePitch: number;
  /** How far phrases may deviate. 0 reproduces the old flat delivery. */
  readonly range: number;
  readonly basePace: number;
}

export const DEFAULT_PROSODY: ProsodyProfile = {
  basePitch: 7.5,
  range: 1.6,
  basePace: 1.05,
};

/** Sentence-ish chunks, keeping their terminating punctuation. */
const SPLIT = /[^.!?…]+[.!?…]*/gu;

/** Openers that should bounce — the character's "tell". */
const EXCLAIM = /^(oh|hey|hi|hello|wow|ah|okay|alright|sure|yes|no|great|nice)\b/i;

export function toPhrases(text: string, profile: ProsodyProfile = DEFAULT_PROSODY): Phrase[] {
  const chunks = (text.match(SPLIT) ?? [text]).map((c) => c.trim()).filter((c) => c.length > 0);

  if (chunks.length === 0) return [];

  return chunks.map((chunk, index) => {
    const isQuestion = chunk.endsWith('?');
    const isExclamation = chunk.endsWith('!') || EXCLAIM.test(chunk);
    const isLast = index === chunks.length - 1;

    // Questions lift, exclamations spike, and the body of a reply settles
    // slightly below centre so the peaks have somewhere to rise from.
    let pitch = profile.basePitch;
    let pace = profile.basePace;

    if (isExclamation) {
      pitch += profile.range;
      pace += 0.12;
    } else if (isQuestion) {
      pitch += profile.range * 0.7;
      pace += 0.05;
    } else {
      pitch -= profile.range * 0.35;
      pace -= 0.06;
    }

    // Trail off very slightly at the end of a multi-part reply, the way a
    // person does when they have finished rather than paused.
    if (isLast && chunks.length > 1 && !isQuestion && !isExclamation) {
      pitch -= profile.range * 0.2;
      pace -= 0.03;
    }

    return {
      text: chunk,
      pace: clamp(pace, 0.7, 1.5),
      pitch: clamp(pitch, 0, 12),
    };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
