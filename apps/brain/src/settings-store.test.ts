import { describe, expect, it } from 'vitest';
import type { AssistantDb } from '@assistant/db';
import { SettingsStore } from './settings-store.js';

/**
 * Settings only mean something if they survive a restart and if a bad row
 * cannot stop one. Both halves are tested here against a hand-rolled database
 * rather than a mocking framework, because what matters is the shape of the
 * two calls, and a fake that has to satisfy the real query builder is a more
 * honest test than one that asserts a spy was called.
 */

function fakeDb(stored: unknown, opts: { failWrite?: boolean; failRead?: boolean } = {}) {
  const writes: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            opts.failRead
              ? Promise.reject(new Error('no such table'))
              : Promise.resolve(stored === null ? [] : [{ value: stored }]),
        }),
      }),
    }),
    insert: () => ({
      values: (row: { value: unknown }) => ({
        onConflictDoUpdate: () => {
          if (opts.failWrite) return Promise.reject(new Error('disk full'));
          writes.push(row.value);
          return Promise.resolve(undefined);
        },
      }),
    }),
  } as unknown as AssistantDb;
  return { db, writes };
}

describe('loading', () => {
  it('uses defaults when nothing has been saved yet', async () => {
    const { db } = fakeDb(null);
    const store = await SettingsStore.load(db);
    expect(store.current.wakeWordEnabled).toBe(true);
    expect(store.current.autoApprovedTools).toEqual([]);
  });

  it('restores what the user chose last time', async () => {
    const { db } = fakeDb({
      preferredLanguage: 'hi-IN',
      wakeWordEnabled: false,
      autoApprovedTools: ['send_message'],
    });
    const store = await SettingsStore.load(db);
    expect(store.current.preferredLanguage).toBe('hi-IN');
    expect(store.current.wakeWordEnabled).toBe(false);
    expect(store.current.autoApprovedTools).toEqual(['send_message']);
  });

  /**
   * A row written by an older version, or edited by hand, must not stop the
   * assistant from starting. Booting on defaults is recoverable; refusing to
   * boot means the user cannot reach the setting that would fix it.
   */
  it('falls back to defaults rather than refusing to start', async () => {
    const { db } = fakeDb({ preferredLanguage: 'klingon', hotkey: 42 });
    const store = await SettingsStore.load(db);
    expect(store.current.preferredLanguage).toBe('auto');
  });

  it('survives a settings table it cannot read', async () => {
    const { db } = fakeDb(null, { failRead: true });
    const store = await SettingsStore.load(db);
    expect(store.current.wakeWordEnabled).toBe(true);
  });
});

describe('updating', () => {
  it('merges a patch instead of replacing everything', async () => {
    const { db, writes } = fakeDb({ preferredLanguage: 'ta-IN', wakeWordEnabled: false });
    const store = await SettingsStore.load(db);

    const outcome = await store.update({ wakeWordEnabled: true });
    expect(outcome.ok).toBe(true);
    // The field nobody touched is still what it was — sending the whole object
    // back from a page loaded before a new field existed would reset it.
    expect(store.current.preferredLanguage).toBe('ta-IN');
    expect(store.current.wakeWordEnabled).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('names the field that was wrong instead of throwing', async () => {
    const store = SettingsStore.inMemory();
    const outcome = await store.update({ preferredLanguage: 'martian' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.path).toBe('preferredLanguage');
    // And nothing changed.
    expect(store.current.preferredLanguage).toBe('auto');
  });

  it('rejects a patch that is not an object', async () => {
    const store = SettingsStore.inMemory();
    expect((await store.update('everything on')).ok).toBe(false);
    expect((await store.update(['a'])).ok).toBe(false);
  });

  /**
   * The write happens first. A setting that appears saved but was not is
   * worse than one that visibly failed — the user would go on believing the
   * wake word is off.
   */
  it('does not change the live value when the write fails', async () => {
    const { db } = fakeDb({ wakeWordEnabled: true }, { failWrite: true });
    const store = await SettingsStore.load(db);

    const outcome = await store.update({ wakeWordEnabled: false });
    expect(outcome.ok).toBe(false);
    expect(store.current.wakeWordEnabled).toBe(true);
  });

  /**
   * The policy engine reads these, so this is the seam where a preference
   * becomes behaviour. `alwaysConfirmTools` beats everything, and nothing here
   * can relax a destructive tool — that is enforced in the engine, not here.
   */
  it('feeds the policy engine what the user actually chose', async () => {
    const store = SettingsStore.inMemory();
    await store.update({ autoApprovedTools: ['send_message'] });
    expect(store.current.autoApprovedTools).toEqual(['send_message']);
  });
});
