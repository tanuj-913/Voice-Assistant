/**
 * Voice conversion against the trained RVC model, applied to Sarvam's output.
 *
 * This is the same seam `applyAssistantVoice` uses — a `Buffer -> Buffer`
 * transform on synthesised speech — so it swaps in without the orchestrator
 * or the TTS provider knowing anything changed. It replaces the pitch shift
 * rather than stacking on it: a formant-shifted cartoon voice is a poor input
 * to conversion, and the target voice is the point.
 *
 * Conversion runs in a separate resident process (`voice-training/rvc_server.py`)
 * because loading the generator, contentvec, rmvpe and a 168 MB faiss index
 * costs ~8 s, and Assistant speaks sentence by sentence as the model writes.
 * Warm, conversion costs roughly 0.3 s plus 0.55x the clip's duration.
 *
 * Failure never silences Assistant. If the server is down, slow, or returns
 * something that is not audio, the original clip is spoken unchanged.
 */

export interface RvcTransformOptions {
  /** Base URL of the conversion server, e.g. `http://127.0.0.1:4318`. */
  endpoint: string;
  /**
   * How much the faiss index pulls the output toward the training data.
   * Higher is more like the target speaker and more prone to its artefacts.
   */
  indexRate?: number;
  /** Semitones. 0 is correct when source and target are the same register. */
  pitch?: number;
  /** Guards consonants and breaths, where conversion artefacts show first. */
  protect?: number;
  /**
   * A clip is worth abandoning once waiting costs more than the wrong voice.
   * Sized against the measured 0.55x realtime factor plus headroom.
   */
  timeoutMs?: number;
  /** Called when conversion is skipped, so the caller can log or count it. */
  onFallback?: (reason: string) => void;
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  indexRate: 0.5,
  pitch: 0,
  protect: 0.33,
  timeoutMs: 8000,
} as const;

/** A WAV starts with `RIFF....WAVE`; anything else is not audio we can speak. */
function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WAVE'
  );
}

export function createRvcTransform(
  options: RvcTransformOptions,
): (audio: Buffer) => Promise<Buffer> {
  const {
    endpoint,
    indexRate = DEFAULTS.indexRate,
    pitch = DEFAULTS.pitch,
    protect = DEFAULTS.protect,
    timeoutMs = DEFAULTS.timeoutMs,
    onFallback,
    fetchImpl = fetch,
  } = options;

  const query = new URLSearchParams({
    index_rate: String(indexRate),
    pitch: String(pitch),
    protect: String(protect),
  });
  const url = `${endpoint.replace(/\/$/, '')}/convert?${query.toString()}`;

  return async (audio: Buffer): Promise<Buffer> => {
    const fallback = (reason: string): Buffer => {
      onFallback?.(reason);
      return audio;
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: new Uint8Array(audio),
        signal: controller.signal,
      });
      if (!response.ok) return fallback(`rvc_http_${String(response.status)}`);

      const converted = Buffer.from(await response.arrayBuffer());
      // An empty or non-WAV body would reach the audio element as noise, which
      // is worse than the untransformed voice.
      if (!isWav(converted)) return fallback('rvc_not_wav');
      return converted;
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return fallback(aborted ? 'rvc_timeout' : 'rvc_unreachable');
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RvcServerStatus {
  available: boolean;
  /** Checkpoint the server currently has loaded, when it is reachable. */
  model: string | null;
}

/**
 * Probed at boot, the same way the rubberband binaries are, so a missing
 * converter is a startup log line rather than a surprise mid-sentence.
 *
 * Retries, because the converter is started *alongside* the brain rather than
 * before it, and it spends a few seconds loading the generator, contentvec,
 * rmvpe and a 168 MB index before it answers. A single probe lost that race
 * and silently demoted the whole session to the pitch-shifted voice.
 */
export async function checkRvcServer(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<RvcServerStatus> {
  const attempts = opts.attempts ?? 1;
  const delayMs = opts.delayMs ?? 1000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = await fetchImpl(`${endpoint.replace(/\/$/, '')}/health`);
      if (!response.ok) continue;
      const body = (await response.json()) as { model?: unknown };
      return {
        available: true,
        model: typeof body.model === 'string' ? body.model : null,
      };
    } catch {
      // Not listening yet, or not listening at all. Both look the same until
      // the attempts run out.
    }
  }
  return { available: false, model: null };
}
