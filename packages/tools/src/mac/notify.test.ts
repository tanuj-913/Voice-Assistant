import { describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { createNotifyTool } from './notify.js';
import { decide } from '../policy.js';

/**
 * "Proactive approved notifications" — the word doing the work is *approved*.
 * An assistant that can interrupt you unprompted is a different product from
 * one that answers when asked, so these tests are about the switch being real.
 */

const ctx = { online: true, signal: AbortSignal.timeout(5000) };
const policyCtx = { settings: UserSettings.parse({}), online: true };

describe('when notifications are off', () => {
  const notify = createNotifyTool({ enabled: false });

  it('does not show one, and says why', async () => {
    const result = await notify.execute({ title: 'Done', body: 'the build finished' }, ctx);
    const value = result._unsafeUnwrap();

    expect((value as { shown: boolean }).shown).toBe(false);
    expect(notify.speak?.(value)).toMatch(/turned off/i);
  });

  /**
   * A result, not an error: the model should tell the user the setting is off,
   * not report that something broke.
   */
  it('reports it as a result rather than a failure', async () => {
    const result = await notify.execute({ title: 'x', body: 'y' }, ctx);
    expect(result.isOk()).toBe(true);
  });

  it('says so in its description, so the model can explain', () => {
    expect(createNotifyTool({ enabled: false }).metadata.description).toMatch(/disabled/i);
    expect(createNotifyTool({ enabled: true }).metadata.description).not.toMatch(/disabled/i);
  });
});

describe('when notifications are on', () => {
  const notify = createNotifyTool({ enabled: true });

  it('runs without interrupting — the notification is the interruption', () => {
    expect(decide(notify.metadata, policyCtx).action).toBe('allow');
  });

  /**
   * Speaking a notification would interrupt exactly the thing the notification
   * exists to avoid interrupting.
   */
  it('says nothing aloud when one is shown', () => {
    expect(notify.speak?.({ shown: true, title: 'Done' })).toBeNull();
  });

  it('keeps titles and bodies short enough to fit a banner', () => {
    expect(notify.input.safeParse({ title: 'x'.repeat(200), body: 'y' }).success).toBe(false);
    expect(notify.input.safeParse({ title: 'Build done', body: 'in 4 minutes' }).success).toBe(
      true,
    );
  });
});
