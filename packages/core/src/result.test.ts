import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appError, parseWith } from './result.js';

describe('parseWith', () => {
  const Schema = z.object({ name: z.string().min(1), count: z.number().int() });

  it('returns the parsed value on success', () => {
    const result = parseWith(Schema, { name: 'x', count: 2 });
    expect(result.isOk()).toBe(true);
    result.map((v) => {
      expect(v).toEqual({ name: 'x', count: 2 });
    });
  });

  it('returns an error rather than throwing on failure', () => {
    const result = parseWith(Schema, { name: '', count: 1.5 });
    expect(result.isErr()).toBe(true);
    result.mapErr((e) => {
      // Every issue is reported, so the model can fix them in one retry.
      expect(e.message).toContain('name');
      expect(e.message).toContain('count');
    });
  });

  it('uses the supplied error code', () => {
    parseWith(Schema, null, 'custom_code').mapErr((e) => {
      expect(e.code).toBe('custom_code');
    });
  });
});

describe('appError', () => {
  it('defaults to non-retryable', () => {
    expect(appError('x', 'y').retryable).toBe(false);
  });

  it('stringifies an Error cause rather than embedding the object', () => {
    const error = appError('x', 'y', { cause: new TypeError('boom') });
    expect(error.cause).toBe('TypeError: boom');
  });

  it('omits cause entirely when none is given', () => {
    expect('cause' in appError('x', 'y')).toBe(false);
  });
});
