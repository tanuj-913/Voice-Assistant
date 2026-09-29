import { runAppleScript } from './osascript.js';

/**
 * Looking someone up by name, which is how people refer to each other.
 *
 * `call_contact` has always done this; `whatsapp_message` did not, so asking
 * Assistant to message someone produced "what is their number?" — a question the
 * Mac can answer for itself. The PRD asks for contact search and identity
 * resolution, and for an unresolved contact to produce a question rather than
 * a guess. Both live here so the two tools cannot drift apart.
 */

export interface ContactPhone {
  name: string;
  /** As stored in Contacts, e.g. "+91 98765 43210". */
  phone: string;
}

/**
 * Every phone of every matching person, rather than the first of the first.
 *
 * The first match is only safe when there is exactly one; with two Rahuls,
 * silently taking one is how a message reaches the wrong person.
 */
const LOOKUP_ALL = [
  'tell application "Contacts"',
  '  set out to ""',
  '  repeat with p in (every person whose name contains (item 1 of argv))',
  '    repeat with ph in phones of p',
  '      set out to out & (name of p) & "|" & (value of ph) & linefeed',
  '    end repeat',
  '  end repeat',
  '  return out',
  'end tell',
];

export function lookupContacts(name: string, opts: { signal?: AbortSignal } = {}) {
  return runAppleScript(LOOKUP_ALL, [name], {
    timeoutMs: 20_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).map(parseContacts);
}

export function parseContacts(raw: string): ContactPhone[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [name, phone] = line.split('|');
      if (!name || !phone) return [];
      return [{ name: name.trim(), phone: phone.trim() }];
    });
}

/**
 * A number WhatsApp will accept, or null when it cannot be trusted.
 *
 * `whatsapp://send?phone=` needs digits including the country code. Contacts
 * often stores a local number, and prefixing a guessed country code is how a
 * message reaches a stranger — so an ambiguous number returns null and the
 * caller asks. Guessing is the one thing not on offer.
 */
export function toWhatsAppNumber(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;

  // Written internationally: what follows is complete by definition.
  if (trimmed.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);

  /**
   * No plus, but long enough that a country code is already in there. Ten
   * digits or fewer is a local number in most of the world, and that is
   * exactly the case worth refusing.
   */
  return digits.length >= 11 ? digits : null;
}

/** Distinct people among the matches, in the order Contacts returned them. */
export function distinctNames(contacts: readonly ContactPhone[]): string[] {
  return [...new Set(contacts.map((c) => c.name))];
}
