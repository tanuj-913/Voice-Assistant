import { describe, expect, it } from 'vitest';
import { browserControlTool } from './mac/browser.js';
import { callContactTool, sendMessageTool } from './mac/comms.js';
import { mediaControlTool, nowPlayingTool, playMusicTool } from './mac/media.js';
import {
  appendNoteTool,
  createNoteTool,
  createReminderTool,
  revealInFinderTool,
  whatsAppTool,
} from './mac/productivity.js';
import { openAppTool, openUrlTool, setVolumeTool, systemInfoTool } from './mac/system.js';
import type { Tool } from './registry.js';

/**
 * Tools that can phrase their own result let the brain end the turn without a
 * second model call — the round trip that exists only to turn `{level: 40}`
 * into a sentence. Two rules make that safe, and both are tested here:
 * a renderer must decline (return null) whenever the result is anything other
 * than the plain success it knows how to describe, and it must never claim
 * more than happened.
 */

const say = (tool: Tool, result: unknown) => tool.speak?.(result) ?? null;

describe('speakable results', () => {
  it.each([
    [setVolumeTool, { level: 40 }, 'Volume set to 40 percent.'],
    [openAppTool, { opened: 'Safari' }, 'Opened Safari.'],
    [mediaControlTool, { action: 'pause' }, 'Paused.'],
    [mediaControlTool, { action: 'next' }, 'Skipped to the next track.'],
    [createNoteTool, { created: 'Shopping' }, 'Saved a note called Shopping.'],
    [appendNoteTool, { appended: true, note: 'Shopping' }, 'Added that to Shopping.'],
    [createReminderTool, { created: 'buy milk' }, 'Reminder set: buy milk.'],
    [revealInFinderTool, { revealed: '/Users/x/a.pdf' }, 'Showed it in Finder.'],
    [openUrlTool, { opened: 'https://example.com/?q=1' }, 'Opened that link.'],
    [callContactTool, { called: 'Rahul', via: 'phone' }, 'Calling Rahul.'],
    [sendMessageTool, { sent: true, to: 'Rahul' }, 'Message sent to Rahul.'],
    [playMusicTool, { source: 'apple-music', played: 'Yellow' }, 'Playing Yellow.'],
    [
      playMusicTool,
      { source: 'spotify', query: 'coldplay' },
      'Opened Spotify search for coldplay.',
    ],
    [
      playMusicTool,
      { source: 'youtube', query: 'lo-fi beats' },
      'Opened YouTube search for lo-fi beats.',
    ],
    [mediaControlTool, { action: 'pause', app: 'spotify' }, 'Paused.'],
    [
      nowPlayingTool,
      { app: 'spotify', state: 'playing', playing: 'Yellow', artist: 'Coldplay' },
      'Playing Yellow by Coldplay.',
    ],
    [
      nowPlayingTool,
      { app: 'spotify', state: 'paused', playing: 'Yellow', artist: 'Coldplay' },
      'Paused on Yellow by Coldplay.',
    ],
    [
      browserControlTool,
      { action: 'focus_tab', browser: 'chrome', matched: 'YouTube' },
      'Switched to YouTube.',
    ],
    [
      browserControlTool,
      { action: 'close_tab', browser: 'chrome', matched: 'Docs' },
      'Closed Docs.',
    ],
    [
      browserControlTool,
      { action: 'current_tab', browser: 'safari', tab: { title: 'Hacker News', url: 'https://x' } },
      "You're on Hacker News.",
    ],
    [
      systemInfoTool,
      { metric: 'time', raw: 'Tuesday 01 September 2026, 05:37 PM IST' },
      "It's 5:37 PM.",
    ],
  ])('renders %#', (tool, result, expected) => {
    expect(say(tool as Tool, result)).toBe(expected);
  });

  /**
   * Each of these is a success as far as the result envelope is concerned, but
   * not the success the renderer describes. Announcing them would be a lie.
   */
  it.each([
    ['no matching contact', callContactTool, { called: null, reason: 'No matching contact' }],
    [
      'no note to append to',
      appendNoteTool,
      { appended: false, reason: 'No note titled like "x"' },
    ],
    ['no track in the library', playMusicTool, { source: 'apple-music', played: null }],
    [
      'a reminder with a time to read out',
      createReminderTool,
      { created: 'x', dueAt: '2026-09-01T14:30' },
    ],
    ['an unexpected payload', setVolumeTool, { level: 'loud' }],
    ['an empty payload', openAppTool, {}],
    ['no player running at all', mediaControlTool, { action: 'pause', app: null }],
    [
      'raw battery output, which needs summarising',
      systemInfoTool,
      { metric: 'battery', raw: "Now drawing from 'AC Power'\n -InternalBattery-0	72%" },
    ],
    ['a clock reading it cannot parse', systemInfoTool, { metric: 'time', raw: 'unknown' }],
    ['nothing loaded in either player', nowPlayingTool, { playing: null }],
    ['no browser running', browserControlTool, { action: 'current_tab', browser: null }],
    [
      'no tab matching the request',
      browserControlTool,
      { action: 'focus_tab', browser: 'chrome', matched: null, reason: 'No tab matching "x"' },
    ],
    [
      'a tab list, which the model phrases better',
      browserControlTool,
      { action: 'list_tabs', browser: 'chrome', tabs: [{ title: 'a', url: 'b' }] },
    ],
  ])('declines and lets the model speak: %s', (_why, tool, result) => {
    expect(say(tool as Tool, result)).toBeNull();
  });

  /**
   * Updated 2026-09-03: WhatsApp messages are now actually sent, because
   * leaving every message sitting in the box was the user's complaint. The
   * rule underneath is unchanged and is what this really tests — "sent" is a
   * claim, and it is never made unless the send happened.
   */
  it('says a WhatsApp message was sent only when it was', () => {
    expect(whatsAppTool.speak?.({ opened: true, sent: true, to: 'Tilak CSM' })).toBe(
      'Sent to Tilak CSM.',
    );

    const unsent = whatsAppTool.speak?.({ opened: true, sent: false, to: 'Tilak CSM' }) ?? '';
    expect(unsent).toMatch(/ready to send/i);
    expect(unsent).not.toMatch(/^Sent/);
  });


  it('does not read a file path or a URL aloud', () => {
    expect(say(revealInFinderTool, { revealed: '/Users/x/Documents/report.pdf' })).not.toMatch(
      /\//,
    );
    expect(say(openUrlTool, { opened: 'https://example.com/?q=1&utm=2' })).not.toMatch(/http/);
  });
  it('never reads a browser tab URL aloud', () => {
    const spoken = browserControlTool.speak?.({
      action: 'current_tab',
      browser: 'chrome',
      tab: { title: 'Hacker News', url: 'https://news.ycombinator.com/item?id=1' },
    });
    expect(spoken).not.toMatch(/http|ycombinator/);
  });

  it('says "search results" rather than claiming a track is playing', () => {
    // play_music on Spotify or YouTube opens a search — nothing was chosen,
    // and a model summarising it as "playing X" would be wrong.
    for (const source of ['spotify', 'youtube']) {
      expect(playMusicTool.speak?.({ source, query: 'coldplay' })).toMatch(/search/i);
    }
  });
});
