import { childLogger } from '@assistant/core';
import {
  deleteMemory,
  listMemories,
  recallMemories,
  recallMemoriesByKeyword,
  storeMemory,
  updateMemory,
  type AssistantDb,
} from '@assistant/db';
import type { MemoryStore, StoredMemory } from '@assistant/tools';

const log = childLogger('memory');

/**
 * Postgres-backed long-term memory.
 *
 * The schema has carried an HNSW index over cosine distance since the first
 * day and nothing has ever written a vector to it, because no embedding model
 * is wired up. Rather than leave the whole feature unavailable waiting for
 * one, this stores facts now and recalls them by keyword, and takes an
 * optional `embed` so semantic recall lights up the moment an embedding model
 * exists — without the tools or the schema changing.
 *
 * Keyword recall is genuinely worse: "what do I drink in the morning" will not
 * find "I take my tea without sugar". That limitation is visible in the logs
 * rather than hidden, so it is obvious why recall feels literal.
 */
export interface MemoryStoreOptions {
  db: AssistantDb;
  /** Returns a vector for the text, or null when unavailable. */
  embed?: (text: string) => Promise<number[] | null>;
}

export function createDbMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const { db, embed } = options;
  let warnedAboutKeywords = false;

  const embedOrNull = async (text: string): Promise<number[] | null> => {
    if (!embed) return null;
    try {
      return await embed(text);
    } catch (error) {
      // An embedding failure must degrade recall, never lose the write.
      log.warn({ error }, 'embedding failed, falling back to keyword recall');
      return null;
    }
  };

  return {
    async remember(fact: string, tags: string[]): Promise<StoredMemory> {
      const embedding = await embedOrNull(fact);
      const row = await storeMemory(db, fact, tags, embedding);
      return { id: row.id, fact: row.fact, tags: row.tags };
    },

    async recall(query: string, limit: number): Promise<StoredMemory[]> {
      const embedding = await embedOrNull(query);
      if (embedding) {
        const found = await recallMemories(db, embedding, { limit });
        return found.map((m) => ({ id: m.id, fact: m.fact, tags: m.tags }));
      }

      if (!warnedAboutKeywords) {
        warnedAboutKeywords = true;
        log.info(
          'no embedding model configured — recall is keyword-only, so related wording will not match',
        );
      }
      const found = await recallMemoriesByKeyword(db, query, limit);
      return found.map((m) => ({ id: m.id, fact: m.fact, tags: m.tags }));
    },

    async list(limit: number): Promise<StoredMemory[]> {
      const rows = await listMemories(db, limit);
      return rows.map((r) => ({
        id: r.id,
        fact: r.fact,
        tags: r.tags,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async edit(id: string, fact: string, tags: string[]): Promise<StoredMemory | null> {
      // Re-embedded, not just rewritten: a vector describing the old wording
      // would keep pulling this fact up for the wrong questions.
      const embedding = await embedOrNull(fact);
      const row = await updateMemory(db, id, fact, tags, embedding);
      return row ? { id: row.id, fact: row.fact, tags: row.tags } : null;
    },

    // Reported honestly: deleting nothing is not the same as forgetting.
    forget: (id: string): Promise<boolean> => deleteMemory(db, id),
  };
}
