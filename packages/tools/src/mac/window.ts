import { okAsync } from '@assistant/core';
import { CloseAppInput, WindowControlInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript } from './osascript.js';

/**
 * The other half of "open, focus and close approved applications".
 *
 * `open_app` covers opening and focusing; this covers quitting and the window
 * itself. Both act by name, and the name arrives through argv — `tell
 * application appName` targets by variable at runtime, so nothing the model
 * says is ever compiled as script text.
 */

export const closeAppTool = defineTool({
  metadata: {
    name: 'close_app',
    description:
      'Quit a running application by name. The app is asked to quit, so it can still prompt about unsaved work.',
    category: 'system',
    /**
     * `quit` rather than `kill`, which is what makes this reversible enough
     * not to prompt: an app with unsaved work puts up its own save dialog and
     * the user answers it. Force-quitting would discard that work silently and
     * is deliberately not offered.
     */
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 15_000,
  },
  input: CloseAppInput,
  execute: (args, ctx) =>
    runAppleScript(
      [
        'set appName to item 1 of argv',
        'tell application "System Events"',
        '  if not (exists process appName) then return "not-running"',
        'end tell',
        'tell application appName to quit',
        'return "quit"',
      ],
      [args.appName],
      { signal: ctx.signal },
    ).map((outcome) => ({ app: args.appName, wasRunning: outcome === 'quit' })),
  /**
   * Waits for the process to actually go. A `quit` that raised a save dialog
   * returns success while the app is still very much running, and reporting
   * "closed Pages" over an unanswered dialog is exactly the false success the
   * PRD forbids.
   */
  verify: (result, ctx) => {
    const app = (result as { app?: unknown }).app;
    if (typeof app !== 'string') return okAsync(false);
    return runAppleScript(
      [
        'set appName to item 1 of argv',
        'delay 0.6',
        'tell application "System Events"',
        '  if exists process appName then return "running"',
        'end tell',
        'return "gone"',
      ],
      [app],
      { signal: ctx.signal },
    ).map((state) => state === 'gone');
  },
  speak: (result) => {
    const r = result as { app?: unknown; wasRunning?: unknown };
    if (typeof r.app !== 'string') return null;
    // Declines when the app was not running: "closed Safari" would be a lie,
    // and the difference is worth a sentence the model can phrase.
    return r.wasRunning === true ? `Closed ${r.app}.` : null;
  },
});

/**
 * Window actions go through the accessibility API rather than each app's own
 * dictionary, because most apps do not have one and the ones that do disagree
 * about what a window is. The cost is that this needs Accessibility permission
 * — which is why a failure says so rather than reporting a missing window.
 */
const WINDOW_SCRIPT: Record<string, readonly string[]> = {
  minimize: ['    set value of attribute "AXMinimized" of window 1 to true'],
  unminimize: ['    set value of attribute "AXMinimized" of window 1 to false'],
  zoom: ['    click (first button of window 1 whose subrole is "AXZoomButton")'],
  close: ['    click (first button of window 1 whose subrole is "AXCloseButton")'],
  focus: ['    set frontmost to true'],
};

export const windowControlTool = defineTool({
  metadata: {
    name: 'window_control',
    description:
      'Minimise, restore, zoom, close or focus an application\'s front window. Use for "minimise Safari" or "bring Notes to the front".',
    category: 'system',
    // Every one of these is undone by a click, including `close` — which
    // closes a window, never the app, and never touches a document.
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['accessibility', 'automation'],
    timeoutMs: 15_000,
  },
  input: WindowControlInput,
  execute: (args, ctx) => {
    const body = WINDOW_SCRIPT[args.action] ?? WINDOW_SCRIPT.focus ?? [];
    return runAppleScript(
      [
        'set appName to item 1 of argv',
        'tell application "System Events"',
        '  if not (exists process appName) then return "not-running"',
        '  tell process appName',
        '    if (count of windows) is 0 then return "no-window"',
        ...body,
        '  end tell',
        'end tell',
        'return "done"',
      ],
      [args.appName],
      { signal: ctx.signal },
    ).map((outcome) => ({
      app: args.appName,
      action: args.action,
      // Reported rather than thrown: "Safari has no open window" is an answer
      // the user can act on, not an internal failure.
      status: outcome === 'done' ? 'done' : outcome,
    }));
  },
  speak: (result) => {
    const r = result as { app?: unknown; action?: unknown; status?: unknown };
    if (typeof r.app !== 'string' || r.status !== 'done') return null;
    const said: Record<string, string> = {
      minimize: `Minimised ${r.app}.`,
      unminimize: `Brought ${r.app} back.`,
      zoom: `Zoomed the ${r.app} window.`,
      close: `Closed the ${r.app} window.`,
      focus: `${r.app} is at the front.`,
    };
    return typeof r.action === 'string' ? (said[r.action] ?? null) : null;
  },
});
