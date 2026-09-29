import { useEffect, useRef } from 'react';
import type { Spectrum } from '../lib/audio.js';

/**
 * The small bar meter that sits inside the ring.
 *
 * Drawn to a canvas on its own animation frame rather than as React state.
 * The parent only re-renders while the microphone is open, so a state-driven
 * version would freeze the moment the mic closed — and a frozen meter reads
 * as a broken app rather than a quiet one.
 */
const BARS = 13;
const BAR_WIDTH = 3;
const GAP = 4;
const MAX_HEIGHT = 30;

/** Cyan at the edges, magenta through the middle. */
const STOPS: [number, number, number][] = [
  [34, 211, 238],
  [96, 165, 250],
  [217, 70, 239],
];

const FALLBACK: [number, number, number] = [34, 211, 238];

function colorAt(t: number): string {
  const scaled = Math.min(0.999, Math.max(0, t)) * (STOPS.length - 1);
  const index = Math.floor(scaled);
  const from = STOPS[index] ?? FALLBACK;
  const to = STOPS[index + 1] ?? from;
  const f = scaled - index;
  const mix = (a: number, b: number) => String(Math.round(a + (b - a) * f));
  return `rgb(${mix(from[0], to[0])}, ${mix(from[1], to[1])}, ${mix(from[2], to[2])})`;
}

export function Waveform({ spectrum, active }: { spectrum: Spectrum; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spectrumRef = useRef(spectrum);
  const activeRef = useRef(active);
  spectrumRef.current = spectrum;
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const width = BARS * BAR_WIDTH + (BARS - 1) * GAP;
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = width * dpr;
    canvas.height = MAX_HEIGHT * dpr;
    canvas.style.width = `${String(width)}px`;
    canvas.style.height = `${String(MAX_HEIGHT)}px`;
    ctx.scale(dpr, dpr);

    // Each bar eases toward its target rather than jumping, so a loud
    // consonant reads as a swell instead of a flicker.
    const heights = new Array<number>(BARS).fill(0.2);
    let frame = 0;
    let time = 0;

    const render = () => {
      frame = requestAnimationFrame(render);
      time += 1 / 60;
      const s = spectrumRef.current;

      ctx.clearRect(0, 0, width, MAX_HEIGHT);

      for (let i = 0; i < BARS; i += 1) {
        // Distance from the centre, so the shape stays symmetric and the
        // low frequencies sit in the middle where the eye goes first.
        const fromCentre = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);

        let target: number;
        if (activeRef.current) {
          const band = fromCentre < 0.34 ? s.bass : fromCentre < 0.67 ? s.lowMid : s.high;
          target = 0.16 + band * 1.5 * (1 - fromCentre * 0.45);
        } else {
          // Idle: a slow travelling wave. Still, it would look switched off.
          target = 0.2 + Math.sin(time * 1.7 - i * 0.55) * 0.13 + (1 - fromCentre) * 0.16;
        }

        const current = heights[i] ?? 0.2;
        heights[i] = current + (Math.min(1, Math.max(0.08, target)) - current) * 0.22;

        const h = (heights[i] ?? 0.2) * MAX_HEIGHT;
        const x = i * (BAR_WIDTH + GAP);
        const y = (MAX_HEIGHT - h) / 2;

        ctx.fillStyle = colorAt(1 - fromCentre);
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.roundRect(x, y, BAR_WIDTH, h, BAR_WIDTH / 2);
        ctx.fill();
      }
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="opacity-90" />;
}
