import { useEffect, useRef, useState, type RefObject } from 'react';
import { Rive, Layout, Fit, Alignment } from '@rive-app/canvas';
import type { AssistantState } from '@assistant/schemas';
import type { Spectrum } from '../lib/audio.js';

/**
 * The two Rive animations, layered.
 *
 * They cannot be merged. A `.riv` is a compiled binary — combining two would
 * mean opening both in the Rive editor and rebuilding one artboard from the
 * pieces. What is possible in code is stacking them: the orb file renders as
 * the body, the voice file sits over it as the reactive element, and the two
 * are driven together.
 *
 * Rive files expose their controls in one of two ways. A state machine takes
 * named inputs, which can be wired to assistant state and microphone level. A
 * plain animation exposes only playback, so the most that can be driven is
 * speed. Both are handled, because which one a downloaded file uses is not
 * knowable until it is opened.
 */

export interface RiveDiagnostics {
  file: string;
  artboard: string | null;
  stateMachines: string[];
  animations: string[];
  inputs: string[];
}

/** Input names commonly used for a level or amplitude signal. */
const LEVEL_INPUTS = ['level', 'volume', 'amplitude', 'audio', 'intensity', 'scale', 'progress'];
/** Input names commonly used to switch between visual states. */
const STATE_INPUTS = ['state', 'mode', 'status', 'active', 'listening', 'speaking', 'thinking'];

function useRiveLayer(
  src: string,
  onReady: (diagnostics: RiveDiagnostics) => void,
): {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  riveRef: RefObject<Rive | null>;
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const riveRef = useRef<Rive | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rive = new Rive({
      src,
      canvas,
      autoplay: true,
      // Cover, so the artboard fills the viewport rather than letterboxing
      // into a small box in the middle of a large dark panel.
      layout: new Layout({ fit: Fit.Cover, alignment: Alignment.Center }),
      onLoad: () => {
        rive.resizeDrawingSurfaceToCanvas();

        const stateMachines = rive.stateMachineNames;
        const animations = rive.animationNames;

        // Start whichever driver the file actually provides.
        const machine = stateMachines[0];
        const animation = animations[0];
        if (machine) rive.play(machine);
        else if (animation) rive.play(animation);

        // Rive now prefers data binding, but these are downloaded community
        // files that predate view models. The classic inputs API is what they
        // actually expose, so the deprecated call is the working one.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const inputs = machine ? (rive.stateMachineInputs(machine) ?? []).map((i) => i.name) : [];

        onReadyRef.current({
          file: src,
          artboard: null,
          stateMachines,
          animations,
          inputs,
        });
      },
    });

    riveRef.current = rive;

    const resize = () => {
      rive.resizeDrawingSurfaceToCanvas();
    };
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      rive.cleanup();
      riveRef.current = null;
    };
  }, [src]);

  return { canvasRef, riveRef };
}

export function RiveOrb({
  state,
  spectrum,
  onDiagnostics,
}: {
  state: AssistantState;
  spectrum: Spectrum;
  /** Reports what each file exposes, so its controls can be wired up. */
  onDiagnostics?: (diagnostics: RiveDiagnostics) => void;
}) {
  const [ready, setReady] = useState<RiveDiagnostics[]>([]);

  const report = (d: RiveDiagnostics) => {
    setReady((prev) => (prev.some((p) => p.file === d.file) ? prev : [...prev, d]));
    onDiagnostics?.(d);
  };

  const base = useRiveLayer('/rive/orb.riv', report);
  const overlay = useRiveLayer('/rive/voice.riv', report);

  const stateRef = useRef(state);
  const spectrumRef = useRef(spectrum);
  stateRef.current = state;
  spectrumRef.current = spectrum;

  // Drive whatever controls the files turned out to expose.
  useEffect(() => {
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const level = spectrumRef.current.level;
      const busy = stateRef.current !== 'idle';

      for (const layer of [base.riveRef, overlay.riveRef]) {
        const rive = layer.current;
        if (!rive) continue;

        const machine = rive.stateMachineNames[0];
        if (machine) {
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
          for (const input of rive.stateMachineInputs(machine) ?? []) {
            const name = input.name.toLowerCase();

            if (LEVEL_INPUTS.some((k) => name.includes(k))) {
              // Rive numeric inputs are conventionally 0-100.
              input.value = level * 100;
            } else if (STATE_INPUTS.some((k) => name.includes(k))) {
              if (typeof input.value === 'boolean') input.value = busy;
            }
          }
        } else {
          // No state machine and no exposed speed control on this runtime
          // version, so playback simply continues at its authored rate.
          void busy;
        }
      }
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [base.riveRef, overlay.riveRef]);

  return (
    <div className="relative size-full">
      <canvas ref={base.canvasRef} className="absolute inset-0 size-full" />
      {/* Additive so the overlay reads as light on top of the body rather
          than a second object occluding it. */}
      <canvas
        ref={overlay.canvasRef}
        className="absolute inset-0 size-full"
        style={{ mixBlendMode: 'screen' }}
      />
      {ready.length < 2 && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-mono text-[10px] tracking-[0.3em] text-cyan-100/20 uppercase">
            loading
          </span>
        </div>
      )}
    </div>
  );
}
