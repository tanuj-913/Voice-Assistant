import { describe, expect, it } from 'vitest';
import { WhatsAppInput } from '@assistant/schemas';
import { distinctNames, parseContacts, toWhatsAppNumber } from './contacts.js';
import { matchContacts, parseWhatsAppContacts } from './whatsapp-contacts.js';
import { whatsAppTool } from './productivity.js';
import { findContactTool } from './find-contact.js';
import { decide } from '../policy.js';
import { UserSettings } from '@assistant/schemas';

/**
 * "Message Rahul" used to be answered with "what is his number?" — a question
 * the Mac can answer for itself, since Contacts holds the mapping and
 * `call_contact` has always used it. What is tested here is mostly the
 * refusals: the number that cannot be trusted, and the name that matches two
 * people. Messaging the wrong person is not undone by apologising.
 */

describe('turning a stored number into one WhatsApp accepts', () => {
  it.each([
    ['+91 98765 43210', '919876543210'],
    ['+1 (415) 555-0132', '14155550132'],
    ['0091 98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
  ])('reads %s as %s', (stored, expected) => {
    expect(toWhatsAppNumber(stored)).toBe(expected);
  });

  /**
   * The important refusal. A ten-digit local number with a guessed country
   * code in front of it is a message to a stranger.
   */
  it.each(['98765 43210', '9876543210', '555-0132', '', 'not a number'])(
    'refuses to guess a country code for %s',
    (stored) => {
      expect(toWhatsAppNumber(stored)).toBeNull();
    },
  );
});

describe('reading what Contacts returned', () => {
  it('pairs each person with each of their numbers', () => {
    const parsed = parseContacts('Rahul Sharma|+91 98765 43210\nRahul Verma|+91 98765 00000\n');
    expect(parsed).toEqual([
      { name: 'Rahul Sharma', phone: '+91 98765 43210' },
      { name: 'Rahul Verma', phone: '+91 98765 00000' },
    ]);
    expect(distinctNames(parsed)).toEqual(['Rahul Sharma', 'Rahul Verma']);
  });

  it('counts one person with two numbers as one person', () => {
    const parsed = parseContacts('Rahul|+91 98765 43210\nRahul|+91 91234 56789');
    expect(distinctNames(parsed)).toEqual(['Rahul']);
  });

  it('ignores malformed lines rather than inventing a contact', () => {
    expect(parseContacts('no separator here\n\n|+919876543210')).toEqual([]);
  });
});

describe('what the tool now accepts', () => {
  it('takes a name, which is how people ask', () => {
    expect(WhatsAppInput.safeParse({ contactName: 'Rahul', message: 'on my way' }).success).toBe(
      true,
    );
  });

  it('still takes a number directly', () => {
    expect(WhatsAppInput.safeParse({ phone: '919876543210', message: 'hi' }).success).toBe(true);
  });

  it('refuses a message addressed to nobody', () => {
    expect(WhatsAppInput.safeParse({ message: 'hi' }).success).toBe(false);
  });
});

describe('asking instead of guessing', () => {
  it('asks which person when the name matches two', () => {
    const asked = whatsAppTool.clarify?.({
      opened: false,
      reason: 'ambiguous',
      candidates: ['Rahul Sharma', 'Rahul Verma'],
    });
    expect(asked?.question).toMatch(/which one/i);
    expect(asked?.options).toEqual(['Rahul Sharma', 'Rahul Verma']);
  });

  it('asks which number when one person has several', () => {
    const asked = whatsAppTool.clarify?.({
      opened: false,
      reason: 'multiple-numbers',
      contactName: 'Rahul',
      candidates: ['+91 98765 43210', '+91 91234 56789'],
    });
    expect(asked?.question).toMatch(/which number for Rahul/i);
  });

  it('asks for the country code rather than assuming one', () => {
    const asked = whatsAppTool.clarify?.({
      opened: false,
      reason: 'no-country-code',
      contactName: 'Rahul',
      candidates: ['98765 43210'],
    });
    expect(asked?.question).toMatch(/country code/i);
  });

  it('says plainly when the contact is not there', () => {
    const asked = whatsAppTool.clarify?.({
      opened: false,
      reason: 'no-match',
      contactName: 'Rahul',
    });
    expect(asked?.question).toMatch(/could not find Rahul/i);
  });

  it('asks nothing once WhatsApp is open', () => {
    expect(whatsAppTool.clarify?.({ opened: true, to: 'Rahul' })).toBeNull();
  });

  /** Nothing was sent, and the renderer must never imply otherwise. */
  it('never says a message was sent', () => {
    const spoken = whatsAppTool.speak?.({ opened: true, to: 'Rahul' }) ?? '';
    expect(spoken).toContain('ready to send');
    expect(spoken).not.toMatch(/\bsent\b/i);
    // And it declines entirely when nothing was opened.
    expect(whatsAppTool.speak?.({ opened: false, reason: 'no-match' })).toBeNull();
  });
});

/**
 * WhatsApp's own contact list.
 *
 * The Mac's address book holds one person here — the phone has no Apple ID, so
 * nothing has ever synced — while WhatsApp keeps 447 people of its own. The
 * numbers people are messaged on live in WhatsApp, so that is where a name is
 * resolved first.
 */
describe("reading WhatsApp's contact list", () => {
  const rows = [
    'Tilak CSM|919876543210@s.whatsapp.net|+91 98765 43210',
    'Tilak Sharma|919876500000@s.whatsapp.net|+91 98765 00000',
    'Rahul|918888888888@s.whatsapp.net|+91 88888 88888',
    // No id and no number: not someone you can message.
    'Ghost Contact||',
  ].join('\n');

  it('takes the WhatsApp id, which already carries a country code', () => {
    const parsed = parseWhatsAppContacts(rows);
    expect(parsed[0]).toEqual({ name: 'Tilak CSM', phone: '919876543210' });
  });

  it('drops a contact with no usable number rather than inventing one', () => {
    expect(parseWhatsAppContacts(rows).map((c) => c.name)).not.toContain('Ghost Contact');
  });

  it('falls back to the stored number when there is no WhatsApp id', () => {
    expect(parseWhatsAppContacts('Neha||+91 91234 56789')).toEqual([
      { name: 'Neha', phone: '919123456789' },
    ]);
  });

  /** The case that started this: "tilak" for a contact saved as "Tilak CSM". */
  it('matches a partial name, case-insensitively', () => {
    const all = parseWhatsAppContacts(rows);
    expect(matchContacts(all, 'tilak').map((c) => c.name)).toEqual(['Tilak CSM', 'Tilak Sharma']);
    expect(matchContacts(all, 'csm').map((c) => c.name)).toEqual(['Tilak CSM']);
    expect(matchContacts(all, 'RAHUL').map((c) => c.name)).toEqual(['Rahul']);
  });

  /**
   * An exact name wins outright. Without this, someone saved as "Tilak" could
   * never be reached while "Tilak CSM" and "Tilak Sharma" also exist — the
   * question would be unanswerable by saying the right thing.
   */
  it('prefers an exact match over the names that contain it', () => {
    const all = parseWhatsAppContacts(`${rows}\nTilak|917777777777@s.whatsapp.net|`);
    expect(matchContacts(all, 'Tilak').map((c) => c.name)).toEqual(['Tilak']);
  });

  it('finds nobody for an empty name rather than everybody', () => {
    expect(matchContacts(parseWhatsAppContacts(rows), '   ')).toEqual([]);
  });

  it('ignores rows it cannot read', () => {
    expect(parseWhatsAppContacts('\n\n|919876543210@s.whatsapp.net|')).toEqual([]);
  });
});

/**
 * Reading contacts back, and actually sending.
 *
 * Two things the user asked for on 2026-09-03: "when I ask to read out the
 * contacts she doesn't do it" — there was no tool to call — and "when I ask to
 * send it just types and leaves it in draft".
 */
describe('looking someone up without messaging them', () => {
  const ctx = { settings: UserSettings.parse({}), online: true };

  it('reads without asking, because it changes nothing and reaches nobody', () => {
    expect(findContactTool.metadata.risk).toBe('read');
    expect(decide(findContactTool.metadata, ctx).action).toBe('allow');
  });

  it('says who it found, by name', () => {
    expect(
      findContactTool.speak?.({ count: 2, query: 'tilak', people: ["Tilak's Dad", 'Tilak CSM'] }),
    ).toBe("You have 2: Tilak's Dad and Tilak CSM.");
    expect(findContactTool.speak?.({ count: 1, query: 'rahul', people: ['Rahul'] })).toBe(
      'You have one: Rahul.',
    );
  });

  it('says plainly when there is nobody', () => {
    expect(findContactTool.speak?.({ count: 0, query: 'Tilak' })).toBe(
      "I couldn't find anyone called Tilak.",
    );
  });

  /** A long list is for the model to summarise, not for Assistant to recite. */
  it('leaves a long list to the model', () => {
    expect(
      findContactTool.speak?.({ count: 9, query: 'a', people: ['a', 'b', 'c', 'd', 'e'] }),
    ).toBeNull();
  });

  /**
   * Numbers are in the result for the model to use when asked, but never read
   * aloud unprompted — a phone number spoken is unlistenable and is the part
   * worth not broadcasting.
   */
  it('never speaks a phone number of its own accord', () => {
    const spoken =
      findContactTool.speak?.({
        count: 1,
        query: 'tilak',
        people: ['Tilak CSM'],
        matches: [{ name: 'Tilak CSM', phone: '919876543210' }],
      }) ?? '';
    expect(spoken).not.toContain('919876543210');
  });
});

describe('pressing send', () => {
  it('sends by default now, and can still be told not to', () => {
    expect(WhatsAppInput.parse({ contactName: 'Tilak', message: 'hi' }).send).toBe(true);
    expect(WhatsAppInput.parse({ contactName: 'Tilak', message: 'hi', send: false }).send).toBe(
      false,
    );
  });

  /** Still always confirmed: the card shows the exact text before any of it. */
  it('keeps the confirmation gate', () => {
    const ctx = { settings: UserSettings.parse({}), online: true };
    expect(whatsAppTool.metadata.risk).toBe('external');
    expect(decide(whatsAppTool.metadata, ctx).action).toBe('confirm');
    // And pre-approving it does not remove the prompt for a destructive tier;
    // external is the tier where "always allow" is honoured, so this is the
    // one place the user can relax it deliberately.
    const relaxed = {
      settings: UserSettings.parse({ autoApprovedTools: ['whatsapp_message'] }),
      online: true,
    };
    expect(decide(whatsAppTool.metadata, relaxed).action).toBe('allow');
  });
});
