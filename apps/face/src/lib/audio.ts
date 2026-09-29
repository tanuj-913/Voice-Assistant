/**
 * Microphone capture with energy-based voice activity detection.
 *
 * Produces two things: a continuous level signal that drives the orb, and
 * discrete utterances — the audio between someone starting and stopping
 * speaking — which is what the speech-to-text layer actually wants.
 */

import {
  ABSOLUTE_FLOOR,
  isSpeechFrame,
  isVoiceLike,
  START_FRAMES,
  sustainsUtterance,
  speechGates,
  trackNoiseFloor,
  shouldSpeculate,
  utteranceOutcome,
} from './vad.js';

const TARGET_SAMPLE_RATE = 16_000;

/**
 * How much audio to keep from before an utterance is declared.
 *
 * Covers the START_FRAMES debounce several times over, so the recording
 * always contains the attack of the first word rather than starting part way
 * through it.
 */
const PRE_ROLL_MS = 250;

/**
 * Energy in four frequency bands, each 0-1.
 *
 * A single amplitude number makes an orb throb; it cannot make it *feel* like
 * it is listening to a voice. Speech carries its identity in the spectrum —
 * vowels sit low, consonants and sibilance sit high — so driving separate
 * visual properties from separate bands is what produces the reactive quality
 * of Siri's waveform rather than a metronome.
 */
export interface Spectrum {
  /** 0-250Hz. Vowel fundamentals and room rumble; drives overall swell. */
  bass: number;
  /** 250-750Hz. Body of the voice; drives surface deformation. */
  lowMid: number;
  /** 750Hz-2kHz. Articulation; drives finer detail. */
  mid: number;
  /** 2k-6kHz. Consonants and sibilance; drives rim brightness and sparkle. */
  high: number;
  /** Overall loudness, for anything that just needs one number. */
  level: number;
}

export const SILENT_SPECTRUM: Spectrum = {
  bass: 0,
  lowMid: 0,
  mid: 0,
  high: 0,
  level: 0,
};

export interface MicCaptureOptions {
  /** RMS above which a frame counts as speech. */
  speechThreshold?: number;
  /** Silence after speech before the utterance is considered finished. */
  silenceHoldMs?: number;
  /**
   * Ignore blips shorter than this.
   *
   * Raised well above a "is there sound" threshold because short clips are
   * exactly what makes Whisper hallucinate: fed half a second of a cough it
   * confidently returns "Thank you." or "Gracias." Requiring real duration is
   * the cheapest defence, applied before any audio is sent anywhere.
   */
  minUtteranceMs?: number;
  /** Hard cap so a stuck-open mic cannot record forever. */
  maxUtteranceMs?: number;
  onLevel?: (level: number) => void;
  /** Fires every animation frame while capturing. */
  onSpectrum?: (spectrum: Spectrum) => void;
  /**
   * Fires periodically while the user is still speaking, with everything
   * captured so far. Used for live transcription: the caller transcribes it
   * with a fast model to show words appearing, and throws the result away
   * when the real utterance lands.
   */
  onPartial?: (wav: Blob, durationMs: number) => void;
  /** How often to emit a partial while speech continues. */
  partialIntervalMs?: number;
  onSpeechStart?: () => void;
  onUtterance?: (wav: Blob, durationMs: number, context: UtteranceContext) => void;
  /**
   * Fires part-way through the silence hold, with everything captured so far,
   * on the guess that the user has finished.
   *
   * The hold exists to be sure they have stopped, and nothing happens during
   * it — so a fast-path command pays 850 ms of waiting and then the whole
   * transcription. Handing the clip over early overlaps the two.
   *
   * The guess is often wrong: people pause between words. That is why
   * `onSpeculationVoid` exists and why it must actually cancel the work —
   * see `SerialQueue` for what happens when it does not.
   */
  onSpeculative?: (wav: Blob, durationMs: number) => void;
  /** The user carried on talking: whatever `onSpeculative` started is worthless. */
  onSpeculationVoid?: () => void;
  /** Silence before a speculative transcription is fired. */
  speculateAfterMs?: number;
  /** Voiced audio required before speculating at all. */
  speculateMinVoicedMs?: number;
}

export interface UtteranceContext {
  /**
   * True when a speculative transcription was fired and never invalidated, so
   * the caller may use its result instead of transcribing again.
   *
   * False the moment any speech arrives after the guess: the recording the
   * speculation was given is then a prefix of a longer utterance, and using it
   * would drop whatever the user said next.
   */
  speculationLive: boolean;
}

/**
 * How many times one utterance may guess that it is over.
 *
 * A speaker who pauses at every comma would otherwise start and cancel a
 * whisper run at every comma. Each one is cheap — an abandoned task never
 * reaches the queue — but not free, and it is the last guess that pays off.
 */
const MAX_SPECULATIONS_PER_UTTERANCE = 3;

export class MicCapture {
  readonly #opts: Required<
    Omit<
      MicCaptureOptions,
      | 'onLevel'
      | 'onSpeechStart'
      | 'onUtterance'
      | 'onSpectrum'
      | 'onPartial'
      | 'onSpeculative'
      | 'onSpeculationVoid'
    >
  > &
    Pick<
      MicCaptureOptions,
      | 'onLevel'
      | 'onSpeechStart'
      | 'onUtterance'
      | 'onSpectrum'
      | 'onPartial'
      | 'onSpeculative'
      | 'onSpeculationVoid'
    >;

  #context: AudioContext | null = null;
  #stream: MediaStream | null = null;
  #node: AudioWorkletNode | null = null;
  #analyser: AnalyserNode | null = null;
  #bins: Uint8Array<ArrayBuffer> | null = null;
  #rafId: number | null = null;
  /** Smoothed per-band values, so the visuals glide instead of strobing. */
  #smoothed: Spectrum = { ...SILENT_SPECTRUM };
  /** Milliseconds of speech captured since the last partial was emitted. */
  #sincePartialMs = 0;

  #buffer: Float32Array[] = [];
  /**
   * Frames kept from *before* speech was declared.
   *
   * The buffer used to be cleared the instant an utterance opened, so the
   * recording began on the frame that crossed the threshold — by which point
   * the onset of the word was already past. Whisper was being handed speech
   * with its first consonant shaved off, which is exactly the error that
   * turns a name into a different name. Now that starting also costs a
   * `START_FRAMES` debounce, the loss would have been worse still.
   */
  #preRoll: Float32Array[] = [];
  /** Consecutive speech-like frames seen while not yet speaking. */
  #candidateFrames = 0;
  #speaking = false;
  #silenceMs = 0;
  #speechMs = 0;
  /**
   * Milliseconds of *voiced* audio in the current utterance.
   *
   * Kept separately from `#speechMs`, which counts every buffered frame
   * including the trailing silence that ends the utterance. Gating on
   * `#speechMs` meant a 100ms door slam accumulated the full silence hold
   * before being measured, sailed past the minimum, and was sent to the
   * speech recogniser as if someone had spoken.
   */
  #voicedMs = 0;
  /** Consecutive ms of loud-but-unvoiced audio inside an open utterance. */
  #unvoicedRunMs = 0;
  /**
   * Rolling estimate of the room's ambient level.
   *
   * A fixed threshold cannot work in both a quiet room and a noisy one: set
   * low it accepts the air conditioning, set high it ignores a soft voice.
   * This tracks the floor while nobody is speaking and the speech thresholds
   * are derived from it.
   */
  #noiseFloor = 0.006;
  /** Smoothed level, so the orb breathes rather than jitters. */
  #smoothedLevel = 0;
  /**
   * A speculative transcription has been fired for this utterance and no
   * speech has arrived since.
   *
   * Cleared the instant the user carries on, which is what makes it safe to
   * hand the early transcript to the turn: if this is still true when the
   * utterance ends, nothing was said after the clip the speculation was given.
   */
  #speculationLive = false;
  /**
   * Speculations fired for the current utterance.
   *
   * Bounded because a speaker who pauses at every comma would otherwise start
   * and cancel a whisper run at every comma too — cheap each time, but not
   * free, and the later guesses are the ones worth having.
   */
  #speculationCount = 0;

  constructor(options: MicCaptureOptions = {}) {
    this.#opts = {
      // Absolute floor beneath which nothing counts as speech, however quiet
      // the room gets. The adaptive thresholds are clamped to at least this.
      // Deliberately low: see ABSOLUTE_FLOOR in vad.ts for why a higher value
      // silently encoded one machine's input gain and lost a whole session.
      speechThreshold: options.speechThreshold ?? ABSOLUTE_FLOOR,
      // Long enough to pause for breath, short enough that it is not the
      // dominant cost of every turn. Two seconds here put two seconds on the
      // front of every reply before transcription had even started.
      silenceHoldMs: options.silenceHoldMs ?? 850,
      // Measured in voiced audio, so short commands like "stop" survive.
      minUtteranceMs: options.minUtteranceMs ?? 320,
      // Thirty seconds was a guard against a stuck-open microphone, not a
      // statement about speech, and it let a stuck microphone record for half
      // a minute before anyone noticed. Nobody issues a thirty-second command;
      // clipping a long one costs a repeat, while the old cap cost a whole
      // turn plus the seconds whisper spent transcribing the room.
      maxUtteranceMs: options.maxUtteranceMs ?? 8_000,
      ...(options.onLevel ? { onLevel: options.onLevel } : {}),
      ...(options.onSpeechStart ? { onSpeechStart: options.onSpeechStart } : {}),
      ...(options.onUtterance ? { onUtterance: options.onUtterance } : {}),
      ...(options.onSpectrum ? { onSpectrum: options.onSpectrum } : {}),
      ...(options.onPartial ? { onPartial: options.onPartial } : {}),
      ...(options.onSpeculative ? { onSpeculative: options.onSpeculative } : {}),
      ...(options.onSpeculationVoid ? { onSpeculationVoid: options.onSpeculationVoid } : {}),
      partialIntervalMs: options.partialIntervalMs ?? 1100,
      // A quarter of the hold. Short enough to buy most of the 850 ms back,
      // long enough that an ordinary between-word pause usually clears it
      // before we guess — and a wrong guess is cancelled, not paid for.
      speculateAfterMs: options.speculateAfterMs ?? 250,
      // Never speculate on something that would be discarded as too short
      // anyway: that would be a whisper run spent on a door slam.
      speculateMinVoicedMs: options.speculateMinVoicedMs ?? options.minUtteranceMs ?? 320,
    };
  }

  get active(): boolean {
    return this.#context !== null;
  }

  async start(): Promise<void> {
    if (this.#context) return;

    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Ask for 16kHz directly; browsers that refuse are resampled on encode.
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.#context = context;

    await context.audioWorklet.addModule('/pcm-worklet.js');

    const source = context.createMediaStreamSource(this.#stream);
    const node = new AudioWorkletNode(context, 'pcm-collector');
    this.#node = node;

    // A separate analyser for the visuals. The worklet handles capture on the
    // audio thread; the FFT is read on the animation frame, which is the only
    // rate the display can actually use.
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    this.#analyser = analyser;
    this.#bins = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.#startSpectrumLoop(context.sampleRate);

    node.port.onmessage = (
      event: MessageEvent<{ samples: Float32Array; rms: number; brightness: number }>,
    ) => {
      this.#onFrame(event.data.samples, event.data.rms, event.data.brightness, context.sampleRate);
    };

    source.connect(node);
    // Not connected to the destination: we are listening, not monitoring.
  }

  stop(): void {
    if (this.#rafId !== null) cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
    this.#analyser?.disconnect();
    this.#analyser = null;
    this.#bins = null;
    this.#smoothed = { ...SILENT_SPECTRUM };
    this.#opts.onSpectrum?.(SILENT_SPECTRUM);

    this.#node?.port.close();
    this.#node?.disconnect();
    this.#stream?.getTracks().forEach((track) => {
      track.stop();
    });
    void this.#context?.close();

    this.#node = null;
    this.#stream = null;
    this.#context = null;
    this.#buffer = [];
    this.#speaking = false;
    this.#silenceMs = 0;
    this.#speechMs = 0;
    this.#opts.onLevel?.(0);
  }

  /**
   * Samples the spectrum once per animation frame.
   *
   * Driven by rAF rather than by audio callbacks: the audio thread fires far
   * more often than the screen refreshes, and pushing 300 updates a second into
   * React would burn the main thread for frames nobody sees.
   */
  #startSpectrumLoop(sampleRate: number): void {
    const tick = () => {
      this.#rafId = requestAnimationFrame(tick);

      const analyser = this.#analyser;
      const bins = this.#bins;
      if (!analyser || !bins) return;

      analyser.getByteFrequencyData(bins);

      const hzPerBin = sampleRate / 2 / bins.length;
      const band = (fromHz: number, toHz: number) => {
        const start = Math.floor(fromHz / hzPerBin);
        const end = Math.min(bins.length, Math.ceil(toHz / hzPerBin));
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += bins[i] ?? 0;
        const count = Math.max(1, end - start);
        return sum / count / 255;
      };

      const raw: Spectrum = {
        bass: band(20, 250),
        lowMid: band(250, 750),
        mid: band(750, 2000),
        high: band(2000, 6000),
        level: 0,
      };
      raw.level = Math.min(1, (raw.bass + raw.lowMid + raw.mid + raw.high) / 3);

      // Rise quickly so speech registers instantly, fall slowly so the orb
      // settles rather than flickering between syllables.
      const ease = (current: number, target: number) =>
        target > current ? current + (target - current) * 0.5 : current + (target - current) * 0.12;

      this.#smoothed = {
        bass: ease(this.#smoothed.bass, raw.bass),
        lowMid: ease(this.#smoothed.lowMid, raw.lowMid),
        mid: ease(this.#smoothed.mid, raw.mid),
        high: ease(this.#smoothed.high, raw.high),
        level: ease(this.#smoothed.level, raw.level),
      };

      this.#opts.onSpectrum?.(this.#smoothed);
    };

    this.#rafId = requestAnimationFrame(tick);
  }

  /** Keeps the last PRE_ROLL_MS of audio so an utterance can open behind itself. */
  #rememberPreRoll(samples: Float32Array, sampleRate: number): void {
    this.#preRoll.push(samples);
    const cap = (PRE_ROLL_MS / 1000) * sampleRate;
    let held = 0;
    for (const frame of this.#preRoll) held += frame.length;
    while (this.#preRoll.length > 1 && held > cap) {
      held -= this.#preRoll[0]?.length ?? 0;
      this.#preRoll.shift();
    }
  }

  #onFrame(samples: Float32Array, rms: number, brightness: number, sampleRate: number): void {
    const frameMs = (samples.length / sampleRate) * 1000;

    // Asymmetric smoothing: rise fast so the orb reacts instantly to speech,
    // fall slow so it does not strobe between syllables.
    const normalised = Math.min(1, rms * 12);
    this.#smoothedLevel =
      normalised > this.#smoothedLevel
        ? this.#smoothedLevel + (normalised - this.#smoothedLevel) * 0.55
        : this.#smoothedLevel + (normalised - this.#smoothedLevel) * 0.12;
    this.#opts.onLevel?.(this.#smoothedLevel);

    // Track the room continuously, much more slowly while someone is talking.
    // Freezing it during speech stopped a speaker raising their own bar, but
    // it also stopped the bar answering the room: an utterance opened in a
    // quiet moment kept a `continueAt` from that quiet, and stayed open on
    // ambient noise until the hard cap. See FLOOR_RISE_SPEAKING.
    this.#noiseFloor = trackNoiseFloor(this.#noiseFloor, rms, this.#speaking);

    // Hysteresis: it takes more to start an utterance than to continue one, so
    // a normal pause between words does not chop a sentence into fragments.
    const loudEnough = isSpeechFrame(
      rms,
      this.#speaking,
      speechGates(this.#opts.speechThreshold, this.#noiseFloor),
    );

    /**
     * Amplitude alone cannot tell a person from a fan, which is why the gate
     * used to have to be loud enough to exclude the room — and with it, a
     * quiet speaker. Starting an utterance now asks two further questions:
     * does the energy sit where a voice sits, and does it *last*? Continuing
     * asks neither, so a pause between words still costs nothing and a
     * trailing sibilant is never clipped.
     */
    const voiceLike = isVoiceLike(brightness);

    /**
     * Continuing now asks the voicing question too, but of a *run* rather
     * than of each frame.
     *
     * Asking it per frame would clip every plosive; not asking it at all —
     * which is what happened before — let anything loud hold the microphone
     * open, because loudness is the only property a fan and a sentence share.
     * A run that passes MAX_UNVOICED_RUN_MS stops counting as speech, and the
     * ordinary silence hold closes the utterance from there.
     */
    if (this.#speaking && loudEnough) {
      this.#unvoicedRunMs = voiceLike ? 0 : this.#unvoicedRunMs + frameMs;
    }

    const isSpeech = this.#speaking
      ? loudEnough && sustainsUtterance(this.#unvoicedRunMs)
      : loudEnough && voiceLike;

    if (isSpeech) {
      if (!this.#speaking) {
        this.#candidateFrames += 1;
        if (this.#candidateFrames < START_FRAMES) {
          this.#rememberPreRoll(samples, sampleRate);
          return;
        }
        this.#speaking = true;
        this.#speechMs = 0;
        // The debounce frames were speech too — they are why we are here.
        this.#voicedMs = this.#candidateFrames * frameMs;
        this.#unvoicedRunMs = 0;
        this.#sincePartialMs = 0;
        // Start the recording before the word, not on top of it.
        this.#buffer = this.#preRoll;
        this.#preRoll = [];
        this.#candidateFrames = 0;
        this.#opts.onSpeechStart?.();
      } else {
        this.#voicedMs += frameMs;
      }
      // The user carried on. Whatever was transcribed on the guess that they
      // had stopped describes only part of what they said, and leaving it
      // running would hold the whisper queue against the real utterance.
      if (this.#speculationLive) {
        this.#speculationLive = false;
        this.#opts.onSpeculationVoid?.();
      }
      this.#silenceMs = 0;
    } else if (this.#speaking) {
      this.#silenceMs += frameMs;
    } else {
      // A blip that did not sustain. Forget it and keep the rolling window.
      this.#candidateFrames = 0;
      this.#rememberPreRoll(samples, sampleRate);
    }

    if (!this.#speaking) return;

    this.#buffer.push(samples);
    this.#speechMs += frameMs;

    // Emit a snapshot of the speech so far, so words can appear while the
    // user is still talking rather than only once they stop.
    this.#sincePartialMs += frameMs;
    if (this.#opts.onPartial && this.#sincePartialMs >= this.#opts.partialIntervalMs) {
      this.#sincePartialMs = 0;
      this.#opts.onPartial(encodeWav(this.#buffer, sampleRate), this.#speechMs);
    }

    /**
     * Part-way through the hold, hand over what we have.
     *
     * Deliberately after the partial block and before the outcome check: the
     * clip is everything buffered so far, which is the same audio the final
     * utterance will carry minus the silence still to come.
     */
    if (
      this.#opts.onSpeculative &&
      shouldSpeculate({
        live: this.#speculationLive,
        count: this.#speculationCount,
        maxPerUtterance: MAX_SPECULATIONS_PER_UTTERANCE,
        silenceMs: this.#silenceMs,
        speculateAfterMs: this.#opts.speculateAfterMs,
        voicedMs: this.#voicedMs,
        minVoicedMs: this.#opts.speculateMinVoicedMs,
      })
    ) {
      this.#speculationLive = true;
      this.#speculationCount += 1;
      this.#opts.onSpeculative(encodeWav(this.#buffer, sampleRate), this.#speechMs);
    }

    const outcome = utteranceOutcome({
      voicedMs: this.#voicedMs,
      speechMs: this.#speechMs,
      silenceMs: this.#silenceMs,
      minUtteranceMs: this.#opts.minUtteranceMs,
      silenceHoldMs: this.#opts.silenceHoldMs,
      maxUtteranceMs: this.#opts.maxUtteranceMs,
    });
    if (outcome === 'continue') return;

    const durationMs = this.#speechMs;
    const frames = this.#buffer;
    const speculationLive = this.#speculationLive;

    this.#speaking = false;
    this.#silenceMs = 0;
    this.#speechMs = 0;
    this.#voicedMs = 0;
    this.#unvoicedRunMs = 0;
    this.#sincePartialMs = 0;
    this.#buffer = [];
    this.#preRoll = [];
    this.#candidateFrames = 0;
    this.#speculationLive = false;
    this.#speculationCount = 0;

    // Measured on voiced audio only. A bang, a keystroke or a chair scrape
    // clears the threshold for a moment and then stops; speech does not.
    if (outcome === 'discard') {
      // Nobody is going to claim it, so it must not be left running.
      if (speculationLive) this.#opts.onSpeculationVoid?.();
      return;
    }

    this.#opts.onUtterance?.(encodeWav(frames, sampleRate), durationMs, { speculationLive });
  }
}

/** Encodes float frames as 16-bit PCM WAV — the format Sarvam expects. */
export function encodeWav(frames: readonly Float32Array[], sampleRate: number): Blob {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const frame of frames) {
    for (const sample of frame) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
