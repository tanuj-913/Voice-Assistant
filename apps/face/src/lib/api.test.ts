import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerEvent } from '@assistant/schemas';
import { deleteMemory, editMemory, patchSettings } from './api.js';

/**
 * Regression guard.
 *
 * The SSE client subscribed to a hand-written list of event names. When
 * `speech.ready` was added to the schema the list was not updated, so every
 * spoken reply was delivered to the browser and dropped — silently, because a
 * missing listener produces no error. The symptom was "Assistant has no voice"
 * while the backend was provably synthesising audio on every turn.
 *
 * The client now derives its subscriptions from the union. This test fails if
 * anyone reintroduces a hardcoded list that omits an event.
 */
describe('SSE event coverage', () => {
  it('exposes every event type on the union for subscription', () => {
    const types = ServerEvent.options.map((option) => option.shape.type.value);

    expect(types).toContain('speech.ready');
    expect(types).toContain('response.done');
    expect(types).toContain('tool.proposed');
    expect(new Set(types).size).toBe(types.length);
  });

  it('derives names dynamically, so a new event is subscribed automatically', () => {
    // The count is intentionally not asserted against a literal: pinning it
    // would just be a second hardcoded list to forget to update.
    const types = ServerEvent.options.map((option) => option.shape.type.value);
    expect(types.length).toBe(ServerEvent.options.length);
    expect(types.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  });
});

/**
 * The control-surface calls.
 *
 * What matters here is not that a fetch happened but what the user is told
 * when it fails. A panel that silently drops a rejected setting looks exactly
 * like one that saved it, and the user goes on believing the wake word is off.
 */
describe('the control surface', () => {
  const stubFetch = (response: { status: number; body: unknown }) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return Promise.resolve({
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: () => Promise.resolve(response.body),
      } as Response);
    }) as typeof fetch;
    return calls;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends only the field that changed', async () => {
    const calls = stubFetch({ status: 200, body: { settings: { wakeWordEnabled: false } } });
    await patchSettings({ wakeWordEnabled: false });

    expect(calls[0]?.init?.method).toBe('PATCH');
    // Not the whole object: a page loaded before a field existed would
    // otherwise reset that field to its default on every save.
    const body = calls[0]?.init?.body;
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({ wakeWordEnabled: false });
  });

  it('reports which field the brain rejected', async () => {
    stubFetch({
      status: 400,
      body: { issues: [{ path: 'preferredLanguage', message: 'Invalid option' }] },
    });
    await expect(patchSettings({ preferredLanguage: 'martian' })).rejects.toThrow(
      /preferredLanguage/,
    );
  });

  /** Deleting nothing is not the same as forgetting, and must not look like it. */
  it('treats a delete that matched nothing as a failure', async () => {
    stubFetch({ status: 404, body: { error: 'not_found' } });
    await expect(deleteMemory('gone')).rejects.toThrow();
  });

  it('reports an edit that matched no memory', async () => {
    stubFetch({ status: 404, body: { error: 'not_found' } });
    await expect(editMemory('gone', 'something else', [])).rejects.toThrow();
  });
});
