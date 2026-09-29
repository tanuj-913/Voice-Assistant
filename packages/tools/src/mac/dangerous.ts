import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { appError, errAsync, fromPromise, okAsync } from '@assistant/core';
import {
  CaptureScreenInput,
  MoveToTrashInput,
  ReadFileInput,
  RunShellCommandInput,
} from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';

const run = promisify(execFile);

/**
 * Capabilities that can cost the user something irreversible.
 *
 * Every tool here is `destructive`, which the registry treats as
 * never-auto-approvable: the confirmation prompt appears on every single call,
 * even if the user just asked for exactly this, and even if they previously
 * ticked "don't ask again" for something else. That is deliberate — a voice
 * assistant mishears, and a language model over-interprets.
 *
 * Each takes a `reason` so the prompt can say *why*, not just *what*.
 */

export const runShellCommandTool = defineTool({
  metadata: {
    name: 'run_shell_command',
    description:
      'Run a shell command in the terminal. Use only when no other tool can do the job. The user must approve the exact command before it runs.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-cli',
    requiredPermissions: [],
    timeoutMs: 60_000,
  },
  input: RunShellCommandInput,
  execute: (args, ctx) =>
    fromPromise(
      run('/bin/zsh', ['-c', args.command], {
        cwd: args.workingDirectory ?? homedir(),
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        signal: ctx.signal,
      }).then(({ stdout, stderr }) => ({
        // Truncated: a command that prints a megabyte should not blow out the
        // model's context window on the next turn.
        stdout: stdout.slice(0, 8000),
        stderr: stderr.slice(0, 2000),
        truncated: stdout.length > 8000,
      })),
      'shell_command_failed',
    ).orElse((error) =>
      // A non-zero exit is information, not an internal failure — the model
      // should be able to read the error and tell the user what went wrong.
      okAsync({ stdout: '', stderr: error.message.slice(0, 2000), failed: true }),
    ),
});

/**
 * Moves to the Trash rather than deleting.
 *
 * `rm` is not offered at all. Trash is recoverable, and an assistant acting on
 * a misheard filename should be an annoyance rather than a data-loss event.
 * If the user genuinely wants a permanent delete they can empty the Trash
 * themselves — that stays a human action.
 */
export const moveToTrashTool = defineTool({
  metadata: {
    name: 'move_to_trash',
    description:
      'Move files or folders to the Trash. This is recoverable. Never permanently deletes anything.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 20_000,
  },
  input: MoveToTrashInput,
  execute: (args, ctx) => {
    const relative = args.paths.filter((path) => !isAbsolute(path));
    if (relative.length > 0) {
      return errAsync(
        appError(
          'trash_relative_path',
          `Refusing relative paths — they are ambiguous: ${relative.join(', ')}`,
        ),
      );
    }

    // POSIX file coercion happens inside AppleScript; the paths themselves
    // travel via argv and are never spliced into the script text.
    const script = [
      'set trashed to {}',
      'repeat with p in argv',
      '  try',
      '    tell application "Finder" to delete (POSIX file (p as text) as alias)',
      '    set end of trashed to (p as text)',
      '  end try',
      'end repeat',
      'return trashed as text',
    ];

    return runAppleScript(script, args.paths, { signal: ctx.signal, timeoutMs: 20_000 }).map(
      (moved) => ({ movedToTrash: moved, requested: args.paths.length }),
    );
  },
});

export const captureScreenTool = defineTool({
  metadata: {
    name: 'capture_screen',
    description:
      'Take a screenshot of the screen or the frontmost window, and describe what it contains.',
    category: 'system',
    risk: 'destructive',
    connector: 'macos-cli',
    requiredPermissions: ['screen-recording'],
    timeoutMs: 20_000,
  },
  input: CaptureScreenInput,
  execute: (args, ctx) =>
    fromPromise(
      (async () => {
        const dir = await mkdtemp(join(tmpdir(), 'assistant-shot-'));
        const path = join(dir, 'capture.png');
        try {
          // -x suppresses the shutter sound; -o omits window shadow.
          const flags = args.mode === 'window' ? ['-x', '-o', '-W'] : ['-x'];
          await run('screencapture', [...flags, path], { timeout: 15_000, signal: ctx.signal });

          const info = await stat(path);
          if (info.size === 0) throw new Error('Capture produced an empty file');

          return { path, bytes: info.size, mode: args.mode };
        } catch (error) {
          await rm(dir, { recursive: true, force: true });
          throw error instanceof Error ? error : new Error('Screen capture failed');
        }
      })(),
      'screen_capture_failed',
    ),
});

export const readFileTool = defineTool({
  metadata: {
    name: 'read_file',
    description: 'Read the contents of a text file on this Mac.',
    category: 'system',
    // Reading is not destructive, but it can surface private data, so it still
    // prompts unless the user has explicitly auto-approved it.
    risk: 'destructive',
    connector: 'filesystem',
    requiredPermissions: [],
    timeoutMs: 15_000,
  },
  input: ReadFileInput,
  execute: (args) =>
    fromPromise(
      (async () => {
        if (!isAbsolute(args.path)) throw new Error('Path must be absolute');
        const text = await readFile(args.path, 'utf8');
        return {
          path: args.path,
          text: text.slice(0, args.maxChars),
          truncated: text.length > args.maxChars,
        };
      })(),
      'read_file_failed',
    ),
});

export const openTerminalTool = defineTool({
  metadata: {
    name: 'open_in_terminal',
    description:
      'Open Terminal with a command typed in but NOT run, so the user can review and press enter themselves.',
    category: 'system',
    // Safer sibling of run_shell_command — the human still presses enter —
    // but it stages an arbitrary command, so it keeps the confirmation gate.
    // `reversible` would let it through unprompted, which it must not.
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
  },
  input: RunShellCommandInput.pick({ command: true, reason: true }),
  execute: (args, ctx) =>
    runCommand('open', ['-a', 'Terminal'], { signal: ctx.signal }).andThen(() =>
      runAppleScript(
        [
          'tell application "System Events" to tell process "Terminal"',
          '  keystroke (item 1 of argv)',
          'end tell',
        ],
        [args.command],
        { signal: ctx.signal },
      ).map(() => ({ typed: args.command, executed: false })),
    ),
});
