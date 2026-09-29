import { describe, expect, it } from 'vitest';
import { FAST_PATH_TOOLS, matchIntent, parseSpokenNumber } from './intent.js';
import { buildToolRegistry } from './index.js';
import { decide } from './policy.js';
import { UserSettings } from '@assistant/schemas';

/**
 * The fast path exists to skip 22 seconds of a language model deciding to call
 * a tool that then runs in 8 ms. Its danger is the mirror image: hijacking a
 * sentence it cannot actually fulfil. Both halves are tested — what must
 * route, and what must be left alone.
 */
describe('matchIntent — routes', () => {
  it.each([
    ['pause', 'media_control', { action: 'pause' }],
    ['Pause the music.', 'media_control', { action: 'pause' }],
    ['pause the song please', 'media_control', { action: 'pause' }],
    ['play', 'media_control', { action: 'play' }],
    ['resume the music', 'media_control', { action: 'play' }],
    ['next', 'media_control', { action: 'next' }],
    ['skip this song', 'media_control', { action: 'next' }],
    ['previous track', 'media_control', { action: 'previous' }],
    ["what's playing", 'now_playing', {}],
    ['which song is this', 'now_playing', {}],
    ['what time is it', 'system_info', { metric: 'time' }],
    ["what's the time", 'system_info', { metric: 'time' }],
    ['battery', 'system_info', { metric: 'battery' }],
    ['how much battery is left', 'system_info', { metric: 'battery' }],
    ['set volume to 40', 'set_volume', { level: 40 }],
    ['volume 70 percent', 'set_volume', { level: 70 }],
    ['mute', 'set_volume', { level: 0 }],
    ['what am i looking at', 'browser_control', { action: 'current_tab' }],
  ])('%j routes to %s', (text, tool, args) => {
    const match = matchIntent(text);
    expect(match?.tool).toBe(tool);
    expect(match?.args).toEqual(args);
  });

  it('ignores wake words and politeness', () => {
    expect(matchIntent('Hey Assistant, pause please')?.tool).toBe('media_control');
    expect(matchIntent('Assistant could you mute')?.args).toEqual({ level: 0 });
  });
});

describe('matchIntent — deliberately declines', () => {
  /**
   * Each of these contains a phrase the router knows, inside a request it
   * cannot fulfil. Matching on substrings would answer the wrong question
   * confidently, which is worse than being slow.
   */
  it.each([
    'pause and tell me what was playing before that',
    'play something by Coldplay',
    'what time is it in Tokyo',
    'set volume to 40 and open Safari',
    'why is my battery draining so fast',
    'skip to the part about pricing',
    'what am i looking at in this screenshot',
    'remind me to pause the recording at four',
  ])('leaves %j to the model', (text) => {
    expect(matchIntent(text)).toBeNull();
  });

  it('declines an out-of-range volume rather than clamping it', () => {
    // A misheard "volume two hundred" must not become 100.
    expect(matchIntent('set volume to 200')).toBeNull();
    expect(matchIntent('volume 999')).toBeNull();
  });

  it('declines empty and whitespace input', () => {
    expect(matchIntent('')).toBeNull();
    expect(matchIntent('   ')).toBeNull();
  });

  it('declines other languages, which the model handles', () => {
    expect(matchIntent('गाना बंद करो')).toBeNull();
    expect(matchIntent('அதை நிறுத்து')).toBeNull();
  });
});

describe('fast path safety', () => {
  const registry = buildToolRegistry({});

  it('only routes to tools that actually exist', () => {
    for (const name of FAST_PATH_TOOLS) {
      expect(registry.get(name), `${name} is not registered`).toBeDefined();
    }
  });

  /**
   * The fast path skips deliberation, never policy. If a destructive tool ever
   * became reachable this way, a misheard word could delete something.
   */
  it('never routes to a tool that needs confirmation', () => {
    // Asked of the policy engine rather than the risk label, so this keeps
    // holding if the levels are ever renamed again.
    const ctx = { settings: UserSettings.parse({}), online: true };
    for (const name of FAST_PATH_TOOLS) {
      const tool = registry.get(name);
      expect(tool, `${name} missing`).toBeDefined();
      expect(tool && decide(tool.metadata, ctx).action, `${name} would prompt`).toBe('allow');
    }
  });

  it('produces arguments the tool schema accepts', () => {
    for (const text of ['pause', 'what time is it', 'set volume to 40', 'what am i looking at']) {
      const match = matchIntent(text);
      expect(match).not.toBeNull();
      const tool = registry.get(match?.tool ?? '');
      expect(tool?.input.safeParse(match?.args).success, `${text} produced invalid args`).toBe(
        true,
      );
    }
  });
});

/**
 * Numbers as people say them.
 *
 * "Set the volume to forty percent" is the commonest command in the app and it
 * used to miss the fast path entirely, because Whisper writes "forty" and the
 * rule wanted "40". It is also the case that settled the small-model question:
 * granite4:3b, asked the same thing in Hindi, produced `level: 50`. A wrong
 * argument is worse than a wrong tool — the action succeeds and nobody is told
 * — so this parses exactly or returns null.
 */
describe('spoken numbers', () => {
  it.each([
    ['forty', 40],
    ['Forty', 40],
    ['twenty five', 25],
    ['twenty-five', 25],
    ['seven', 7],
    ['a hundred', 100],
    ['one hundred', 100],
    ['0', 0],
    ['65', 65],
  ])('reads %s as %i', (text, expected) => {
    expect(parseSpokenNumber(text)).toBe(expected);
  });

  it.each(['two hundred', 'a lot', 'fifty five sixty', 'five twenty', 'half', '', 'forty two ish'])(
    'refuses to guess at %s',
    (text) => {
      expect(parseSpokenNumber(text)).toBeNull();
    },
  );

  it('routes the spoken form of the commonest command', () => {
    expect(matchIntent('set the volume to forty percent')).toMatchObject({
      tool: 'set_volume',
      args: { level: 40 },
    });
    expect(matchIntent('turn the volume to twenty five')).toMatchObject({
      args: { level: 25 },
    });
  });

  it('still refuses a number it cannot read exactly', () => {
    // Falls through to the model rather than clamping to something plausible.
    expect(matchIntent('set the volume to two hundred')).toBeNull();
    expect(matchIntent('turn the volume up a bit')).toBeNull();
  });
});

describe('apps, windows and the rest', () => {
  it.each([
    ['open safari', 'open_app', { appName: 'Safari' }],
    ['launch spotify', 'open_app', { appName: 'Spotify' }],
    ['open vs code', 'open_app', { appName: 'Visual Studio Code' }],
    ['open the calendar app', 'open_app', { appName: 'Calendar' }],
    ['quit slack', 'close_app', { appName: 'Slack' }],
    ['close whatsapp', 'close_app', { appName: 'WhatsApp' }],
    ['minimise safari', 'window_control', { action: 'minimize', appName: 'Safari' }],
    [
      'minimize the chrome window',
      'window_control',
      { action: 'minimize', appName: 'Google Chrome' },
    ],
    ['list my tabs', 'browser_control', { action: 'list_tabs' }],
    ['refresh the page', 'browser_control', { action: 'reload' }],
    ['how much storage do i have', 'system_info', { metric: 'storage' }],
    ['am i online', 'system_info', { metric: 'network' }],
    ['how much memory is free', 'system_info', { metric: 'memory' }],
    ['what day is it today', 'system_info', { metric: 'time' }],
    ["what's on my calendar today", 'read_calendar', { daysAhead: 0 }],
    ['do i have any meetings tomorrow', 'read_calendar', { daysAhead: 1 }],
    ['find my tax return pdf', 'search_files', { query: 'tax return', scope: 'name' }],
    ['look for the invoice document', 'search_files', { query: 'invoice', scope: 'name' }],
  ])('routes %s', (text, tool, args) => {
    expect(matchIntent(text)).toMatchObject({ tool, args });
  });
});

/**
 * The half that matters more. A fast path that hijacks a sentence it cannot
 * fulfil is worse than no fast path — the model would at least have said
 * something sensible.
 */
describe('what the widened path must still leave alone', () => {
  it.each([
    // An app nobody has. `open -a "the pod bay doors"` is a shell error where
    // the model would have said something useful.
    'open the pod bay doors',
    'open my email from rahul',
    // A tab is not an app.
    'close the tab',
    'close this window',
    // Not a file search.
    'find my keys',
    'find out who won the match',
    // Compound requests belong to the planner, whole and intact.
    'open safari and search for train times',
    'pause the music and tell me what was playing',
    'minimise safari then open spotify',
    // Questions, not commands.
    'should i open safari',
    'why is my storage full',
    'what happens if i quit slack',
  ])('leaves %s to the model', (text) => {
    expect(matchIntent(text)).toBeNull();
  });

  it('keeps producing arguments every schema accepts', () => {
    const registry = buildToolRegistry({});
    const spoken = [
      'set the volume to forty percent',
      'open safari',
      'quit slack',
      'minimise safari',
      'list my tabs',
      'refresh the page',
      'how much storage do i have',
      "what's on my calendar today",
      'find my tax return pdf',
      'am i online',
    ];
    for (const text of spoken) {
      const match = matchIntent(text);
      expect(match, `${text} did not route`).not.toBeNull();
      const tool = registry.get(match?.tool ?? '');
      expect(tool?.input.safeParse(match?.args).success, `${text} produced invalid args`).toBe(
        true,
      );
    }
  });
});
