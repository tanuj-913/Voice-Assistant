/**
 * The microphone's decision rules, separated from the audio plumbing.
 *
 * `MicCapture` needs a live `AudioContext` and a real microphone, so the
 * judgements that decide whether Assistant heard you — or heard a door — could
 * only ever be checked by talking at the machine. These are the same
 * expressions, lifted out so they can be tested with numbers. The buffering,
 * WAV encoding and partial-transcript emission stay where they were.
 *
 * Both bugs behind the 2026-08-31 rewrite live here: the fixed threshold that
 * could not suit both a quiet room and a noisy one, and the duration measured
 * over trailing silence so a door slam always cleared the minimum.
 */

/**
 * Rises slowly so one loud noise does not deafen the mic to the next
 * sentence; falls fast so the bar drops as soon as the room quietens.
 */
const FLOOR_RISE = 0.004;
const FLOOR_FALL = 0.08;

/**
 * The rise rate while an utterance is open.
 *
 * The floor used to stop tracking entirely once speech started, so that a
 * speaker could not raise their own bar and cut themselves off mid-sentence.
 * That reasoning is right and the consequence was not: the bar also stopped
 * responding to the *room*. An utterance that opened in a quiet moment kept a
 * `continueAt` computed from that quiet, and when the room got louder every
 * ambient frame cleared it — so the microphone stayed open on nothing, for as
 * long as the hard cap allowed. Measured on 2026-09-26 that produced single
 * recordings of 6.8, 8.9 and 14.6 seconds, none of which contained a command
 * anywhere near their start.
 *
 * So it keeps tracking, about twenty times slower than at rest. The time
 * constant is roughly thirteen seconds: a sentence does not move it, and
 * sustained noise eventually lifts the bar past itself and closes the
 * utterance. Falling is left at the fast rate — a bar that drops when the room
 * quietens can only help the person talking.
 */
const FLOOR_RISE_SPEAKING = 0.0006;

/** Starting an utterance takes more than continuing one — see `speechGates`. */
const START_MULTIPLE = 3.2;
const CONTINUE_MULTIPLE = 1.7;
const CONTINUE_ABSOLUTE_RATIO = 0.6;

/**
 * Tracked continuously, but far more slowly while someone is talking — see
 * `FLOOR_RISE_SPEAKING` for why it cannot simply freeze.
 */
export function trackNoiseFloor(noiseFloor: number, rms: number, speaking = false): number {
  const rise = speaking ? FLOOR_RISE_SPEAKING : FLOOR_RISE;
  const rate = rms > noiseFloor ? rise : FLOOR_FALL;
  return noiseFloor + (rms - noiseFloor) * rate;
}

export interface SpeechGates {
  /** RMS needed to begin an utterance. */
  startAt: number;
  /** Lower bar to stay in one, so a pause between words does not split it. */
  continueAt: number;
}

/**
 * `speechThreshold` is an absolute floor beneath which nothing counts as
 * speech however quiet the room gets; the adaptive part is the multiple of
 * the measured noise floor.
 */
export function speechGates(speechThreshold: number, noiseFloor: number): SpeechGates {
  return {
    startAt: Math.max(speechThreshold, noiseFloor * START_MULTIPLE),
    continueAt: Math.max(speechThreshold * CONTINUE_ABSOLUTE_RATIO, noiseFloor * CONTINUE_MULTIPLE),
  };
}

export function isSpeechFrame(rms: number, speaking: boolean, gates: SpeechGates): boolean {
  return rms > (speaking ? gates.continueAt : gates.startAt);
}

export type UtteranceOutcome =
  /** Still talking, or still inside the silence hold. */
  | 'continue'
  /** Finished and long enough to send. */
  | 'accept'
  /** Finished but too little voiced audio — a bang, a keystroke, a chair. */
  | 'discard';

/**
 * `voicedMs` is deliberately not `speechMs`.
 *
 * `speechMs` includes the trailing silence that ends an utterance, so with a
 * silence hold of 850 ms every utterance is at least 850 ms long and a
 * minimum-duration guard beneath that can never fire. A 100 ms door slam sat
 * through the hold, measured over the minimum, and was sent to Whisper — which
 * answers half a second of a cough with a confident "Thank you."
 */
export function utteranceOutcome(state: {
  voicedMs: number;
  speechMs: number;
  silenceMs: number;
  minUtteranceMs: number;
  silenceHoldMs: number;
  maxUtteranceMs: number;
}): UtteranceOutcome {
  const finishedTalking = state.silenceMs >= state.silenceHoldMs;
  const ranTooLong = state.speechMs >= state.maxUtteranceMs;
  if (!finishedTalking && !ranTooLong) return 'continue';
  return state.voicedMs >= state.minUtteranceMs ? 'accept' : 'discard';
}

/**
 * How much of the room's own level a frame must exceed before it is even
 * considered — and why the absolute gate is now much lower than it was.
 *
 * The old default was 0.014 RMS, which is not a property of speech but of a
 * particular input gain. On 2026-09-06 the Mac's input volume was at 40 and
 * ordinary speech never reached it: in a whole session of talking, one
 * utterance passed the gate and Whisper returned zero characters for it. A
 * fixed amplitude cannot be right for every microphone and every gain, so the
 * absolute value drops to a true sanity floor and the work of rejecting noise
 * moves to `isVoiceLike` and `START_FRAMES`, which describe what speech *is*
 * rather than how loud this particular machine happens to record it.
 */
export const ABSOLUTE_FLOOR = 0.004;

/**
 * Bounds on `brightness` (see `pcm-worklet.js`) for something that could be a
 * person talking.
 *
 * Deliberately wide, and rejecting only at the extremes. The low bound cuts
 * mains hum, fans, traffic rumble and desk thumps — energy below ~110 Hz,
 * where no voice has its centroid. The high bound cuts hiss and mouse clicks
 * above ~6.5 kHz.
 *
 * It is not narrowed to the vowel range on purpose: "stop" opens on /s/, which
 * is bright, and a gate tight enough to exclude hiss would clip the first
 * consonant off half the commands in the app.
 */
export const VOICE_BRIGHTNESS_MIN = 0.04;
export const VOICE_BRIGHTNESS_MAX = 1.9;

export function isVoiceLike(brightness: number): boolean {
  return brightness >= VOICE_BRIGHTNESS_MIN && brightness <= VOICE_BRIGHTNESS_MAX;
}

/**
 * Consecutive qualifying frames needed to open an utterance — about 40 ms at
 * 128 samples and 16 kHz.
 *
 * This is what replaces a high amplitude gate as the defence against taps,
 * clicks and keystrokes: they are loud and broadband but they do not *last*.
 * Speech does. Applied only to starting, never to continuing, so a pause
 * inside a sentence still costs nothing.
 */
export const START_FRAMES = 5;

/**
 * How long a run of loud-but-not-voice-like audio may hold an utterance open.
 *
 * `isVoiceLike` was applied only to *starting* an utterance, on the reasoning
 * that continuing should ask nothing extra so a pause between words costs
 * nothing. The gap that left: once open, the only question asked of each frame
 * was whether it was loud, and a fan or an air conditioner is loud
 * indefinitely. The test that exists precisely to reject that kind of sound
 * was never consulted again.
 *
 * It is a *run* rather than a single frame because speech is full of brief
 * unvoiced moments — plosives, sibilants, the gap before a hard consonant —
 * and closing on any one of them would chop sentences apart. 400 ms is far
 * longer than any of those and far shorter than a fan.
 */
export const MAX_UNVOICED_RUN_MS = 400;

/**
 * Whether an open utterance should still count a loud frame as speech.
 *
 * Returning false does not end the utterance on its own; it stops the frame
 * counting as voice, which starts the ordinary silence hold. Noise therefore
 * closes the microphone by the same path as a person finishing a sentence.
 */
export function sustainsUtterance(unvoicedRunMs: number): boolean {
  return unvoicedRunMs < MAX_UNVOICED_RUN_MS;
}

/**
 * The frequency a brightness ratio implies, for logs and the mic-check page.
 * Inverse of 2·sin(pi·f/rate).
 */
export function dominantHz(brightness: number, sampleRate: number): number {
  const ratio = Math.min(2, Math.max(0, brightness)) / 2;
  return (Math.asin(ratio) * sampleRate) / Math.PI;
}

/**
 * Whether to start transcribing before the silence hold has finished.
 *
 * The hold exists to be sure the user has stopped, and nothing happens during
 * it: on a fast-path command the 850 ms wait and the ~626 ms transcription run
 * back to back, and both are paid before the model is even asked. Firing the
 * transcription part-way through overlaps them.
 *
 * The guess is wrong whenever someone pauses mid-sentence, which is often.
 * That is affordable only because an abandoned run is dropped before it
 * reaches whisper's queue — see `SerialQueue`. Without that cancellation this
 * function would be a way of making the mic slower, not faster.
 */
export function shouldSpeculate(state: {
  /** Already guessed for this utterance and not yet invalidated. */
  live: boolean;
  /** Guesses already made for this utterance. */
  count: number;
  maxPerUtterance: number;
  silenceMs: number;
  speculateAfterMs: number;
  voicedMs: number;
  /** Below this the utterance would be discarded as noise anyway. */
  minVoicedMs: number;
}): boolean {
  if (state.live) return false;
  // A speaker who pauses at every comma would otherwise start and cancel a run
  // at every comma. Each is cheap, none is free, and the last one is the one
  // that pays off.
  if (state.count >= state.maxPerUtterance) return false;
  if (state.silenceMs < state.speculateAfterMs) return false;
  // Never speculate on something that would be thrown away as too short: that
  // is a whisper run spent on a door slam.
  return state.voicedMs >= state.minVoicedMs;
}
