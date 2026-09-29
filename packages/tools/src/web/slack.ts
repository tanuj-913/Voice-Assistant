import { appError, errAsync, fromPromise, type AppResultAsync } from '@assistant/core';
import { SlackSearchInput, SlackSendInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';

/**
 * Slack through its Web API.
 *
 * Unlike Mail, Slack ships no useful AppleScript dictionary, so there is no
 * token-free route: reading or sending anything needs a token with scopes. The
 * alternatives were `slack://` deep links, which need channel and team ids that
 * only the API can resolve, and UI scripting through System Events, which is
 * fragile and needs Accessibility permission. Neither is worth shipping.
 *
 * The tools register with or without a token — a model told the capability
 * exists can explain that it is unconfigured, where a silently absent tool just
 * looks like Assistant ignoring the request.
 *
 * Channel names are resolved to ids rather than passed through: Slack's API
 * accepts a name in some endpoints and an id in others, and the failure when it
 * does not is a generic `channel_not_found` that says nothing useful.
 */

const API = 'https://slack.com/api';

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** Slack answers HTTP 200 with `{ok: false}`; the real status is in the body. */
async function call(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<SlackResponse> {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal,
  });
  const parsed = (await response.json()) as SlackResponse;
  if (!parsed.ok) {
    // `invalid_auth` and `missing_scope` are the two a user can actually fix,
    // so they are worth passing through verbatim rather than flattening.
    throw new Error(parsed.error ?? `slack ${method} failed`);
  }
  return parsed;
}

async function resolveChannel(
  token: string,
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  const wanted = name.replace(/^#/, '').toLowerCase();
  const result = await call(
    token,
    'conversations.list',
    { limit: 1000, exclude_archived: true, types: 'public_channel,private_channel' },
    signal,
  );
  const channels = Array.isArray(result.channels) ? result.channels : [];
  for (const channel of channels) {
    const c = channel as { id?: unknown; name?: unknown };
    if (typeof c.name === 'string' && c.name.toLowerCase() === wanted && typeof c.id === 'string') {
      return c.id;
    }
  }
  return null;
}

export interface SlackOptions {
  /** A bot or user token. Without one the tools explain rather than fail oddly. */
  token?: string | undefined;
}

export function createSlackTools(options: SlackOptions) {
  const token = options.token;
  const missing = () =>
    errAsync(
      appError(
        'slack_not_configured',
        'Slack is not connected. Add SLACK_TOKEN to .env with chat:write and channels:read scopes.',
      ),
    );

  const send = defineTool({
    metadata: {
      name: 'slack_send_message',
      description:
        'Post a message to a Slack channel. Use the channel name, with or without the leading #.',
      category: 'communication',
      // Leaves the machine, reaches other people, cannot be unsent.
      risk: 'external',
      connector: 'http',
      scopes: ['chat:write'],
      requiresNetwork: true,
      timeoutMs: 20_000,
    },
    input: SlackSendInput,
    execute: (args, ctx): AppResultAsync<unknown> => {
      if (!token) return missing();
      return fromPromise(
        (async () => {
          const channelId = await resolveChannel(token, args.channel, ctx.signal);
          if (!channelId) {
            // Reported, not guessed at. Posting to the wrong channel is a
            // public mistake.
            return { sent: false, channel: args.channel, reason: 'no channel by that name' };
          }
          await call(
            token,
            'chat.postMessage',
            { channel: channelId, text: args.text },
            ctx.signal,
          );
          return { sent: true, channel: args.channel };
        })(),
        'slack_send_failed',
      );
    },
    speak: (result) => {
      const r = result as { sent?: unknown; channel?: unknown };
      return r.sent === true && typeof r.channel === 'string'
        ? `Posted to ${r.channel.startsWith('#') ? r.channel : `#${r.channel}`}.`
        : null;
    },
    clarify: (result) => {
      const r = result as { sent?: unknown; reason?: unknown };
      return r.sent === false && typeof r.reason === 'string'
        ? { question: 'I could not find that channel. Which one did you mean?', options: [] }
        : null;
    },
  });

  const search = defineTool({
    metadata: {
      name: 'slack_search',
      description:
        'Search Slack messages for a phrase and report who said what, and where. Needs a user token with search:read.',
      category: 'communication',
      /**
       * Gated for the same reason as `search_mail`: reading a workspace's
       * messages is not a green "read permitted information" action, and a
       * misheard word must never read colleagues' messages aloud.
       */
      risk: 'destructive',
      connector: 'http',
      scopes: ['search:read'],
      requiresNetwork: true,
      timeoutMs: 20_000,
    },
    input: SlackSearchInput,
    execute: (args, ctx): AppResultAsync<unknown> => {
      if (!token) return missing();
      return fromPromise(
        (async () => {
          const result = await call(
            token,
            'search.messages',
            { query: args.query, count: args.limit },
            ctx.signal,
          );
          const messages = (result.messages as { matches?: unknown } | undefined)?.matches;
          const matches = Array.isArray(messages) ? messages : [];
          return {
            query: args.query,
            matches: matches.slice(0, args.limit).map((m) => {
              const match = m as { text?: unknown; username?: unknown; channel?: unknown };
              const channel = match.channel as { name?: unknown } | undefined;
              return {
                from: typeof match.username === 'string' ? match.username : 'someone',
                channel: typeof channel?.name === 'string' ? channel.name : 'a channel',
                text: typeof match.text === 'string' ? match.text.slice(0, 300) : '',
              };
            }),
          };
        })(),
        'slack_search_failed',
      );
    },
    speak: (result) => {
      const r = result as { matches?: unknown };
      return Array.isArray(r.matches) && r.matches.length === 0
        ? 'Nothing in Slack matches that.'
        : null;
    },
  });

  const listChannels = defineTool({
    metadata: {
      name: 'slack_list_channels',
      description: 'List the Slack channels Assistant can post to.',
      category: 'communication',
      risk: 'read',
      connector: 'http',
      // Someone else's server, read-only: a failed request is worth one
      // more try, and repeating it changes nothing.
      retry: { maxAttempts: 2, backoffMs: 400 },
      scopes: ['channels:read', 'groups:read'],
      requiresNetwork: true,
      timeoutMs: 20_000,
    },
    input: SlackSearchInput.pick({ limit: true }),
    execute: (args, ctx): AppResultAsync<unknown> => {
      if (!token) return missing();
      return fromPromise(
        (async () => {
          const result = await call(
            token,
            'conversations.list',
            { limit: 1000, exclude_archived: true, types: 'public_channel,private_channel' },
            ctx.signal,
          );
          const channels = Array.isArray(result.channels) ? result.channels : [];
          return {
            channels: channels
              .map((c) => (c as { name?: unknown }).name)
              .filter((n): n is string => typeof n === 'string')
              .slice(0, args.limit),
          };
        })(),
        'slack_list_failed',
      );
    },
  });

  return { send, search, listChannels };
}

export function slackTools(options: SlackOptions) {
  const tools = createSlackTools(options);
  return [tools.send, tools.search, tools.listChannels];
}
