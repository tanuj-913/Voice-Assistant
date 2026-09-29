import { describe, expect, it } from 'vitest';
import { detectSpeechLocale } from './language.js';

describe('script detection', () => {
  it.each([
    ['hi_IN', 'अभी दोपहर के तीन बजे हैं।'],
    ['bn_IN', 'এখন বিকেল তিনটে বাজে।'],
    ['ta_IN', 'இப்போது மதியம் மூன்று மணி.'],
    ['te_IN', 'ఇప్పుడు మధ్యాహ్నం మూడు గంటలు.'],
    ['kn_IN', 'ಈಗ ಮಧ್ಯಾಹ್ನ ಮೂರು ಗಂಟೆ.'],
    ['ml_IN', 'ഇപ്പോൾ ഉച്ചയ്ക്ക് മൂന്ന് മണി.'],
    ['gu_IN', 'અત્યારે બપોરે ત્રણ વાગ્યા છે.'],
    ['pa_IN', 'ਹੁਣ ਦੁਪਹਿਰ ਦੇ ਤਿੰਨ ਵੱਜੇ ਹਨ।'],
    ['ru_RU', 'Сейчас три часа дня.'],
    ['el_GR', 'Είναι τρεις η ώρα το απόγευμα.'],
    ['he_IL', 'עכשיו שלוש אחר הצהריים.'],
    ['th_TH', 'ตอนนี้บ่ายสามโมง'],
    ['ko_KR', '지금 오후 세 시입니다.'],
  ])('detects %s from script', (locale, text) => {
    expect(detectSpeechLocale(text).locale).toBe(locale);
  });

  it('prefers Japanese when kana is present alongside Han', () => {
    // Han characters are shared with Chinese; kana is Japanese-only, so it
    // settles the ambiguity even when Han characters outnumber it.
    expect(detectSpeechLocale('今は午後三時です。').locale).toBe('ja_JP');
  });

  it('reads Han-only text as Chinese', () => {
    expect(detectSpeechLocale('现在是下午三点。').locale).toBe('zh_CN');
  });

  it('does not flip on a stray foreign glyph in English', () => {
    const result = detectSpeechLocale(
      'The Hindi word नमस्ते is a common greeting used across India',
    );
    expect(result.locale).toBe('en_IN');
  });
});

describe('statistical detection for Latin scripts', () => {
  it.each([
    ['es_ES', 'Hola, ¿cómo estás? Espero que tengas un buen día hoy por la tarde.'],
    ['fr_FR', "Bonjour, comment allez-vous aujourd'hui? J'espère que vous allez bien."],
    ['de_DE', 'Guten Tag, wie geht es Ihnen heute? Ich hoffe, es geht Ihnen gut.'],
    ['it_IT', 'Buongiorno, come stai oggi? Spero che tu stia bene questo pomeriggio.'],
    ['pt_BR', 'Bom dia, como você está hoje? Espero que esteja tudo bem com você.'],
  ])('detects %s', (locale, text) => {
    const result = detectSpeechLocale(text);
    expect(result.locale).toBe(locale);
    expect(result.method).toBe('statistical');
  });

  it('keeps English for a mostly-English sentence containing one foreign word', () => {
    // "How do you say hello in Spanish? You say hola." must stay English —
    // one Spanish word does not make a Spanish sentence.
    const result = detectSpeechLocale('To say hello in Spanish you would say hola to someone.');
    expect(result.locale).toBe('en_IN');
  });

  it('defaults to English for short Latin replies', () => {
    // Too little signal for a statistical guess; English is far safer.
    expect(detectSpeechLocale('Okay, done.').locale).toBe('en_IN');
  });

  it('does not switch voice on a short sentence franc misreads', () => {
    // Unguarded, franc scores "I opened Safari for you." as Danish at 1.00.
    expect(detectSpeechLocale('I opened Safari for you.').locale).toBe('en_IN');
  });
});

describe('fallbacks', () => {
  it('uses the hint when the text carries no letters', () => {
    expect(detectSpeechLocale('42', 'hi_IN')).toEqual({ locale: 'hi_IN', method: 'default' });
  });

  it('defaults to Indian English with no hint', () => {
    expect(detectSpeechLocale('!!!').locale).toBe('en_IN');
  });
});
