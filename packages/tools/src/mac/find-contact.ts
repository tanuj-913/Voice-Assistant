import { okAsync } from '@assistant/core';
import { FindContactInput } from '@assistant/schemas';
import { defineTool } from '../registry.js';
import { distinctNames, lookupContacts } from './contacts.js';
import { matchContacts, readWhatsAppContacts, type WhatsAppContact } from './whatsapp-contacts.js';

/**
 * Answering a question about a contact, rather than acting on one.
 *
 * Names were only ever resolved *inside* `whatsapp_message`, so Assistant could
 * message Tilak but could not tell you which Tilaks it knew about — asking
 * produced nothing, because no tool existed to call. The PRD lists contact
 * search as its own capability for exactly this reason.
 *
 * Searches WhatsApp's own list first, for the same reason the message tool
 * does: on this Mac the address book holds one person and WhatsApp holds 447.
 */
export const findContactTool = defineTool({
  metadata: {
    name: 'find_contact',
    description:
      "Look up people by name in WhatsApp's contacts and the Contacts app. Use for \"who do I have called Tilak\", \"what is Rahul's number\", or before messaging someone.",
    category: 'communication',
    /**
     * Reads, changes nothing, and reaches nobody. The names are the user's
     * own, and being asked to approve a lookup before every message would
     * make the assistant tiresome without making it safer.
     */
    risk: 'read',
    connector: 'macos-cli',
    requiredPermissions: ['contacts'],
    timeoutMs: 20_000,
  },
  input: FindContactInput,
  execute: (args, ctx) =>
    readWhatsAppContacts({ signal: ctx.signal })
      .map((all) => matchContacts(all, args.query))
      // WhatsApp's database being unreadable is not a reason to fail: the
      // address book may still know them.
      .orElse(() => okAsync([] as WhatsAppContact[]))
      .andThen((fromWhatsApp) =>
        fromWhatsApp.length > 0
          ? okAsync(
              fromWhatsApp
                .slice(0, args.limit)
                .map((c) => ({ name: c.name, phone: c.phone, source: 'whatsapp' })),
            )
          : lookupContacts(args.query, { signal: ctx.signal })
              .map((matches) =>
                matches
                  .slice(0, args.limit)
                  .map((m) => ({ name: m.name, phone: m.phone, source: 'contacts' })),
              )
              .orElse(() => okAsync([])),
      )
      .map((matches) => ({
        query: args.query,
        count: matches.length,
        matches,
        people: distinctNames(matches),
      })),
  /**
   * Speaks the names, and only the names.
   *
   * A phone number read aloud is unlistenable and is the part worth not
   * broadcasting; if the user asked for a specific number the model has it in
   * the result and can say it. Beyond a handful, the list is for the model to
   * summarise rather than recite.
   */
  speak: (result) => {
    const r = result as { count?: unknown; query?: unknown; people?: unknown };
    const query = typeof r.query === 'string' ? r.query : 'that';
    if (r.count === 0) return `I couldn't find anyone called ${query}.`;

    const people = Array.isArray(r.people)
      ? r.people.filter((p): p is string => typeof p === 'string')
      : [];
    if (people.length === 0 || people.length > 4) return null;
    if (people.length === 1) return `You have one: ${people[0] ?? ''}.`;
    const last = people[people.length - 1] ?? '';
    return `You have ${String(people.length)}: ${people.slice(0, -1).join(', ')} and ${last}.`;
  },
});
