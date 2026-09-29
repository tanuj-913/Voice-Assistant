import { runAppleScript } from './osascript.js';

/**
 * Reminders that are about to come due.
 *
 * Read outside the tool layer because nobody asks for this — it is what makes
 * "proactive notifications" proactive. The model is not involved: a reminder
 * falling due is a fact, and routing it through a language model to decide
 * whether to mention it would add seconds and a chance of it deciding not to.
 *
 * Only incomplete reminders that already have a due date, and only within the
 * window asked for. `whose` filters inside the Reminders app rather than
 * pulling every reminder across the Apple Event boundary one property at a
 * time, which is the difference between a query that takes a moment and one
 * that takes the better part of a minute on a busy list.
 */

export interface DueReminder {
  id: string;
  title: string;
  /** ISO 8601, in the Mac's own timezone. */
  dueAt: string;
}

const SCRIPT = [
  'set cutoff to (current date) + ((item 1 of argv) as integer) * minutes',
  'set out to ""',
  'tell application "Reminders"',
  '  repeat with r in (reminders whose completed is false and due date is not missing value and due date ≤ cutoff)',
  '    set out to out & (id of r) & "|" & (name of r) & "|" & ((due date of r) as «class isot» as string) & linefeed',
  '  end repeat',
  'end tell',
  'return out',
];

export function listDueReminders(
  withinMinutes: number,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return runAppleScript(SCRIPT, [String(withinMinutes)], {
    // Reminders is slow to answer when a list is large, and this runs on a
    // timer rather than in front of a waiting user, so it can afford to wait.
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).map(parseReminders);
}

export function parseReminders(raw: string): DueReminder[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [id, title, dueAt] = line.split('|');
      // A reminder with no id cannot be de-duplicated, and one that is
      // announced twice an hour is worse than one that is missed.
      if (!id || !title) return [];
      return [{ id, title, dueAt: dueAt ?? '' }];
    });
}
