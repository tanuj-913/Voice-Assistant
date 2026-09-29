import { describe, expect, it, vi } from 'vitest';
import { checkRvcServer, createRvcTransform } from './rvc.js';

/** Minimal well-formed WAV header — enough for the shape check. */
function wav(payload = 'data'): Buffer {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + payload.length, 4);
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, Buffer.from(payload)]);
}

const source = wav('source');
const converted = wav('converted');

function respond(body: Buffer, init: { status?: number } = {}): Response {
  return new Response(new Uint8Array(body), { status: init.status ?? 200 });
}

describe('createRvcTransform', () => {
  it('returns the converted clip', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(converted)));
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318',
      fetchImpl: fetchImpl,
    });
    expect(await transform(source)).toEqual(converted);
  });

  it('passes conversion settings as query parameters', async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(respond(converted)),
    );
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318/',
      indexRate: 0.75,
      pitch: -2,
      protect: 0.2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await transform(source);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    // The trailing slash on the endpoint must not produce a double slash.
    expect(url).toBe('http://127.0.0.1:4318/convert?index_rate=0.75&pitch=-2&protect=0.2');
  });

  /**
   * Every branch below must speak *something*. A silent turn is a worse
   * failure than the untransformed voice, so the source clip is the floor.
   */
  it('falls back to the source clip when the server errors', async () => {
    const onFallback = vi.fn();
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318',
      onFallback,
      fetchImpl: () => Promise.resolve(respond(converted, { status: 500 })),
    });
    expect(await transform(source)).toEqual(source);
    expect(onFallback).toHaveBeenCalledWith('rvc_http_500');
  });

  it('falls back when the server is unreachable', async () => {
    const onFallback = vi.fn();
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318',
      onFallback,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await transform(source)).toEqual(source);
    expect(onFallback).toHaveBeenCalledWith('rvc_unreachable');
  });

  it('falls back when the response is not a WAV', async () => {
    const onFallback = vi.fn();
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318',
      onFallback,
      fetchImpl: () => Promise.resolve(new Response('{"error":"boom"}', { status: 200 })),
    });
    expect(await transform(source)).toEqual(source);
    expect(onFallback).toHaveBeenCalledWith('rvc_not_wav');
  });

  it('gives up on a slow conversion rather than delaying speech', async () => {
    const onFallback = vi.fn();
    const transform = createRvcTransform({
      endpoint: 'http://127.0.0.1:4318',
      timeoutMs: 10,
      onFallback,
      fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as unknown as typeof fetch,
    });
    expect(await transform(source)).toEqual(source);
    expect(onFallback).toHaveBeenCalledWith('rvc_timeout');
  });
});

describe('checkRvcServer', () => {
  it('reports the loaded checkpoint', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, model: 'assistant-friend_25e_1575s.pth' }), {
          status: 200,
        }),
      )) as unknown as typeof fetch;
    expect(await checkRvcServer('http://127.0.0.1:4318', fetchImpl)).toEqual({
      available: true,
      model: 'assistant-friend_25e_1575s.pth',
    });
  });

  it('reports unavailable rather than throwing when nothing is listening', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    expect(await checkRvcServer('http://127.0.0.1:4318', fetchImpl)).toEqual({
      available: false,
      model: null,
    });
  });
});

describe('checkRvcServer retries', () => {
  it('waits for a converter that is still warming up', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      // Refuses twice, then answers — the converter loading its models.
      if (calls < 3) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, model: 'assistant-friend_175e_11025s.pth' }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch;

    const status = await checkRvcServer('http://127.0.0.1:4318', fetchImpl, {
      attempts: 5,
      delayMs: 1,
    });
    expect(status).toEqual({ available: true, model: 'assistant-friend_175e_11025s.pth' });
    expect(calls).toBe(3);
  });

  it('gives up after the attempts run out', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    }) as unknown as typeof fetch;

    const status = await checkRvcServer('http://127.0.0.1:4318', fetchImpl, {
      attempts: 3,
      delayMs: 1,
    });
    expect(status).toEqual({ available: false, model: null });
    expect(calls).toBe(3);
  });
});
