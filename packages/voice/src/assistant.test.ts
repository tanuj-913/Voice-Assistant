import { describe, expect, it } from 'vitest';
import { checkAssistantVoiceTooling } from './assistant.js';

/**
 * Guards a silent-degradation bug: the original probe ran `rubberband --help`,
 * which exits 2. That read as "not installed", so the Assistant voice quietly
 * turned itself off and shipped the plain TTS voice instead.
 */
describe('checkAssistantVoiceTooling', () => {
  it('detects the installed binaries', async () => {
    const tooling = await checkAssistantVoiceTooling();
    expect(tooling.ffmpeg).toBe(true);
    expect(tooling.rubberband).toBe(true);
  });
});
