import { describe, expect, it } from 'vitest';
import { DEFAULT_PROSODY, toPhrases } from './prosody.js';

describe('toPhrases', () => {
  it('splits a reply into sentences, keeping punctuation', () => {
    const phrases = toPhrases("Oh, hi there! It's six fifteen. Want me to open Spotify?");
    expect(phrases.map((p) => p.text)).toEqual([
      'Oh, hi there!',
      "It's six fifteen.",
      'Want me to open Spotify?',
    ]);
  });

  it('lifts questions above the base pitch', () => {
    const [question] = toPhrases('Shall I open it?');
    expect(question?.pitch).toBeGreaterThan(DEFAULT_PROSODY.basePitch);
  });

  it('spikes exclamations highest and quickest', () => {
    const [excl] = toPhrases('Oh, hi there!');
    const [plain] = toPhrases('The time is six fifteen.');
    expect(excl?.pitch).toBeGreaterThan(plain?.pitch ?? 0);
    expect(excl?.pace).toBeGreaterThan(plain?.pace ?? 0);
  });

  it('settles statements below centre so peaks have room to rise', () => {
    const [plain] = toPhrases('Your battery is at sixty seven percent.');
    expect(plain?.pitch).toBeLessThan(DEFAULT_PROSODY.basePitch);
  });

  it('treats a greeting as an exclamation even without a bang', () => {
    // The opener is the character's tell; it should bounce regardless.
    const [greeting] = toPhrases('Hey, I found three results.');
    expect(greeting?.pitch).toBeGreaterThan(DEFAULT_PROSODY.basePitch);
  });

  it('produces variation across a reply rather than one flat value', () => {
    const phrases = toPhrases("Oh, hi! It's late. Shall I remind you?");
    const pitches = new Set(phrases.map((p) => p.pitch));
    // Flat delivery is the bug this module exists to fix.
    expect(pitches.size).toBeGreaterThan(1);
  });

  it('keeps pitch and pace inside safe bounds', () => {
    const extreme = toPhrases('Wow!!! '.repeat(20), { basePitch: 11, range: 9, basePace: 1.4 });
    for (const p of extreme) {
      expect(p.pitch).toBeGreaterThanOrEqual(0);
      expect(p.pitch).toBeLessThanOrEqual(12);
      expect(p.pace).toBeLessThanOrEqual(1.5);
    }
  });

  it('handles a reply with no terminal punctuation', () => {
    const phrases = toPhrases('opening Spotify now');
    expect(phrases).toHaveLength(1);
    expect(phrases[0]?.text).toBe('opening Spotify now');
  });

  it('returns nothing for empty input', () => {
    expect(toPhrases('   ')).toEqual([]);
  });
});
