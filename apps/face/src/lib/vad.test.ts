import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_FLOOR,
  dominantHz,
  isSpeechFrame,
  isVoiceLike,
  MAX_UNVOICED_RUN_MS,
  START_FRAMES,
  shouldSpeculate,
  sustainsUtterance,
  speechGates,
  trackNoiseFloor,
  utteranceOutcome,
} from './vad.js';

/**
 * The two failures behind the 2026-08-31 rewrite, written as tests: the mic
 * "took background noises without accepting my voice". Until now the only way
 * to check either was to talk at the machine.
 */

// MicCapture's shipped defaults.
const SPEECH_THRESHOLD = 0.014;
const SILENCE_HOLD_MS = 850;
const MIN_UTTERANCE_MS = 320;
const MAX_UTTERANCE_MS = 8_000;

/** Runs the floor to equilibrium against a steady room level. */
function settle(startFloor: number, roomRms: number, frames: number): number {
  let floor = startFloor;
  for (let i = 0; i < frames; i += 1) floor = trackNoiseFloor(floor, roomRms);
  return floor;
}

describe('noise floor', () => {
  it('rises slowly, so one loud noise does not deafen the mic', () => {
    // A single bang at 20x the floor barely moves it.
    const after = trackNoiseFloor(0.006, 0.12);
    expect(after).toBeLessThan(0.0065);
  });

  it('falls fast, so the bar drops when the room quietens', () => {
    const noisy = settle(0.006, 0.05, 400);
    expect(noisy).toBeGreaterThan(0.03);
    // Twenty frames of quiet is roughly a third of a second.
    const quietened = settle(noisy, 0.002, 20);
    expect(quietened).toBeLessThan(noisy / 2);
  });

  it('falls toward the room level rather than to zero', () => {
    expect(settle(0.05, 0.004, 300)).toBeCloseTo(0.004, 4);
  });
});

describe('speech gates', () => {
  it('never drops below the absolute threshold in a silent room', () => {
    const gates = speechGates(SPEECH_THRESHOLD, 0);
    expect(gates.startAt).toBe(SPEECH_THRESHOLD);
    expect(gates.continueAt).toBeCloseTo(SPEECH_THRESHOLD * 0.6, 6);
  });

  it('raises the bar above the room once it is noisy', () => {
    // A fixed 0.014 threshold is the original bug: this room clears it on
    // noise alone, so everything would count as speech.
    const noisy = 0.02;
    const gates = speechGates(SPEECH_THRESHOLD, noisy);
    expect(noisy).toBeGreaterThan(SPEECH_THRESHOLD);
    expect(isSpeechFrame(noisy, false, gates)).toBe(false);
    expect(gates.startAt).toBeCloseTo(noisy * 3.2, 6);
  });

  it('accepts a soft voice in a quiet room', () => {
    const gates = speechGates(SPEECH_THRESHOLD, 0.003);
    expect(isSpeechFrame(0.02, false, gates)).toBe(true);
  });

  it('takes more to start an utterance than to stay in one', () => {
    const gates = speechGates(SPEECH_THRESHOLD, 0.01);
    expect(gates.continueAt).toBeLessThan(gates.startAt);

    // A dip between words: too quiet to have started, loud enough to continue.
    const betweenWords = (gates.startAt + gates.continueAt) / 2;
    expect(isSpeechFrame(betweenWords, false, gates)).toBe(false);
    expect(isSpeechFrame(betweenWords, true, gates)).toBe(true);
  });
});

describe('utterance outcome', () => {
  const base = {
    minUtteranceMs: MIN_UTTERANCE_MS,
    silenceHoldMs: SILENCE_HOLD_MS,
    maxUtteranceMs: MAX_UTTERANCE_MS,
  };

  it('keeps listening through a pause shorter than the hold', () => {
    expect(utteranceOutcome({ ...base, voicedMs: 900, speechMs: 1300, silenceMs: 400 })).toBe(
      'continue',
    );
  });

  it('accepts a normal sentence once the speaker stops', () => {
    expect(utteranceOutcome({ ...base, voicedMs: 1500, speechMs: 2350, silenceMs: 850 })).toBe(
      'accept',
    );
  });

  /**
   * The exact shape of the original bug. A 100 ms door slam then silence:
   * speechMs reaches 950 because the silence hold is counted, so a guard on
   * speechMs would have passed it straight to Whisper.
   */
  it('discards a door slam even though its speechMs clears the minimum', () => {
    const doorSlam = { ...base, voicedMs: 100, speechMs: 950, silenceMs: 850 };
    expect(doorSlam.speechMs).toBeGreaterThan(MIN_UTTERANCE_MS);
    expect(utteranceOutcome(doorSlam)).toBe('discard');
  });

  it('accepts a short command like "stop"', () => {
    expect(utteranceOutcome({ ...base, voicedMs: 360, speechMs: 1210, silenceMs: 850 })).toBe(
      'accept',
    );
  });

  it('cuts off a stuck-open mic at the hard cap', () => {
    expect(utteranceOutcome({ ...base, voicedMs: 25_000, speechMs: 30_000, silenceMs: 0 })).toBe(
      'accept',
    );
  });

  it('discards a long stretch of noise with almost no voiced audio', () => {
    expect(utteranceOutcome({ ...base, voicedMs: 200, speechMs: 30_000, silenceMs: 0 })).toBe(
      'discard',
    );
  });
});

/**
 * The 2026-09-06 failure: the user spoke repeatedly and Assistant heard one
 * utterance in the whole session, which transcribed to zero characters. The
 * Mac's input volume was at 40, so ordinary speech never reached the 0.014
 * gate — a number that describes a gain setting, not a voice.
 */
describe('low input gain', () => {
  const QUIET_ROOM = 0.0012;
  /** Normal speech recorded at ~40% input gain. */
  const QUIET_SPEECH = 0.008;

  it('used to ignore ordinary speech, and no longer does', () => {
    const old = speechGates(0.014, QUIET_ROOM);
    expect(isSpeechFrame(QUIET_SPEECH, false, old)).toBe(false);

    const now = speechGates(ABSOLUTE_FLOOR, QUIET_ROOM);
    expect(isSpeechFrame(QUIET_SPEECH, false, now)).toBe(true);
  });

  it('still keeps the adaptive gate in charge when the room is loud', () => {
    // Lowering the absolute floor must not re-open the original bug.
    const noisy = 0.02;
    const gates = speechGates(ABSOLUTE_FLOOR, noisy);
    expect(isSpeechFrame(noisy, false, gates)).toBe(false);
    expect(gates.startAt).toBeCloseTo(noisy * 3.2, 6);
  });
});

describe('voice-likeness', () => {
  /** brightness = 2·sin(pi·f/rate) — see pcm-worklet.js. */
  const at = (hz: number) => 2 * Math.sin((Math.PI * hz) / 16_000);

  it('rejects mains hum and rumble below the range of a voice', () => {
    expect(isVoiceLike(at(50))).toBe(false);
    expect(isVoiceLike(at(90))).toBe(false);
  });

  it('accepts the whole range a voice actually occupies', () => {
    for (const hz of [150, 300, 800, 1500, 3000]) {
      expect(isVoiceLike(at(hz))).toBe(true);
    }
  });

  it('accepts a bright opening consonant, so "stop" is not clipped to "top"', () => {
    expect(isVoiceLike(at(5500))).toBe(true);
  });

  it('rejects hiss and clicks above anything speech produces', () => {
    expect(isVoiceLike(at(7500))).toBe(false);
  });

  it('reports the frequency a ratio implies, for the mic check', () => {
    expect(dominantHz(at(1000), 16_000)).toBeCloseTo(1000, 3);
    expect(dominantHz(at(220), 16_000)).toBeCloseTo(220, 3);
  });

  it('treats a silent frame as unvoiced rather than as rumble', () => {
    // brightness is 0 when there is no signal to divide by.
    expect(isVoiceLike(0)).toBe(false);
  });
});

describe('start debounce', () => {
  it('needs sustained energy, so a keystroke cannot open an utterance', () => {
    // A click is loud and broadband but over in a frame or two; the debounce
    // is what rejects it, now that amplitude alone no longer can.
    expect(START_FRAMES).toBeGreaterThan(1);
    const clickFrames = 2;
    expect(clickFrames).toBeLessThan(START_FRAMES);
  });

  it('opens fast enough not to be heard as hesitation', () => {
    // 128 samples at 16kHz is 8ms a frame.
    const debounceMs = START_FRAMES * (128 / 16_000) * 1000;
    expect(debounceMs).toBeLessThan(60);
  });
});

/**
 * Speculative transcription, added to claw back the silence hold.
 *
 * The hold and the transcription were the two largest fixed costs on a
 * fast-path command — 850 ms then ~626 ms, one after the other — and nothing
 * happened during the first. These are the conditions under which guessing
 * early is worth it, and the ones under which it is not.
 */
describe('shouldSpeculate', () => {
  const base = {
    live: false,
    count: 0,
    maxPerUtterance: 3,
    silenceMs: 300,
    speculateAfterMs: 250,
    voicedMs: 900,
    minVoicedMs: 320,
  };

  it('fires once the silence has run long enough', () => {
    expect(shouldSpeculate(base)).toBe(true);
  });

  it('waits while the user is still mid-word', () => {
    expect(shouldSpeculate({ ...base, silenceMs: 100 })).toBe(false);
  });

  /**
   * A door slam clears the speech gate for a moment and stops. It would be
   * discarded as too short when the utterance ended, so transcribing it early
   * spends a whisper run on nothing.
   */
  it('ignores anything too short to be kept', () => {
    expect(shouldSpeculate({ ...base, voicedMs: 200 })).toBe(false);
  });

  it('does not guess twice about the same silence', () => {
    expect(shouldSpeculate({ ...base, live: true })).toBe(false);
  });

  /**
   * Someone who pauses at every comma would otherwise start and cancel a run
   * at every comma for the length of a paragraph.
   */
  it('stops guessing after the cap', () => {
    expect(shouldSpeculate({ ...base, count: 3 })).toBe(false);
    expect(shouldSpeculate({ ...base, count: 2 })).toBe(true);
  });

  /**
   * The gate must open strictly before the hold does, or the speculation is
   * fired at the same moment the real utterance is — which buys nothing and
   * costs a duplicate transcription.
   */
  it('always fires before the hold expires', () => {
    const silenceHoldMs = 850;
    expect(base.speculateAfterMs).toBeLessThan(silenceHoldMs);
    expect(shouldSpeculate({ ...base, silenceMs: base.speculateAfterMs })).toBe(true);
  });
});

/**
 * The 2026-09-26 failure: "the mic is always on and due to which the assistant
 * takes input all the time and doesnt stop".
 *
 * The live log showed utterances of 6.8, 8.9 and 14.6 seconds and thirteen
 * transcriptions that started zero turns. The microphone was opening and not
 * closing, which buried the wake word in the middle of a clip — and
 * `detectWakeWord` is anchored to the start, so none of it was ever addressed
 * to Assistant. Three separate causes, one per block below.
 */
describe('a noisy room cannot hold the microphone open', () => {
  const FRAME_MS = 8;

  it('keeps adapting the floor while speaking, slower but never frozen', () => {
    // This is the contract, and both halves of it matter. Freezing is what
    // caused the bug; rising at the resting rate is what the freeze was
    // there to prevent. A speaking rate of zero must fail this.
    const floor = 0.006;
    const speaking = trackNoiseFloor(floor, 0.05, true);
    const resting = trackNoiseFloor(floor, 0.05, false);
    expect(speaking).toBeGreaterThan(floor);
    expect(speaking).toBeLessThan(resting);
  });

  it('does not let a speaker raise their own bar mid-sentence', () => {
    // Three seconds of loud speech over a quiet floor. The bar must stay well
    // under the speaker, or they cut themselves off — the reason it used to
    // freeze at all.
    let floor = 0.006;
    for (let ms = 0; ms < 3000; ms += FRAME_MS) floor = trackNoiseFloor(floor, 0.05, true);
    expect(speechGates(SPEECH_THRESHOLD, floor).continueAt).toBeLessThan(0.05);
  });

  it('lifts the bar past sustained noise, so a stuck utterance closes itself', () => {
    // An utterance that opened in a quiet moment, then ten seconds of a room
    // three times louder than the floor it was measured against.
    const room = 0.018;
    let floor = 0.006;
    expect(room).toBeGreaterThan(speechGates(SPEECH_THRESHOLD, floor).continueAt);

    for (let ms = 0; ms < 10_000; ms += FRAME_MS) floor = trackNoiseFloor(floor, room, true);
    expect(room).toBeLessThan(speechGates(SPEECH_THRESHOLD, floor).continueAt);
  });

  it('stops counting a fan as speech once the run is long enough', () => {
    // Hum sits below VOICE_BRIGHTNESS_MIN and is loud indefinitely.
    const hum = 0.01;
    expect(isVoiceLike(hum)).toBe(false);

    // Bounded independently of the constant. Looping to MAX_UNVOICED_RUN_MS
    // itself means a bad value hangs the suite instead of failing it, which
    // is the one thing a guard against a stuck microphone must not do.
    expect(MAX_UNVOICED_RUN_MS).toBeLessThanOrEqual(1000);
    expect(sustainsUtterance(MAX_UNVOICED_RUN_MS - FRAME_MS)).toBe(true);
    expect(sustainsUtterance(MAX_UNVOICED_RUN_MS)).toBe(false);
  });

  it('does not close on a plosive, which is unvoiced but brief', () => {
    // A hard consonant is tens of milliseconds, not hundreds.
    expect(sustainsUtterance(60)).toBe(true);
  });

  it('resets the run on any voiced frame, so speech never accumulates one', () => {
    // Alternating voiced and unvoiced frames is what a sentence looks like;
    // the run must never build up across it.
    let run = 0;
    for (let i = 0; i < 500; i += 1) {
      const voiced = i % 3 !== 0;
      run = voiced ? 0 : run + FRAME_MS;
      expect(sustainsUtterance(run)).toBe(true);
    }
  });

  it('caps an utterance long before whisper has to transcribe the room', () => {
    // The 14.6s recording that started this could not happen under the cap.
    expect(MAX_UTTERANCE_MS).toBeLessThan(14_584);
    expect(
      utteranceOutcome({
        voicedMs: 4000,
        speechMs: MAX_UTTERANCE_MS,
        silenceMs: 0,
        minUtteranceMs: MIN_UTTERANCE_MS,
        silenceHoldMs: SILENCE_HOLD_MS,
        maxUtteranceMs: MAX_UTTERANCE_MS,
      }),
    ).toBe('accept');
  });

  it('still leaves room for an ordinary spoken command', () => {
    // Long enough that clipping is rare; the cost of being wrong is a repeat.
    expect(MAX_UTTERANCE_MS).toBeGreaterThan(5000);
  });
});

/**
 * The capture loop, reduced to the decisions under test.
 *
 * `MicCapture` needs a live `AudioContext`, so the loop that actually runs
 * these rules cannot be instantiated here — which is why `vad.ts` exists at
 * all. This mirrors the ordering in `MicCapture#onFrame`: track the floor,
 * compute the gates, decide whether the frame is speech, then age the silence
 * hold. If that ordering changes, this stops describing the real thing.
 */
function runCapture(room: { rms: number; brightness: number }, ms: number) {
  const FRAME_MS = 8;
  let floor = 0.006;
  let speaking = false;
  let speechMs = 0;
  let voicedMs = 0;
  let silenceMs = 0;
  let unvoicedRunMs = 0;

  for (let t = 0; t < ms; t += FRAME_MS) {
    floor = trackNoiseFloor(floor, room.rms, speaking);
    const gates = speechGates(SPEECH_THRESHOLD, floor);
    const loudEnough = isSpeechFrame(room.rms, speaking, gates);
    const voiceLike = isVoiceLike(room.brightness);

    if (speaking && loudEnough) {
      unvoicedRunMs = voiceLike ? 0 : unvoicedRunMs + FRAME_MS;
    }
    const isSpeech = speaking
      ? loudEnough && sustainsUtterance(unvoicedRunMs)
      : loudEnough && voiceLike;

    if (isSpeech) {
      if (!speaking) {
        speaking = true;
        voicedMs = START_FRAMES * FRAME_MS;
        unvoicedRunMs = 0;
      } else {
        voicedMs += FRAME_MS;
      }
      silenceMs = 0;
    } else if (speaking) {
      silenceMs += FRAME_MS;
    }

    if (speaking) {
      speechMs += FRAME_MS;
      const outcome = utteranceOutcome({
        voicedMs,
        speechMs,
        silenceMs,
        minUtteranceMs: MIN_UTTERANCE_MS,
        silenceHoldMs: SILENCE_HOLD_MS,
        maxUtteranceMs: MAX_UTTERANCE_MS,
      });
      if (outcome !== 'continue') return { closedAtMs: speechMs, outcome };
    }
  }
  return { closedAtMs: Infinity, outcome: 'continue' as const };
}

describe('the stuck-open microphone, end to end', () => {
  it('never opens on a fan, which has no voicing at all', () => {
    // Loud enough to clear the gates, with hum's brightness — below
    // VOICE_BRIGHTNESS_MIN, so it fails the voicing test on every frame.
    const fan = runCapture({ rms: 0.05, brightness: 0.01 }, 30_000);
    expect(fan.closedAtMs).toBe(Infinity);
  });

  it('closes rather than recording the room for fourteen seconds', () => {
    // Broadband noise that does pass the voicing bounds — a television in
    // another room, the case the voicing test alone cannot catch. The rising
    // floor and the cap are what have to close this one.
    const room = runCapture({ rms: 0.05, brightness: 0.5 }, 60_000);
    expect(room.closedAtMs).toBeLessThanOrEqual(MAX_UTTERANCE_MS);
    // And well under the 14.6s recording that prompted the fix.
    expect(room.closedAtMs).toBeLessThan(14_584);
  });

  it('still accepts a person talking', () => {
    const speech = runCapture({ rms: 0.05, brightness: 0.5 }, 3000);
    expect(speech.outcome).not.toBe('discard');
  });
});
