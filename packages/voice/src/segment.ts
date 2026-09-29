/**
 * Splits a streaming reply into speakable sentences as it arrives.
 *
 * The point is latency. Synthesising the whole reply and then playing it means
 * the user hears nothing until the model has finished writing — on a long
 * answer that is most of the wait. Speaking each sentence as it completes puts
 * the first audio in their ears seconds earlier, and the rest arrives while
 * they are still listening to it.
 *
 * Stateful because a sentence boundary can straddle a chunk: the model may
 * emit "fine" and "." as separate deltas, and a per-chunk regex would miss it.
 */

/** Terminators, including the Devanagari danda used by several Indian scripts. */
const TERMINATORS = new Set(['.', '!', '?', '।', '\n']);

/**
 * Short enough that speaking it alone sounds clipped rather than deliberate.
 * Fragments below this are held back and merged with what follows.
 */
const MIN_SPEAKABLE_CHARS = 12;

/**
 * Words that take a full stop without ending a sentence.
 *
 * Lower-cased for comparison. Not exhaustive and does not need to be — a miss
 * costs one slightly clipped phrase, not a wrong answer.
 */
const ABBREVIATIONS = new Set([
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'sr',
  'jr',
  'st',
  'mt',
  'vs',
  'etc',
  'approx',
  'no',
  'fig',
  'al',
  'inc',
  'ltd',
  'co',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'am',
  'pm',
]);

/**
 * A "." that is not the end of a sentence.
 *
 * Splitting on every full stop cuts "3.5 GB" and "Dr. Rao" in half, and the
 * synthesiser reads each piece with a falling final intonation — which sounds
 * like two broken sentences rather than one.
 */
function isFalseStop(text: string, index: number): boolean {
  if (text[index] !== '.') return false;

  const before = text[index - 1];
  const after = text[index + 1];

  // Decimal or version number: 3.5, v1.2
  if (before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after)) {
    return true;
  }

  // Ellipsis — one boundary at its end, not three.
  if (after === '.') return true;

  // An initial: "J. Smith". A single letter preceded by a non-letter.
  if (before !== undefined && /[A-Za-z]/.test(before)) {
    const twoBefore = text[index - 2];
    if (/[A-Z]/.test(before) && (twoBefore === undefined || !/[a-zA-Z]/.test(twoBefore))) {
      return true;
    }
  }

  // A known abbreviation immediately before the stop.
  const word = /([A-Za-z.]+)$/.exec(text.slice(0, index))?.[1];
  if (word !== undefined && ABBREVIATIONS.has(word.toLowerCase())) return true;

  return false;
}

/**
 * Clause boundaries the first clip may break at.
 *
 * A comma or dash leaves the voice rising, which is what you want when more is
 * coming — unlike a full stop, which would make one sentence sound like two.
 */
const CLAUSE_BREAKS = new Set([',', ';', ':', '—', '–']);

/**
 * How long the first sentence has to get before it is worth breaking early.
 *
 * Voice conversion costs roughly a fixed setup plus a share of the clip's
 * duration — measured 2026-09-06 at 1.03 s for a 2.1 s clip — so the first
 * sentence is both the most expensive to convert and the only one the user is
 * actually waiting on. Everything after it synthesises while they are already
 * listening and costs them nothing.
 *
 * 70 characters is around five seconds of speech. Below that the conversion is
 * already short enough that breaking the sentence would trade naturalness for
 * very little.
 */
const FIRST_CLIP_MAX_CHARS = 70;

/**
 * And how short it is allowed to get. Below this a clause on its own sounds
 * clipped rather than deliberate — the same reason `MIN_SPEAKABLE_CHARS`
 * exists, at the length a half-sentence needs rather than a whole one.
 */
const MIN_FIRST_CLIP_CHARS = 25;

/** A "," inside a number: "1,234" is not two clauses. */
function isGroupingComma(text: string, index: number): boolean {
  if (text[index] !== ',') return false;
  const before = text[index - 1];
  const after = text[index + 1];
  return before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
}

export interface SentenceStreamOptions {
  /**
   * Break the first clip at a clause boundary when the opening sentence runs
   * long, so the user hears something sooner.
   *
   * On by default, and worth turning off for any consumer that wants whole
   * sentences — the split is a latency trade, not a transcription improvement.
   */
  breakFirstClip?: boolean;
}

export class SentenceStream {
  #buffer = '';
  /**
   * Whether anything has been emitted yet. The early break applies to the
   * first clip only: doing it to every sentence would chop the whole reply
   * into clauses to save time nobody is waiting through.
   */
  #emitted = 0;
  readonly #breakFirstClip: boolean;

  constructor(options: SentenceStreamOptions = {}) {
    this.#breakFirstClip = options.breakFirstClip ?? true;
  }

  /** Feeds a chunk in and returns whatever complete sentences it produced. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const out: string[] = [];

    let start = 0;
    for (let i = 0; i < this.#buffer.length; i += 1) {
      const char = this.#buffer[i];
      if (char === undefined || !TERMINATORS.has(char)) continue;

      // A "." at the very end of what we have so far cannot be judged yet:
      // whether it is a decimal point, an ellipsis or a sentence end depends
      // on the character after it, which has not arrived. Hold and re-examine
      // when the next chunk lands. `!`, `?`, the danda and newline are
      // unambiguous, so they do not need to wait.
      if (char === '.' && i === this.#buffer.length - 1) break;

      if (isFalseStop(this.#buffer, i)) continue;

      const candidate = this.#buffer.slice(start, i + 1).trim();
      if (candidate.length === 0) {
        start = i + 1;
        continue;
      }
      // Too short to stand alone — keep accumulating rather than speaking a
      // stub like "Yes." on its own breath.
      if (candidate.length < MIN_SPEAKABLE_CHARS) continue;

      out.push(candidate);
      this.#emitted += 1;
      start = i + 1;
    }

    this.#buffer = this.#buffer.slice(start);

    // Only once the sentence loop has had its chance: if it produced anything,
    // the first clip is already out and there is nothing to shorten.
    const early = this.#takeFirstClause(out.length);
    if (early !== null) {
      out.unshift(early);
      this.#emitted += 1;
    }

    return out;
  }

  /**
   * Breaks a long opening sentence at its first clause boundary.
   *
   * Returns null unless this is still the first clip, the sentence has run
   * past {@link FIRST_CLIP_MAX_CHARS} without terminating, and there is a
   * boundary far enough in to stand on its own.
   */
  #takeFirstClause(emittedThisPush: number): string | null {
    if (!this.#breakFirstClip) return null;
    if (this.#emitted > 0 || emittedThisPush > 0) return null;
    if (this.#buffer.length < FIRST_CLIP_MAX_CHARS) return null;

    for (let i = MIN_FIRST_CLIP_CHARS; i < this.#buffer.length; i += 1) {
      const char = this.#buffer[i];
      if (char === undefined || !CLAUSE_BREAKS.has(char)) continue;
      if (isGroupingComma(this.#buffer, i)) continue;

      const clause = this.#buffer.slice(0, i + 1).trim();
      if (clause.length < MIN_FIRST_CLIP_CHARS) continue;

      this.#buffer = this.#buffer.slice(i + 1);
      // The earliest acceptable boundary, not the latest: the whole point is
      // the shortest clip that still sounds deliberate.
      return clause;
    }

    return null;
  }

  /** Returns anything left over once the stream has ended. */
  flush(): string | null {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    if (rest.length > 0) this.#emitted += 1;
    return rest.length > 0 ? rest : null;
  }
}
