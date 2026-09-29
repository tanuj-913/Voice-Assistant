import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appError, fromPromise, type AppResultAsync } from '@assistant/core';

const run = promisify(execFile);

/**
 * WhatsApp's own contact list.
 *
 * The Mac's Contacts app is the obvious place to resolve a name, and on this
 * machine it holds exactly one person — the user's contacts live on a phone
 * with no Apple ID, so they have never synced. WhatsApp, meanwhile, keeps its
 * own address book locally: 447 people in `ContactsV2.sqlite`, names and
 * numbers, sitting in the group container.
 *
 * So "message Tilak" is answerable after all, just not from where we were
 * looking.
 *
 * Three rules, because this is someone's private message store:
 *
 * 1. **Read-only, and immutable.** WhatsApp is usually running, and opening
 *    its database read-write would touch the WAL of a live app. `immutable=1`
 *    means sqlite never writes, never creates a journal, and never takes a
 *    lock.
 * 2. **Only the contact table.** Not `ChatStorage.sqlite`, which is the
 *    messages themselves. Resolving a name needs names and numbers.
 * 3. **No user input in the SQL.** The query is a compile-time constant that
 *    dumps the contact table; the filtering happens in TypeScript. The same
 *    rule the AppleScript layer follows — the model never authors the code
 *    that runs.
 */

const DB_PATH = join(
  homedir(),
  'Library',
  'Group Containers',
  'group.net.whatsapp.WhatsApp.shared',
  'ContactsV2.sqlite',
);

/** Constant. The needle never goes near it. */
const DUMP = "select ZFULLNAME, ZWHATSAPPID, ZPHONENUMBER from ZWAADDRESSBOOKCONTACT where ZFULLNAME is not null;";

export interface WhatsAppContact {
  name: string;
  /** Digits only, ready for the `whatsapp://send?phone=` link. */
  phone: string;
}

export function readWhatsAppContacts(
  opts: { dbPath?: string; signal?: AbortSignal } = {},
): AppResultAsync<WhatsAppContact[]> {
  const path = opts.dbPath ?? DB_PATH;
  return fromPromise(
    run('sqlite3', ['-readonly', '-separator', '|', `file:${path}?immutable=1`, DUMP], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).then(({ stdout }) => parseWhatsAppContacts(stdout)),
    'whatsapp_contacts_unavailable',
  ).mapErr((error) =>
    // Named precisely: this fails when macOS withholds the file, and the fix
    // is a permission the user has to grant, not something to retry.
    appError(
      'whatsapp_contacts_unavailable',
      `Could not read WhatsApp's contact list (${error.message.slice(0, 120)}). If this keeps happening, give the app Full Disk Access in System Settings > Privacy & Security.`,
      { retryable: false },
    ),
  );
}

export function parseWhatsAppContacts(raw: string): WhatsAppContact[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [name, whatsappId, phoneNumber] = line.split('|');
      if (!name) return [];
      const phone = toDigits(whatsappId ?? '') ?? toDigits(phoneNumber ?? '');
      // A contact with no usable number is not a contact you can message.
      return phone === null ? [] : [{ name: name.trim(), phone }];
    });
}

/**
 * `ZWHATSAPPID` arrives as `919876543210@s.whatsapp.net`, and the number as
 * `+91 98765 43210`. Both already carry a country code — which is the whole
 * advantage of asking WhatsApp rather than the address book, where a local
 * ten-digit number cannot be trusted.
 */
function toDigits(value: string): string | null {
  const digits = value.split('@')[0]?.replace(/\D/g, '') ?? '';
  return digits.length >= 8 ? digits : null;
}

/**
 * Contacts whose name contains the words asked for, matched the way a person
 * means it: case-insensitively, on any part of the name.
 *
 * "tilak" finds "Tilak CSM"; "csm" finds it too. Two people called Tilak both
 * come back, and the caller asks which — picking one is how a message reaches
 * the wrong person.
 */
export function matchContacts(
  contacts: readonly WhatsAppContact[],
  needle: string,
): WhatsAppContact[] {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length === 0) return [];

  const exact = contacts.filter((c) => c.name.toLowerCase() === wanted);
  if (exact.length > 0) return exact;

  return contacts.filter((c) => c.name.toLowerCase().includes(wanted));
}
