import { ClickAtInput, PressKeyInput, TypeTextInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript } from './osascript.js';

/**
 * Driving the interface directly — typing into whatever is focused, pressing a
 * key, clicking a point.
 *
 * This is what the PRD's "form assistance" and "permitted UI actions" need,
 * and it is the least safe thing in the app, because unlike every other tool
 * here it acts on whatever happens to be in front rather than on a named
 * object. Assistant cannot see what is focused, so it cannot know that the field
 * it is about to fill is the address bar and not the search box.
 *
 * Three consequences, all deliberate:
 *
 * 1. Every tool here is `destructive`, so every call is confirmed and no
 *    pre-approval unlocks it. The approval card shows the exact text or key.
 * 2. `press_key` takes named keys only. Characters go through `type_text`, so
 *    this cannot be used to assemble input one keystroke at a time behind a
 *    prompt that says "pressing tab".
 * 3. Nothing here submits on its own. Pressing return is its own call with its
 *    own confirmation — which is exactly what "require approval before final
 *    submission" means when the submission is a keystroke.
 *
 * All three need Accessibility permission, which macOS asks for once.
 */

/**
 * Key codes rather than `keystroke`, because `keystroke "\r"` is interpreted
 * differently by different apps. The table is a compile-time constant selected
 * by a closed enum — the model picks an entry, it never supplies script text.
 */
const KEY_CODE: Record<string, number> = {
  return: 36,
  tab: 48,
  escape: 53,
  space: 49,
  delete: 51,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
};

const MODIFIER: Record<string, string> = {
  command: 'command down',
  shift: 'shift down',
  option: 'option down',
  control: 'control down',
};

export const typeTextTool = defineTool({
  metadata: {
    name: 'type_text',
    description:
      'Type text into whatever field is currently focused on screen. Use to fill in a form the user is looking at. The user approves the exact text first.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['accessibility'],
    timeoutMs: 20_000,
  },
  input: TypeTextInput,
  execute: (args, ctx) =>
    runAppleScript(
      ['tell application "System Events" to keystroke (item 1 of argv)'],
      [args.text],
      { signal: ctx.signal },
    ).map(() => ({ typed: args.text.length })),
  /**
   * No renderer, and no verifier either. Assistant cannot read back what it
   * typed without also reading the screen — a separate gated action — so this
   * stays `unverified` rather than claiming an effect it did not check.
   */
});

export const pressKeyTool = defineTool({
  metadata: {
    name: 'press_key',
    description:
      'Press a single named key, optionally with modifiers — return, tab, escape, the arrow keys. Use to submit a form or move between fields.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['accessibility'],
    timeoutMs: 15_000,
  },
  input: PressKeyInput,
  execute: (args, ctx) => {
    const code = KEY_CODE[args.key] ?? KEY_CODE.escape ?? 53;
    const using = args.modifiers
      .map((name) => MODIFIER[name])
      .filter((clause): clause is string => clause !== undefined);
    const suffix = using.length > 0 ? ` using {${using.join(', ')}}` : '';

    return runAppleScript(
      [`tell application "System Events" to key code ${String(code)}${suffix}`],
      [],
      { signal: ctx.signal },
    ).map(() => ({ pressed: args.key, modifiers: args.modifiers }));
  },
});

export const clickAtTool = defineTool({
  metadata: {
    name: 'click_at',
    description:
      'Click a point on screen, in screen coordinates. Use only after reading the screen, when there is no other way to reach a control.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['accessibility'],
    timeoutMs: 15_000,
  },
  input: ClickAtInput,
  execute: (args, ctx) =>
    runAppleScript(
      [
        'tell application "System Events"',
        '  click at {(item 1 of argv) as integer, (item 2 of argv) as integer}',
        'end tell',
      ],
      [String(args.x), String(args.y)],
      { signal: ctx.signal },
    ).map(() => ({ clicked: { x: args.x, y: args.y } })),
});
