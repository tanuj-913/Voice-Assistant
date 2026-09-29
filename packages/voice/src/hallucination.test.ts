import { describe, expect, it } from 'vitest';
import { detectHallucination } from './hallucination.js';

/**
 * Every phrase below was produced by Whisper during one real listening session
 * in which the user said nothing. Each one started an LLM turn.
 */
describe('detectHallucination', () => {
  const d = (ms: number) => ({ durationMs: ms });

  it.each([
    ['- Thank you.', 1200],
    ['Gracias.', 1000],
    ['Obrigado.', 1100],
    ['- Awesome.', 1000],
    ['- Hi.', 900],
    ['Thanks for watching!', 1500],
    ['you', 800],
    ['Bye.', 900],
  ])('rejects observed artifact %j', (text, ms) => {
    expect(detectHallucination(text, d(ms)).isHallucination).toBe(true);
  });

  it.each(['♪', '...', '[MUSIC]', '(applause)', '   ', '.'])(
    'rejects non-lexical output %j',
    (text) => {
      expect(detectHallucination(text, d(1500)).isHallucination).toBe(true);
    },
  );

  it('rejects a few words stretched over a long recording', () => {
    // Five seconds of audio yielding two words means it invented them.
    expect(detectHallucination('Thank you so much', d(6000)).isHallucination).toBe(true);
  });

  it('rejects a repetition loop', () => {
    const looped = 'ప్రు ప్రు ప్రు ప్రు క్రు ప్రు ప్రు క్రు ప్రు';
    expect(detectHallucination(looped, d(3000)).isHallucination).toBe(true);
  });

  it.each([
    ['Hey Assistant, what is the weather in Mumbai today?', 2500],
    ['अभी कितने बजे हैं?', 2000],
    ['open Safari for me please', 2200],
    ['reply in telugu, what time is it now', 3000],
  ])('accepts genuine speech %j', (text, ms) => {
    const verdict = detectHallucination(text, d(ms));
    expect(verdict.isHallucination).toBe(false);
    expect(verdict.reason).toBeNull();
  });

  it('accepts a short real command without over-filtering', () => {
    // Brief but lexical and proportionate to its duration.
    expect(detectHallucination('open Spotify', d(1200)).isHallucination).toBe(false);
  });

  it('explains why it rejected something', () => {
    const verdict = detectHallucination('Gracias.', d(1000));
    expect(verdict.reason).toContain('known artifact');
  });
});
