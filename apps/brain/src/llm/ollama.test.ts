import { describe, expect, it } from 'vitest';
import { normaliseKeepAlive, ReasoningFilter, stripReasoning } from './ollama.js';

/**
 * Reasoning leaking into the reply is not cosmetic. In the failure that
 * prompted these tests, the model's private deliberation reached the user and
 * included the line "I'll use a placeholder like 85%" — a fabricated number
 * presented as a fact about their machine.
 */
describe('stripReasoning', () => {
  it('removes a complete think block', () => {
    expect(stripReasoning('<think>deliberating</think>The answer is 391.')).toBe(
      'The answer is 391.',
    );
  });

  it('removes everything before an orphan closing tag', () => {
    // Ollama emits this shape when the chat template opens the tag itself.
    expect(stripReasoning('Let me work it out. 17*23=391.\n</think>\n\n17 times 23 is 391.')).toBe(
      '17 times 23 is 391.',
    );
  });

  it('drops an unterminated opening tag and everything after it', () => {
    expect(stripReasoning('Here you go.<think>still thinking...')).toBe('Here you go.');
  });

  it('leaves ordinary content untouched', () => {
    expect(stripReasoning('It is 1:37 PM.')).toBe('It is 1:37 PM.');
  });

  it('handles multiple blocks', () => {
    expect(stripReasoning('<think>a</think>One.<think>b</think> Two.')).toBe('One. Two.');
  });
});

describe('ReasoningFilter (streaming)', () => {
  const run = (chunks: string[]) => {
    const filter = new ReasoningFilter();
    return chunks.map((c) => filter.push(c)).join('') + filter.flush();
  };

  it('passes plain content straight through', () => {
    expect(run(['Hello ', 'world.'])).toBe('Hello world.');
  });

  it('suppresses a think block spread across chunks', () => {
    expect(run(['<thi', 'nk>secret ', 'reasoning</thi', 'nk>Visible.'])).toBe('Visible.');
  });

  it('suppresses reasoning when the tag arrives in one chunk', () => {
    expect(run(['<think>hidden</think>', 'Shown.'])).toBe('Shown.');
  });

  it('never emits a partial tag as visible text', () => {
    // A naive per-chunk filter would emit "<thi" here before the tag completed.
    const filter = new ReasoningFilter();
    // The partial tag is withheld, not emitted...
    expect(filter.push('Answer<thi')).toBe('Answer');
    // ...and is discarded once it resolves into a real think block.
    expect(filter.push('nk>hidden</think>!')).toBe('!');
  });

  it('keeps content that merely resembles a tag', () => {
    expect(run(['a < b and c > d'])).toBe('a < b and c > d');
  });

  it('drops an unterminated block rather than flushing it', () => {
    const filter = new ReasoningFilter();
    expect(filter.push('Visible.<think>never closed')).toBe('Visible.');
    expect(filter.flush()).toBe('');
  });

  it('handles interleaved reasoning and content', () => {
    expect(run(['One.', '<think>x</think>', ' Two.', '<think>y</think>', ' Three.'])).toBe(
      'One. Two. Three.',
    );
  });
});

describe('normaliseKeepAlive', () => {
  it('converts a numeric string to a number', () => {
    // Ollama rejects "-1" as a string with `missing unit in duration "-1"`,
    // which fails every chat request rather than just ignoring the setting.
    expect(normaliseKeepAlive('-1')).toBe(-1);
    expect(normaliseKeepAlive('300')).toBe(300);
    expect(normaliseKeepAlive(' 0 ')).toBe(0);
  });

  it('passes a Go duration string through untouched', () => {
    expect(normaliseKeepAlive('10m')).toBe('10m');
    expect(normaliseKeepAlive('1h30m')).toBe('1h30m');
  });

  it('falls back to a sane default when empty', () => {
    expect(normaliseKeepAlive('')).toBe('5m');
    expect(normaliseKeepAlive('   ')).toBe('5m');
  });
});
