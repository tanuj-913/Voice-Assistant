import { childLogger } from '@assistant/core';
import { EMBEDDING_DIMENSIONS } from '@assistant/db';

const log = childLogger('embedding');

/**
 * Vectors for semantic recall, from Ollama.
 *
 * The default model is `nomic-embed-text` because the schema's
 * `EMBEDDING_DIMENSIONS` is 768 and that is what it produces — a mismatch here
 * is not a soft failure, Postgres rejects the insert outright. The dimension
 * is therefore checked on the first response rather than trusted.
 *
 * Returning null is a first-class outcome, not an error path. The model may
 * not be pulled, and memory is meant to keep working by keyword when it is
 * absent. Nothing here should ever be able to lose a write.
 */
export interface EmbedderOptions {
  baseUrl: string;
  model: string;
  /** Vectors are small and the model is local; this is a guard, not a budget. */
  timeoutMs?: number;
}

export function createOllamaEmbedder(
  options: EmbedderOptions,
): (text: string) => Promise<number[] | null> {
  const base = options.baseUrl.replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;
  let warned = false;

  /** Complained about once, not once per recall. */
  const warnOnce = (message: string, detail: Record<string, unknown> = {}) => {
    if (warned) return;
    warned = true;
    log.warn(detail, message);
  };

  return async (text: string): Promise<number[] | null> => {
    try {
      const response = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: options.model, prompt: text }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        warnOnce(
          `embedding model "${options.model}" is unavailable — recall stays keyword-only. Pull it with: ollama pull ${options.model}`,
          { status: response.status },
        );
        return null;
      }

      const body = (await response.json()) as { embedding?: unknown };
      const vector = body.embedding;
      if (!Array.isArray(vector) || !vector.every((n): n is number => typeof n === 'number')) {
        warnOnce('embedding response was not a vector');
        return null;
      }

      if (vector.length !== EMBEDDING_DIMENSIONS) {
        // Silently storing the wrong width would fail at the database, one
        // insert at a time, with an error that says nothing about the cause.
        warnOnce(
          `embedding model "${options.model}" returns ${String(vector.length)} dimensions but the schema expects ${String(EMBEDDING_DIMENSIONS)} — recall stays keyword-only`,
        );
        return null;
      }

      return vector;
    } catch (error) {
      warnOnce('could not reach the embedding model — recall stays keyword-only', { error });
      return null;
    }
  };
}
