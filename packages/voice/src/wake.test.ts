import { describe, expect, it } from 'vitest';
import { detectWakeWord, matchSpokenDecision } from './wake.js';

describe('detectWakeWord', () => {
  it.each(['hey assistant', 'Hey Assistant', 'hey, Assistant!', 'hi assistant', 'hello assistant', 'okay assistant'])(
    'detects %j',
    (text) => {
      expect(detectWakeWord(text).detected).toBe(true);
    },
  );

  it.each(['hey asistant', 'hey assistent', 'hey assistante', 'hey sistant'])(
    'tolerates whisper mis-spelling %j',
    (text) => {
      // Whisper renders the name inconsistently; requiring exact spelling
      // would make the feature look broken to the user.
      expect(detectWakeWord(text).detected).toBe(true);
    },
  );

  it('accepts the bare name', () => {
    expect(detectWakeWord('Assistant, open Safari').detected).toBe(true);
  });

  it('extracts the command after the wake phrase', () => {
    expect(detectWakeWord('Hey Assistant, what time is it?').command).toBe('what time is it?');
  });

  it('preserves the original casing of the command', () => {
    // The model should see what was said, not a lowercased copy.
    expect(detectWakeWord('hey assistant, Open Safari for me').command).toBe('Open Safari for me');
  });

  it('returns an empty command when only the wake word was said', () => {
    const result = detectWakeWord('Hey Assistant');
    expect(result.detected).toBe(true);
    expect(result.command).toBe('');
  });

  it('ignores the name mid-sentence', () => {
    // Otherwise it interrupts whenever its name comes up in conversation.
    expect(detectWakeWord('I was telling Assistant about the project').detected).toBe(false);
  });

  it.each(['what time is it', 'open Safari', 'thanks', ''])('ignores %j', (text) => {
    expect(detectWakeWord(text).detected).toBe(false);
  });

  it('handles a Hindi command after the wake word', () => {
    const result = detectWakeWord('Hey Assistant, kitne baje hain');
    expect(result.detected).toBe(true);
    expect(result.command).toBe('kitne baje hain');
  });
});

/**
 * Answering the consent card out loud.
 *
 * Asked for on 2026-09-03: "if I say allow, it should send". This decides
 * whether an irreversible action happens, so it is a fixed vocabulary matched
 * on the whole utterance — never the model, which the PRD forbids from
 * granting itself permission, and never a substring, which would let "no,
 * message Rahul instead" read as an answer.
 */
describe('answering a consent prompt by voice', () => {
  it.each(['yes', 'Yes.', 'allow', 'allow it', 'go ahead', 'do it', 'send it', 'okay', 'sure'])(
    'takes %s as approval',
    (said) => {
      expect(matchSpokenDecision(said)).toBe('approve');
    },
  );

  it.each(['no', 'nope', 'deny', 'cancel', 'stop', "don't", 'never mind', 'leave it'])(
    'takes %s as a refusal',
    (said) => {
      expect(matchSpokenDecision(said)).toBe('deny');
    },
  );

  /** Spoken as often as the English, on this machine. */
  it.each([
    ['haan', 'approve'],
    ['theek hai', 'approve'],
    ['kar do', 'approve'],
    ['nahi', 'deny'],
    ['mat karo', 'deny'],
  ])('understands %s', (said, expected) => {
    expect(matchSpokenDecision(said)).toBe(expected);
  });

  it('ignores the wake word and politeness around the answer', () => {
    expect(matchSpokenDecision('Hey Assistant, yes please')).toBe('approve');
    expect(matchSpokenDecision('Assistant no')).toBe('deny');
  });

  /**
   * The half that matters. A sentence that merely contains "no" is a new
   * request, and answering the card with it would run — or refuse — the wrong
   * thing entirely.
   */
  it.each([
    'no, message Rahul instead',
    'yes and then open safari',
    'send it to Tilak CSM',
    'what time is it',
    'allow me to think about it',
    '',
    '   ',
  ])('leaves %s alone', (said) => {
    expect(matchSpokenDecision(said)).toBeNull();
  });
});
