import { describe, expect, it } from 'vitest';
import { SentenceStream } from './segment.js';

/**
 * Feeds text one character at a time — the worst case for a stateful splitter —
 * and returns the sentences emitted plus whatever `flush` had left.
 *
 * A "." is deliberately held until the next character arrives, so the final
 * sentence of any text always comes out of `flush` rather than `push`.
 */
function drip(text: string): { emitted: string[]; rest: string | null; all: string[] } {
  const stream = new SentenceStream();
  const emitted: string[] = [];
  for (const char of text) emitted.push(...stream.push(char));
  const rest = stream.flush();
  return { emitted, rest, all: rest === null ? emitted : [...emitted, rest] };
}

describe('SentenceStream', () => {
  it('emits a sentence as soon as the next chunk confirms the boundary', () => {
    const stream = new SentenceStream();
    expect(stream.push('I am doing fine')).toEqual([]);
    // The "." alone is ambiguous — it could still be a decimal point.
    expect(stream.push('.')).toEqual([]);
    expect(stream.push(' And you?')).toEqual(['I am doing fine.']);
  });

  it('does not wait on unambiguous terminators', () => {
    const stream = new SentenceStream();
    expect(stream.push('Shall I play some music?')).toEqual(['Shall I play some music?']);
  });

  it('does not split decimals, versions, initials or abbreviations', () => {
    expect(drip('You have 3.5 GB free on the disk.').all).toEqual([
      'You have 3.5 GB free on the disk.',
    ]);
    expect(drip('I spoke to Dr. Rao about the meeting.').all).toEqual([
      'I spoke to Dr. Rao about the meeting.',
    ]);
    expect(drip('Ask J. Smith when he arrives.').all).toEqual(['Ask J. Smith when he arrives.']);
  });

  it('holds back fragments too short to speak alone', () => {
    // "Yes." on its own breath sounds clipped; it rides with what follows.
    expect(drip('Yes. The meeting is at four in the afternoon.').all).toEqual([
      'Yes. The meeting is at four in the afternoon.',
    ]);
  });

  it('handles the Devanagari danda', () => {
    const { all } = drip('मैं ठीक हूँ और आप कैसे हैं। अगला काम क्या है।');
    expect(all).toHaveLength(2);
    expect(all[0]).toBe('मैं ठीक हूँ और आप कैसे हैं।');
  });

  it('speaks earlier sentences before the reply has finished', () => {
    // The whole point: the first sentence must be available while the model
    // is still writing the second.
    const stream = new SentenceStream();
    const first = stream.push('Good evening. The time is nine twenty five.');
    expect(first).toEqual(['Good evening.']);
    expect(stream.flush()).toBe('The time is nine twenty five.');
  });

  it('loses nothing: every character comes back out', () => {
    const text = 'Good evening. The time is 9.25 PM. Shall I play some music?';
    const rebuilt = drip(text).all.join(' ').replace(/\s+/g, ' ').trim();
    expect(rebuilt).toBe(text.replace(/\s+/g, ' ').trim());
  });
});

/**
 * Voice conversion costs a fixed setup plus a share of the clip's duration —
 * measured 2026-09-06 at 1.03 s for a 2.1 s clip. That makes the opening
 * sentence both the most expensive clip to convert and the only one anyone is
 * waiting on; everything after it is synthesised while the user is already
 * listening. Breaking a long opener at a clause boundary trades a little
 * naturalness for the one second that is actually felt.
 */
describe('first-clip shortening', () => {
  const longOpener =
    'I had a look at the calendar for you and it turns out tomorrow is completely free, so you can pick any time.';

  it('breaks a long opening sentence at its first clause boundary', () => {
    const stream = new SentenceStream();
    const out = stream.push(longOpener);

    expect(out[0]).toBe(
      'I had a look at the calendar for you and it turns out tomorrow is completely free,',
    );
    // Short enough to convert quickly, long enough not to sound clipped.
    expect(out[0]?.length).toBeLessThan(longOpener.length);
    expect(out[0]?.length).toBeGreaterThanOrEqual(25);
  });

  it('never loses a word', () => {
    const stream = new SentenceStream();
    const spoken = [...stream.push(longOpener), stream.flush() ?? ''].join(' ');
    // Whitespace is normalised by the trim on each piece; the words are not.
    expect(spoken.replace(/\s+/g, ' ').trim()).toBe(longOpener.replace(/\s+/g, ' ').trim());
  });

  /**
   * The saving only exists for the clip the user waits on. Applying it to the
   * whole reply would chop it into clauses to save time nobody is listening
   * through.
   */
  it('applies to the first clip only', () => {
    const stream = new SentenceStream();
    stream.push(longOpener);
    const second =
      'The one after it is also quite long and full of commas, but it must not be broken up.';
    const out = stream.push(` ${second}`);

    expect(out.some((s) => s.endsWith(','))).toBe(false);
  });

  it('leaves a short opening sentence alone', () => {
    const stream = new SentenceStream();
    // The trailing space is how a real stream arrives: a "." at the very end
    // of the buffer is held back until the next character can rule out a
    // decimal point.
    const out = stream.push('Tomorrow is free, so pick any time. ');

    // Under the threshold: breaking here would cost naturalness for almost no
    // conversion time.
    expect(out).toEqual(['Tomorrow is free, so pick any time.']);
  });

  it('does not split a number at its thousands separator', () => {
    const stream = new SentenceStream();
    const out = stream.push(
      'Your drive has about 1,234 gigabytes free at the moment which is plenty for that',
    );

    expect(out[0] ?? '').not.toMatch(/1,$/);
  });

  it('can be turned off for consumers that want whole sentences', () => {
    const stream = new SentenceStream({ breakFirstClip: false });
    const out = stream.push(longOpener);

    expect(out).toEqual([]);
    expect(stream.flush()).toBe(longOpener);
  });

  /**
   * A sentence that ends normally must still win: the early break exists for
   * openers that run on, not to pre-empt punctuation that was about to arrive.
   */
  it('prefers a real sentence end when one arrives first', () => {
    const stream = new SentenceStream();
    const out = stream.push('That is done now. And here, after a comma, is some more of it.');

    expect(out[0]).toBe('That is done now.');
  });
});
