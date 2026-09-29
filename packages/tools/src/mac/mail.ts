import { DraftEmailInput, SearchMailInput, SendEmailInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { runAppleScript } from './osascript.js';

/**
 * Email through Mail.app.
 *
 * Chosen over an API connector because it needs no token, no OAuth consent
 * screen and no account configuration — it uses whatever accounts Mail is
 * already signed into. The PRD asks for "email draft/search/send through
 * approved connectors"; on a Mac the approved connector is the mail client the
 * user already trusts with their mail.
 *
 * Drafting and sending are separate tools rather than one with a flag. A flag
 * is one misheard word away from sending something meant as a draft, and the
 * risk levels genuinely differ: a draft sits there, a sent mail is gone.
 *
 * As everywhere here, values reach AppleScript through `argv` — a subject line
 * containing quotes is data, never script.
 */

const DRAFT = [
  'tell application "Mail"',
  '  set newMessage to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:true}',
  '  tell newMessage',
  '    make new to recipient at end of to recipients with properties {address:(item 1 of argv)}',
  '  end tell',
  '  activate',
  'end tell',
  'return "drafted"',
];

const SEND = [
  'tell application "Mail"',
  '  set newMessage to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:false}',
  '  tell newMessage',
  '    make new to recipient at end of to recipients with properties {address:(item 1 of argv)}',
  '  end tell',
  '  send newMessage',
  'end tell',
  'return "sent"',
];

/**
 * Subjects and senders only, never bodies.
 *
 * "Find the mail about the invoice" needs enough to identify a message; it
 * does not need the contents read aloud, and a tool that returns them invites
 * the model to summarise private mail it was not asked about.
 */
const SEARCH = [
  'tell application "Mail"',
  '  set needle to item 1 of argv',
  '  set found to {}',
  '  set searched to 0',
  '  repeat with box in {inbox}',
  '    repeat with msg in (messages of box)',
  '      set searched to searched + 1',
  '      if searched > 200 then exit repeat',
  '      set subj to subject of msg',
  '      if subj contains needle then',
  '        set end of found to (subj & " | from " & (sender of msg))',
  '      end if',
  '      if (count of found) ≥ 10 then exit repeat',
  '    end repeat',
  '  end repeat',
  '  set text item delimiters to linefeed',
  '  return found as text',
  'end tell',
];

export const draftEmailTool = defineTool({
  metadata: {
    name: 'draft_email',
    description:
      'Open a new email in Mail with the recipient, subject and body filled in, ready for the user to review and send themselves. Does NOT send it.',
    category: 'communication',
    // A draft sits in front of the user and changes nothing until they act.
    risk: 'reversible',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 20_000,
  },
  input: DraftEmailInput,
  execute: (args, ctx) =>
    runAppleScript(DRAFT, [args.to, args.subject, args.body], {
      signal: ctx.signal,
      timeoutMs: 20_000,
    }).map(() => ({ drafted: true, to: args.to, sent: false })),
  // Rendered precisely because a model might summarise this as "I emailed
  // them". Nothing was sent, and saying so is the whole point of the tool.
  speak: (result) =>
    (result as { drafted?: unknown }).drafted === true
      ? 'I have opened the email ready for you to send.'
      : null,
});

export const sendEmailTool = defineTool({
  metadata: {
    name: 'send_email',
    description:
      'Send an email immediately through Mail. Use only when the user clearly asked to send it rather than draft it.',
    category: 'communication',
    // Leaves the machine and cannot be recalled.
    risk: 'external',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    requiresNetwork: true,
    timeoutMs: 30_000,
  },
  input: SendEmailInput,
  execute: (args, ctx) =>
    runAppleScript(SEND, [args.to, args.subject, args.body], {
      signal: ctx.signal,
      timeoutMs: 30_000,
    }).map(() => ({ sent: true, to: args.to })),
  speak: (result) => {
    const r = result as { sent?: unknown; to?: unknown };
    return r.sent === true && typeof r.to === 'string' ? `Email sent to ${r.to}.` : null;
  },
});

export const searchMailTool = defineTool({
  metadata: {
    name: 'search_mail',
    description:
      'Search recent inbox messages by subject and report the subjects and senders that match. Does not read message bodies.',
    category: 'communication',
    /**
     * Gated deliberately. Reading someone's mail is not a green "read
     * permitted information" action — a misheard word should never cause an
     * inbox to be summarised aloud.
     */
    risk: 'destructive',
    connector: 'macos-applescript',
    requiredPermissions: ['automation'],
    timeoutMs: 30_000,
  },
  input: SearchMailInput,
  execute: (args, ctx) =>
    runAppleScript(SEARCH, [args.query], { signal: ctx.signal, timeoutMs: 30_000 }).map((raw) => {
      const matches = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return { query: args.query, matches, count: matches.length };
    }),
  speak: (result) => {
    const r = result as { matches?: unknown };
    // Nothing found is a complete answer; a list is better composed by the model.
    return Array.isArray(r.matches) && r.matches.length === 0
      ? 'Nothing in your inbox matches that.'
      : null;
  },
});
