import * as THREE from 'three';
import type { AssistantState } from '@assistant/schemas';

/**
 * How the field behaves in each state.
 *
 * Every value is a target, never a switch. Each frame the live value eases
 * toward its target, so a state change reads as the field *becoming*
 * something rather than cutting to it — which is most of what separates this
 * from a spinner.
 */
export interface FieldMood {
  /**
   * The rim's three stops, swept around the circle. Deliberately a different
   * family from the ribbons: a single palette shared by every layer is what
   * made the first attempt read as one flat blue fog rather than a bright
   * edge with light moving around it. Measured off the reference the rim runs
   * 240 to 280 degrees at 0.8-0.9 saturation — blue-violet into magenta, and
   * never into the blues the strands occupy.
   */
  cool: THREE.Color;
  mid: THREE.Color;
  hot: THREE.Color;
  /**
   * The strands' ramp: electric blue through azure to cyan. Sampling the
   * reference by hue over the strand annulus, the saturated strand colour
   * sits almost entirely in 180-220 degrees at 0.9-1.0 saturation — the
   * modes are 190 (#19d8ff) and 210 (#007fff). An earlier read of this called
   * the strands "deep navy", which counted the unlit backs of the soft bands
   * rather than the strands themselves and tinted the whole weave muddy.
   */
  ribbonCool: THREE.Color;
  ribbonMid: THREE.Color;
  ribbonHot: THREE.Color;
  /**
   * The mint accent, held off the ramp on purpose. In the reference green is
   * a minority colour on one or two strands, not a third of the gradient —
   * putting it on the ramp tinted every strand green. It lives at hue 170 and
   * full saturation (#19ffd8), and it appears out at the *edge* of the field
   * rather than near the rim.
   */
  ribbonAccent: THREE.Color;
  /** Speed of the underlying flow field. */
  flow: number;
  /** How far the flow displaces particles. */
  turbulence: number;
  /** Ring rotation rate. */
  spin: number;
  /** Amplitude of the idle breath. */
  breath: number;
  /** Core brightness multiplier. */
  energy: number;
  /** Bloom strength. */
  bloom: number;
  /** How far the rings tilt out of plane. */
  tilt: number;
}

type Trio = [string, string, string];
type Quad = [string, string, string, string];

const mood = (
  rim: Trio,
  ribbon: Quad,
  rest: Omit<
    FieldMood,
    'cool' | 'mid' | 'hot' | 'ribbonCool' | 'ribbonMid' | 'ribbonHot' | 'ribbonAccent'
  >,
): FieldMood => ({
  cool: new THREE.Color(rim[0]),
  mid: new THREE.Color(rim[1]),
  hot: new THREE.Color(rim[2]),
  ribbonCool: new THREE.Color(ribbon[0]),
  ribbonMid: new THREE.Color(ribbon[1]),
  ribbonHot: new THREE.Color(ribbon[2]),
  ribbonAccent: new THREE.Color(ribbon[3]),
  ...rest,
});

export const MOODS: Record<AssistantState, FieldMood> = {
  // Barely moving. The field should look asleep but not switched off — a
  // completely still centrepiece reads as a broken page.
  idle: mood(['#3a2bff', '#7a2bff', '#c11cff'], ['#0054ff', '#00a9ff', '#1ae4ff', '#19ffd8'], {
    flow: 0.1,
    turbulence: 0.28,
    spin: 0.055,
    breath: 0.03,
    energy: 0.72,
    bloom: 0.62,
    tilt: 0.1,
  }),

  // Opening outward, brighter, faster — attention turned toward the speaker.
  listening: mood(['#4a3bff', '#8f3cff', '#d33cff'], ['#0a6bff', '#22bcff', '#5cf0ff', '#5cffe2'], {
    flow: 0.4,
    turbulence: 0.62,
    spin: 0.16,
    breath: 0.06,
    energy: 1.25,
    bloom: 1.05,
    tilt: 0.26,
  }),

  transcribing: mood(
    ['#3a2bff', '#7a2bff', '#b53cff'],
    ['#0054ff', '#00a9ff', '#1ae4ff', '#19ffd8'],
    {
      flow: 0.55,
      turbulence: 0.6,
      spin: 0.3,
      breath: 0.04,
      energy: 1.1,
      bloom: 0.9,
      tilt: 0.32,
    },
  ),

  // Tighter and faster: circular, controlled, clearly working.
  thinking: mood(['#2f22d8', '#6522e8', '#a31ce8'], ['#0040dd', '#0f8cf1', '#1ae4ff', '#22f0cc'], {
    flow: 0.95,
    turbulence: 0.78,
    spin: 0.62,
    breath: 0.022,
    energy: 1.15,
    bloom: 1.0,
    tilt: 0.5,
  }),

  acting: mood(['#4a2bf0', '#8a2bff', '#c93cff'], ['#0a6bff', '#00a9ff', '#1ae4ff', '#6effc0'], {
    flow: 0.8,
    turbulence: 0.7,
    spin: 0.48,
    breath: 0.03,
    energy: 1.2,
    bloom: 1.0,
    tilt: 0.42,
  }),

  // Waves rolling outward in time with the reply.
  speaking: mood(['#4433ff', '#8a2bff', '#cf2bff'], ['#0054ff', '#22bcff', '#5cf0ff', '#3cffdc'], {
    flow: 0.62,
    turbulence: 0.72,
    spin: 0.22,
    breath: 0.09,
    energy: 1.35,
    bloom: 1.2,
    tilt: 0.2,
  }),

  // Waiting on a person: held still and warm, so it reads as paused rather
  // than working.
  awaiting_approval: mood(
    ['#b45309', '#78350f', '#fbbf24'],
    ['#f59e0b', '#fbbf24', '#fde68a', '#fb923c'],
    {
      flow: 0.18,
      turbulence: 0.3,
      spin: 0.1,
      breath: 0.12,
      energy: 1.15,
      bloom: 1.05,
      tilt: 0.3,
    },
  ),

  success: mood(['#047857', '#064e3b', '#34d399'], ['#10b981', '#34d399', '#6ee7b7', '#a7f3d0'], {
    flow: 0.3,
    turbulence: 0.25,
    spin: 0.15,
    breath: 0.05,
    energy: 1.0,
    bloom: 1.0,
    tilt: 0.2,
  }),

  failure: mood(['#be123c', '#7f1d1d', '#fb7185'], ['#dc2626', '#f97316', '#fbbf24', '#fca5a5'], {
    flow: 1.15,
    turbulence: 1.0,
    spin: 0.8,
    breath: 0.07,
    energy: 1.1,
    bloom: 0.9,
    tilt: 0.6,
  }),
};

/**
 * Frame-rate independent easing.
 *
 * `current += (target - current) * rate` is the usual shorthand and is wrong:
 * it eases faster on a 120Hz display than a 60Hz one, so the same transition
 * has a different duration per machine. Raising the retention to the power of
 * elapsed time fixes that.
 */
export function ease(current: number, target: number, smoothing: number, delta: number): number {
  return current + (target - current) * (1 - Math.pow(smoothing, delta));
}

export function easeColor(
  current: THREE.Color,
  target: THREE.Color,
  smoothing: number,
  delta: number,
): void {
  current.lerp(target, 1 - Math.pow(smoothing, delta));
}

/** Cubic ease-out — the settle curve for one-shot flourishes. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Overshoots then settles, for the success confirmation. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
