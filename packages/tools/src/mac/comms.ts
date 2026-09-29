import { CallContactInput, SendMessageInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript, runCommand } from './osascript.js';

/** Resolves a contact name to their first phone number via the Contacts app. */
const LOOKUP_PHONE = [
  'tell application "Contacts"',
  '  set matches to (every person whose name contains (item 1 of argv))',
  '  if (count of matches) is 0 then return "no-match"',
  '  set thePerson to item 1 of matches',
  '  if (count of phones of thePerson) is 0 then return "no-phone"',
  '  return value of first phone of thePerson',
  'end tell',
];

export const callContactTool = defineTool({
  metadata: {
    name: 'call_contact',
    description:
      'Place a FaceTime audio, FaceTime video, or phone call to someone in the Contacts app, by name.',
    category: 'communication',
    // Placing a call is visible, interrupts someone, and is awkward to undo.
    risk: 'external',
    connector: 'macos-cli',
    requiredPermissions: ['contacts', 'automation'],
    timeoutMs: 20_000,
  },
  input: CallContactInput,
  execute: (args, ctx) =>
    runAppleScript(LOOKUP_PHONE, [args.contactName], { signal: ctx.signal }).andThen((phone) => {
      if (phone === 'no-match' || phone === 'no-phone' || phone.length === 0) {
        return runCommand('true', [], { signal: ctx.signal }).map(() => ({
          called: null,
          reason: phone === 'no-phone' ? 'Contact has no phone number' : 'No matching contact',
        }));
      }

      const scheme =
        args.method === 'facetime-video'
          ? 'facetime'
          : args.method === 'phone'
            ? 'tel'
            : 'facetime-audio';

      return runCommand('open', [`${scheme}://${phone}`], { signal: ctx.signal }).map(() => ({
        called: args.contactName,
        via: args.method,
      }));
    }),
  speak: (result) => {
    const r = result as { called?: unknown };
    // `called: null` means no contact or no number — the model explains that.
    return typeof r.called === 'string' ? `Calling ${r.called}.` : null;
  },
  /**
   * The PRD's own example: a contact that cannot be resolved must produce a
   * question, not a guess. Dialling the wrong person is not recoverable by
   * apologising afterwards.
   */
  clarify: (result) => {
    const r = result as { called?: unknown; reason?: unknown; candidates?: unknown };
    if (typeof r.called === 'string') return null;
    const candidates = Array.isArray(r.candidates)
      ? r.candidates.filter((c): c is string => typeof c === 'string').slice(0, 6)
      : [];
    if (candidates.length > 1) {
      return { question: 'Which one did you mean?', options: candidates };
    }
    return typeof r.reason === 'string'
      ? { question: `I could not find that contact. Who should I call?`, options: [] }
      : null;
  },
});

/**
 * Messages' `buddy` lookup resolves against the active iMessage service.
 * The body is passed through argv, never interpolated, so message content
 * cannot escape into script.
 */
const SEND_MESSAGE = [
  'tell application "Messages"',
  '  set theService to 1st service whose service type = iMessage',
  '  set theBuddy to buddy (item 1 of argv) of theService',
  '  send (item 2 of argv) to theBuddy',
  '  return "sent"',
  'end tell',
];

export const sendMessageTool = defineTool({
  metadata: {
    name: 'send_message',
    description: 'Send an iMessage to a contact by name.',
    category: 'communication',
    // Sending a message on someone's behalf is not undoable.
    risk: 'external',
    connector: 'macos-applescript',
    requiredPermissions: ['contacts', 'automation'],
    timeoutMs: 20_000,
  },
  input: SendMessageInput,
  execute: (args, ctx) =>
    runAppleScript(SEND_MESSAGE, [args.contactName, args.body], { signal: ctx.signal }).map(() => ({
      sent: true,
      to: args.contactName,
    })),
  speak: (result) => {
    const r = result as { sent?: unknown; to?: unknown };
    return r.sent === true && typeof r.to === 'string' ? `Message sent to ${r.to}.` : null;
  },
});
