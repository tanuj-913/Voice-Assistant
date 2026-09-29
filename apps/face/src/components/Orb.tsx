import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AssistantState } from '@assistant/schemas';
import type { Spectrum } from '../lib/audio.js';

/**
 * The sphere.
 *
 * Particles fill the volume rather than sitting on a shell. That single
 * decision is what produces depth: a surface of points reads as a ball, while
 * points distributed through the interior read as something you can see into.
 *
 * Motion comes from curl noise — a divergence-free field, so particles swirl
 * around each other instead of piling into clumps and leaving holes, which is
 * what ordinary noise does to a point cloud. Colour is mapped along the flow
 * so the neon gradient moves through the body rather than being painted on.
 */

interface StateVisual {
  /** Three stops sampled across the gradient. */
  cool: THREE.Color;
  mid: THREE.Color;
  hot: THREE.Color;
  flow: number;
  turbulence: number;
}

const VISUALS: Record<AssistantState, StateVisual> = {
  idle: {
    cool: new THREE.Color('#0ea5e9'),
    mid: new THREE.Color('#6366f1'),
    hot: new THREE.Color('#a855f7'),
    flow: 0.16,
    turbulence: 0.5,
  },
  listening: {
    cool: new THREE.Color('#22d3ee'),
    mid: new THREE.Color('#818cf8'),
    hot: new THREE.Color('#e879f9'),
    flow: 0.42,
    turbulence: 0.8,
  },
  transcribing: {
    cool: new THREE.Color('#2dd4bf'),
    mid: new THREE.Color('#38bdf8'),
    hot: new THREE.Color('#a78bfa'),
    flow: 0.55,
    turbulence: 0.9,
  },
  thinking: {
    cool: new THREE.Color('#6366f1'),
    mid: new THREE.Color('#a855f7'),
    hot: new THREE.Color('#f472b6'),
    flow: 1.05,
    turbulence: 1.35,
  },
  acting: {
    cool: new THREE.Color('#f59e0b'),
    mid: new THREE.Color('#fb7185'),
    hot: new THREE.Color('#e879f9'),
    flow: 0.85,
    turbulence: 1.1,
  },
  speaking: {
    cool: new THREE.Color('#facc15'),
    mid: new THREE.Color('#fb923c'),
    hot: new THREE.Color('#f472b6'),
    flow: 0.7,
    turbulence: 1.0,
  },
  awaiting_approval: {
    cool: new THREE.Color('#f59e0b'),
    mid: new THREE.Color('#fbbf24'),
    hot: new THREE.Color('#fde68a'),
    flow: 0.25,
    turbulence: 0.4,
  },
  success: {
    cool: new THREE.Color('#10b981'),
    mid: new THREE.Color('#34d399'),
    hot: new THREE.Color('#a7f3d0'),
    flow: 0.4,
    turbulence: 0.5,
  },
  failure: {
    cool: new THREE.Color('#f43f5e'),
    mid: new THREE.Color('#e11d48'),
    hot: new THREE.Color('#fb7185'),
    flow: 1.3,
    turbulence: 1.5,
  },
};

const NOISE = /* glsl */ `
  vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
  vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  /**
   * Curl of a noise field. Divergence-free, so the flow swirls rather than
   * converging — plain noise pulls every particle toward the same attractors
   * and tears visible holes in the cloud.
   */
  vec3 curlNoise(vec3 p) {
    const float e = 0.08;
    vec3 dx = vec3(e, 0.0, 0.0);
    vec3 dy = vec3(0.0, e, 0.0);
    vec3 dz = vec3(0.0, 0.0, e);

    float x = snoise(p + dy).z - snoise(p - dy).z - snoise(p + dz).y + snoise(p - dz).y;
    float y = snoise(p + dz).x - snoise(p - dz).x - snoise(p + dx).z + snoise(p - dx).z;
    float z = snoise(p + dx).y - snoise(p - dx).y - snoise(p + dy).x + snoise(p - dy).x;
    return normalize(vec3(x, y, z) + 1e-5);
  }
`;

const VERT = /* glsl */ `
  uniform float uTime, uFlow, uTurbulence, uSize, uBass, uLowMid, uHigh;
  attribute float aSeed;
  varying float vDepth, vBand, vAlpha;
  ${NOISE}

  void main() {
    vec3 p = position;
    float t = uTime * uFlow;

    // Displace along the curl field: the particle drifts through the volume
    // on a path that curves around its neighbours.
    vec3 flow = curlNoise(p * 0.85 + vec3(0.0, 0.0, t));
    float amount = uTurbulence * (0.16 + uLowMid * 0.4) * (0.55 + aSeed * 0.9);
    vec3 displaced = p + flow * amount;

    // Bass inflates the whole body; high frequencies scatter the fine grains.
    displaced *= 1.0 + uBass * 0.22;
    displaced += flow * uHigh * 0.1;

    vec4 mv = modelViewMatrix * vec4(displaced, 1.0);

    // Colour follows the flow rather than the fixed position, so the gradient
    // moves through the sphere instead of being painted onto it.
    vBand = clamp(flow.y * 0.5 + 0.5 + length(displaced) * 0.22, 0.0, 1.0);
    vDepth = clamp((mv.z + 3.2) / 5.0, 0.0, 1.0);

    // Interior grains are dimmer, which is what gives the volume its depth.
    float radial = length(position);
    vAlpha = (0.18 + aSeed * 0.5) * mix(0.35, 1.0, radial) * (0.7 + uHigh * 0.7);

    gl_PointSize = uSize * (0.4 + aSeed) * (1.0 + uBass * 0.5) * (150.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uCool, uMid, uHot;
  varying float vDepth, vBand, vAlpha;

  void main() {
    // Round, soft grains. Square points read as dead pixels.
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, d);

    // Three-stop gradient across the flow band.
    vec3 color = vBand < 0.5
      ? mix(uCool, uMid, vBand * 2.0)
      : mix(uMid, uHot, (vBand - 0.5) * 2.0);

    // Nearer grains burn brighter, which separates front from back.
    float lift = mix(0.55, 1.35, vDepth);
    gl_FragColor = vec4(color * lift, vAlpha * soft);
  }
`;

const SHELL_VERT = /* glsl */ `
  varying vec3 vNormal, vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

/** The glass boundary: visible only at the silhouette, like a bubble. */
const SHELL_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal, vView;
  void main() {
    float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 3.0);
    gl_FragColor = vec4(uColor, fresnel * uOpacity);
  }
`;

const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float core = pow(max(0.0, 1.0 - d), 3.0);
    float wide = pow(max(0.0, 1.0 - d), 1.2) * 0.4;
    gl_FragColor = vec4(uColor, (core + wide) * uIntensity * 0.5);
  }
`;

export function Orb({ state, spectrum }: { state: AssistantState; spectrum: Spectrum }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const spectrumRef = useRef(spectrum);
  stateRef.current = state;
  spectrumRef.current = spectrum;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4.6);

    const disposables: { dispose: () => void }[] = [];

    const shared = {
      uTime: { value: 0 },
      uFlow: { value: VISUALS.idle.flow },
      uTurbulence: { value: VISUALS.idle.turbulence },
      uSize: { value: 2.4 },
      uBass: { value: 0 },
      uLowMid: { value: 0 },
      uHigh: { value: 0 },
      uCool: { value: VISUALS.idle.cool.clone() },
      uMid: { value: VISUALS.idle.mid.clone() },
      uHot: { value: VISUALS.idle.hot.clone() },
    };

    // --- glow ---------------------------------------------------------------
    const glowUniforms = { uColor: shared.uMid, uIntensity: { value: 0.5 } };
    const glowGeo = new THREE.PlaneGeometry(8, 8);
    const glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: glowUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.z = -1.4;
    glow.renderOrder = -2;
    disposables.push(glowGeo, glowMat);
    scene.add(glow);

    // --- volumetric particles ----------------------------------------------
    const COUNT = 14_000;
    const positions = new Float32Array(COUNT * 3);
    const seeds = new Float32Array(COUNT);

    for (let i = 0; i < COUNT; i += 1) {
      // Uniform through the volume, not on the surface. Cube-rooting the
      // radius counteracts the fact that outer shells hold more space, which
      // otherwise leaves the centre empty.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = Math.cbrt(Math.random()) * 1.25;
      const planar = Math.sqrt(1 - u * u);

      positions[i * 3] = planar * Math.cos(theta) * r;
      positions[i * 3 + 1] = planar * Math.sin(theta) * r;
      positions[i * 3 + 2] = u * r;
      seeds[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: shared,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cloud = new THREE.Points(geo, mat);
    disposables.push(geo, mat);
    scene.add(cloud);

    // --- glass boundary -----------------------------------------------------
    const shellUniforms = { uColor: shared.uHot, uOpacity: { value: 0.16 } };
    const shellGeo = new THREE.SphereGeometry(1.42, 64, 64);
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      uniforms: shellUniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    });
    const shell = new THREE.Mesh(shellGeo, shellMat);
    disposables.push(shellGeo, shellMat);
    scene.add(shell);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const clock = new THREE.Clock();
    let frame = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const delta = Math.min(clock.getDelta(), 0.1);
      const target = VISUALS[stateRef.current];
      const s = spectrumRef.current;

      shared.uTime.value += delta;

      const ease = 1 - Math.pow(0.0015, delta);
      const lerp = (c: number, t: number) => c + (t - c) * ease;
      shared.uFlow.value = lerp(shared.uFlow.value, target.flow);
      shared.uTurbulence.value = lerp(shared.uTurbulence.value, target.turbulence);
      shared.uCool.value.lerp(target.cool, ease);
      shared.uMid.value.lerp(target.mid, ease);
      shared.uHot.value.lerp(target.hot, ease);

      const follow = 1 - Math.pow(0.02, delta);
      shared.uBass.value += (s.bass - shared.uBass.value) * follow;
      shared.uLowMid.value += (s.lowMid - shared.uLowMid.value) * follow;
      shared.uHigh.value += (s.high - shared.uHigh.value) * follow;

      glowUniforms.uIntensity.value = lerp(glowUniforms.uIntensity.value, 0.35 + s.level * 0.8);
      shellUniforms.uOpacity.value = lerp(shellUniforms.uOpacity.value, 0.12 + s.level * 0.22);

      cloud.rotation.y += delta * 0.055;
      shell.rotation.y = cloud.rotation.y;

      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const resource of disposables) resource.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={mountRef} className="size-full overflow-hidden" />;
}
