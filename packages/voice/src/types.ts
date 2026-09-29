import type {
  ProviderStatus,
  SynthesisRequest,
  SynthesisResult,
  TranscriptionRequest,
  TranscriptionResult,
} from '@assistant/schemas';
import type { AppResultAsync } from '@assistant/core';

/**
 * Provider interfaces.
 *
 * Sarvam and the local models sit behind the same contract so the brain can
 * fall back to offline mid-session without knowing which one answered. Adding
 * a provider means implementing an interface, not editing a switch statement.
 */
export interface SpeechToTextProvider {
  readonly name: 'sarvam' | 'whisper-local';
  readonly requiresNetwork: boolean;
  /**
   * `signal` abandons the transcription.
   *
   * Optional, and not every provider honours it: `SarvamSttProvider` ignores
   * it, because a request already with Sarvam cannot be recalled and pretending
   * otherwise would be worse than saying so. Callers that need the guarantee —
   * speculative transcription is the only one — check `name` first.
   */
  transcribe(
    request: TranscriptionRequest,
    options?: { signal?: AbortSignal },
  ): AppResultAsync<TranscriptionResult>;
  health(): AppResultAsync<ProviderStatus>;
}

export interface TextToSpeechProvider {
  readonly name: 'sarvam' | 'macos-say';
  readonly requiresNetwork: boolean;
  synthesize(request: SynthesisRequest): AppResultAsync<SynthesisResult>;
  health(): AppResultAsync<ProviderStatus>;
}
