import { MediaControlInput, NowPlayingInput, PlayMusicInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';

/**
 * Apple Music: search the local library first, since playing a known track is
 * both faster and works offline. Falls back to opening the app's search when
 * nothing in the library matches.
 */
const APPLE_MUSIC_PLAY = [
  'tell application "Music"',
  '  activate',
  '  set theQuery to item 1 of argv',
  '  set matches to (every track of library playlist 1 whose name contains theQuery)',
  '  if (count of matches) is 0 then',
  '    set matches to (every track of library playlist 1 whose artist contains theQuery)',
  '  end if',
  '  if (count of matches) is 0 then',
  '    return "no-match"',
  '  end if',
  '  play (item 1 of matches)',
  '  return name of (item 1 of matches)',
  'end tell',
];

/**
 * Which player to act on when the user did not say.
 *
 * People say "pause" without naming an app. Preferring the one that is
 * actually playing is right far more often than defaulting to either, and
 * falling back to whichever is merely running covers "play" after a pause.
 */
const DETECT_PLAYER = [
  // `running` is a reserved word in AppleScript — an application property —
  // so `set running to {}` fails with -10006 and takes the whole tool with it.
  'set foundApps to {}',
  'tell application "System Events"',
  '  if exists process "Spotify" then set end of foundApps to "spotify"',
  '  if exists process "Music" then set end of foundApps to "apple-music"',
  'end tell',
  'if foundApps contains "spotify" then',
  '  tell application "Spotify"',
  '    if player state is playing then return "spotify"',
  '  end tell',
  'end if',
  'if foundApps contains "apple-music" then',
  '  tell application "Music"',
  '    if player state is playing then return "apple-music"',
  '  end tell',
  'end if',
  'if (count of foundApps) is 0 then return "none"',
  'return item 1 of foundApps',
];

/**
 * Spotify has no `stop`, so it is mapped to `pause` — the audible result is
 * the same and failing on a word the user reasonably said would not be.
 */
const SPOTIFY_VERBS: Record<string, string> = {
  play: 'play',
  pause: 'pause',
  stop: 'pause',
  next: 'next track',
  previous: 'previous track',
};

const SPOTIFY_CONTROL = [
  'tell application "Spotify"',
  '  set verb to item 1 of argv',
  '  if verb is "play" then play',
  '  if verb is "pause" then pause',
  '  if verb is "next track" then next track',
  '  if verb is "previous track" then previous track',
  'end tell',
  'return "ok"',
];

/** Reads whatever is loaded, playing or paused, from both players. */
const NOW_PLAYING = [
  'tell application "System Events"',
  '  set hasSpotify to (exists process "Spotify")',
  '  set hasMusic to (exists process "Music")',
  'end tell',
  'if hasSpotify then',
  '  tell application "Spotify"',
  '    try',
  '      set t to current track',
  '      return "spotify|" & (player state as text) & "|" & (name of t) & "|" & (artist of t)',
  '    end try',
  '  end tell',
  'end if',
  'if hasMusic then',
  '  tell application "Music"',
  '    try',
  '      set t to current track',
  '      return "apple-music|" & (player state as text) & "|" & (name of t) & "|" & (artist of t)',
  '    end try',
  '  end tell',
  'end if',
  'return "none"',
];

export const playMusicTool = defineTool({
  metadata: {
    name: 'play_music',
    description:
      'Play a song, artist, album or playlist in Apple Music or Spotify. Use when the user asks to play or put on music.',
    category: 'media',
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 20_000,
  },
  input: PlayMusicInput,
  execute: (args, ctx) => {
    if (args.source === 'youtube') {
      // No API key, so this opens the results rather than pretending to pick
      // a video. Saying which is what the renderer does.
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
      return runCommand('open', [url], { signal: ctx.signal }).map(() => ({
        source: 'youtube',
        query: args.query,
        note: 'Opened YouTube search results',
      }));
    }

    if (args.source === 'spotify') {
      // Spotify's AppleScript dictionary needs a URI, so hand the query to its
      // own search rather than guessing one.
      const uri = `spotify:search:${encodeURIComponent(args.query)}`;
      return runCommand('open', [uri], { signal: ctx.signal }).map(() => ({
        source: 'spotify',
        query: args.query,
        note: 'Opened Spotify search results',
      }));
    }

    return runAppleScript(APPLE_MUSIC_PLAY, [args.query], {
      signal: ctx.signal,
      timeoutMs: 20_000,
    }).map((result) =>
      result === 'no-match'
        ? { source: 'apple-music', query: args.query, played: null, note: 'No library match' }
        : { source: 'apple-music', query: args.query, played: result },
    );
  },
  speak: (result) => {
    const r = result as { source?: unknown; played?: unknown; query?: unknown };
    if (r.source === 'spotify' || r.source === 'youtube') {
      const where = r.source === 'spotify' ? 'Spotify' : 'YouTube';
      // Deliberately "search results", not "playing": nothing was chosen.
      return typeof r.query === 'string' ? `Opened ${where} search for ${r.query}.` : null;
    }
    // A miss needs explaining, not announcing.
    return typeof r.played === 'string' ? `Playing ${r.played}.` : null;
  },
});

export const mediaControlTool = defineTool({
  metadata: {
    name: 'media_control',
    description: 'Play, pause, stop, or skip to the next or previous track in Apple Music.',
    category: 'media',
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
  },
  input: MediaControlInput,
  execute: (args, ctx) => {
    const appleVerb = {
      play: 'play',
      pause: 'pause',
      stop: 'stop',
      next: 'next track',
      previous: 'previous track',
    }[args.action];

    const control = (app: 'apple-music' | 'spotify') => {
      if (app === 'spotify') {
        const verb = SPOTIFY_VERBS[args.action] ?? 'pause';
        // The verb is chosen from a fixed table here, never taken from the
        // model — script text stays a compile-time constant either way.
        return runAppleScript(SPOTIFY_CONTROL, [verb], { signal: ctx.signal }).map(() => ({
          action: args.action,
          app: 'spotify',
        }));
      }
      return runAppleScript([`tell application "Music" to ${appleVerb}`], [], {
        signal: ctx.signal,
      }).map(() => ({ action: args.action, app: 'apple-music' }));
    };

    if (args.app !== 'auto') return control(args.app);

    return runAppleScript(DETECT_PLAYER, [], { signal: ctx.signal }).andThen((detected) =>
      detected === 'none'
        ? runCommand('true', [], { signal: ctx.signal }).map(() => ({
            action: args.action,
            app: null,
            reason: 'Neither Spotify nor Apple Music is running',
          }))
        : control(detected === 'spotify' ? 'spotify' : 'apple-music'),
    );
  },
  speak: (result) => {
    const r = result as { action?: unknown; app?: unknown };
    // Nothing was running, so nothing happened — the model explains that.
    if (r.app === null) return null;
    const said: Record<string, string> = {
      play: 'Playing.',
      pause: 'Paused.',
      stop: 'Stopped.',
      next: 'Skipped to the next track.',
      previous: 'Went back a track.',
    };
    return typeof r.action === 'string' ? (said[r.action] ?? null) : null;
  },
});

export const nowPlayingTool = defineTool({
  metadata: {
    name: 'now_playing',
    description:
      'Report what is currently playing in Spotify or Apple Music, including whether it is paused.',
    category: 'media',
    risk: 'read',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 15_000,
  },
  input: NowPlayingInput,
  execute: (_args, ctx) =>
    runAppleScript(NOW_PLAYING, [], { signal: ctx.signal }).map((raw) => {
      if (raw === 'none') return { playing: null };
      const [app, state, title, artist] = raw.split('|');
      return {
        app: app ?? null,
        state: state ?? null,
        playing: title ?? null,
        artist: artist ?? null,
      };
    }),
  speak: (result) => {
    const r = result as { playing?: unknown; artist?: unknown; state?: unknown };
    if (typeof r.playing !== 'string' || r.playing.length === 0) return null;
    const by = typeof r.artist === 'string' && r.artist.length > 0 ? ` by ${r.artist}` : '';
    // "Paused" is not "playing", and saying otherwise would be wrong.
    return r.state === 'playing' ? `Playing ${r.playing}${by}.` : `Paused on ${r.playing}${by}.`;
  },
});
