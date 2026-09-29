import { describe, expect, it, vi } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { createSlackTools } from './slack.js';
import { decide } from '../policy.js';

/**
 * Slack is the first connector that can embarrass someone in public. The tests
 * are mostly about the failure modes: never posting to a guessed channel,
 * never claiming a message was sent, and never reading a workspace without
 * asking.
 */

const ctx = { online: true, signal: AbortSignal.timeout(5000) };
const policyCtx = { settings: UserSettings.parse({}), online: true };

const json = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

const channels = {
  ok: true,
  channels: [
    { id: 'C1', name: 'general' },
    { id: 'C2', name: 'eng' },
  ],
};

describe('posting', () => {
  it('resolves the channel name to an id before posting', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      calls.push(url);
      if (url.endsWith('conversations.list')) return json(channels);
      // Slack accepts a name on some endpoints and an id on others; posting
      // by id is the one that behaves.
      const body = JSON.parse(init.body) as { channel?: unknown };
      expect(body.channel).toBe('C2');
      return json({ ok: true });
    });

    const { send } = createSlackTools({ token: 'x' });
    const result = await send.execute({ channel: '#eng', text: 'hello' }, ctx);

    expect(result.isOk()).toBe(true);
    expect(send.speak?.(result._unsafeUnwrap())).toBe('Posted to #eng.');
    expect(calls.some((c) => c.endsWith('conversations.list'))).toBe(true);
  });

  /**
   * The failure worth guarding hardest: posting to the wrong channel is a
   * public mistake, so an unmatched name asks rather than guesses.
   */
  it('asks instead of guessing when the channel does not exist', async () => {
    vi.stubGlobal('fetch', () => json(channels));
    const { send } = createSlackTools({ token: 'x' });

    const result = await send.execute({ channel: '#nowhere', text: 'hello' }, ctx);
    const value = result._unsafeUnwrap();

    expect((value as { sent: boolean }).sent).toBe(false);
    expect(send.speak?.(value)).toBeNull();
    expect(send.clarify?.(value)?.question).toMatch(/could not find that channel/i);
  });

  it('surfaces an auth failure verbatim, since only the user can fix it', async () => {
    vi.stubGlobal('fetch', () => json({ ok: false, error: 'invalid_auth' }));
    const { send } = createSlackTools({ token: 'bad' });

    const result = await send.execute({ channel: '#eng', text: 'hi' }, ctx);
    expect(result.isErr()).toBe(true);
  });
});

describe('when Slack is not connected', () => {
  const { send, search, listChannels } = createSlackTools({ token: undefined });

  it.each([
    ['send', () => send.execute({ channel: '#eng', text: 'hi' }, ctx)],
    ['search', () => search.execute({ query: 'invoice', limit: 5 }, ctx)],
    ['list', () => listChannels.execute({ limit: 5 }, ctx)],
  ])('%s explains rather than failing oddly', async (_name, run) => {
    const result = await run();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('slack_not_configured');
    // Names the scopes, because "it didn't work" is not actionable.
    expect(error.message).toMatch(/chat:write/);
  });
});

describe('policy', () => {
  const { send, search, listChannels } = createSlackTools({ token: 'x' });

  it('always confirms before posting', () => {
    expect(decide(send.metadata, policyCtx).action).toBe('confirm');
  });

  /**
   * Reading a workspace's messages is not a green "read permitted
   * information" action — these are other people's words.
   */
  it('always confirms before searching messages', () => {
    expect(decide(search.metadata, policyCtx).action).toBe('confirm');
  });

  it('lists channels without interrupting', () => {
    expect(decide(listChannels.metadata, policyCtx).action).toBe('allow');
  });

  it('cannot be pre-approved into silent posting', () => {
    const preApproved = {
      settings: UserSettings.parse({ alwaysConfirmTools: ['slack_send_message'] }),
      online: true,
    };
    expect(decide(send.metadata, preApproved).action).toBe('confirm');
  });
});
