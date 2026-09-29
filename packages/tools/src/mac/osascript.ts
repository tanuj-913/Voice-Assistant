import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appError, fromPromise, type AppResultAsync } from '@assistant/core';
import type { AppError } from '@assistant/schemas';

const run = promisify(execFile);

/**
 * Runs AppleScript with arguments passed out-of-band.
 *
 * Values from the model are NEVER interpolated into script text. They arrive
 * via `argv`, so a contact name of `" & (do shell script "rm -rf ~") & "` is
 * inert data rather than executable script. This is the single most important
 * boundary in the app: the model chooses the tool, but it never gets to author
 * the code that runs.
 *
 * Script text itself is always a compile-time constant in this codebase.
 */
export function runAppleScript(
  scriptLines: readonly string[],
  args: readonly string[] = [],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): AppResultAsync<string> {
  for (const arg of args) {
    if (arg.includes('\0')) {
      return fromPromise(
        Promise.reject(new Error('Null byte in AppleScript argument')),
        'osascript_invalid_argument',
      );
    }
  }

  const execArgs = [
    '-e',
    'on run argv',
    ...scriptLines.flatMap((line) => ['-e', line]),
    '-e',
    'end run',
    '--',
    ...args,
  ];

  return fromPromise(
    run('osascript', execArgs, {
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 4 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).then(({ stdout }) => stdout.trim()),
    'osascript_failed',
    { retryable: false },
  ).mapErr(explainAppleScriptFailure);
}

/** Runs a plain binary with an argument vector — never a shell string. */
export function runCommand(
  bin: string,
  args: readonly string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): AppResultAsync<string> {
  return fromPromise(
    run(bin, [...args], {
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 4 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).then(({ stdout }) => stdout.trim()),
    'command_failed',
    { retryable: false },
  );
}

/**
 * Turns macOS's refusals into the sentence that fixes them.
 *
 * "osascript is not allowed to send keystrokes. (1002)" is what the user sees
 * when Accessibility has never been granted — accurate, and useless unless you
 * already know it means a checkbox in System Settings. Measured on 2026-09-03:
 * every WhatsApp send failed this way, and the message named `osascript`
 * rather than the permission.
 *
 * Matched on the numeric codes as well as the words, because the wording has
 * changed between macOS releases and the codes have not.
 */
export function explainAppleScriptFailure(error: AppError): AppError {
  const detail = `${error.message} ${error.cause ?? ''}`;

  if (/not allowed to send keystrokes|\(1002\)|assistive access|-25211/i.test(detail)) {
    return permissionError(
      'sending keystrokes needs Accessibility. Open System Settings > Privacy & Security > Accessibility and turn on the terminal or app running Assistant',
    );
  }
  if (/Not authorized to send Apple events|-1743/i.test(detail)) {
    return permissionError(
      'controlling other apps needs Automation. Open System Settings > Privacy & Security > Automation and allow it',
    );
  }
  return error;
}

export const permissionError = (what: string) =>
  appError(
    'permission_denied',
    `macOS blocked this action (${what}). Grant it in System Settings > Privacy & Security.`,
    { retryable: false },
  );
