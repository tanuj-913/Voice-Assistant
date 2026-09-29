import { describe, expect, it } from 'vitest';
import { AssistantVoiceProfile } from '@assistant/schemas';
import { SayTtsProvider } from './say.js';

/**
 * Integration tests against the real `say` and `rubberband` binaries. The
 * point of this provider is that Assistant has a voice with no API key, so
 * mocking the binaries would test nothing that matters.
 */
describe('SayTtsProvider', () => {
  const profile = AssistantVoiceProfile.parse({});

  it('reports itself available and offline-capable', async () => {
    const provider = new SayTtsProvider();
    expect(provider.requiresNetwork).toBe(false);

    const health = await provider.health();
    expect(health.isOk()).toBe(true);
    health.map((status) => {
      expect(status.available).toBe(true);
    });
  });

  it('produces a valid WAV', async () => {
    const provider = new SayTtsProvider({ assistant: profile });
    const result = await provider.synthesize({
      text: 'Testing one two three.',
      language: 'en-IN',
    });

    expect(result.isOk()).toBe(true);
    result.map((synthesis) => {
      expect(synthesis.provider).toBe('macos-say');

      const wav = Buffer.from(synthesis.audio.data, 'base64');
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.subarray(8, 12).toString()).toBe('WAVE');
      expect(wav.length).toBeGreaterThan(1000);
    });
  }, 40_000);

  it('applies the Assistant transform, changing the audio', async () => {
    const plain = new SayTtsProvider({ assistant: { ...profile, enabled: false } });
    const assistant = new SayTtsProvider({ assistant: profile });
    const text = 'The quick brown fox jumps over the lazy dog.';

    const [a, b] = await Promise.all([
      plain.synthesize({ text, language: 'en-IN' }),
      assistant.synthesize({ text, language: 'en-IN' }),
    ]);

    expect(a.isOk() && b.isOk()).toBe(true);
    if (a.isErr() || b.isErr()) return;

    // Pitch-shifted and slightly sped up, so the payloads must differ.
    expect(b.value.audio.data).not.toBe(a.value.audio.data);
  }, 60_000);

  it('falls back to an English voice for a language with none installed', async () => {
    // Odia has no macOS voice; this must still produce audio rather than throw.
    const provider = new SayTtsProvider({ assistant: { ...profile, enabled: false } });
    const result = await provider.synthesize({ text: 'Namaskar.', language: 'od-IN' });

    expect(result.isOk()).toBe(true);
  }, 40_000);
});
