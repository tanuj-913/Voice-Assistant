import { describe, expect, it } from 'vitest';
import { KNOWN_APPS } from '@assistant/tools';
import { COMMON_PHRASES } from '@assistant/voice';
import { warmablePhrases } from './warm-phrases.js';

describe('warmablePhrases', () => {
  it('includes the fixed sentences the speech layer declares', () => {
    const phrases = warmablePhrases();
    for (const phrase of COMMON_PHRASES) expect(phrases).toContain(phrase);
  });

  /**
   * Derived from the router's own list rather than retyped, so an app added to
   * `KNOWN_APPS` is warmed without anyone remembering to come back here. A
   * hand-maintained copy would drift, and the only symptom would be one app
   * being slower than the rest.
   */
  it('covers every app the fast path can open', () => {
    const phrases = warmablePhrases();
    for (const app of Object.values(KNOWN_APPS)) {
      expect(phrases).toContain(`Opened ${app}.`);
    }
  });

  it('collapses aliases that resolve to the same app', () => {
    const phrases = warmablePhrases();
    // "chrome" and "google chrome" are two ways to say one app; synthesising
    // "Opened Google Chrome." twice would be two round trips for one clip.
    expect(phrases.filter((p) => p === 'Opened Google Chrome.')).toHaveLength(1);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it('warms the volume levels people actually say', () => {
    const phrases = warmablePhrases();
    expect(phrases).toContain('Volume set to 50 percent.');
    expect(phrases).toContain('Volume set to 0 percent.');
    expect(phrases).toContain('Volume set to 100 percent.');
    // Not every level: 101 phrases to cover requests nobody makes would spend
    // a hundred round trips for nothing.
    expect(phrases).not.toContain('Volume set to 37 percent.');
  });

  /**
   * Each phrase is one Sarvam round trip plus one conversion on a cold cache.
   * That is fine at this size and background-paced; it would not be fine if
   * the list quietly grew into the hundreds, which is exactly the kind of
   * change nobody notices making.
   */
  it('stays small enough to warm in the background', () => {
    expect(warmablePhrases().length).toBeLessThan(80);
  });
});
