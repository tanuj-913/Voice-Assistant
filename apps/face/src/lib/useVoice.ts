import { useCallback, useEffect, useRef, useState } from 'react';
import { MicCapture, type Spectrum } from './audio.js';
import { cancelSpeculation, sendPartial, sendUtterance, startSpeculation } from './api.js';

export interface UseVoiceOptions {
  onLevel?: (level: number) => void;
  /** Per-frame frequency bands, used to drive the orb. */
  onSpectrum?: (spectrum: Spectrum) => void;
  onError: (message: string) => void;
  /** Live interim transcript while the user is still speaking. */
  onPartialText?: (text: string) => void;
}

/**
 * Owns the microphone.
 *
 * The callbacks are held in a ref and re-read on each use rather than being
 * captured in `useCallback` dependencies. That is not a style choice — it fixes
 * a bug that made the mic impossible to turn on.
 *
 * The caller passes inline arrow functions, so their identity changes on every
 * render. With those as dependencies, `stop` was rebuilt each render, and the
 * unmount cleanup — written as `useEffect(() => stop, [stop])` — therefore ran
 * on *every* render rather than at unmount. Capture began, React re-rendered,
 * and the cleanup tore the microphone straight back down. The button never
 * latched on, and nothing errored, because nothing had actually failed.
 *
 * With the callbacks behind a ref, `start` and `stop` are stable for the life
 * of the component and the cleanup runs exactly once, at unmount.
 */
export function useVoice(options: UseVoiceOptions) {
  const captureRef = useRef<MicCapture | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [listening, setListening] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  /**
   * Guards against out-of-order partials. Each snapshot is longer than the
   * last, but transcription time varies, so a shorter earlier one can land
   * after a longer later one and make the text jump backwards.
   */
  const latestPartialRef = useRef(0);

  /**
   * The speculative transcription in flight for the current utterance.
   *
   * Holds a promise rather than an id because the guess is fired long before
   * the brain answers with one, and the utterance can complete in between —
   * in which case it must wait for the id rather than silently transcribe
   * everything twice.
   */
  const speculationRef = useRef<Promise<string | null> | null>(null);

  /** Abandons whatever is in flight. Safe to call when there is nothing. */
  const dropSpeculation = useCallback(() => {
    const pending = speculationRef.current;
    speculationRef.current = null;
    if (!pending) return;
    void pending.then((id) => {
      if (id) void cancelSpeculation(id);
    });
  }, []);

  const stop = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    setListening(false);
    optionsRef.current.onLevel?.(0);
    // Stopping mid-utterance leaves a guess nobody will claim; without this it
    // would sit in the brain until its TTL, holding whisper's slot.
    dropSpeculation();
  }, [dropSpeculation]);

  const start = useCallback(async () => {
    if (captureRef.current) return;

    const capture = new MicCapture({
      onLevel: (level) => optionsRef.current.onLevel?.(level),
      onSpectrum: (spectrum) => optionsRef.current.onSpectrum?.(spectrum),
      onPartial: (wav, durationMs) => {
        if (!optionsRef.current.onPartialText) return;
        latestPartialRef.current = durationMs;

        void sendPartial(wav).then((text) => {
          // Discard if a newer snapshot has already been sent.
          if (durationMs < latestPartialRef.current) return;
          if (text) optionsRef.current.onPartialText?.(text);
        });
      },

      /**
       * Part-way through the silence hold, on the guess that the user has
       * stopped. Overlaps transcription with the wait instead of running it
       * afterwards — the hold and the transcription were the two largest
       * fixed costs on a fast-path command.
       */
      onSpeculative: (wav) => {
        // A newer guess supersedes an older one.
        dropSpeculation();
        speculationRef.current = startSpeculation(wav);
      },

      onSpeculationVoid: () => {
        dropSpeculation();
      },

      onUtterance: (wav, _durationMs, context) => {
        // Stop listening the moment an utterance completes.
        //
        // Without this the microphone stays open while the model thinks, and
        // every subsequent VAD trigger — including Assistant's own reply coming
        // out of the speakers — starts another turn that cancels the one in
        // progress. In testing that produced a session where seven turns in a
        // row aborted each other and none ever answered.
        //
        // Captured before `stop()`, which drops any live speculation — this is
        // the one case where we want to keep it rather than cancel it.
        //
        // Only cleared from the ref when we are actually keeping it: if the
        // guess was invalidated, leaving it in place is what lets `stop()`
        // cancel it, rather than abandoning a run to time out on its own.
        const pending = context.speculationLive ? speculationRef.current : null;
        if (pending) speculationRef.current = null;

        stop();
        optionsRef.current.onPartialText?.('');

        void Promise.resolve(pending ?? null).then((speculationId) =>
          sendUtterance(wav, speculationId).then((result) => {
            if (!result.ok)
              optionsRef.current.onError(result.message ?? 'Could not transcribe that.');
          }),
        );
      },
    });

    // Claim the slot before awaiting, so a second click during the permission
    // prompt cannot start a competing capture.
    captureRef.current = capture;

    try {
      await capture.start();
      setListening(true);
      setPermissionDenied(false);
    } catch (error) {
      captureRef.current = null;
      const denied =
        error instanceof DOMException &&
        (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setPermissionDenied(denied);
      optionsRef.current.onError(
        denied
          ? 'Microphone access was denied. Enable it in System Settings > Privacy & Security > Microphone.'
          : `Could not open the microphone: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }, [stop]);

  const toggle = useCallback(() => {
    if (captureRef.current) stop();
    else void start();
  }, [start, stop]);

  /**
   * Opens the microphone as soon as the app loads.
   *
   * A wake word whose prerequisite is pressing a button is not a wake word.
   * The point of "Hey Assistant" is that nothing has to be touched first, so
   * capture runs continuously and the brain decides what was addressed to it.
   */
  useEffect(() => {
    void start();
    return () => {
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, [start]);

  return { listening, permissionDenied, start, stop, toggle };
}
