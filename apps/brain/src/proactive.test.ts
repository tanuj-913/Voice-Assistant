import { describe, expect, it } from 'vitest';
import { parseReminders } from '@assistant/tools';
import { ProactiveWatcher } from './proactive.js';

/**
 * The only part of Assistant that speaks first, so the tests are mostly about
 * restraint: it stays quiet unless turned on, it says a thing once, and it
 * never says anything the user did not themselves ask to be told.
 */

const reminder = (id: string, title: string) => ({ id, title, dueAt: '2026-09-02T18:00:00' });

function watcher(due: ReturnType<typeof reminder>[][], opts: { enabled?: boolean } = {}) {
  const shown: string[] = [];
  let poll = 0;
  const instance = new ProactiveWatcher({
    enabled: opts.enabled ?? true,
    readDue: () => {
      const batch = due[Math.min(poll, due.length - 1)] ?? [];
      poll += 1;
      return Promise.resolve(batch);
    },
    notify: (_title, body) => {
      shown.push(body);
      return Promise.resolve();
    },
  });
  return { instance, shown };
}

describe('announcing reminders', () => {
  it('says a reminder that is coming due', async () => {
    const { instance, shown } = watcher([[reminder('a', 'Call the dentist')]]);
    await instance.check();
    expect(shown).toEqual(['Call the dentist']);
  });

  /**
   * A reminder due in ten minutes is due on every poll for ten minutes.
   * Announcing it each time would make the feature unusable within a day.
   */
  it('says it once, not once a minute', async () => {
    const due = [reminder('a', 'Call the dentist')];
    const { instance, shown } = watcher([due, due, due]);
    await instance.check();
    await instance.check();
    await instance.check();
    expect(shown).toEqual(['Call the dentist']);
  });

  /**
   * A reminder pushed to tomorrow leaves the window and comes back. It should
   * be announced again then — the user rescheduled it because they still want
   * telling.
   */
  it('announces it again if it comes back', async () => {
    const due = [reminder('a', 'Call the dentist')];
    const { instance, shown } = watcher([due, [], due]);
    await instance.check();
    await instance.check();
    await instance.check();
    expect(shown).toEqual(['Call the dentist', 'Call the dentist']);
  });

  it('is silent when it is switched off', () => {
    const { instance, shown } = watcher([[reminder('a', 'Call the dentist')]], { enabled: false });
    const stop = instance.start();
    stop();
    expect(shown).toEqual([]);
  });

  /**
   * The Reminders app is slow and occasionally refuses. A failed poll must not
   * take the brain down — the next one is a minute away.
   */
  it('survives a reminders app that will not answer', async () => {
    const instance = new ProactiveWatcher({
      enabled: true,
      readDue: () => Promise.reject(new Error('Reminders got an error')),
      notify: () => Promise.resolve(),
    });
    await expect(instance.check()).resolves.toEqual([]);
  });
});

describe('reading them off AppleScript', () => {
  it('parses id, title and time', () => {
    const parsed = parseReminders('x-1|Call the dentist|2026-09-02T18:00:00\n');
    expect(parsed).toEqual([
      { id: 'x-1', title: 'Call the dentist', dueAt: '2026-09-02T18:00:00' },
    ]);
  });

  /** No id means no way to tell it apart from the next poll's copy of itself. */
  it('drops a row with no id rather than announcing it repeatedly', () => {
    expect(parseReminders('|No id here|2026-09-02T18:00:00')).toEqual([]);
  });

  it('ignores blank lines', () => {
    expect(parseReminders('\n\n')).toEqual([]);
  });
});
