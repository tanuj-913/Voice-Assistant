import { describe, expect, it } from 'vitest';
import { UserSettings } from '@assistant/schemas';
import { draftEmailTool, searchMailTool, sendEmailTool } from './mail.js';
import { decide } from '../policy.js';
import { buildToolRegistry } from '../index.js';

/**
 * Email is the clearest case of "external actions cannot be taken back". These
 * tests are about the seam between drafting and sending, and about Assistant
 * never describing one as the other.
 */

const ctx = { settings: UserSettings.parse({}), online: true };

describe('drafting versus sending', () => {
  /**
   * Two tools rather than one with a flag: a flag is one misheard word away
   * from sending something meant as a draft.
   */
  it('treats a draft as reversible and a send as external', () => {
    expect(draftEmailTool.metadata.risk).toBe('reversible');
    expect(sendEmailTool.metadata.risk).toBe('external');
  });

  it('lets a draft through but always confirms a send', () => {
    expect(decide(draftEmailTool.metadata, ctx).action).toBe('allow');
    expect(decide(sendEmailTool.metadata, ctx).action).toBe('confirm');
  });

  it('never lets pre-approval turn into silent sending', () => {
    // "Always allow email" is a reasonable-sounding preference that must not
    // become "send anything without telling me".
    const preApproved = {
      settings: UserSettings.parse({ alwaysConfirmTools: ['send_email'] }),
      online: true,
    };
    expect(decide(sendEmailTool.metadata, preApproved).action).toBe('confirm');
  });

  it('does not claim a draft was sent', () => {
    const spoken = draftEmailTool.speak?.({ drafted: true, to: 'a@b.com', sent: false }) ?? '';
    expect(spoken).toContain('ready for you to send');
    expect(spoken).not.toMatch(/\bsent\b/i);
  });

  it('says who a sent email went to', () => {
    expect(sendEmailTool.speak?.({ sent: true, to: 'rahul@example.com' })).toBe(
      'Email sent to rahul@example.com.',
    );
  });
});

describe('searching mail', () => {
  /**
   * Reading someone's inbox is not a green "read permitted information"
   * action. A misheard word must never cause mail to be summarised aloud.
   */
  it('asks before reading the inbox', () => {
    expect(decide(searchMailTool.metadata, ctx).action).toBe('confirm');
  });

  it('promises not to read message bodies', () => {
    // The description is the contract the model plans against.
    expect(searchMailTool.metadata.description).toMatch(/does not read message bodies/i);
  });

  it('answers "nothing matched" itself, and leaves a list to the model', () => {
    expect(searchMailTool.speak?.({ query: 'invoice', matches: [], count: 0 })).toBe(
      'Nothing in your inbox matches that.',
    );
    expect(searchMailTool.speak?.({ query: 'invoice', matches: ['a', 'b'], count: 2 })).toBeNull();
  });
});

describe('registration', () => {
  const registry = buildToolRegistry({});

  it('exposes all three to the model', () => {
    for (const name of ['draft_email', 'send_email', 'search_mail']) {
      expect(registry.get(name), `${name} missing`).toBeDefined();
    }
  });

  it('rejects a malformed address before anything runs', () => {
    // Validation is the gate every call passes, so a typo fails locally rather
    // than as an opaque AppleScript error.
    expect(
      sendEmailTool.input.safeParse({ to: 'not-an-email', subject: 's', body: 'b' }).success,
    ).toBe(false);
    expect(sendEmailTool.input.safeParse({ to: 'a@b.com', subject: 's', body: 'b' }).success).toBe(
      true,
    );
  });
});
