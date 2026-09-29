import { and, cosineDistance, desc, eq, gt, sql } from 'drizzle-orm';
import type { AssistantDb } from './client.js';
import { memories } from './schema.js';

/**
 * Semantic recall over stored facts.
 *
 * Uses cosine distance against the HNSW index. The similarity floor matters:
 * without it every query returns the five least-unrelated rows, and the model
 * confidently builds on facts that have nothing to do with the question.
 */
export async function recallMemories(
  db: AssistantDb,
  embedding: readonly number[],
  opts: { limit?: number; minSimilarity?: number } = {},
) {
  const similarity = sql<number>`1 - (${cosineDistance(memories.embedding, [...embedding])})`;

  return db
    .select({
      id: memories.id,
      fact: memories.fact,
      tags: memories.tags,
      similarity,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(gt(similarity, opts.minSimilarity ?? 0.5)))
    .orderBy(desc(similarity))
    .limit(opts.limit ?? 5);
}

/** Keyword recall, used when the embedding model is unavailable. */
export async function recallMemoriesByKeyword(db: AssistantDb, query: string, limit = 5) {
  return db
    .select({ id: memories.id, fact: memories.fact, tags: memories.tags })
    .from(memories)
    .where(sql`to_tsvector('english', ${memories.fact}) @@ plainto_tsquery('english', ${query})`)
    .limit(limit);
}

/** Writes a fact, with a vector when one is available. */
export async function storeMemory(
  db: AssistantDb,
  fact: string,
  tags: string[],
  embedding?: readonly number[] | null,
) {
  const [row] = await db
    .insert(memories)
    .values({ fact, tags, ...(embedding ? { embedding: [...embedding] } : {}) })
    .returning({ id: memories.id, fact: memories.fact, tags: memories.tags });
  if (!row) throw new Error('the memory was not written');
  return row;
}

/** Most recent first — the order a person expects when reviewing their own data. */
export async function listMemories(db: AssistantDb, limit = 10) {
  return db
    .select({
      id: memories.id,
      fact: memories.fact,
      tags: memories.tags,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .orderBy(desc(memories.createdAt))
    .limit(limit);
}

/** False when nothing matched: deleting nothing is not the same as forgetting. */
export async function deleteMemory(db: AssistantDb, id: string): Promise<boolean> {
  const removed = await db.delete(memories).where(eq(memories.id, id)).returning({
    id: memories.id,
  });
  return removed.length > 0;
}

/**
 * Rewrites a stored fact.
 *
 * The embedding is rewritten with it, and that is the whole reason this is not
 * a bare `UPDATE`: leaving the old vector in place would mean the fact reads
 * one way and is recalled by another, which is worse than either the old text
 * or the new one alone. Passing `null` clears the vector, so an edit made
 * while the embedding model is unavailable degrades to keyword recall rather
 * than silently keeping a vector for text that no longer exists.
 */
export async function updateMemory(
  db: AssistantDb,
  id: string,
  fact: string,
  tags: string[],
  embedding?: readonly number[] | null,
) {
  const [row] = await db
    .update(memories)
    .set({ fact, tags, embedding: embedding ? [...embedding] : null })
    .where(eq(memories.id, id))
    .returning({ id: memories.id, fact: memories.fact, tags: memories.tags });
  return row ?? null;
}
