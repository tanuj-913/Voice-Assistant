import { describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { readScreenTool } from './screen.js';
import { decide } from '../policy.js';

/**
 * Reading the screen returns its *contents*, not a path — whatever is visible
 * becomes text in the transcript. These tests are about that boundary: it
 * always asks, it says why, and it never dumps an unbounded screen.
 */

const policyCtx = { settings: UserSettings.parse({}), online: true };

describe('read_screen', () => {
  /**
   * Stronger than `capture_screen`, which only returns a path. This one could
   * put a password manager or someone's messages into the conversation.
   */
  it('always asks, and cannot be pre-approved away', () => {
    expect(decide(readScreenTool.metadata, policyCtx).action).toBe('confirm');

    const preApproved = {
      settings: UserSettings.parse({ autoApprovedTools: ['read_screen'] }),
      online: true,
    };
    expect(decide(readScreenTool.metadata, preApproved).action).toBe('confirm');
  });

  it('declares the screen-recording permission it needs', () => {
    expect(readScreenTool.metadata.requiredPermissions).toContain('screen-recording');
  });

  it('requires a reason, which the user sees when approving', () => {
    // A prompt saying only "read_screen?" gives nobody enough to decide.
    expect(readScreenTool.input.safeParse({ mode: 'screen' }).success).toBe(false);
    expect(
      readScreenTool.input.safeParse({ mode: 'screen', reason: 'read the error dialog' }).success,
    ).toBe(true);
  });

  it('says so plainly when there is no text, and leaves the rest to the model', () => {
    expect(
      readScreenTool.speak?.({ mode: 'screen', lineCount: 0, text: '', truncated: false }),
    ).toBe("I can't see any text on the screen.");
    // Reading a screen aloud verbatim is useless; summarising is the model's job.
    expect(
      readScreenTool.speak?.({ mode: 'screen', lineCount: 12, text: 'a\nb', truncated: false }),
    ).toBeNull();
  });

  it('works offline, since Vision is on the machine', () => {
    expect(readScreenTool.metadata.requiresNetwork).toBe(false);
  });
});
