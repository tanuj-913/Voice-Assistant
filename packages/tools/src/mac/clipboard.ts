import { okAsync } from '@assistant/core';
import { ReadClipboardInput, WriteClipboardInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';

/**
 * The clipboard, which the PRD lists beside screenshots for a reason: both are
 * ways of getting at whatever the user is currently working on, and both can
 * hand over something they never meant to share.
 */

export const readClipboardTool = defineTool({
  metadata: {
    name: 'read_clipboard',
    description:
      'Read the text currently on the clipboard. Use when the user says "what did I just copy" or asks about something they copied.',
    category: 'system',
    /**
     * Same gate as `read_screen`, for the same reason. A copied password or a
     * one-time code becomes text in the transcript, is sent to the model, and
     * may be spoken aloud. It always asks, and no pre-approval unlocks it.
     */
    risk: 'destructive',
    connector: 'macos-cli',
    timeoutMs: 10_000,
  },
  input: ReadClipboardInput,
  // `pbpaste` takes no arguments at all, so there is nothing here for a model
  // to influence beyond deciding to call it.
  execute: (_args, ctx) =>
    runCommand('pbpaste', [], { signal: ctx.signal }).map((text) => ({
      text: text.slice(0, 8_000),
      truncated: text.length > 8_000,
      empty: text.length === 0,
    })),
  speak: (result) =>
    (result as { empty?: unknown }).empty === true ? 'There is nothing on the clipboard.' : null,
});

export const writeClipboardTool = defineTool({
  metadata: {
    name: 'write_clipboard',
    description:
      'Put text on the clipboard so the user can paste it. Use when they ask you to copy something for them.',
    category: 'system',
    // Replacing the clipboard loses whatever was there, which is a real but
    // small loss, and the user asked for it. It does not leave the machine.
    risk: 'reversible',
    connector: 'macos-applescript',
    timeoutMs: 10_000,
  },
  input: WriteClipboardInput,
  // Via argv rather than `pbcopy`, which would need the text on stdin and
  // `runCommand` deliberately offers no way to write to a child's stdin.
  execute: (args, ctx) =>
    runAppleScript(['set the clipboard to (item 1 of argv)'], [args.text], {
      signal: ctx.signal,
    }).map(() => ({ copied: args.text })),
  /**
   * Reads it back. `set the clipboard to` reports success even when another
   * app owns the pasteboard and overwrites it a moment later, so the command
   * being accepted is not evidence the text is there.
   *
   * Compared trimmed, because `pbpaste` output is trimmed on the way in and a
   * trailing newline is not a difference worth calling a failure.
   */
  verify: (result, ctx) => {
    const copied = (result as { copied?: unknown }).copied;
    if (typeof copied !== 'string') return okAsync(false);
    return runCommand('pbpaste', [], { signal: ctx.signal }).map(
      (text) => text.trim() === copied.trim(),
    );
  },
  speak: () => 'Copied that to your clipboard.',
});
