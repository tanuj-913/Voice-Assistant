import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { AssistantState } from '@assistant/schemas';
import type { Spectrum } from '../lib/audio.js';
import { Orb } from './Orb.js';
import { SIMPLEX } from './field/shaders.js';
import { easeOutBack, easeOutCubic, ease, easeColor, MOODS } from './field/states.js';

/**
 * Assistant's reactor.
 *
 * The composition is deliberate and worth stating, because the obvious
 * approach — layer a lot of noise and turn the bloom up — produces a blue fog
 * with no shape, which is exactly what the first attempt did. What reads as
 * "premium" here is contrast, not volume:
 *
 *   1. a dark centre, so text sits inside it and the frame has somewhere to rest
 *   2. one razor-thin, very bright rim, hue swept around its circumference
 *   3. broad smooth ribbons of light orbiting it in a cooler, greener family
 *   4. sparse dotted trails and sparkles for scale
 *   5. a soft outer haze that never resolves into an edge
 *
 * Layer 2 is the whole effect. A sharp line that blooms outward looks like
 * light; a soft band that blooms outward looks like smoke.
 */

/** Wrapping three-stop colour wheel, so the rim's hue sweep has no seam. */
const WHEEL = /* glsl */ `
  uniform vec3 uCool, uMid, uHot;
  vec3 wheel(float t) {
    t = fract(t) * 3.0;
    if (t < 1.0) return mix(uCool, uMid, t);
    if (t < 2.0) return mix(uMid, uHot, t - 1.0);
    return mix(uHot, uCool, t - 2.0);
  }
`;

/** The ribbons run on their own palette; sharing one washes everything out. */
const RIBBON_PALETTE = /* glsl */ `
  uniform vec3 uRibCool, uRibMid, uRibHot, uRibAccent;
  vec3 ribbonColor(float t) {
    t = clamp(t, 0.0, 1.0);
    return t < 0.5 ? mix(uRibCool, uRibMid, t * 2.0) : mix(uRibMid, uRibHot, (t - 0.5) * 2.0);
  }
`;

const PLANE_VERT = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The rim.
 *
 * Brightness is a gaussian across the band rather than a smoothstep. A
 * smoothstep gives a plateau — a stripe — while a gaussian gives a single
 * bright filament with an exponential falloff, which is what a neon tube
 * actually does and what the bloom pass needs to work with.
 */
const RIM_FRAG = /* glsl */ `
  uniform float uTime, uEnergy, uBass, uHigh, uBreath, uRadius, uBreathe;
  varying vec2 vLocal;
  ${SIMPLEX}
  ${WHEEL}

  const float TAU = 6.28318530718;

  void main() {
    float r = length(vLocal);
    float angle = atan(vLocal.y, vLocal.x) / TAU + 0.5;

    // Never quite a circle. A slow low-frequency wobble on the radius keeps
    // it from reading as a vector shape, and the breath expands and contracts
    // the whole ring on a roughly six-second cycle.
    float wobble = snoise(vec3(cos(angle * TAU) * 0.9, sin(angle * TAU) * 0.9, uTime * 0.1));
    float radius = uRadius * (1.0 + uBreathe * 0.022 + uBreath * 0.4 + wobble * 0.010 + uBass * 0.04);

    // Wide enough to read as a tube full of light, but no wider. Measured
    // against the reference, only 13% of the rim annulus is brighter than
    // mid-grey; at 0.032 this band was blowing 37% of it to flat white, which
    // is what turned a violet neon ring into a glare.
    float d = (r - radius) / 0.036;
    float core = exp(-d * d);

    // A second, tighter line sitting just inside the core is what gives the
    // rim its layered look rather than a single soft stripe.
    float di = (r - radius * 0.978) / 0.013;
    float inner = exp(-di * di) * 0.75;

    // The wide dim gaussian is the light the rim throws into the space around
    // it. Bloom cannot produce this: it spreads what is already bright, it
    // does not add a falloff of its own.
    float halo = exp(-d * d * 0.02) * 0.30;

    // Two hot spots, half a turn apart, drifting at slightly different rates
    // so they never sit in a fixed relationship.
    float headA = fract(uTime * 0.055);
    float headB = fract(uTime * 0.041 + 0.5);
    float toA = abs(fract(angle - headA + 0.5) - 0.5);
    float toB = abs(fract(angle - headB + 0.5) - 0.5);
    // Tight. Broad heads are what spread the blowout around most of the
    // circumference instead of leaving two discrete bright points.
    float hot = exp(-toA * toA * 1100.0) + exp(-toB * toB * 1900.0) * 0.6;

    // Biased toward magenta, which is the rim's dominant colour; a full even
    // sweep spends too much of the circle in blue.
    vec3 tint = wheel(angle * 0.85 + 0.62 + uTime * 0.015);
    // Capped well below 1. The reference rim holds 0.8-0.9 saturation the
    // whole way round — it is a *coloured* tube with two white-hot points on
    // it, not a white tube with colour at the edges. Letting this reach 1
    // desaturates the hue sweep entirely and the sweep is the effect.
    tint = mix(tint, vec3(1.0), min(hot * 0.30 + core * core * 0.10 + inner * 0.12, 0.55));

    float intensity =
      ((core * 1.45 + inner) * (1.0 + hot * 0.6) + halo) * uEnergy * (0.85 + uHigh * 0.45);
    if (intensity < 0.004) discard;
    gl_FragColor = vec4(tint * intensity, intensity);
  }
`;

/** The faint violet wash inside the rim, fading to black at the centre. */
const DISC_FRAG = /* glsl */ `
  uniform float uEnergy, uBass, uRadius, uBreathe;
  varying vec2 vLocal;
  ${WHEEL}

  void main() {
    vec2 q = vLocal / uRadius;
    float r = length(q);
    if (r > 1.0) discard;

    // The interior is a lit violet dome, not an empty hole. Three parts:
    // a body that brightens toward the edge, a bright band just inside the
    // rim where the light pools, and a lift toward the top so the sphere
    // reads as lit from above rather than glowing uniformly.
    // Sampled from the reference: the interior averages #010211 out to about
    // 0.65 of the rim radius and only reaches violet (#5824ad) in the last
    // few percent. A fifth-power ramp matches that; anything gentler lights
    // the middle and the transcript stops being readable against it.
    float body = pow(r, 5.0) * 0.62;
    // A narrow pool right at the join. Widening it floods the interior.
    float pool = exp(-pow((1.0 - r) / 0.07, 2.0)) * 0.30;
    // Lit from above, but only gently. A strong gradient here crushes the
    // lower half to black and the dome stops looking like a volume.
    float lift = 0.86 + 0.14 * q.y;

    // Pulses on the same phase as the outer energy, so the whole assembly
    // breathes as one object instead of several things moving separately.
    float pulse = 0.86 + 0.14 * uBreathe;

    float alpha = (body + pool) * lift * pulse * uEnergy * (0.8 + uBass * 0.45);
    if (alpha < 0.004) discard;

    // Violet through the body, warming toward magenta as it approaches the
    // rim, which is what stops the fill reading as flat tinted plastic.
    vec3 tint = mix(wheel(0.02), wheel(0.86), smoothstep(0.45, 1.0, r));
    gl_FragColor = vec4(tint * alpha * 1.05, alpha);
  }
`;

/**
 * Outer haze — deliberately shapeless, and never allowed a hard edge.
 *
 * This layer is what stops the field dying at the last strand. In the
 * reference the frame is still visibly lit at its own edge (roughly a fifth
 * of the rim's brightness); with a quadratic falloff at a fifth of this
 * strength it went to black just outside the strands, and the whole piece
 * read as a small object on a large black page rather than as something
 * filling the view.
 *
 * It also runs on the *ribbon* palette, not the rim's. Sampled past the
 * strands the reference is blue through mint, 170-220 degrees — nowhere near
 * the rim's violet.
 */
const HAZE_FRAG = /* glsl */ `
  uniform float uTime, uEnergy, uBass, uInner, uOuter;
  varying vec2 vLocal;
  ${SIMPLEX}
  ${RIBBON_PALETTE}

  void main() {
    float r = length(vLocal);
    float t = (r - uInner) / (uOuter - uInner);
    if (t < 0.0 || t > 1.0) discard;

    float cloud = 0.5 + 0.5 * snoise(vec3(vLocal * 1.6, uTime * 0.06));
    // The exponent is the reach. Too gentle and the haze stops being a halo:
    // at 1.35 it still covered a third of the frame edge, more than the band
    // it is supposed to be falling away from, and the field lost its centre.
    float band = pow(1.0 - t, 1.55) * (0.35 + cloud * 0.65);
    float alpha = band * 0.50 * uEnergy * (0.8 + uBass * 0.6);
    if (alpha < 0.003) discard;

    // Cooling outward: azure close in, drifting onto the mint accent at the
    // limit, which is where the reference puts its green.
    vec3 tint = mix(ribbonColor(0.35), uRibAccent, smoothstep(0.45, 1.0, t) * 0.55);
    gl_FragColor = vec4(tint * alpha, alpha);
  }
`;

/**
 * Ribbons.
 *
 * Fixed tube geometry displaced on the GPU. Rebuilding TubeGeometry per frame
 * is the usual way this effect is written and the usual reason it stutters.
 * The displacement is sampled by position *along* the tube, not by world
 * position, so neighbouring segments stay coherent and the tube bends rather
 * than tearing.
 */
const RIBBON_VERT = /* glsl */ `
  uniform float uTime, uFlow, uTurbulence, uBass, uPhase, uAmp, uLobes;
  varying float vAlong, vEdge, vShade;

  const float TAU = 6.28318530718;

  void main() {
    vAlong = uv.x;
    vEdge = abs(uv.y - 0.5) * 2.0;

    float t = uTime * uFlow + uPhase;
    float a = vAlong * TAU;

    // The strand's *radius* ripples as a travelling wave, rather than the
    // strand being pushed around in 3D. This is the motion in the Rive
    // reference: harmonics of the angle with the phase moving over time, so
    // the bulges chase each other around the ring. Displacing in 3D instead
    // gives orbiting loops, which is a different — and much busier — effect.
    //
    // The lobe count varies per strand. With every strand sharing one set of
    // harmonics the whole weave lobes in step and the silhouette comes out as
    // a single clean rosette — which is exactly what it was doing, and why it
    // read as geometry rather than as light. Different counts let the outlines
    // disagree, and the outline is the shape you actually see.
    float wave =
      sin(a * uLobes         - t * 1.5 + uPhase) * 0.115 +
      sin(a * (uLobes + 2.0) + t * 1.0 - uPhase) * 0.028 +
      sin(a * 2.0            - t * 0.7)          * 0.048;

    // Outward from the ring's centre, in the strand's own plane.
    float baseR = length(position.xy);
    vec2 radial = position.xy / max(baseR, 1e-5);

    // Bounded to a fraction of the strand's own radius: in the busier states
    // uTurbulence is high enough that an unbounded offset would exceed the
    // radius, push the point through the centre and fold the tube.
    //
    // Turbulence is folded in with a floor rather than as a bare multiplier.
    // As a multiplier, idle (0.28) flattened the lobes almost completely and
    // the field only took its shape once it was busy — so the state it spends
    // most of its time in was the one that looked least like the reference.
    //
    // Saturated smoothly rather than clamped. A clamp is continuous but its
    // derivative is not, and on a thin bright filament that kink is plainly
    // visible as a corner. x / sqrt(1 + (x/k)^2) has the same bound k and is
    // smooth everywhere.
    // The 7.0 here used to push the displacement to roughly the strand's
    // whole radius, so the saturation below — meant only as a guard against
    // the tube folding through its own centre — was doing the shaping
    // instead of the wave. Two things went wrong with that: the lobes came out squared off
    // rather than sinusoidal, and every strand was thrown far enough outward
    // that the weave orbited the ring at 1.5-1.8x its radius instead of
    // hugging it. Measured against the reference the strands sit between
    // 1.05x and 1.4x the rim and are gone by 1.6x. Keep the peak well under
    // the bound and the bound goes back to being a guard.
    float raw = wave * uAmp * (0.62 + uTurbulence * 0.75) * 1.3;
    float k = baseR * 0.34;
    float offset = raw / sqrt(1.0 + (raw / k) * (raw / k));

    vec3 p = position;
    p.xy += radial * offset;
    // A little out-of-plane so crossings read as depth rather than as two
    // lines meeting on a flat surface.
    p.z += sin(a * 2.0 + t * 0.8 + uPhase) * 0.07;
    p *= 1.0 + uBass * 0.06;

    vShade = clamp(wave * 9.0 + 0.5, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RIBBON_FRAG = /* glsl */ `
  uniform float uEnergy, uHigh, uTime, uPhase, uOpacity, uBreathe, uTintBias, uSharpness, uBrightness, uAccent;
  varying float vAlong, vEdge, vShade;
  ${RIBBON_PALETTE}

  void main() {
    // The tube is a closed loop; fading the seam turns it into an arc, which
    // is what reads as a strand flowing past rather than a ring sitting there.
    float ends = smoothstep(0.0, 0.26, vAlong) * smoothstep(1.0, 0.74, vAlong);

    // Crucially, the *width* collapses toward the ends as well. Fading only
    // the brightness leaves a tube of full thickness stopping dead, and a
    // finite-thickness tube cut square across shows up as a hard right-angle
    // notch. Shrinking the width brings each strand to a point instead.
    float taper = pow(ends, 0.6);

    // A bright spine with a soft skirt, same as the rim. The falloff constant
    // travels along the strand, so it visibly thickens and thins as it flows.
    float width = uSharpness * (0.75 + 0.5 * (0.5 + 0.5 * sin((vAlong * 2.0 + uTime * 0.16 + uPhase) * 6.28318)));
    float across = exp(-vEdge * vEdge * width / max(taper, 0.06));

    // Two travelling waves at different rates, so brightness never repeats on
    // an obvious loop. The floor is high: Rive's strands are consistently lit
    // bands, not strands that fade in and out along their length.
    float travel =
      0.80 +
      0.14 * sin((vAlong * 1.7 - uTime * 0.22 + uPhase) * 6.28318) +
      0.06 * sin((vAlong * 4.1 + uTime * 0.13 - uPhase) * 6.28318);

    float alpha = across * travel * taper * uOpacity * uEnergy
      * (0.85 + uHigh * 0.5) * (0.9 + uBreathe * 0.1);
    if (alpha < 0.004) discard;

    // Same trick as the rim: blow the spine toward white, so the strand reads
    // as light rather than as flatly saturated rope.
    vec3 tint = ribbonColor(clamp(uTintBias + vShade * 0.18 - 0.09, 0.0, 1.0));
    tint = mix(tint, uRibAccent, uAccent);

    // Only the sharp filaments blow out toward white. Applying this to the
    // wide soft bands as well is what turned them into grey smoke — a broad
    // strand is bright across most of its width, so the whitening covers it.
    float bloomCore = across * across * 0.42 * smoothstep(1.6, 3.6, uSharpness);
    tint = mix(tint, vec3(1.0), bloomCore);

    gl_FragColor = vec4(tint * uBrightness * (1.0 + uHigh * 0.3), alpha);
  }
`;

/** Dotted trails and sparkles share a shader; only their geometry differs. */
const POINT_VERT = /* glsl */ `
  uniform float uTime, uSize, uEnergy, uHigh, uDpr, uCamera;
  attribute float aSeed;
  varying float vSeed;
  void main() {
    vSeed = aSeed;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.6 + 0.4 * sin(uTime * 2.2 + aSeed * 40.0);
    // gl_PointSize is in device pixels, so uSize is multiplied by the device
    // pixel ratio to mean the same thing on a retina display as anywhere else.
    // Without this the dots are twice the intended size on exactly the
    // machines this runs on.
    gl_PointSize = uSize * uDpr * twinkle * (1.0 + uHigh * 0.7) * (uCamera / -view.z);
    gl_Position = projectionMatrix * view;
  }
`;

const POINT_FRAG = /* glsl */ `
  uniform float uTime, uEnergy, uOpacity;
  uniform vec3 uTint;
  varying float vSeed;
  void main() {
    // Round, with a tight core — square points are the giveaway that this is
    // a particle system rather than light.
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = exp(-d * d * 6.0);
    // A high power on the sine means most particles sit dim most of the time
    // and each one flares briefly. An evenly oscillating blink reads as a
    // string of fairy lights; this reads as sparkle.
    float base = 0.35 + 0.2 * sin(uTime * 0.9 + vSeed * 17.0);
    float flare = pow(max(0.0, sin(uTime * 0.6 + vSeed * 31.0)), 24.0);
    float alpha = core * (base + flare * 1.4) * uOpacity * uEnergy;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uTint * 1.9, alpha);
  }
`;

const RIPPLE_VERT = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIPPLE_FRAG = /* glsl */ `
  uniform float uOpacity, uBand, uRadius;
  varying vec2 vLocal;
  ${WHEEL}
  void main() {
    float d = (length(vLocal) - uRadius) / 0.05;
    float ring = exp(-d * d);
    float alpha = ring * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(wheel(uBand) * alpha, alpha);
  }
`;

interface Ripple {
  mesh: THREE.Mesh;
  /**
   * Held directly rather than read back through `material.uniforms` each
   * frame: that map is indexed by string, so every access would need a null
   * check for a value we created ourselves.
   */
  opacity: THREE.IUniform<number>;
  band: THREE.IUniform<number>;
  /** Its own radius, not the rim's — this is what expands as it travels. */
  radius: THREE.IUniform<number>;
  /** 0 to 1; retired at 1. */
  life: number;
  active: boolean;
}

const RIM_RADIUS = 1.12;
/** One full breath. Slow enough to feel like respiration, not a pulse. */
const BREATH_SECONDS = 6;
const RIPPLE_POOL = 5;
const TRAIL_COUNT = 4;
const SPARKLE_COUNT = 90;

export function EnergyField({
  state,
  spectrum,
  /** Fires a one-shot confirmation flourish when it increments. */
  successPulse = 0,
}: {
  state: AssistantState;
  spectrum: Spectrum;
  successPulse?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Set when WebGL is unavailable, so a machine that cannot run this gets the
  // simpler visual rather than an empty rectangle. Worth the few lines: the
  // last visual that failed to start did so silently, and that cost hours.
  const [failed, setFailed] = useState(false);

  const stateRef = useRef(state);
  const spectrumRef = useRef(spectrum);
  const pulseRef = useRef(successPulse);
  stateRef.current = state;
  spectrumRef.current = spectrum;
  pulseRef.current = successPulse;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      console.error('[EnergyField] WebGL unavailable, falling back', error);
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Pure black, opaque. EffectComposer's final pass writes alpha 1 whatever
    // the clear alpha is, so this canvas is never transparent; it runs
    // full-bleed instead. Black is also the one value the composer's colour
    // conversion leaves alone — a dark navy clear came back out visibly grey.
    renderer.setClearColor(0x000000, 1);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 6.4);

    const disposables: { dispose: () => void }[] = [];
    const mood = MOODS.idle;

    const u = {
      uTime: { value: 0 },
      uFlow: { value: mood.flow },
      uTurbulence: { value: mood.turbulence },
      uBreath: { value: mood.breath },
      uEnergy: { value: mood.energy },
      uBass: { value: 0 },
      uLowMid: { value: 0 },
      uHigh: { value: 0 },
      uCool: { value: mood.cool.clone() },
      uMid: { value: mood.mid.clone() },
      uHot: { value: mood.hot.clone() },
      uRibCool: { value: mood.ribbonCool.clone() },
      uRibMid: { value: mood.ribbonMid.clone() },
      uRibHot: { value: mood.ribbonHot.clone() },
      uRibAccent: { value: mood.ribbonAccent.clone() },
      uRadius: { value: RIM_RADIUS },
      // One shared breath phase in [-1, 1] on a six-second cycle. Every layer
      // reads from this rather than running its own sine, which is what makes
      // the assembly feel like a single living object instead of a handful of
      // independently animated parts.
      uBreathe: { value: 0 },
    };

    const additive = (vertexShader: string, fragmentShader: string, uniforms: object) =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: uniforms as Record<string, THREE.IUniform>,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });

    /** Flat layers are quads, clipped to a circle in the shader. */
    const quad = (size: number, fragmentShader: string, uniforms: object, order: number) => {
      const geo = new THREE.PlaneGeometry(size, size, 1, 1);
      const mat = additive(PLANE_VERT, fragmentShader, uniforms);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = order;
      disposables.push(geo, mat);
      scene.add(mesh);
      return mesh;
    };

    // --- haze, disc, rim ----------------------------------------------------
    quad(6.4, HAZE_FRAG, { ...u, uInner: { value: 0.95 }, uOuter: { value: 2.6 } }, 0);
    quad(2.6, DISC_FRAG, u, 1);
    quad(3.2, RIM_FRAG, u, 4);

    // --- ribbons ------------------------------------------------------------
    // Two distinct kinds, because the reference has two. Sampling it, the
    // strands are overwhelmingly blue: deep navy (#0a32b0) is the single most
    // common colour by a wide margin, then azure, then cyan, with only a small
    // mint presence. And they are not all the same object — wide soft bands
    // sweep behind, while thin bright filaments cut across in front. One
    // uniform tube style cannot produce both.
    const STRANDS: {
      radius: number;
      tube: number;
      /** Falloff across the strand: low is a soft band, high is a filament. */
      sharpness: number;
      opacity: number;
      /** Position in the strand palette: 0 blue, 0.5 azure, 1 cyan. */
      tint: number;
      /** 1 pulls the strand onto the mint accent, off the blue ramp. */
      accent: number;
      brightness: number;
      amp: number;
      /** Primary harmonic — how many lobes this strand's outline has. */
      lobes: number;
    }[] = [
      // Wide soft veils, behind the bundle, giving it something to be seen
      // against.
      { radius: 1.22, tube: 0.058, sharpness: 1.0, opacity: 0.52, tint: 0.04, accent: 0, brightness: 1.5, amp: 1.05, lobes: 2.0 },
      { radius: 1.41, tube: 0.050, sharpness: 1.2, opacity: 0.46, tint: 0.16, accent: 0, brightness: 1.5, amp: 1.15, lobes: 3.0 },

      // The bright bundle. Held to a narrow span on purpose: measured across
      // the reference the light is not spread evenly outward, it peaks in one
      // annulus a little outside the rim — brighter there than at the rim
      // itself — and falls away past it. Spreading these across the frame
      // instead produced an even cage of strands with no focus anywhere.
      //
      // The innermost starts *below* the rim radius, so its lobes carry it
      // across the ring rather than around it. Every strand orbiting outside
      // the rim leaves a clean annular gap between ring and weave, and that
      // gap is the single clearest tell that this is a diagram of a reactor
      // rather than a photograph of one — the reference has strands passing
      // in front of the ring on both sides.
      { radius: 1.15, tube: 0.015, sharpness: 4.2, opacity: 1.0, tint: 0.26, accent: 0, brightness: 3.2, amp: 1.25, lobes: 2.0 },
      { radius: 1.26, tube: 0.014, sharpness: 4.6, opacity: 1.0, tint: 0.46, accent: 0, brightness: 3.5, amp: 1.35, lobes: 3.0 },
      { radius: 1.36, tube: 0.014, sharpness: 4.4, opacity: 1.0, tint: 0.68, accent: 0, brightness: 3.5, amp: 1.45, lobes: 2.0 },
      { radius: 1.48, tube: 0.013, sharpness: 4.8, opacity: 0.95, tint: 0.90, accent: 0, brightness: 3.2, amp: 1.55, lobes: 3.0 },

      // Mint. A minority colour, and on the outside of the bundle — which is
      // where the reference's green sits, never on the rim.
      { radius: 1.42, tube: 0.012, sharpness: 4.4, opacity: 0.9, tint: 1.0, accent: 1, brightness: 3.0, amp: 1.50, lobes: 3.0 },
      { radius: 1.56, tube: 0.011, sharpness: 5.0, opacity: 0.7, tint: 1.0, accent: 0.85, brightness: 2.7, amp: 1.60, lobes: 2.0 },
    ];

    const ribbons = STRANDS.map((spec, index) => {
      const phase = index / STRANDS.length;

      const points: THREE.Vector3[] = [];
      const SEGMENTS = 200;
      // `i < SEGMENTS`, not `<=`: a closed CatmullRomCurve3 joins the last
      // point to the first itself, so repeating the endpoint puts a kink in it.
      for (let i = 0; i < SEGMENTS; i += 1) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        const lean = Math.sin(a * 2 + phase * 6.28) * 0.05;
        points.push(new THREE.Vector3(Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, lean));
      }

      const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', 0.5);
      const geo = new THREE.TubeGeometry(curve, 340, spec.tube, 12, true);
      const mat = additive(RIBBON_VERT, RIBBON_FRAG, {
        ...u,
        uPhase: { value: phase * 6.283 },
        uAmp: { value: spec.amp },
        uLobes: { value: spec.lobes },
        uOpacity: { value: spec.opacity },
        uTintBias: { value: spec.tint },
        uSharpness: { value: spec.sharpness },
        uBrightness: { value: spec.brightness },
        uAccent: { value: spec.accent },
      });

      const mesh = new THREE.Mesh(geo, mat);
      // Soft bands sit behind the rim, filaments in front of it.
      mesh.renderOrder = spec.sharpness < 2 ? 2 : 5;
      // Nearly coplanar. The wave supplies the movement; tilting these into
      // 3D orbits turns the piece into a tangle of rings rather than a ring
      // that ripples.
      mesh.rotation.set(Math.sin(index * 1.3) * 0.09, Math.cos(index * 1.9) * 0.09, index * 1.26);
      disposables.push(geo, mat);
      scene.add(mesh);

      // Spin about the view axis only, and slowly.
      return { mesh, axis: new THREE.Vector3(0, 0, 1) };
    });

    /** Points layer, used for both the dotted trails and the sparkles. */
    const pointLayer = (
      positions: Float32Array,
      size: number,
      opacity: number,
      tint: THREE.Color,
      order: number,
    ) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const seeds = new Float32Array(positions.length / 3);
      for (let i = 0; i < seeds.length; i += 1) seeds[i] = (i * 0.6180339887) % 1;
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
      const mat = additive(POINT_VERT, POINT_FRAG, {
        ...u,
        uSize: { value: size },
        uDpr: { value: renderer.getPixelRatio() },
        uCamera: { value: camera.position.z },
        uOpacity: { value: opacity },
        uTint: { value: tint },
      });
      const points = new THREE.Points(geo, mat);
      points.renderOrder = order;
      disposables.push(geo, mat);
      scene.add(points);
      return points;
    };

    // --- dotted trails ------------------------------------------------------
    // Evenly spaced dots on tilted circles. The reference's dotted arcs are
    // what give the field a sense of scale; without them the ribbons have
    // nothing to be measured against.
    const trails = Array.from({ length: TRAIL_COUNT }, (_, index) => {
      const DOTS = 190;
      const radius = 1.24 + index * 0.11;
      // Lobed like the strands rather than round. Steeply tilted circles read
      // as scattered dust once they are projected — which is all these were
      // contributing. Tracing the same outline the strands take is what makes
      // them read as a dotted path *along* the weave.
      const lobes = 2 + (index % 2);
      const positions = new Float32Array(DOTS * 3);
      for (let i = 0; i < DOTS; i += 1) {
        const a = (i / DOTS) * Math.PI * 2;
        const r = radius * (1 + Math.sin(a * lobes + index * 1.7) * 0.11);
        positions[i * 3] = Math.cos(a) * r;
        positions[i * 3 + 1] = Math.sin(a) * r;
        positions[i * 3 + 2] = Math.sin(a * 2 + index) * 0.22;
      }
      const layer = pointLayer(positions, 2.6, 1.0, new THREE.Color('#bae6fd'), 7);
      layer.rotation.set(0, 0, index * 0.8);
      return layer;
    });

    // --- sparkles -----------------------------------------------------------
    const sparklePositions = new Float32Array(SPARKLE_COUNT * 3);
    for (let i = 0; i < SPARKLE_COUNT; i += 1) {
      // Golden-angle spiral: even coverage without clumping, and no RNG, so
      // the layout is identical on every reload.
      const a = i * 2.39996;
      const radius = 1.15 + Math.sqrt(i / SPARKLE_COUNT) * 0.95;
      sparklePositions[i * 3] = Math.cos(a) * radius;
      sparklePositions[i * 3 + 1] = Math.sin(a) * radius;
      sparklePositions[i * 3 + 2] = Math.sin(a * 3) * 0.5;
    }
    const sparkles = pointLayer(sparklePositions, 3.0, 0.95, new THREE.Color('#e0f2fe'), 5);

    // --- ripples ------------------------------------------------------------
    // Pooled rather than allocated on demand: building geometry inside the
    // animation loop hitches exactly when the field should look most alive.
    const rippleGeo = new THREE.PlaneGeometry(5.2, 5.2, 1, 1);
    disposables.push(rippleGeo);
    const ripples: Ripple[] = Array.from({ length: RIPPLE_POOL }, () => {
      const opacity: THREE.IUniform<number> = { value: 0 };
      const band: THREE.IUniform<number> = { value: 0.7 };
      const radius: THREE.IUniform<number> = { value: RIM_RADIUS };
      const material = additive(RIPPLE_VERT, RIPPLE_FRAG, {
        ...u,
        uOpacity: opacity,
        uBand: band,
        uRadius: radius,
      });
      const mesh = new THREE.Mesh(rippleGeo, material);
      mesh.visible = false;
      mesh.renderOrder = 6;
      disposables.push(material);
      scene.add(mesh);
      return { mesh, opacity, band, radius, life: 0, active: false };
    });

    const fireRipple = (band: number) => {
      const free = ripples.find((r) => !r.active);
      if (!free) return;
      free.active = true;
      free.life = 0;
      free.mesh.visible = true;
      free.band.value = band;
      free.radius.value = RIM_RADIUS;
    };

    // --- composer -----------------------------------------------------------
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // Threshold well above zero and a tight radius: a low threshold blooms the
    // haze as readily as the rim, which is precisely how this turns to fog.
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), mood.bloom, 0.42, 0.3);
    composer.addPass(bloom);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloom.resolution.set(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let frame = 0;
    let lastPulse = pulseRef.current;
    let pulseAge = Infinity;
    let sinceRipple = 0;
    let prevLevel = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const delta = Math.min(clock.getDelta(), 0.05);
      const target = MOODS[stateRef.current];
      const s = spectrumRef.current;

      u.uTime.value += delta;
      u.uBreathe.value = Math.sin((u.uTime.value / BREATH_SECONDS) * Math.PI * 2);

      // Every field parameter eases toward the mood; nothing snaps.
      u.uFlow.value = ease(u.uFlow.value, target.flow, 0.02, delta);
      u.uTurbulence.value = ease(u.uTurbulence.value, target.turbulence, 0.02, delta);
      u.uBreath.value = ease(u.uBreath.value, target.breath, 0.05, delta);
      easeColor(u.uCool.value, target.cool, 0.03, delta);
      easeColor(u.uMid.value, target.mid, 0.03, delta);
      easeColor(u.uHot.value, target.hot, 0.03, delta);
      easeColor(u.uRibCool.value, target.ribbonCool, 0.03, delta);
      easeColor(u.uRibMid.value, target.ribbonMid, 0.03, delta);
      easeColor(u.uRibHot.value, target.ribbonHot, 0.03, delta);
      easeColor(u.uRibAccent.value, target.ribbonAccent, 0.03, delta);

      // Audio bands follow closely — lag here reads as unresponsiveness.
      u.uBass.value = ease(u.uBass.value, s.bass, 0.0008, delta);
      u.uLowMid.value = ease(u.uLowMid.value, s.lowMid, 0.0008, delta);
      u.uHigh.value = ease(u.uHigh.value, s.high, 0.0006, delta);

      // One-shot success flourish: a quick overshoot that settles.
      if (pulseRef.current !== lastPulse) {
        lastPulse = pulseRef.current;
        pulseAge = 0;
        fireRipple(0.95);
      }
      let flourish = 0;
      if (pulseAge < 1) {
        pulseAge = Math.min(1, pulseAge + delta / 0.85);
        flourish = (1 - easeOutCubic(pulseAge)) * 0.7;
      }

      u.uEnergy.value = ease(u.uEnergy.value, target.energy + flourish, 0.02, delta);
      bloom.strength = ease(bloom.strength, target.bloom + flourish * 0.8, 0.03, delta);

      // Ripples fire on speech onsets rather than on a timer, so they track
      // syllables instead of ticking along beside them.
      sinceRipple += delta;
      const onset = s.level - prevLevel;
      prevLevel = s.level;
      if (onset > 0.075 && sinceRipple > 0.22 && s.level > 0.16) {
        sinceRipple = 0;
        fireRipple(0.35 + s.high * 0.5);
      }

      for (const ripple of ripples) {
        if (!ripple.active) continue;
        ripple.life = Math.min(1, ripple.life + delta / 1.4);
        const eased = easeOutCubic(ripple.life);
        ripple.radius.value = RIM_RADIUS + eased * 0.9;
        ripple.opacity.value = (1 - ripple.life) * 0.5 * u.uEnergy.value;
        if (ripple.life >= 1) {
          ripple.active = false;
          ripple.mesh.visible = false;
        }
      }

      const spin = target.spin;

      // Ribbons orbit on their own axes at slightly different rates, which is
      // what makes the weave look continuous rather than looping.
      ribbons.forEach((ribbon, index) => {
        ribbon.mesh.rotateOnAxis(ribbon.axis, delta * spin * (0.4 + index * 0.11));
      });

      // Trails counter-rotate against the ribbons so the two layers separate.
      trails.forEach((trail, index) => {
        trail.rotation.z -= delta * spin * (0.3 + index * 0.12);
        // Shallow. The lobed outline is the point of these now, and a steep
        // tilt foreshortens it back into the ellipse it used to be.
        trail.rotation.x = ease(trail.rotation.x, target.tilt * (0.3 + index * 0.12), 0.06, delta);
      });

      sparkles.rotation.z += delta * spin * 0.15;

      // Scale eases with the flourish so success gives a physical bump.
      const scale = 1 + flourish * 0.05 * easeOutBack(Math.min(1, pulseAge + 0.001));
      scene.scale.setScalar(ease(scene.scale.x, scale, 0.02, delta));

      composer.render();
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const resource of disposables) resource.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  if (failed) return <Orb state={state} spectrum={spectrum} />;

  return <div ref={mountRef} className="size-full" />;
}
