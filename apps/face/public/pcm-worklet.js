/**
 * Captures raw mono PCM off the audio thread.
 *
 * An AudioWorklet rather than ScriptProcessorNode: capture runs on the audio
 * thread, so a busy main thread (the orb is rendering at 60fps) cannot cause
 * dropped frames in the recording.
 */
class PcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Copy: the input buffer is reused by the audio thread after this returns.
    const samples = new Float32Array(channel.length);
    samples.set(channel);

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / samples.length);

    /**
     * `brightness` is the RMS of the first difference divided by the RMS of
     * the signal — a one-multiply-per-sample stand-in for spectral centroid,
     * which is all that fits in a 128-sample frame with no FFT.
     *
     * For a tone at frequency f it evaluates to 2·sin(pi·f/rate), so it maps
     * monotonically onto "where the energy sits": room rumble and mains hum
     * land near zero, voiced speech in the middle, hiss and clicks near the
     * top. That is enough to tell a fan from a person, which amplitude alone
     * cannot do — the reason a quiet room used to need a high fixed gate.
     */
    let diffSquares = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const d = samples[i] - samples[i - 1];
      diffSquares += d * d;
    }
    const diffRms = Math.sqrt(diffSquares / Math.max(1, samples.length - 1));
    const brightness = rms > 1e-7 ? diffRms / rms : 0;

    this.port.postMessage({ samples, rms, brightness }, [samples.buffer]);
    return true;
  }
}

registerProcessor('pcm-collector', PcmCollector);
