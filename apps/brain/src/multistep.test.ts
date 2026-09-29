import { describe, expect, it } from 'vitest';
import { looksMultiStep } from './multistep.js';

/**
 * Planning costs a whole extra generation. This gate errs towards *not*
 * planning: a missed plan degrades to the ordinary tool loop, while a spurious
 * one makes a one-word command take seconds.
 */
describe('looksMultiStep', () => {
  it.each([
    'message Rahul and then call Priya about the meeting',
    'open Safari and search for train times to Bangalore',
    'create a note about the trip and set a reminder for tomorrow',
    'find the docs tab, after that close everything else',
  ])('plans for %j', (text) => {
    expect(looksMultiStep(text)).toBe(true);
  });

  it.each([
    ['a bare command', 'pause'],
    ['a short command with a verb', 'set volume to 40'],
    ['a question', 'what time is it right now'],
    ['one action described at length', 'please open Safari for me when you get a chance'],
    ['a conjunction inside a single description', 'find the note about tea and coffee'],
  ])('does not plan for %s', (_why, text) => {
    expect(looksMultiStep(text)).toBe(false);
  });

  it('ignores anything short enough to be one command', () => {
    // "and" alone must not be enough; length is the cheap first filter.
    expect(looksMultiStep('open and play')).toBe(false);
  });
});

/**
 * The shape that dropped half a request.
 *
 * This gate acquired a second job on 2026-09-03: it also decides whether a
 * tool may end the turn by speaking its own result. "Open Spotify and play the
 * last song" opened Spotify, said "Opened Spotify.", and stopped — reported as
 * success with half the request undone. So the borderline cases now lean
 * towards more steps, because a false positive costs one extra model call and
 * a false negative costs the user the thing they asked for.
 */
describe('a second step that reports rather than acts', () => {
  it.each([
    'pause the music and tell me what was playing',
    'open the invoice and read it out',
    'check my calendar and let me know if I am free',
    'take a screenshot and show me what it says',
    'open spotify and tell me what is playing',
  ])('sees two steps in %s', (text) => {
    expect(looksMultiStep(text)).toBe(true);
  });

  /**
   * Narrow on purpose: "and tell me", not "and tell". Telling someone
   * something is usually the content of the one action, not a second one.
   */
  it.each([
    'call mum and tell her I will be late',
    'message tilak on whatsapp saying come to me once',
    'send a message to rahul saying I am on my way and running late',
  ])('leaves %s as one action', (text) => {
    expect(looksMultiStep(text)).toBe(false);
  });

  it('still refuses to plan a short command', () => {
    expect(looksMultiStep('pause')).toBe(false);
    expect(looksMultiStep('set the volume to forty')).toBe(false);
  });
});
