import { describe, expect, it } from 'vitest';
import { TypedEmitter } from '@assistant/core';
import type { ServerEvent } from '@assistant/schemas';
import { buildToolRegistry, type MemoryStore, type StoredMemory } from '@assistant/tools';
import { createServer } from './server.js';
import { SettingsStore } from './settings-store.js';
import type { Orchestrator } from './orchestrator.js';
import type { VoiceStack } from './voice.js';

/**
 * The routes that make Assistant's own state visible and editable.
 *
 * Until these existed the user could not see what was stored about them, could
 * not correct it, and could not change a single preference — the settings
 * schema described choices nobody could make. These tests are mostly about the
 * unhappy paths, because that is where a control surface lies: an edit that
 * matched nothing must not come back looking saved.
 */

function harness(opts: { memory?: MemoryStore | null; settings?: SettingsStore } = {}) {
  const settings = opts.settings ?? SettingsStore.inMemory();
  const { app } = createServer({
    events: new TypedEmitter<ServerEvent>(),
    orchestrator: { busy: false } as unknown as Orchestrator,
    voice: { configured: true } as unknown as VoiceStack,
    settings,
    registry: buildToolRegistry({ slackToken: 'x' }),
    memory: opts.memory ?? null,
    port: 0,
  });
  return { app, settings };
}

function fakeMemory(seed: StoredMemory[]): MemoryStore {
  const rows = [...seed];
  return {
    remember: (fact, tags) => Promise.resolve({ id: 'new', fact, tags }),
    recall: () => Promise.resolve([]),
    list: (limit) => Promise.resolve(rows.slice(0, limit)),
    edit: (id, fact, tags) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      row.fact = fact;
      row.tags = tags;
      return Promise.resolve(row);
    },
    forget: (id) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at === -1) return Promise.resolve(false);
      rows.splice(at, 1);
      return Promise.resolve(true);
    },
  };
}

describe('settings', () => {
  it('reports the settings in force', async () => {
    const { app } = harness();
    const body = (await (await app.request('/settings')).json()) as {
      settings: { wakeWordEnabled: boolean };
    };
    expect(body.settings.wakeWordEnabled).toBe(true);
  });

  it('applies a change and keeps it', async () => {
    const { app } = harness();
    const patched = await app.request('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ wakeWordEnabled: false }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patched.status).toBe(200);

    const body = (await (await app.request('/settings')).json()) as {
      settings: { wakeWordEnabled: boolean };
    };
    expect(body.settings.wakeWordEnabled).toBe(false);
  });

  /** A rejected setting names the field, so the UI can point at it. */
  it('refuses an invalid value with the field that caused it', async () => {
    const { app } = harness();
    const response = await app.request('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ preferredLanguage: 'martian' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues[0]?.path).toBe('preferredLanguage');
  });
});

describe('the tool declarations', () => {
  it('publishes what each tool is, needs and risks', async () => {
    const { app } = harness();
    const body = (await (await app.request('/tools')).json()) as {
      tools: { name: string; connector: string; scopes: string[]; rollback: string }[];
    };

    const slack = body.tools.find((t) => t.name === 'slack_send_message');
    expect(slack?.connector).toBe('http');
    expect(slack?.scopes).toEqual(['chat:write']);

    // The declaration reflects what is implemented, not what was hoped for.
    expect(body.tools.find((t) => t.name === 'move_file')?.rollback).toBe('supported');
    expect(body.tools.find((t) => t.name === 'send_email')?.rollback).toBe('none');
  });

  /**
   * The confirmation shown here is computed from the user's live settings, so
   * the page cannot claim a tool will prompt when their own preference says
   * otherwise.
   */
  it('reflects the user’s own approvals', async () => {
    const settings = SettingsStore.inMemory({ autoApprovedTools: ['send_message'] });
    const { app } = harness({ settings });
    const body = (await (await app.request('/tools')).json()) as {
      tools: { name: string; confirmation: string }[];
    };
    expect(body.tools.find((t) => t.name === 'send_message')?.confirmation).toBe('allow');
    // And a destructive tool is still confirmed, whatever they approved.
    expect(body.tools.find((t) => t.name === 'move_to_trash')?.confirmation).toBe('normal');
  });
});

describe('memory the user can see', () => {
  const seed = (): StoredMemory[] => [
    { id: 'a', fact: 'I take my tea without sugar', tags: ['food'] },
    { id: 'b', fact: 'My sister is called Meera', tags: ['people'] },
  ];

  it('lists what is stored', async () => {
    const { app } = harness({ memory: fakeMemory(seed()) });
    const body = (await (await app.request('/memories')).json()) as {
      memories: StoredMemory[];
      configured: boolean;
    };
    expect(body.configured).toBe(true);
    expect(body.memories).toHaveLength(2);
  });

  it('says memory is unconfigured rather than pretending it is empty', async () => {
    const { app } = harness({ memory: null });
    const body = (await (await app.request('/memories')).json()) as { configured: boolean };
    expect(body.configured).toBe(false);
  });

  it('corrects a fact', async () => {
    const memory = fakeMemory(seed());
    const { app } = harness({ memory });
    const response = await app.request('/memories/a', {
      method: 'PATCH',
      body: JSON.stringify({ fact: 'I take my tea with one sugar', tags: ['food'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect((await memory.list(10))[0]?.fact).toBe('I take my tea with one sugar');
  });

  /** An edit that matched nothing changed nothing, and must not read as saved. */
  it('404s an edit to a memory that is not there', async () => {
    const { app } = harness({ memory: fakeMemory(seed()) });
    const response = await app.request('/memories/missing', {
      method: 'PATCH',
      body: JSON.stringify({ fact: 'Something else entirely', tags: [] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  it('refuses an empty fact', async () => {
    const { app } = harness({ memory: fakeMemory(seed()) });
    const response = await app.request('/memories/a', {
      method: 'PATCH',
      body: JSON.stringify({ fact: '' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  it('deletes one, and says so honestly when there was nothing to delete', async () => {
    const memory = fakeMemory(seed());
    const { app } = harness({ memory });
    expect((await app.request('/memories/b', { method: 'DELETE' })).status).toBe(200);
    expect(await memory.list(10)).toHaveLength(1);
    expect((await app.request('/memories/b', { method: 'DELETE' })).status).toBe(404);
  });
});
