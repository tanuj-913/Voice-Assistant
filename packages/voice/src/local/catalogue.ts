import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpeechLocale } from '../language.js';

const run = promisify(execFile);

/**
 * The macOS voices actually present on this machine.
 *
 * Built by asking the system rather than hardcoding a list, for two reasons:
 * which voices ship varies by macOS version and region, and the user can add
 * more at any time through System Settings. A hardcoded table would silently
 * go stale in both directions — claiming voices that are missing, and ignoring
 * ones that were installed later.
 */

export interface InstalledVoice {
  readonly name: string;
  readonly locale: SpeechLocale;
}

/**
 * Voices to prefer when a locale offers several. Chosen for being clear and
 * neutral; the Assistant transform sits on top of whatever this picks.
 */
const PREFERRED = new Set([
  'Tara',
  'Rishi',
  'Lekha',
  'Piya',
  'Vani',
  'Geeta',
  'Soumya',
  'Monica',
  'Mónica',
  'Paulina',
  'Thomas',
  'Amélie',
  'Anna',
  'Alice',
  'Luciana',
  'Joana',
  'Kyoko',
  'Ting-Ting',
  'Sin-ji',
  'Yuna',
  'Milena',
  'Xander',
  'Alva',
  'Sara',
  'Nora',
  'Satu',
  'Zosia',
  'Zuzana',
  'Laura',
  'Ioana',
  'Yelda',
  'Damayanti',
  'Amira',
  'Linh',
  'Montse',
  'Lana',
  'Tina',
  'Melina',
  'Carmit',
]);

export class VoiceCatalogue {
  readonly #byLocale = new Map<SpeechLocale, InstalledVoice[]>();
  readonly #byLanguage = new Map<string, InstalledVoice[]>();

  static async load(): Promise<VoiceCatalogue> {
    const catalogue = new VoiceCatalogue();
    const { stdout } = await run('say', ['-v', '?'], { timeout: 10_000 });

    for (const line of stdout.split('\n')) {
      // "Tara                en_IN    # Hello! My name is Tara."
      const match = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Z0-9]{2,3})\s/.exec(line);
      if (!match) continue;

      const name = match[1]?.trim();
      const locale = match[2]?.replace('-', '_');
      if (!name || !locale) continue;

      catalogue.#add({ name, locale });
    }
    return catalogue;
  }

  #add(voice: InstalledVoice): void {
    const forLocale = this.#byLocale.get(voice.locale) ?? [];
    forLocale.push(voice);
    this.#byLocale.set(voice.locale, forLocale);

    const language = voice.locale.split('_')[0] ?? voice.locale;
    const forLanguage = this.#byLanguage.get(language) ?? [];
    forLanguage.push(voice);
    this.#byLanguage.set(language, forLanguage);
  }

  /**
   * Finds a voice for a locale, widening the search rather than giving up:
   * exact locale, then any region of the same language (Mexican Spanish will
   * read Castilian text far better than an English voice would).
   */
  resolve(locale: SpeechLocale): InstalledVoice | null {
    const exact = pick(this.#byLocale.get(locale));
    if (exact) return exact;

    const language = locale.split('_')[0] ?? locale;
    return pick(this.#byLanguage.get(language));
  }

  /** True when this machine can speak the language at all. */
  supports(locale: SpeechLocale): boolean {
    return this.resolve(locale) !== null;
  }

  get locales(): SpeechLocale[] {
    return [...this.#byLocale.keys()].sort();
  }

  get size(): number {
    return [...this.#byLocale.values()].reduce((n, v) => n + v.length, 0);
  }
}

function pick(voices: InstalledVoice[] | undefined): InstalledVoice | null {
  if (!voices || voices.length === 0) return null;
  return voices.find((v) => PREFERRED.has(v.name)) ?? voices[0] ?? null;
}
