import { eq } from 'drizzle-orm';
import type { AssistantDb } from './client.js';
import { settings } from './schema.js';

/**
 * The user's settings, stored as one row.
 *
 * Deliberately untyped here. The database's job is to hold the JSON; deciding
 * what shape counts as valid belongs to the schema package, and validating on
 * read means a row written by an older version cannot crash the boot — it
 * fails one field back to its default instead.
 */
const KEY = 'user';

/** `unknown` covers the missing case too: an absent row reads back as null. */
export async function loadSettingsRow(db: AssistantDb): Promise<unknown> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY)).limit(1);
  return row?.value ?? null;
}

export async function saveSettingsRow(db: AssistantDb, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}
