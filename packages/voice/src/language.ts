import { francAll } from 'franc';

/**
 * Language identification for choosing a speaking voice.
 *
 * Deliberately separate from `LanguageCode` in @assistant/schemas. That type is
 * the set Sarvam can *transcribe* — eleven Indian languages. This is the set
 * Assistant can *speak*, which is whatever the operating system has voices for.
 * Conflating them would mean Assistant could not say "hola" in Spanish just
 * because Sarvam cannot hear Spanish.
 *
 * Detection runs in two stages because the two cases need different evidence:
 *
 *   1. Script. Devanagari, Telugu, Kana, Hangul, Cyrillic and the rest each
 *      occupy their own Unicode block, so a single glance settles it.
 *   2. Statistical. Latin script is shared by English, Spanish, French, German
 *      and dozens more, so those need an actual language model — `franc`,
 *      which works offline on trigram frequencies.
 */

/** BCP-47-ish locale, matching what macOS voices advertise. */
export type SpeechLocale = string;

interface ScriptRange {
  readonly locale: SpeechLocale;
  readonly start: number;
  readonly end: number;
}

/**
 * Scripts that identify a language on sight.
 *
 * Ordered most-specific first; CJK is handled separately because Han
 * characters are shared between Chinese and Japanese.
 */
const SCRIPTS: readonly ScriptRange[] = [
  { locale: 'hi_IN', start: 0x0900, end: 0x097f }, // Devanagari (Hindi/Marathi)
  { locale: 'bn_IN', start: 0x0980, end: 0x09ff },
  { locale: 'pa_IN', start: 0x0a00, end: 0x0a7f }, // Gurmukhi
  { locale: 'gu_IN', start: 0x0a80, end: 0x0aff },
  { locale: 'or_IN', start: 0x0b00, end: 0x0b7f }, // Odia
  { locale: 'ta_IN', start: 0x0b80, end: 0x0bff },
  { locale: 'te_IN', start: 0x0c00, end: 0x0c7f },
  { locale: 'kn_IN', start: 0x0c80, end: 0x0cff },
  { locale: 'ml_IN', start: 0x0d00, end: 0x0d7f },
  { locale: 'th_TH', start: 0x0e00, end: 0x0e7f },
  { locale: 'he_IL', start: 0x0590, end: 0x05ff },
  { locale: 'ar_001', start: 0x0600, end: 0x06ff },
  { locale: 'el_GR', start: 0x0370, end: 0x03ff },
  { locale: 'ru_RU', start: 0x0400, end: 0x04ff }, // Cyrillic
  { locale: 'ko_KR', start: 0xac00, end: 0xd7af }, // Hangul syllables
  { locale: 'ja_JP', start: 0x3040, end: 0x309f }, // Hiragana — Japanese only
  { locale: 'ja_JP', start: 0x30a0, end: 0x30ff }, // Katakana — Japanese only
  { locale: 'zh_CN', start: 0x4e00, end: 0x9fff }, // Han — see note below
];

/** ISO 639-3 (what franc returns) to the locale a voice is listed under. */
const ISO3_TO_LOCALE: Readonly<Record<string, SpeechLocale>> = {
  eng: 'en_IN', // Indian English is Assistant's default accent
  spa: 'es_ES',
  fra: 'fr_FR',
  deu: 'de_DE',
  ita: 'it_IT',
  por: 'pt_BR',
  nld: 'nl_NL',
  swe: 'sv_SE',
  dan: 'da_DK',
  nob: 'nb_NO',
  fin: 'fi_FI',
  pol: 'pl_PL',
  ces: 'cs_CZ',
  slk: 'sk_SK',
  hun: 'hu_HU',
  ron: 'ro_RO',
  tur: 'tr_TR',
  ind: 'id_ID',
  msa: 'ms_MY',
  zsm: 'ms_MY',
  vie: 'vi_VN',
  cat: 'ca_ES',
  hrv: 'hr_HR',
  slv: 'sl_SI',
  lit: 'lt_LT',
};

export interface DetectionResult {
  readonly locale: SpeechLocale;
  /** How the decision was reached, for logging and tests. */
  readonly method: 'script' | 'statistical' | 'default';
}

/**
 * Identifies the language of text that is about to be spoken.
 *
 * `hint` is the language the user was heard speaking; it only breaks ties on
 * text with no linguistic content (a bare number, punctuation).
 */
export function detectSpeechLocale(text: string, hint?: SpeechLocale): DetectionResult {
  const byScript = detectByScript(text);
  if (byScript) return { locale: byScript, method: 'script' };

  if (!/\p{L}/u.test(text)) {
    return { locale: hint ?? 'en_IN', method: 'default' };
  }

  const statistical = detectLatinLanguage(text);
  if (statistical) return { locale: statistical, method: 'statistical' };

  return { locale: 'en_IN', method: 'default' };
}

/** Languages franc is allowed to consider, as ISO 639-3. */
const CANDIDATES = Object.keys(ISO3_TO_LOCALE);

/**
 * Below this many characters, franc is guessing. "I opened Safari for you."
 * scored Danish at full confidence.
 */
const MIN_SAMPLE_CHARS = 40;

/**
 * How far ahead of English the winner must score before Assistant switches voice.
 *
 * Measured on this candidate set: genuine Spanish/French/German/Italian/
 * Portuguese sentences lead English by 0.199-0.501, while an English sentence
 * containing the word "hola" leads by only 0.093. The gap is wide enough to
 * separate them, and erring toward English is the cheaper mistake — an English
 * voice reading one foreign word is fine, an Italian voice reading a whole
 * English sentence is not.
 */
const MIN_MARGIN_OVER_ENGLISH = 0.15;

function detectLatinLanguage(text: string): SpeechLocale | null {
  if (text.trim().length < MIN_SAMPLE_CHARS) return null;

  // Restricting the candidate set is what makes this usable at all. Unbounded,
  // franc ranks 400+ languages and Galician outscores Spanish, Scots outscores
  // English, and plain English comes back as Italian.
  const ranked = francAll(text, { minLength: 10, only: CANDIDATES });
  const top = ranked[0];
  if (!top) return null;

  const [iso3, score] = top;
  if (iso3 === 'eng') return null;

  const english = ranked.find(([code]) => code === 'eng')?.[1] ?? 0;
  if (score - english < MIN_MARGIN_OVER_ENGLISH) return null;

  return ISO3_TO_LOCALE[iso3] ?? null;
}

function detectByScript(text: string): SpeechLocale | null {
  const counts = new Map<SpeechLocale, number>();
  let letters = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;

    const script = SCRIPTS.find((s) => code >= s.start && code <= s.end);
    if (script) {
      counts.set(script.locale, (counts.get(script.locale) ?? 0) + 1);
      letters += 1;
    } else if (/\p{L}/u.test(char)) {
      letters += 1;
    }
  }

  if (letters === 0 || counts.size === 0) return null;

  // Han characters also appear in Japanese. If any kana is present the text is
  // Japanese, so kana wins over a larger count of shared Han characters.
  if (counts.has('ja_JP')) return 'ja_JP';

  let best: SpeechLocale | null = null;
  let bestCount = 0;
  for (const [locale, count] of counts) {
    if (count > bestCount) {
      best = locale;
      bestCount = count;
    }
  }

  // A stray foreign glyph inside an English sentence must not flip the voice.
  return best !== null && bestCount / letters >= 0.2 ? best : null;
}
