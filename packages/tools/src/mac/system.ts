import { OpenAppInput, OpenUrlInput, SetVolumeInput, SystemInfoInput } from '@assistant/schemas';
import { okAsync } from '@assistant/core';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';

export const openAppTool = defineTool({
  metadata: {
    name: 'open_app',
    description:
      'Launch or focus a macOS application by name, for example Safari, Spotify, Notes or Visual Studio Code.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-cli',
    requiredPermissions: [],
    timeoutMs: 10_000,
  },
  input: OpenAppInput,
  // `open -a` takes the name as an argv entry, so no shell parsing is involved.
  execute: (args, ctx) =>
    runCommand('open', ['-a', args.appName], { signal: ctx.signal }).map(() => ({
      opened: args.appName,
    })),
  speak: (result) => {
    const opened = (result as { opened?: unknown }).opened;
    return typeof opened === 'string' && opened.length > 0 ? `Opened ${opened}.` : null;
  },
});

export const openUrlTool = defineTool({
  metadata: {
    name: 'open_url',
    description: 'Open a web page in the default browser.',
    category: 'web',
    risk: 'reversible',
    connector: 'macos-cli',
    requiresNetwork: true,
  },
  input: OpenUrlInput,
  execute: (args, ctx) =>
    runCommand('open', [args.url], { signal: ctx.signal }).map(() => ({ opened: args.url })),
  // The URL itself is not read out: hearing a query string is no use to anyone.
  speak: (result) =>
    typeof (result as { opened?: unknown }).opened === 'string' ? 'Opened that link.' : null,
});

export const setVolumeTool = defineTool({
  metadata: {
    name: 'set_volume',
    description: 'Set the system output volume to a percentage between 0 and 100.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-applescript',
  },
  input: SetVolumeInput,
  execute: (args, ctx) =>
    runAppleScript(['set volume output volume (item 1 of argv as integer)'], [String(args.level)], {
      signal: ctx.signal,
    }).map(() => ({ level: args.level })),
  /**
   * Reads the volume back. `set volume` succeeds against a muted or absent
   * output device, so the command being accepted proves nothing on its own.
   * macOS rounds to the nearest representable step, hence the tolerance.
   */
  verify: (result, ctx) => {
    const wanted = (result as { level?: unknown }).level;
    if (typeof wanted !== 'number') return okAsync(false);
    return runAppleScript(['return output volume of (get volume settings)'], [], {
      signal: ctx.signal,
    }).map((raw) => {
      const actual = Number(raw);
      return Number.isFinite(actual) && Math.abs(actual - wanted) <= 3;
    });
  },
  // Nothing a model could add to this. Rendering it here spares the user a
  // second round trip whose only job is to say the number back.
  speak: (result) => {
    const level = (result as { level?: unknown }).level;
    return typeof level === 'number' ? `Volume set to ${String(level)} percent.` : null;
  },
});

export const systemInfoTool = defineTool({
  metadata: {
    name: 'system_info',
    description:
      'Read a system metric: battery percentage, free storage, memory pressure, network status, or the current time.',
    category: 'system',
    risk: 'read',
    connector: 'macos-cli',
  },
  input: SystemInfoInput,
  execute: (args, ctx) => {
    const opts = { signal: ctx.signal };
    switch (args.metric) {
      case 'battery':
        return runCommand('pmset', ['-g', 'batt'], opts).map((raw) => ({ metric: 'battery', raw }));
      case 'storage':
        return runCommand('df', ['-h', '/System/Volumes/Data'], opts).map((raw) => ({
          metric: 'storage',
          raw,
        }));
      case 'memory':
        return runCommand('memory_pressure', [], opts).map((raw) => ({ metric: 'memory', raw }));
      case 'network':
        return runCommand('networksetup', ['-getinfo', 'Wi-Fi'], opts).map((raw) => ({
          metric: 'network',
          raw,
        }));
      case 'time':
        return runCommand('date', ['+%A %d %B %Y, %I:%M %p %Z'], opts).map((raw) => ({
          metric: 'time',
          raw,
        }));
    }
  },
  /**
   * Only the clock. "What time is it" is the commonest question here and the
   * answer needs no phrasing help, so it ends the turn without a second model
   * call. Battery, storage, memory and network all return raw command output
   * that genuinely does need a model to summarise, so they decline.
   */
  speak: (result) => {
    const r = result as { metric?: unknown; raw?: unknown };
    if (r.metric !== 'time' || typeof r.raw !== 'string') return null;
    // "Tuesday 01 September 2026, 05:37 PM IST" -> "It's 5:37 PM."
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(r.raw);
    if (!m) return null;
    const hour = String(Number(m[1]));
    return `It's ${hour}:${m[2] ?? ''} ${(m[3] ?? '').toUpperCase()}.`;
  },
});
