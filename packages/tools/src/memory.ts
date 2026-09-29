import { z } from 'zod';
import { appError, errAsync, fromPromise, type AppResultAsync } from '@assistant/core';
import { ForgetInput, RecallInput, RememberInput } from '@assistant/schemas';
import { defineTool } from './registry.js';

/**
 * Long-term memory.
 *
 * The PRD is specific that this is "long-term memory only for useful
 * user-approved information", with controls to view, edit and delete. So
 * remembering is an explicit act with a confirmation, not a background habit —
 * an assistant that silently accumulates facts about someone is a different
 * and worse product than one that asks.
 *
 * The store is injected rather than imported so these tools can be tested
 * without Postgres, and so the brain owns the embedding model rather than the
 * tool layer reaching for one.
 */

export interface StoredMemory {
  id: string;
  fact: string;
  tags: string[];
  createdAt?: string;
}

export interface MemoryStore {
  remember: (fact: string, tags: string[]) => Promise<StoredMemory>;
  /** Semantic where possible, keyword when the embedding model is absent. */
  recall: (query: string, limit: number) => Promise<StoredMemory[]>;
  list: (limit: number) => Promise<StoredMemory[]>;
  /**
   * Rewrites a fact the user has corrected. Null when the id matched nothing —
   * "edited" is a claim, and it needs a row behind it.
   */
  edit: (id: string, fact: string, tags: string[]) => Promise<StoredMemory | null>;
  /** Returns false when nothing matched, so Assistant can say so honestly. */
  forget: (id: string) => Promise<boolean>;
}

const wrap = <T>(work: Promise<T>, code: string): AppResultAsync<T> => fromPromise(work, code);

export function createMemoryTools(store: MemoryStore | null) {
  const unavailable = () =>
    errAsync(appError('memory_unavailable', 'Long-term memory is not configured.'));

  const rememberTool = defineTool({
    metadata: {
      name: 'remember',
      description:
        'Store a durable fact about the user for later recall, such as a preference or a recurring detail. Only for things worth keeping.',
      category: 'knowledge',
      risk: 'reversible',
      connector: 'postgres',
      requiresNetwork: false,
    },
    input: RememberInput,
    execute: (args) =>
      store
        ? wrap(store.remember(args.fact, args.tags), 'memory_write_failed').map((saved) => ({
            remembered: saved.fact,
            id: saved.id,
          }))
        : unavailable(),
    speak: (result) => {
      const fact = (result as { remembered?: unknown }).remembered;
      // Repeating it back is the confirmation — the user hears exactly what
      // was kept, which is the point of asking before storing.
      return typeof fact === 'string' ? `I'll remember that ${fact}.` : null;
    },
  });

  const recallTool = defineTool({
    metadata: {
      name: 'recall',
      description:
        'Look up something the user asked to be remembered. Use when a request refers to a preference or detail from earlier.',
      category: 'knowledge',
      risk: 'read',
      connector: 'postgres',
      requiresNetwork: false,
    },
    input: RecallInput,
    execute: (args) =>
      store
        ? wrap(store.recall(args.query, args.limit), 'memory_read_failed').map((found) => ({
            query: args.query,
            found: found.map((m) => m.fact),
          }))
        : unavailable(),
    speak: (result) => {
      const found = (result as { found?: unknown }).found;
      if (!Array.isArray(found)) return null;
      // Nothing found is a real answer, and a better one than inventing.
      if (found.length === 0) return "I don't have anything about that.";
      // More than one needs composing, which is what the model is for.
      return found.length === 1 && typeof found[0] === 'string' ? `${found[0]}.` : null;
    },
  });

  const listMemoriesTool = defineTool({
    metadata: {
      name: 'list_memories',
      description: 'List what Assistant has been asked to remember, most recent first.',
      category: 'knowledge',
      risk: 'read',
      connector: 'postgres',
      requiresNetwork: false,
    },
    input: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    execute: (args) =>
      store
        ? wrap(store.list(args.limit), 'memory_read_failed').map((found) => ({
            memories: found.map((m) => ({ id: m.id, fact: m.fact })),
          }))
        : unavailable(),
  });

  const forgetTool = defineTool({
    metadata: {
      name: 'forget',
      description: 'Delete a stored memory by its id. Use after list_memories identifies it.',
      category: 'knowledge',
      // Deleting the user's own data: it prompts, and pre-approval cannot
      // unlock it. Forgetting the wrong thing is not recoverable.
      risk: 'destructive',
      connector: 'postgres',
      requiresNetwork: false,
    },
    input: ForgetInput,
    execute: (args) =>
      store
        ? wrap(store.forget(args.id), 'memory_write_failed').map((removed) => ({
            forgotten: removed,
            id: args.id,
          }))
        : unavailable(),
    speak: (result) => {
      const removed = (result as { forgotten?: unknown }).forgotten;
      if (removed === true) return 'Forgotten.';
      // Saying "done" when nothing was deleted is the lie this avoids.
      return removed === false ? "I couldn't find that one to forget." : null;
    },
  });

  return { rememberTool, recallTool, listMemoriesTool, forgetTool };
}

/** Convenience for callers that only want the array. */
export function memoryTools(store: MemoryStore | null) {
  const tools = createMemoryTools(store);
  return [tools.rememberTool, tools.recallTool, tools.listMemoriesTool, tools.forgetTool];
}
