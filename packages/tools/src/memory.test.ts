import { describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { createMemoryTools, type MemoryStore, type StoredMemory } from './memory.js';
import { decide } from './policy.js';
import { buildToolRegistry } from './index.js';

/**
 * The PRD allows long-term memory "only for useful user-approved information",
 * with controls to view, edit and delete. So the tests here are less about
 * storage working and more about the promises around it: nothing is kept
 * silently, nothing is deleted casually, and Assistant never claims to know or to
 * have forgotten something it did not.
 */

function fakeStore(seed: StoredMemory[] = []): MemoryStore & { rows: StoredMemory[] } {
  const rows = [...seed];
  return {
    rows,
    remember: (fact, tags) => {
      const saved = { id: `id-${String(rows.length)}`, fact, tags };
      rows.push(saved);
      return Promise.resolve(saved);
    },
    edit: (id, fact, tags) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      row.fact = fact;
      row.tags = tags;
      return Promise.resolve(row);
    },
    recall: (query, limit) =>
      Promise.resolve(
        rows.filter((r) => r.fact.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
      ),
    list: (limit) => Promise.resolve(rows.slice(-limit).reverse()),
    forget: (id) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return Promise.resolve(false);
      rows.splice(index, 1);
      return Promise.resolve(true);
    },
  };
}

const ctx = { online: true, signal: AbortSignal.timeout(5000) };

describe('remember', () => {
  it('stores the fact and repeats it back', async () => {
    const store = fakeStore();
    const { rememberTool } = createMemoryTools(store);

    const result = await rememberTool.execute(
      { fact: 'I take my tea without sugar', tags: [] },
      ctx,
    );

    expect(result.isOk()).toBe(true);
    expect(store.rows[0]?.fact).toBe('I take my tea without sugar');
    // Repeating it back *is* the confirmation: the user hears exactly what was kept.
    expect(rememberTool.speak?.(result._unsafeUnwrap())).toBe(
      "I'll remember that I take my tea without sugar.",
    );
  });
});

describe('recall', () => {
  const store = fakeStore([
    { id: 'a', fact: 'I take my tea without sugar', tags: [] },
    { id: 'b', fact: 'my sister is called Meera', tags: [] },
  ]);
  const { recallTool } = createMemoryTools(store);

  it('answers directly when exactly one thing matches', async () => {
    const result = await recallTool.execute({ query: 'tea', limit: 5 }, ctx);
    expect(recallTool.speak?.(result._unsafeUnwrap())).toBe('I take my tea without sugar.');
  });

  /**
   * The alternative to saying this is inventing something, which is the worst
   * possible failure for a memory feature.
   */
  it('says it knows nothing rather than guessing', async () => {
    const result = await recallTool.execute({ query: 'my passport number', limit: 5 }, ctx);
    expect(recallTool.speak?.(result._unsafeUnwrap())).toBe("I don't have anything about that.");
  });

  it('leaves several matches to the model to compose', async () => {
    const many = fakeStore([
      { id: 'a', fact: 'my tea is without sugar', tags: [] },
      { id: 'b', fact: 'my tea is always strong', tags: [] },
    ]);
    const tools = createMemoryTools(many);
    const result = await tools.recallTool.execute({ query: 'tea', limit: 5 }, ctx);
    expect(tools.recallTool.speak?.(result._unsafeUnwrap())).toBeNull();
  });
});

describe('forget', () => {
  it('deletes the named memory', async () => {
    const store = fakeStore([{ id: 'a', fact: 'something', tags: [] }]);
    const { forgetTool } = createMemoryTools(store);

    const result = await forgetTool.execute({ id: 'a' }, ctx);

    expect(store.rows).toHaveLength(0);
    expect(forgetTool.speak?.(result._unsafeUnwrap())).toBe('Forgotten.');
  });

  it('does not claim to have forgotten something it never had', async () => {
    const { forgetTool } = createMemoryTools(fakeStore());
    const result = await forgetTool.execute({ id: 'missing' }, ctx);

    expect(forgetTool.speak?.(result._unsafeUnwrap())).toBe("I couldn't find that one to forget.");
  });
});

describe('when memory is not configured', () => {
  const tools = createMemoryTools(null);

  it('fails with an explanation rather than pretending to work', async () => {
    const result = await tools.rememberTool.execute({ fact: 'anything at all', tags: [] }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('memory_unavailable');
  });

  it('is still registered, so the model can say why it cannot', () => {
    const registry = buildToolRegistry({});
    for (const name of ['remember', 'recall', 'list_memories', 'forget']) {
      expect(registry.get(name), `${name} missing`).toBeDefined();
    }
  });
});

describe('policy around memory', () => {
  const registry = buildToolRegistry({ memory: fakeStore() });
  const policyCtx = { settings: UserSettings.parse({}), online: true };

  it('reads without interrupting', () => {
    for (const name of ['recall', 'list_memories']) {
      const tool = registry.get(name);
      expect(tool && decide(tool.metadata, policyCtx).action, name).toBe('allow');
    }
  });

  /**
   * Deleting someone's own data is not something a blanket pre-approval should
   * ever unlock, so `forget` is destructive rather than merely sensitive.
   */
  it('always confirms before forgetting, even if pre-approved', () => {
    const tool = registry.get('forget');
    const preApproved = {
      settings: UserSettings.parse({ autoApprovedTools: ['forget'] }),
      online: true,
    };
    expect(tool && decide(tool.metadata, preApproved).action).toBe('confirm');
  });
});
