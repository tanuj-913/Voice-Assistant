import { describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { createTaskTools, type OpenTask, type TaskStore } from './tasks.js';
import { decide } from './policy.js';
import { buildToolRegistry } from './index.js';

/**
 * Task continuation.
 *
 * The promises being guarded are the same ones memory makes: nothing is
 * claimed that did not happen. Closing a task that does not exist is not
 * tidiness, and an unfinished task must stay unfinished until something
 * actually finishes it.
 */

const ctx = { online: true, signal: new AbortController().signal };
const policyCtx = { settings: UserSettings.parse({}), online: true };

function fakeStore(seed: OpenTask[] = []): TaskStore & { rows: OpenTask[] } {
  const rows = [...seed];
  return {
    rows,
    start: (goal) => {
      const id = `t-${String(rows.length)}`;
      rows.push({ id, goal, status: 'running', summary: null });
      return Promise.resolve(id);
    },
    finish: (id, status, summary) => {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = status;
        row.summary = summary;
      }
      return Promise.resolve();
    },
    unfinished: (limit) =>
      Promise.resolve(rows.filter((r) => r.status !== 'closed').slice(0, limit)),
    close: (id) => {
      const row = rows.find((r) => r.id === id && r.status !== 'closed');
      if (!row) return Promise.resolve(false);
      row.status = 'closed';
      return Promise.resolve(true);
    },
  };
}

const tools = (store: TaskStore | null) => {
  const [list, close] = createTaskTools(store);
  return { list, close };
};

describe('listing what is outstanding', () => {
  it('reads without asking', () => {
    const { list } = tools(fakeStore());
    expect(decide(list.metadata, policyCtx).action).toBe('allow');
  });

  it('says plainly when nothing is outstanding', async () => {
    const { list } = tools(fakeStore());
    const result = await list.execute({ limit: 5 }, ctx);
    expect(list.speak?.(result._unsafeUnwrap())).toBe('Nothing is outstanding.');
  });

  /** A list of tasks is for the model to phrase, not to read out verbatim. */
  it('leaves a real list to the model', async () => {
    const { list } = tools(
      fakeStore([{ id: 'a', goal: 'move the photos', status: 'partial', summary: null }]),
    );
    const result = await list.execute({ limit: 5 }, ctx);
    expect(list.speak?.(result._unsafeUnwrap())).toBeNull();
  });
});

describe('closing one', () => {
  it('closes it and says it will not come up again', async () => {
    const store = fakeStore([
      { id: 'a', goal: 'move the photos', status: 'partial', summary: null },
    ]);
    const { close } = tools(store);
    const result = await close.execute({ id: 'a' }, ctx);
    expect(close.speak?.(result._unsafeUnwrap())).toMatch(/won't bring it up again/i);
    expect(await store.unfinished(5)).toHaveLength(0);
  });

  /**
   * Closing nothing is not closing something. The renderer declines so the
   * model has to explain, rather than confirming a tidiness that never
   * happened.
   */
  it('does not claim to have closed a task that was not there', async () => {
    const { close } = tools(fakeStore());
    const result = await close.execute({ id: 'ghost' }, ctx);
    expect((result._unsafeUnwrap() as { closed?: boolean }).closed).toBe(false);
    expect(close.speak?.(result._unsafeUnwrap())).toBeNull();
  });
});

describe('without a store', () => {
  /** Registered regardless, so the model can say the capability is off. */
  it('is registered but reports itself unconfigured', async () => {
    const names = buildToolRegistry()
      .list()
      .map((t) => t.metadata.name);
    expect(names).toContain('list_tasks');
    expect(names).toContain('close_task');

    const { list } = tools(null);
    const result = await list.execute({ limit: 5 }, ctx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('tasks_unavailable');
  });
});
