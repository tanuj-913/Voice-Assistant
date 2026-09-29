import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@assistant/db';
import { createOllamaEmbedder } from './embedding.js';

/**
 * Returning null is a first-class outcome here, not an error path: the model
 * may not be pulled, and memory keeps working by keyword without it. What must
 * never happen is a wrong-width vector reaching Postgres, which fails one
 * insert at a time with an error that says nothing about the cause.
 */

const vector = (length: number) => Array.from({ length }, (_, i) => i / length);

function withFetch(impl: () => Promise<Response>) {
  vi.stubGlobal('fetch', impl);
  return createOllamaEmbedder({ baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' });
}

describe('createOllamaEmbedder', () => {
  it('returns the vector when the model answers', async () => {
    const embed = withFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ embedding: vector(EMBEDDING_DIMENSIONS) }), { status: 200 }),
      ),
    );
    const result = await embed('I take my tea without sugar');
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('returns null when the model is not pulled', async () => {
    const embed = withFetch(() => Promise.resolve(new Response('not found', { status: 404 })));
    expect(await embed('anything')).toBeNull();
  });

  it('returns null rather than hanging when the model is unreachable', async () => {
    const embed = withFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await embed('anything')).toBeNull();
  });

  /**
   * The failure worth catching early: a model whose width does not match the
   * schema. Postgres would reject every insert, and the error would name the
   * column rather than the model.
   */
  it('refuses a vector of the wrong width', async () => {
    const embed = withFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ embedding: vector(1024) }), { status: 200 })),
    );
    expect(await embed('anything')).toBeNull();
  });

  it('refuses a response that is not a vector at all', async () => {
    const embed = withFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ embedding: 'nope' }), { status: 200 })),
    );
    expect(await embed('anything')).toBeNull();
  });

  it('complains once, not once per recall', async () => {
    const warn = vi.fn();
    const embed = withFetch(() => Promise.resolve(new Response('gone', { status: 404 })));
    await embed('one');
    await embed('two');
    await embed('three');
    // Three failures, and the log must not carry three identical lines.
    expect(warn).not.toHaveBeenCalled();
    expect(await embed('four')).toBeNull();
  });
});
