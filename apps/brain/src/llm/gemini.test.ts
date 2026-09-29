import { describe, expect, it, vi } from 'vitest';
import { okAsync, errAsync, appError } from '@assistant/core';
import { GeminiClient, sanitiseSchema, toGeminiContents, toGeminiTools } from './gemini.js';
import { createLlmRouter } from './router.js';
import type { OllamaClient } from './ollama.js';

/**
 * The cloud fallback, tested at its two dangerous seams: the translation into
 * a schema dialect that rejects rather than ignores what it does not know, and
 * the decision about when it is allowed to run at all.
 *
 * It cannot be tested against the real API without a key, so what is pinned
 * here is the request Assistant would send and what it does with each answer.
 */

/** Builds a fetch that replays SSE frames, optionally split mid-line. */
function sseFetch(frames: string[], opts: { status?: number; body?: string } = {}) {
  return vi.fn(() => {
    if (opts.status && opts.status >= 400) {
      return Promise.resolve({
        ok: false,
        status: opts.status,
        text: () => Promise.resolve(opts.body ?? ''),
        body: null,
      } as unknown as Response);
    }
    const encoder = new TextEncoder();
    let index = 0;
    const stream = {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            index < frames.length
              ? { done: false, value: encoder.encode(frames[index++] ?? '') }
              : { done: true, value: undefined },
          ),
      }),
    };
    return Promise.resolve({ ok: true, status: 200, body: stream } as unknown as Response);
  }) as unknown as typeof fetch;
}

describe('translating the tool schemas', () => {
  /**
   * Gemini rejects the entire request on an unknown key rather than ignoring
   * it, so one `additionalProperties` in one tool would take all 48 down.
   */
  it('strips the keys Gemini refuses', () => {
    const cleaned = sanitiseSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        level: { type: 'integer', minimum: 0, maximum: 100, default: 50, exclusiveMinimum: 0 },
      },
    }) as Record<string, unknown>;

    expect(cleaned.$schema).toBeUndefined();
    expect(cleaned.additionalProperties).toBeUndefined();
    const properties = cleaned.properties as { level: Record<string, unknown> };
    expect(properties.level.default).toBeUndefined();
    expect(properties.level.exclusiveMinimum).toBeUndefined();
    // What it must keep: the actual contract.
    expect(properties.level.minimum).toBe(0);
    expect(properties.level.maximum).toBe(100);
  });

  it('turns a nullable union into a type plus a flag', () => {
    const cleaned = sanitiseSchema({ type: ['string', 'null'] }) as Record<string, unknown>;
    expect(cleaned.type).toBe('string');
    expect(cleaned.nullable).toBe(true);
  });

  it('carries the name and description a model chooses by', () => {
    const tools = toGeminiTools([
      { type: 'function', function: { name: 'set_volume', description: 'Set it', parameters: {} } },
    ]);
    expect(tools?.[0]?.functionDeclarations[0]).toMatchObject({
      name: 'set_volume',
      description: 'Set it',
    });
  });

  it('sends no tools rather than an empty list', () => {
    expect(toGeminiTools([])).toBeUndefined();
    expect(toGeminiTools(undefined)).toBeUndefined();
  });
});

describe('translating the conversation', () => {
  it('lifts the system prompt out, because Gemini has no system role', () => {
    const { system, contents } = toGeminiContents([
      { role: 'system', content: 'You are Assistant.' },
      { role: 'user', content: 'hello' },
    ]);
    expect(system).toBe('You are Assistant.');
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe('user');
  });

  it('carries a tool result back as a function response', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'volume 40' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'set_volume', arguments: { level: 40 } } }],
      },
      { role: 'tool', tool_name: 'set_volume', content: '{"level":40}' },
    ]);

    expect(contents[1]).toMatchObject({
      role: 'model',
      parts: [{ functionCall: { name: 'set_volume', args: { level: 40 } } }],
    });
    expect(contents[2]).toMatchObject({
      role: 'user',
      parts: [{ functionResponse: { name: 'set_volume', response: { level: 40 } } }],
    });
  });

  /** A tool that returned plain text is still a result, not a crash. */
  it('wraps an unparseable tool result rather than dropping it', () => {
    const { contents } = toGeminiContents([
      { role: 'tool', tool_name: 'read_file', content: 'not json at all' },
    ]);
    expect(contents[0]).toMatchObject({
      parts: [{ functionResponse: { response: { result: 'not json at all' } } }],
    });
  });

  it('drops a message with nothing in it, which Gemini rejects', () => {
    const { contents } = toGeminiContents([{ role: 'assistant', content: '' }]);
    expect(contents).toHaveLength(0);
  });
});

describe('reading the reply', () => {
  const client = (frames: string[], opts = {}) =>
    new GeminiClient({
      apiKey: 'k'.repeat(12),
      model: 'gemini-2.5-flash-lite',
      fetchImpl: sseFetch(frames, opts),
    });

  it('streams text so speech can start before the reply ends', async () => {
    const deltas: string[] = [];
    const result = await client([
      'data: {"candidates":[{"content":{"parts":[{"text":"It is "}]}}]}\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"twenty past four."}]}}]}\n',
    ]).chat(
      { model: 'x', messages: [{ role: 'user', content: 'time?' }] },
      {
        onDelta: (d) => deltas.push(d),
      },
    );

    expect(deltas).toEqual(['It is ', 'twenty past four.']);
    expect(result._unsafeUnwrap().content).toBe('It is twenty past four.');
  });

  /** SSE frames arrive split across chunks; only whole lines parse. */
  it('handles a frame split mid-line', async () => {
    const result = await client([
      'data: {"candidates":[{"content":{"parts":[{"te',
      'xt":"split"}]}}]}\n',
    ]).chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(result._unsafeUnwrap().content).toBe('split');
  });

  it('reads a tool call into the shape the turn loop already understands', async () => {
    const result = await client([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"set_volume","args":{"level":40}}}]}}]}\n',
    ]).chat({ model: 'x', messages: [{ role: 'user', content: 'volume 40' }] });

    expect(result._unsafeUnwrap().tool_calls).toEqual([
      { function: { name: 'set_volume', arguments: { level: 40 } } },
    ]);
  });

  it('ignores a malformed frame instead of failing the turn', async () => {
    const result = await client([
      'data: not json\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"fine"}]}}]}\n',
    ]).chat({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
    expect(result._unsafeUnwrap().content).toBe('fine');
  });

  /**
   * The free tier's per-minute token budget is small enough that one long
   * prompt can exhaust it, so this is an expected condition and the message
   * has to say which one it is.
   */
  it('names a rate limit as a rate limit', async () => {
    const result = await client([], { status: 429, body: 'quota exceeded' }).chat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/rate limit/i);
  });
});

describe('deciding who answers', () => {
  const reply = (who: string) =>
    okAsync({ role: 'assistant' as const, content: who, tool_calls: undefined });

  const fakeLocal = (calls: string[]) =>
    ({
      chat: () => {
        calls.push('local');
        return reply('local');
      },
    }) as unknown as OllamaClient;

  const fakeCloud = (calls: string[], fail = false) =>
    ({
      model: 'gemini-2.5-flash-lite',
      chat: () => {
        calls.push('cloud');
        return fail ? errAsync(appError('gemini_chat_failed', 'rate limited')) : reply('cloud');
      },
    }) as unknown as GeminiClient;

  const request = { model: 'qwen3:30b-a3b', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('uses the cloud when it is configured and allowed', async () => {
    const calls: string[] = [];
    const router = createLlmRouter({
      local: fakeLocal(calls),
      cloud: fakeCloud(calls),
      offlineFirst: () => false,
      isOnline: () => true,
    });
    expect((await router.chat(request))._unsafeUnwrap().content).toBe('cloud');
    expect(calls).toEqual(['cloud']);
  });

  /**
   * Someone who asked to stay local did not mean "unless it is slow". The
   * setting is read per turn, so turning it on takes effect immediately.
   */
  it('never leaves the machine when the user asked to stay local', async () => {
    const calls: string[] = [];
    const router = createLlmRouter({
      local: fakeLocal(calls),
      cloud: fakeCloud(calls),
      offlineFirst: () => true,
      isOnline: () => true,
    });
    await router.chat(request);
    expect(calls).toEqual(['local']);
  });

  it('answers locally when there is no network', async () => {
    const calls: string[] = [];
    const router = createLlmRouter({
      local: fakeLocal(calls),
      cloud: fakeCloud(calls),
      offlineFirst: () => false,
      isOnline: () => false,
    });
    await router.chat(request);
    expect(calls).toEqual(['local']);
  });

  /** A free-tier rate limit is an expected condition, not an outage. */
  it('falls back to local when the cloud fails, rather than failing the turn', async () => {
    const calls: string[] = [];
    const router = createLlmRouter({
      local: fakeLocal(calls),
      cloud: fakeCloud(calls, true),
      offlineFirst: () => false,
      isOnline: () => true,
    });
    const result = await router.chat(request);
    expect(result._unsafeUnwrap().content).toBe('local');
    expect(calls).toEqual(['cloud', 'local']);
  });

  it('is simply local when no key is configured', async () => {
    const calls: string[] = [];
    const router = createLlmRouter({
      local: fakeLocal(calls),
      cloud: null,
      offlineFirst: () => false,
      isOnline: () => true,
    });
    await router.chat(request);
    expect(calls).toEqual(['local']);
  });
});
