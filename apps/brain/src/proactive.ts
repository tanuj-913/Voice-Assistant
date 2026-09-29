import { childLogger } from '@assistant/core';
import { listDueReminders, showNotification, type DueReminder } from '@assistant/tools';

const log = childLogger('proactive');

/**
 * The only thing in Assistant that speaks first.
 *
 * The PRD's phase 6 asks for "proactive approved notifications", and until now
 * the `notify` tool existed with nothing to trigger it: the model could raise
 * a notification if it happened to be in a turn, which is not proactive at
 * all — it still needed you to start talking.
 *
 * What it watches is deliberately narrow. A reminder falling due is something
 * the user themselves asked to be told about, at a time they chose. That is
 * the whole justification for interrupting them, and it is why nothing else is
 * watched here: an assistant that decides on its own when you would like to
 * hear from it is a different product.
 *
 * Three rules:
 *
 * 1. **Off unless turned on.** `PROACTIVE_NOTIFICATIONS=true`, the same flag
 *    that gates the tool.
 * 2. **Once per reminder.** Announced ids are remembered, so a reminder due in
 *    ten minutes is not announced on every poll for ten minutes.
 * 3. **Never spoken.** A notification exists to reach someone who is doing
 *    something else; speaking would interrupt exactly what it is trying not
 *    to.
 */

export interface ProactiveOptions {
  enabled: boolean;
  /** How far ahead to look. Anything due sooner than this is announced now. */
  windowMinutes?: number;
  intervalMs?: number;
  /** Injected for tests; the real one talks to the Reminders app. */
  readDue?: (withinMinutes: number) => Promise<DueReminder[]>;
  notify?: (title: string, body: string) => Promise<void>;
}

export class ProactiveWatcher {
  readonly #opts: Required<Omit<ProactiveOptions, 'readDue' | 'notify'>> &
    Pick<ProactiveOptions, 'readDue' | 'notify'>;
  readonly #announced = new Set<string>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ProactiveOptions) {
    this.#opts = {
      enabled: options.enabled,
      windowMinutes: options.windowMinutes ?? 10,
      // A minute is often enough to be timely and rare enough that the
      // Reminders app's slow AppleScript never overlaps with itself.
      intervalMs: options.intervalMs ?? 60_000,
      ...(options.readDue ? { readDue: options.readDue } : {}),
      ...(options.notify ? { notify: options.notify } : {}),
    };
  }

  start(): () => void {
    if (!this.#opts.enabled) {
      log.info(
        'proactive notifications are off — set PROACTIVE_NOTIFICATIONS=true to turn them on',
      );
      return () => undefined;
    }

    log.info({ everyMs: this.#opts.intervalMs }, 'watching for reminders coming due');
    this.#timer = setInterval(() => {
      void this.check();
    }, this.#opts.intervalMs);
    // Never the reason the process stays alive: the brain should exit when the
    // server closes, not be held open by a poll nobody is waiting on.
    this.#timer.unref();

    return () => {
      this.stop();
    };
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One pass. Exposed so a test does not have to wait for a timer. */
  async check(): Promise<DueReminder[]> {
    const read =
      this.#opts.readDue ??
      (async (minutes: number) => {
        const result = await listDueReminders(minutes);
        // A failure here is logged and dropped rather than retried: the next
        // poll is a minute away, and a Reminders app that is busy now will
        // answer then.
        if (result.isErr()) {
          log.warn({ error: result.error }, 'could not read reminders');
          return [];
        }
        return result.value;
      });

    let due: DueReminder[];
    try {
      due = await read(this.#opts.windowMinutes);
    } catch (error) {
      log.warn({ error }, 'could not read reminders');
      return [];
    }

    const fresh = due.filter((reminder) => !this.#announced.has(reminder.id));
    for (const reminder of fresh) {
      // Marked before the notification is shown, not after. A failure to
      // display is not a reason to try the same reminder again every minute.
      this.#announced.add(reminder.id);
      const notify =
        this.#opts.notify ??
        (async (title: string, body: string) => {
          const shown = await showNotification(title, body);
          if (shown.isErr()) log.warn({ error: shown.error }, 'could not show a notification');
        });
      await notify('Reminder', reminder.title);
      log.info({ reminder: reminder.title }, 'announced a reminder');
    }

    // Anything no longer due — completed, deleted, or rescheduled — is
    // forgotten, so a reminder pushed to tomorrow is announced again tomorrow.
    const live = new Set(due.map((r) => r.id));
    for (const id of this.#announced) {
      if (!live.has(id)) this.#announced.delete(id);
    }

    return fresh;
  }
}
