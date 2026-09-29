import { describe, expect, it } from 'vitest';
import { parseEnv, UserSettings } from './index.js';

describe('environment parsing', () => {
  it('applies defaults when only required values are present', () => {
    const env = parseEnv({});
    expect(env.BRAIN_PORT).toBe(4317);
    expect(env.OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(env.DATABASE_URL).toContain('postgres://');
  });

  it('treats an empty secret as unset rather than invalid', () => {
    // `SARVAM_API_KEY=` in a .env file arrives as '', not as absent.
    const env = parseEnv({ SARVAM_API_KEY: '', SERPER_API_KEY: '   ' });
    expect(env.SARVAM_API_KEY).toBeUndefined();
    expect(env.SERPER_API_KEY).toBeUndefined();
  });

  it('keeps a real secret', () => {
    const env = parseEnv({ SARVAM_API_KEY: 'sk_test_abcdefghijk' });
    expect(env.SARVAM_API_KEY).toBe('sk_test_abcdefghijk');
  });

  it('coerces a port from its string form', () => {
    expect(parseEnv({ BRAIN_PORT: '5000' }).BRAIN_PORT).toBe(5000);
  });

  it('reports every problem at once, not just the first', () => {
    expect(() => parseEnv({ BRAIN_PORT: '99999', OLLAMA_BASE_URL: 'nonsense' })).toThrow(
      /BRAIN_PORT[\s\S]*OLLAMA_BASE_URL|OLLAMA_BASE_URL[\s\S]*BRAIN_PORT/,
    );
  });
});

describe('user settings', () => {
  it('fills in a full default voice profile from an empty object', () => {
    const settings = UserSettings.parse({});
    expect(settings.voice.enabled).toBe(true);
    expect(settings.voice.pitchShiftSemitones).toBeGreaterThan(0);
    // Formants must scale with pitch for the cartoon timbre.
    expect(settings.voice.preserveFormants).toBe(false);
    expect(settings.hotkey).toBe('Cmd+Shift+Space');
  });

  it('rejects a pitch shift outside the sane range', () => {
    expect(UserSettings.safeParse({ voice: { pitchShiftSemitones: 40 } }).success).toBe(false);
  });
});
