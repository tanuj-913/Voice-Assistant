import {
  AppendNoteInput,
  CreateNoteInput,
  CreateReminderInput,
  ReadCalendarInput,
  RevealInFinderInput,
  WhatsAppInput,
} from '@assistant/schemas';
import { okAsync } from '@assistant/core';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';
import { distinctNames, lookupContacts, toWhatsAppNumber } from './contacts.js';
import { matchContacts, readWhatsAppContacts, type WhatsAppContact } from './whatsapp-contacts.js';

/**
 * Apps Assistant can actually operate.
 *
 * Everything here drives a real application through AppleScript, with the
 * text arriving via argv so dictated content can never become script. Notes,
 * Calendar and Reminders all ship scriptable dictionaries; WhatsApp does not,
 * which is why it is the one exception below.
 */

export const createNoteTool = defineTool({
  metadata: {
    name: 'create_note',
    description:
      'Create a new note in the Notes app with a title and body. Use when the user wants something written down.',
    category: 'system',
    // Writes into the user's own documents; worth a prompt the first time.
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 20_000,
  },
  input: CreateNoteInput,
  execute: (args, ctx) =>
    runAppleScript(
      [
        'tell application "Notes"',
        '  tell account 1',
        '    make new note with properties {name:(item 1 of argv), body:(item 2 of argv)}',
        '  end tell',
        '  activate',
        'end tell',
        'return "created"',
      ],
      [args.title, args.body],
      { signal: ctx.signal, timeoutMs: 20_000 },
    ).map(() => ({ created: args.title })),
  speak: (result) => {
    const title = (result as { created?: unknown }).created;
    return typeof title === 'string' ? `Saved a note called ${title}.` : null;
  },
});

export const appendNoteTool = defineTool({
  metadata: {
    name: 'append_to_note',
    description: 'Add text to the end of an existing note, found by its title.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 20_000,
  },
  input: AppendNoteInput,
  execute: (args, ctx) =>
    runAppleScript(
      [
        'tell application "Notes"',
        '  set matches to (every note of account 1 whose name contains (item 1 of argv))',
        '  if (count of matches) is 0 then return "no-match"',
        '  set theNote to item 1 of matches',
        '  set body of theNote to (body of theNote) & "<br>" & (item 2 of argv)',
        '  activate',
        'end tell',
        'return "appended"',
      ],
      [args.title, args.body],
      { signal: ctx.signal, timeoutMs: 20_000 },
    ).map((result) =>
      result === 'no-match'
        ? { appended: false, reason: `No note titled like "${args.title}"` }
        : { appended: true, note: args.title },
    ),
  speak: (result) => {
    const r = result as { appended?: unknown; note?: unknown };
    // Not finding the note is a thing to explain, not announce.
    if (r.appended !== true) return null;
    return typeof r.note === 'string' ? `Added that to ${r.note}.` : null;
  },
});

export const readCalendarTool = defineTool({
  metadata: {
    name: 'read_calendar',
    description:
      "Read events from the user's calendar for today or the next few days. Use for questions like what is on today, or when is my next meeting.",
    category: 'system',
    risk: 'read',
    connector: 'macos-applescript',
    requiredPermissions: ['calendar', 'automation'],
    timeoutMs: 30_000,
  },
  input: ReadCalendarInput,
  execute: (args, ctx) =>
    runAppleScript(
      [
        'set daysAhead to (item 1 of argv) as integer',
        'set startDate to (current date)',
        'set time of startDate to 0',
        'set endDate to startDate + ((daysAhead + 1) * days)',
        'set output to ""',
        'tell application "Calendar"',
        '  repeat with cal in calendars',
        '    repeat with evt in (every event of cal whose start date is greater than startDate and start date is less than endDate)',
        '      set output to output & (summary of evt) & " @ " & (start date of evt as string) & linefeed',
        '    end repeat',
        '  end repeat',
        'end tell',
        'return output',
      ],
      [String(args.daysAhead)],
      { signal: ctx.signal, timeoutMs: 30_000 },
    ).map((raw) => {
      const events = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return { daysAhead: args.daysAhead, count: events.length, events };
    }),
});

export const createReminderTool = defineTool({
  metadata: {
    name: 'create_reminder',
    description: 'Add a reminder to the Reminders app, optionally with a due date.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['reminders', 'automation'],
    timeoutMs: 20_000,
  },
  input: CreateReminderInput,
  execute: (args, ctx) => {
    // `date` in AppleScript parses natural phrasing like "tomorrow 9am".
    const script = args.dueAt
      ? [
          'tell application "Reminders"',
          '  make new reminder with properties {name:(item 1 of argv), due date:(date (item 2 of argv))}',
          'end tell',
          'return "created"',
        ]
      : [
          'tell application "Reminders"',
          '  make new reminder with properties {name:(item 1 of argv)}',
          'end tell',
          'return "created"',
        ];

    const argv = args.dueAt ? [args.text, args.dueAt] : [args.text];
    return runAppleScript(script, argv, { signal: ctx.signal, timeoutMs: 20_000 }).map(() => ({
      created: args.text,
      ...(args.dueAt ? { dueAt: args.dueAt } : {}),
    }));
  },
  speak: (result) => {
    const r = result as { created?: unknown; dueAt?: unknown };
    // With a time set, let the model say it — "2026-09-01T14:30" read aloud
    // is worse than the round trip it saves.
    if (r.dueAt !== undefined) return null;
    return typeof r.created === 'string' ? `Reminder set: ${r.created}.` : null;
  },
});

export const revealInFinderTool = defineTool({
  metadata: {
    name: 'reveal_in_finder',
    description: 'Show a file or folder in Finder, selecting it in its containing folder.',
    category: 'system',
    risk: 'reversible',
    connector: 'macos-applescript',
    timeoutMs: 10_000,
  },
  input: RevealInFinderInput,
  // `open -R` reveals rather than opens, so a document is shown in place
  // instead of being launched in whatever app claims it.
  execute: (args, ctx) =>
    runCommand('open', ['-R', args.path], { signal: ctx.signal }).map(() => ({
      revealed: args.path,
    })),
  // Deliberately not reading the path aloud — a full POSIX path is unlistenable.
  speak: (result) =>
    (result as { revealed?: unknown }).revealed !== undefined ? 'Showed it in Finder.' : null,
});

/**
 * Pressing send, which WhatsApp gives no other way to do.
 *
 * The deep link fills the box and stops. Return sends it — but a keystroke
 * goes wherever the focus is, so this waits for WhatsApp to actually be the
 * frontmost app and gives up rather than typing into whatever else is there.
 * Sending to the wrong window is the failure worth preventing; a message left
 * unsent is merely annoying.
 *
 * The wait is generous because the Mac is often paging when this runs, and the
 * chat has to load before the text lands in the box.
 */
const PRESS_SEND = [
  'set attempts to 0',
  'repeat until attempts is 25',
  '  tell application "System Events"',
  '    if exists process "WhatsApp" then',
  '      if frontmost of process "WhatsApp" then exit repeat',
  '    end if',
  '  end tell',
  '  delay 0.2',
  '  set attempts to attempts + 1',
  'end repeat',
  'tell application "System Events"',
  '  if not (exists process "WhatsApp") then return "not-running"',
  '  if not (frontmost of process "WhatsApp") then return "not-frontmost"',
  '  delay 0.9',
  '  key code 36',
  'end tell',
  'return "sent"',
];

/**
 * A message to someone by name, resolved from the list they are actually in.
 *
 * WhatsApp ships no AppleScript dictionary, so there is no way to press send
 * for the user, and the URL scheme it does offer needs digits. That used to
 * mean Assistant asked "what is their number?" — a question the Mac can answer
 * for itself, twice over:
 *
 * 1. **WhatsApp's own contact list**, read from its local database. This is
 *    the one that matters here: the numbers people message on WhatsApp live in
 *    WhatsApp, and its entries already carry a country code.
 * 2. **The Contacts app**, as a fallback, which is where `call_contact` looks.
 *    On a Mac whose phone has no Apple ID to sync from, it may hold nobody.
 */
export const whatsAppTool = defineTool({
  metadata: {
    name: 'whatsapp_message',
    description:
      "Open WhatsApp with a message typed out and ready to send, to someone by name or by phone number. Looks the name up in WhatsApp's own contacts. The user presses send themselves.",
    category: 'communication',
    risk: 'external',
    connector: 'macos-cli',
    requiredPermissions: ['contacts'],
    timeoutMs: 25_000,
  },
  input: WhatsAppInput,
  execute: (args, ctx) => {
    const open = (phone: string, to: string | null) =>
      openChat({ phone, to, message: args.message, send: args.send, signal: ctx.signal });

    if (args.phone !== undefined) return open(args.phone, null);
    const name = args.contactName ?? '';

    return (
      readWhatsAppContacts({ signal: ctx.signal })
        .map((all) => matchContacts(all, name))
        // A database that cannot be read is not a reason to fail the turn —
        // the address book might still know them.
        .orElse(() => okAsync([] as WhatsAppContact[]))
        .andThen((found) => {
          if (found.length === 0) return fromAddressBook(name, args.message, args.send, ctx.signal);

          const people = [...new Set(found.map((c) => c.name))];
          // Two people called Tilak: picking one is how a message reaches the
          // wrong person.
          if (people.length > 1) {
            return okAsync({ opened: false, reason: 'ambiguous', candidates: people });
          }

          const first = found[0];
          return first
            ? open(first.phone, first.name)
            : okAsync({ opened: false, reason: 'no-match', contactName: name });
        })
    );
  },
  // Worth rendering precisely because a model might summarise this as "I sent
  // it". Nothing was sent, and saying so is the whole point of the tool.
  /**
   * Says which of the two actually happened. "Sent" is a claim, and the PRD
   * forbids making it without the action behind it — so a message that was
   * typed but not sent never borrows the word.
   */
  speak: (result) => {
    const r = result as { opened?: unknown; sent?: unknown; to?: unknown };
    if (r.opened !== true) return null;
    const who = typeof r.to === 'string' ? r.to : null;
    if (r.sent === true) return who === null ? 'Sent.' : `Sent to ${who}.`;
    return who === null
      ? 'WhatsApp is open with the message ready. Press send to deliver it.'
      : `WhatsApp is open with a message to ${who}, ready to send — I could not press send myself.`;
  },
  /**
   * An unresolved contact becomes a question rather than a guess — the same
   * rule `call_contact` follows, for the same reason.
   */
  clarify: (result) => {
    const r = result as {
      opened?: unknown;
      reason?: unknown;
      candidates?: unknown;
      contactName?: unknown;
    };
    if (r.opened === true) return null;

    const candidates = Array.isArray(r.candidates)
      ? r.candidates.filter((c): c is string => typeof c === 'string').slice(0, 6)
      : [];
    const who = typeof r.contactName === 'string' ? r.contactName : 'them';

    switch (r.reason) {
      case 'ambiguous':
        return { question: 'Which one did you mean?', options: candidates };
      case 'multiple-numbers':
        return { question: `Which number for ${who}?`, options: candidates };
      case 'no-country-code':
        return {
          question: `I have a number for ${who} but no country code. What is the full number?`,
          options: [],
        };
      case 'no-match':
        return {
          question: `I could not find ${who} in WhatsApp or your contacts. What is their number?`,
          options: [],
        };
      default:
        return null;
    }
  },
});

/**
 * The Contacts app, tried only when WhatsApp's own list has nobody.
 *
 * Its numbers are often local — ten digits with no country code — and putting
 * a guessed country code in front of one is how a message reaches a stranger.
 * So an untrustworthy number asks rather than dials.
 */
function fromAddressBook(name: string, message: string, send: boolean, signal: AbortSignal) {
  return lookupContacts(name, { signal }).andThen((matches) => {
    const people = distinctNames(matches);
    if (matches.length === 0) {
      return okAsync({ opened: false, reason: 'no-match', contactName: name });
    }
    if (people.length > 1) {
      return okAsync({ opened: false, reason: 'ambiguous', candidates: people });
    }

    const usable = matches
      .map((m) => ({ label: m.phone, digits: toWhatsAppNumber(m.phone) }))
      .filter((m): m is { label: string; digits: string } => m.digits !== null);

    if (usable.length === 0) {
      return okAsync({
        opened: false,
        reason: 'no-country-code',
        contactName: people[0] ?? name,
        candidates: matches.map((m) => m.phone),
      });
    }
    if (usable.length > 1) {
      return okAsync({
        opened: false,
        reason: 'multiple-numbers',
        contactName: people[0] ?? name,
        candidates: usable.map((m) => m.label),
      });
    }

    const chosen = usable[0];
    if (!chosen) return okAsync({ opened: false, reason: 'no-match', contactName: name });

    return openChat({
      phone: chosen.digits,
      to: people[0] ?? name,
      message,
      send,
      signal,
    });
  });
}

/**
 * Opens the chat with the message in it, and presses send if asked to.
 *
 * One implementation, because there are two ways to arrive here — WhatsApp's
 * own contact list and the Contacts app — and a second copy of "did it
 * actually send" is exactly where the two would drift apart.
 */
function openChat(opts: {
  phone: string;
  to: string | null;
  message: string;
  send: boolean;
  signal: AbortSignal;
}) {
  const url = `whatsapp://send?phone=${opts.phone}&text=${encodeURIComponent(opts.message)}`;
  const to = opts.to === null ? {} : { to: opts.to };

  return runCommand('open', [url], { signal: opts.signal }).andThen(() => {
    if (!opts.send) {
      return okAsync({
        opened: true,
        sent: false,
        ...to,
        note: 'WhatsApp is open with the message ready. Press send to deliver it.',
      });
    }

    return runAppleScript(PRESS_SEND, [], { signal: opts.signal, timeoutMs: 20_000 }).map(
      (outcome) => ({
        opened: true,
        sent: outcome === 'sent',
        ...to,
        ...(outcome === 'sent'
          ? {}
          : {
              reason: outcome,
              note: 'The message is typed into WhatsApp but was not sent. Press send yourself.',
            }),
      }),
    );
  });
}
