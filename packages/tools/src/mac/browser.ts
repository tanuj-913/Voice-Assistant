import { BrowserControlInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript } from './osascript.js';

/**
 * Browser control, which is how most of the web actually gets used — YouTube,
 * a docs tab, the thing you left open three windows ago.
 *
 * Safari and Chrome both ship AppleScript dictionaries, so tab listing,
 * focusing and closing are reliable and need no extra permission beyond
 * automation. Deliberately *not* used here: `do JavaScript`, which would allow
 * pausing a YouTube video but requires the user to turn on "Allow JavaScript
 * from Apple Events" by hand in a developer menu. A tool that silently does
 * nothing until an obscure checkbox is ticked is worse than no tool.
 *
 * Chrome calls the tab's text `title`; Safari calls it `name`. That is the
 * only real difference, so the two scripts are near-duplicates rather than one
 * parameterised script — the app name cannot come from a variable in a `tell`.
 */

const CHROME = 'Google Chrome';
const SAFARI = 'Safari';

/** Which browser to act on when the user did not say: prefer one that is running. */
const DETECT_BROWSER = [
  'tell application "System Events"',
  '  if exists process "Google Chrome" then return "chrome"',
  '  if exists process "Safari" then return "safari"',
  'end tell',
  'return "none"',
];

const listTabs = (app: string, titleProp: string) => [
  `tell application "${app}"`,
  '  set out to ""',
  '  repeat with w from 1 to count of windows',
  '    repeat with t from 1 to count of tabs of window w',
  `      set theTab to tab t of window w`,
  `      set out to out & (w as text) & "|" & (t as text) & "|" & (${titleProp} of theTab) & "|" & (URL of theTab) & linefeed`,
  '    end repeat',
  '  end repeat',
  '  return out',
  'end tell',
];

const currentTab = (app: string, titleProp: string) => [
  `tell application "${app}"`,
  '  if (count of windows) is 0 then return "none"',
  app === CHROME
    ? '  set theTab to active tab of front window'
    : '  set theTab to current tab of front window',
  `  return (${titleProp} of theTab) & "|" & (URL of theTab)`,
  'end tell',
];

/**
 * `match` arrives via argv and is compared with `contains`, never interpolated
 * into the script — the same boundary every other tool here respects.
 */
const findTab = (app: string, titleProp: string, close: boolean) => [
  `tell application "${app}"`,
  '  set needle to item 1 of argv',
  '  repeat with w from 1 to count of windows',
  '    repeat with t from 1 to count of tabs of window w',
  '      set theTab to tab t of window w',
  `      set haystack to (${titleProp} of theTab) & " " & (URL of theTab)`,
  '      if haystack contains needle then',
  ...(close
    ? [
        `        set foundTitle to ${titleProp} of theTab`,
        '        close theTab',
        '        return foundTitle',
      ]
    : [
        app === CHROME
          ? '        set active tab index of window w to t'
          : '        set current tab of window w to theTab',
        '        set index of window w to 1',
        '        activate',
        `        return ${titleProp} of theTab`,
      ]),
  '      end if',
  '    end repeat',
  '  end repeat',
  '  return "no-match"',
  'end tell',
];

const openUrl = (app: string) => [
  `tell application "${app}"`,
  '  activate',
  '  set theUrl to item 1 of argv',
  ...(app === CHROME
    ? [
        '  if (count of windows) is 0 then make new window',
        '  tell front window to make new tab with properties {URL: theUrl}',
      ]
    : [
        '  if (count of windows) is 0 then',
        '    make new document with properties {URL: theUrl}',
        '  else',
        '    tell front window to set current tab to (make new tab with properties {URL: theUrl})',
        '  end if',
      ]),
  '  return "opened"',
  'end tell',
];

/**
 * Back, forward and reload.
 *
 * Both browsers expose these only through `do JavaScript`, which needs a
 * checkbox in a developer menu that nobody has ticked — the same reason this
 * file avoids it everywhere else. The menu-key route works with the
 * Accessibility permission the UI tools already ask for, and it is what the
 * user would press themselves.
 */
const navigate = (app: string, key: string) => [
  `tell application "${app}" to activate`,
  '  delay 0.2',
  `tell application "System Events" to keystroke "${key}" using command down`,
  'return "done"',
];

interface Tab {
  window: number;
  index: number;
  title: string;
  url: string;
}

function parseTabs(raw: string): Tab[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [w, t, title, url] = line.split('|');
      if (!w || !t) return [];
      return [{ window: Number(w), index: Number(t), title: title ?? '', url: url ?? '' }];
    });
}

export const browserControlTool = defineTool({
  metadata: {
    name: 'browser_control',
    description:
      'Work with browser tabs in Safari or Chrome: open a URL, list open tabs, switch to a tab, close a tab, read the current one, or go back, forward and reload. Use for "what am I looking at", "go back", "close the docs tab".',
    category: 'web',
    risk: 'reversible',
    connector: 'macos-applescript',
    // Accessibility is for back/forward/reload only, which go through menu
    // keys; everything else here needs automation alone.
    requiredPermissions: ['automation', 'accessibility'],
    timeoutMs: 20_000,
  },
  input: BrowserControlInput,
  execute: (args, ctx) => {
    const act = (browser: 'chrome' | 'safari') => {
      const app = browser === 'chrome' ? CHROME : SAFARI;
      const titleProp = browser === 'chrome' ? 'title' : 'name';

      switch (args.action) {
        case 'open': {
          if (!args.url) {
            return runAppleScript(['return "no-url"'], [], { signal: ctx.signal }).map(() => ({
              action: args.action,
              opened: null,
              reason: 'No URL was given to open',
            }));
          }
          return runAppleScript(openUrl(app), [args.url], { signal: ctx.signal }).map(() => ({
            action: args.action,
            browser,
            opened: args.url,
          }));
        }
        case 'list_tabs':
          return runAppleScript(listTabs(app, titleProp), [], { signal: ctx.signal }).map(
            (raw) => ({ action: args.action, browser, tabs: parseTabs(raw) }),
          );
        case 'current_tab':
          return runAppleScript(currentTab(app, titleProp), [], { signal: ctx.signal }).map(
            (raw) => {
              if (raw === 'none') return { action: args.action, browser, tab: null };
              const [title, url] = raw.split('|');
              return {
                action: args.action,
                browser,
                tab: { title: title ?? '', url: url ?? '' },
              };
            },
          );
        case 'back':
        case 'forward':
        case 'reload': {
          const key = args.action === 'back' ? '[' : args.action === 'forward' ? ']' : 'r';
          return runAppleScript(navigate(app, key), [], { signal: ctx.signal }).map(() => ({
            action: args.action,
            browser,
            navigated: true,
          }));
        }
        case 'focus_tab':
        case 'close_tab': {
          if (!args.match) {
            return runAppleScript(['return "no-match-term"'], [], { signal: ctx.signal }).map(
              () => ({
                action: args.action,
                matched: null,
                reason: 'No text was given to match a tab against',
              }),
            );
          }
          const closing = args.action === 'close_tab';
          return runAppleScript(findTab(app, titleProp, closing), [args.match], {
            signal: ctx.signal,
          }).map((title) => ({
            action: args.action,
            browser,
            matched: title === 'no-match' ? null : title,
            ...(title === 'no-match' ? { reason: `No tab matching "${args.match ?? ''}"` } : {}),
          }));
        }
      }
    };

    if (args.browser !== 'auto') return act(args.browser);

    return runAppleScript(DETECT_BROWSER, [], { signal: ctx.signal }).andThen((detected) =>
      detected === 'none'
        ? runAppleScript(['return "none"'], [], { signal: ctx.signal }).map(() => ({
            action: args.action,
            browser: null,
            reason: 'Neither Safari nor Chrome is running',
          }))
        : act(detected === 'chrome' ? 'chrome' : 'safari'),
    );
  },
  speak: (result) => {
    const r = result as {
      action?: unknown;
      browser?: unknown;
      matched?: unknown;
      opened?: unknown;
      tab?: { title?: unknown } | null;
      tabs?: unknown;
    };
    // No browser running, no URL, no match — all things to explain, not announce.
    if (r.browser === null) return null;

    switch (r.action) {
      case 'open':
        return typeof r.opened === 'string' ? 'Opened that in your browser.' : null;
      case 'focus_tab':
        return typeof r.matched === 'string' ? `Switched to ${r.matched}.` : null;
      case 'close_tab':
        return typeof r.matched === 'string' ? `Closed ${r.matched}.` : null;
      case 'current_tab':
        return r.tab && typeof r.tab.title === 'string' ? `You're on ${r.tab.title}.` : null;
      // A list of tabs is exactly the case where a model phrases it better.
      default:
        return null;
    }
  },
});
