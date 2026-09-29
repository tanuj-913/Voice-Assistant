import { childLogger } from '@assistant/core';
import { UserSettings } from '@assistant/schemas';
import { loadSettingsRow, saveSettingsRow, type AssistantDb } from '@assistant/db';

const log = childLogger('settings');

/**
 * The user's settings, held in memory and written through to Postgres.
 *
 * Until this existed, `UserSettings.parse({})` ran at boot and nothing ever
 * changed it: the schema described a set of preferences that no user could
 * actually express. `autoApprovedTools` was permanently empty, the wake word
 * could not be turned off, and the risk table's "preference-controlled" tier
 * was a row in a document rather than behaviour.
 *
 * Two rules shape the design:
 *
 * 1. **Validate on read as well as on write.** A row written by an older
 *    version, or edited by hand, must not stop Assistant from booting. Anything
 *    that fails the schema falls back to defaults, loudly.
 * 2. **A patch merges, it does not replace.** The UI sends the field the user
 *    touched; sending the whole object back would mean any field added since
 *    the page loaded gets silently reset to its default. The merge is one
 *    level deep — a patch containing `voice` replaces the whole voice profile,
 *    with the schema filling in whatever it left out.
 */
export class SettingsStore {
  #current: UserSettings;
  readonly #db: AssistantDb | null;

  private constructor(current: UserSettings, db: AssistantDb | null) {
    this.#current = current;
    this.#db = db;
  }

  /** Reads the stored row, falling back to defaults if there is not one yet. */
  static async load(db: AssistantDb): Promise<SettingsStore> {
    let stored: unknown;
    try {
      stored = await loadSettingsRow(db);
    } catch (error) {
      // A settings table that cannot be read is not a reason to refuse to
      // start; it is a reason to run on defaults and say so.
      log.error({ error }, 'could not read stored settings — running on defaults');
      return new SettingsStore(UserSettings.parse({}), db);
    }

    if (stored === null) return new SettingsStore(UserSettings.parse({}), db);

    const parsed = UserSettings.safeParse(stored);
    if (!parsed.success) {
      log.warn(
        { issues: parsed.error.issues },
        'stored settings did not match the schema — running on defaults',
      );
      return new SettingsStore(UserSettings.parse({}), db);
    }
    return new SettingsStore(parsed.data, db);
  }

  /** For tests and for callers with no database. */
  static inMemory(initial: Partial<UserSettings> = {}): SettingsStore {
    return new SettingsStore(UserSettings.parse(initial), null);
  }

  get current(): UserSettings {
    return this.#current;
  }

  /**
   * Applies a partial update.
   *
   * Returns the validation issues rather than throwing, so the route can hand
   * the user a message naming the field they got wrong. The write happens
   * before the in-memory value changes: a setting that appears to have been
   * saved but was not is worse than one that visibly failed.
   */
  async update(
    patch: unknown,
  ): Promise<
    | { ok: true; settings: UserSettings }
    | { ok: false; issues: { path: string; message: string }[] }
  > {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return { ok: false, issues: [{ path: '', message: 'Expected an object of settings.' }] };
    }

    const merged = UserSettings.safeParse({ ...this.#current, ...patch });
    if (!merged.success) {
      return {
        ok: false,
        issues: merged.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }

    if (this.#db) {
      try {
        await saveSettingsRow(this.#db, merged.data);
      } catch (error) {
        log.error({ error }, 'could not persist settings');
        return {
          ok: false,
          issues: [{ path: '', message: 'The settings could not be saved. Nothing was changed.' }],
        };
      }
    }

    this.#current = merged.data;
    log.info({ changed: Object.keys(patch) }, 'settings updated');
    return { ok: true, settings: merged.data };
  }
}
