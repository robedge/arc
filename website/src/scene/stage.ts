import * as THREE from 'three';
import { bump, clamp, damp, easeInOutCubic, easeOutCubic, lerp, range, smoothstep } from './math';
import type { Stage, StageInput, StageOptions } from './types';

/*
 * The Arc stage: one fixed WebGL canvas behind the page.
 *
 * Everything is procedural (no downloaded models or textures). A single
 * "timeline" value derived from scroll position picks the camera framing, and
 * "story" (0..1) scrubs the brain -> workers -> worktrees -> merge sequence.
 * Because every state is a pure function of scroll, scrolling back up plays
 * the sequence in reverse, the same way scroll-scrubbed scenes on igloo.inc do.
 */

const CYAN = new THREE.Color('#38e1ff');
const AMBER = new THREE.Color('#ffb547');
const GREEN = new THREE.Color('#4be08a');
const RED = new THREE.Color('#ff5c6c');
const WHITE = new THREE.Color('#e8fbff');

const TRUNK_Y = -4;
const TRUNK_START = -4.6;
const TRUNK_END = 4.6;

interface WorkerDef {
  id: string;
  role: string;
  provider: string;
  pos: THREE.Vector3;
  fork: number;
  merge: number;
  spawnAt: number;
  worktreeAt: number;
  mergeAt: number;
  conflict?: boolean;
}

// Mirrors the user journey in the product definition: an API worker and a
// Codex infra reviewer, then a web worker that picks up the API change.
const WORKERS: WorkerDef[] = [
  { id: 'W1', role: 'api', provider: 'claude', pos: new THREE.Vector3(-3.1, -1.25, 0), fork: -4.1, merge: 1.2, spawnAt: 0.21, worktreeAt: 0.41, mergeAt: 0.66 },
  { id: 'W2', role: 'infra', provider: 'codex', pos: new THREE.Vector3(0, -1.55, 0.7), fork: -3.3, merge: 0, spawnAt: 0.25, worktreeAt: 0.45, mergeAt: 0.6 },
  { id: 'W3', role: 'web', provider: 'claude', pos: new THREE.Vector3(3.1, -1.25, 0), fork: -2.5, merge: 3.2, spawnAt: 0.29, worktreeAt: 0.49, mergeAt: 0.82, conflict: true },
];

// Camera keyframes along the timeline.
interface Frame {
  t: number;
  pos: THREE.Vector3;
  look: THREE.Vector3;
  frameX: number;
  opacity: number;
}
const FRAMES: Frame[] = [
  { t: 0, pos: new THREE.Vector3(0, 0.15, 5.6), look: new THREE.Vector3(0, 0, 0), frameX: 0.72, opacity: 1 },
  { t: 1, pos: new THREE.Vector3(1.6, 1.4, 7.2), look: new THREE.Vector3(0, 0, 0), frameX: 0.7, opacity: 0.6 },
  { t: 2, pos: new THREE.Vector3(0, -0.9, 14.5), look: new THREE.Vector3(0, -1.5, 0), frameX: 0.63, opacity: 1 },
  { t: 3, pos: new THREE.Vector3(0.8, -0.7, 14), look: new THREE.Vector3(0, -1.5, 0), frameX: 0.63, opacity: 1 },
  { t: 3.5, pos: new THREE.Vector3(-2, 0.2, 12.5), look: new THREE.Vector3(0, -1.2, 0), frameX: 0.74, opacity: 0.4 },
  { t: 4, pos: new THREE.Vector3(0, 0.1, 6.5), look: new THREE.Vector3(0, 0, 0), frameX: 0.5, opacity: 0.75 },
];

function sampleFrames(t: number, out: Frame): Frame {
  const last = FRAMES[FRAMES.length - 1];
  if (t <= FRAMES[0].t) return copyFrame(FRAMES[0], out);
  if (t >= last.t) return copyFrame(last, out);
  for (let i = 0; i < FRAMES.length - 1; i++) {
    const a = FRAMES[i];
    const b = FRAMES[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = easeInOutCubic((t - a.t) / (b.t - a.t));
      out.pos.lerpVectors(a.pos, b.pos, k);
      out.look.lerpVectors(a.look, b.look, k);
      out.frameX = lerp(a.frameX, b.frameX, k);
      out.opacity = lerp(a.opacity, b.opacity, k);
      return out;
    }
  }
  return out;
}

function copyFrame(src: Frame, out: Frame): Frame {
  out.pos.copy(src.pos);
  out.look.copy(src.look);
  out.frameX = src.frameX;
  out.opacity = src.opacity;
  return out;
}

function glowTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const basic = (color: THREE.Color, opacity = 1): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

const lineMat = (color: THREE.Color, opacity = 1): THREE.LineBasicMaterial =>
  new THREE.LineBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

interface Quality {
  /** Upper bound for the renderer pixel ratio. */
  maxDpr: number;
  particles: number;
  /** Multiplier for curve and mesh segment counts. */
  detail: number;
}

/**
 * Phones and small tablets (touch-first, small screen) and very modest
 * hardware get fewer particles, coarser geometry and a lower pixel ratio cap.
 * The renderer also steps its pixel ratio down at runtime if frames run long.
 */
function pickQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const minSide = Math.min(window.screen.width, window.screen.height);
  const cores = navigator.hardwareConcurrency || 8;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const low = (coarse && minSide < 900) || cores <= 2 || memory <= 2;
  return low ? { maxDpr: 1.5, particles: 600, detail: 0.5 } : { maxDpr: 1.75, particles: 1400, detail: 1 };
}

/** A tube along a curve that can be drawn progressively from its start. */
class Trace {
  readonly mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  private readonly stride: number;
  private readonly segments: number;

  constructor(
    readonly curve: THREE.Curve<THREE.Vector3>,
    radius: number,
    color: THREE.Color,
    opacity = 1,
    segments = 96,
  ) {
    const radial = segments < 64 ? 5 : 6;
    this.segments = segments;
    this.stride = radial * 6;
    this.mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, radial, false), basic(color, opacity));
    this.draw(0);
  }

  draw(fraction: number): void {
    const n = Math.round(clamp(fraction) * this.segments);
    this.mesh.geometry.setDrawRange(0, n * this.stride);
    this.mesh.visible = n > 0;
  }
}

function circlePoints(radius: number, count: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return pts;
}

interface Label {
  el: HTMLElement;
  anchor: THREE.Object3D;
  alpha: number;
  dx: number;
  dy: number;
  /** Rendered width in px, measured lazily; 0 means unknown. */
  w: number;
  flipped: boolean;
  /** Centered under the anchor instead of beside it (worker nodes on small screens). */
  below: boolean;
}

interface WorkerRig {
  def: WorkerDef;
  node: THREE.Group;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Sprite;
  ghost: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  link: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  worktree: Trace;
  mergeTrace: Trace;
  mergePulse: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  commit: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  label: Label;
}

export function createStage({ canvas, labels, reducedMotion }: StageOptions): Stage {
  const quality = pickQuality();
  const seg = (n: number): number => Math.max(8, Math.round(n * quality.detail));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  let dpr = Math.min(window.devicePixelRatio || 1, quality.maxDpr);
  renderer.setPixelRatio(dpr);

  const FOG = 0.028;
  const fog = new THREE.FogExp2(0x03080f, FOG);
  const scene = new THREE.Scene();
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);

  const glow = glowTexture();
  const disposables: { dispose(): void }[] = [glow];
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const makeHalo = (color: THREE.Color, scale: number, opacity: number): THREE.Sprite => {
    const s = new THREE.Sprite(
      track(
        new THREE.SpriteMaterial({
          map: glow,
          color: color.clone(),
          transparent: true,
          opacity,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
    s.scale.setScalar(scale);
    return s;
  };

  // ---------- Particle field with an intro "materialize" ----------
  const PARTICLES = quality.particles;
  const pPos = new Float32Array(PARTICLES * 3);
  const pStart = new Float32Array(PARTICLES * 3);
  const pSeed = new Float32Array(PARTICLES);
  for (let i = 0; i < PARTICLES; i++) {
    const r = 6 + Math.pow(Math.random(), 0.6) * 22;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pPos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
    pPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 6;
    // Particles start collapsed into the brain and stream outward.
    const k = Math.random() * 0.25;
    pStart[i * 3] = pPos[i * 3] * k;
    pStart[i * 3 + 1] = pPos[i * 3 + 1] * k;
    pStart[i * 3 + 2] = pPos[i * 3 + 2] * k;
    pSeed[i] = Math.random();
  }
  const pGeo = track(new THREE.BufferGeometry());
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('aStart', new THREE.BufferAttribute(pStart, 3));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
  const pMat = track(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uIntro: { value: reducedMotion ? 1 : 0 },
        uTime: { value: 0 },
        uSize: { value: 2.6 },
        uPixelRatio: { value: renderer.getPixelRatio() },
        uColor: { value: CYAN.clone() },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aStart;
        attribute float aSeed;
        uniform float uIntro;
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          float t = smoothstep(0.0, 1.0, clamp(uIntro * 1.5 - aSeed * 0.5, 0.0, 1.0));
          vec3 p = mix(aStart, position, t);
          p += vec3(
            sin(uTime * 0.3 + aSeed * 20.0),
            cos(uTime * 0.25 + aSeed * 13.0),
            sin(uTime * 0.2 + aSeed * 7.0)
          ) * 0.12;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (0.5 + aSeed) * (10.0 / -mv.z);
          vAlpha = t * (0.25 + 0.75 * fract(aSeed * 7.13));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(uColor, a * vAlpha * 0.8);
        }
      `,
    }),
  );
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  // ---------- Floor grid ----------
  const grid = new THREE.GridHelper(80, 80, CYAN, CYAN);
  const gridMat = grid.material as THREE.LineBasicMaterial;
  gridMat.transparent = true;
  gridMat.opacity = 0.09;
  gridMat.depthWrite = false;
  grid.position.y = -5.6;
  scene.add(grid);
  track(grid.geometry);
  track(gridMat);

  // ---------- Brain: the Arc ring ----------
  const brain = new THREE.Group();
  scene.add(brain);
  const brainSpin = new THREE.Group();
  brain.add(brainSpin);

  const arcMat = track(basic(CYAN, 1));
  const outer = new THREE.Mesh(track(new THREE.TorusGeometry(1, 0.06, seg(12), seg(140), Math.PI * 2 * 0.8)), arcMat);
  brainSpin.add(outer);
  const innerMat = track(basic(CYAN, 0.75));
  const inner = new THREE.Mesh(track(new THREE.TorusGeometry(0.58, 0.028, seg(8), seg(100))), innerMat);
  brain.add(inner);
  const coreMat = track(basic(WHITE, 1));
  const core = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, seg(24), seg(16))), coreMat);
  brain.add(core);
  const brainHalo = makeHalo(CYAN, 3.6, 0.5);
  brain.add(brainHalo);

  // Tick ring
  const tickPts: number[] = [];
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2;
    const r0 = 1.32;
    const r1 = i % 6 === 0 ? 1.5 : 1.4;
    tickPts.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0);
  }
  const tickGeo = track(new THREE.BufferGeometry());
  tickGeo.setAttribute('position', new THREE.Float32BufferAttribute(tickPts, 3));
  const ticks = new THREE.LineSegments(tickGeo, track(lineMat(CYAN, 0.45)));
  brain.add(ticks);

  // Orbit rings
  const orbits: THREE.LineLoop[] = [];
  [1.85, 2.4].forEach((r, i) => {
    const g = track(new THREE.BufferGeometry().setFromPoints(circlePoints(r, seg(160))));
    const loop = new THREE.LineLoop(g, track(lineMat(CYAN, 0.18)));
    loop.rotation.x = i === 0 ? 1.15 : 1.35;
    loop.rotation.y = i === 0 ? 0.3 : -0.45;
    brain.add(loop);
    orbits.push(loop);
  });

  // Ping ring (scan in plan phase, alert in attention phase)
  const pingMat = track(basic(CYAN, 0));
  const ping = new THREE.Mesh(track(new THREE.TorusGeometry(1, 0.012, 6, seg(120))), pingMat);
  brain.add(ping);

  // ---------- Knowledge satellites (groups section) ----------
  const SECTIONS = ['PROJECTS', 'NOTES', 'DOCS', 'PLAYBOOKS', 'LINKS'];
  const satGeo = track(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.17)));
  const satellites = SECTIONS.map(() => {
    const s = new THREE.Group();
    const wire = new THREE.LineSegments(satGeo, track(lineMat(CYAN, 0)));
    const dot = makeHalo(CYAN, 0.5, 0);
    s.add(wire, dot);
    brain.add(s);
    return { group: s, wire, dot };
  });

  // Everything in the brain -> workers -> merge diagram; collapses into the brain at the end.
  const graph = new THREE.Group();
  scene.add(graph);

  // ---------- Session branch (trunk) ----------
  const trunkCurve = new THREE.LineCurve3(new THREE.Vector3(TRUNK_START, TRUNK_Y, 0), new THREE.Vector3(TRUNK_END, TRUNK_Y, 0));
  const trunkBase = new Trace(trunkCurve, 0.022, CYAN, 0.35, seg(120));
  const trunkLit = new Trace(trunkCurve, 0.045, CYAN, 1, seg(120));
  graph.add(trunkBase.mesh, trunkLit.mesh);
  track(trunkBase.mesh.geometry);
  track(trunkBase.mesh.material);
  track(trunkLit.mesh.geometry);
  track(trunkLit.mesh.material);
  const trunkHead = makeHalo(CYAN, 0.9, 0);
  graph.add(trunkHead);
  const trunkAnchor = new THREE.Object3D();
  trunkAnchor.position.set(TRUNK_START, TRUNK_Y, 0);
  graph.add(trunkAnchor);

  // ---------- Labels (DOM, projected each frame) ----------
  const labelList: Label[] = [];
  const addLabel = (anchor: THREE.Object3D, title: string, sub: string, dx = 18, dy = -10): Label => {
    const el = document.createElement('div');
    el.className = 'stage-label';
    const b = document.createElement('b');
    b.textContent = title;
    el.append(b, document.createTextNode(sub));
    labels.append(el);
    const l: Label = { el, anchor, alpha: 0, dx, dy, w: 0, flipped: false, below: false };
    labelList.push(l);
    return l;
  };

  const brainLabel = addLabel(brain, 'BRAIN', 'plans // merges', 0, 0);
  const brainLabelAnchor = new THREE.Object3D();
  brainLabelAnchor.position.set(1.15, 0.95, 0);
  brain.add(brainLabelAnchor);
  brainLabel.anchor = brainLabelAnchor;

  const satLabels = satellites.map((s, i) => addLabel(s.group, SECTIONS[i], 'knowledge', 12, -8));
  const trunkLabel = addLabel(trunkAnchor, 'SESSION BRANCH', 'arc/orders-timeout  <-  dev', 0, 14);

  // ---------- Workers ----------
  const workers: WorkerRig[] = WORKERS.map((def) => {
    const node = new THREE.Group();
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.34, 0.03, 8, seg(64))), track(basic(CYAN, 1)));
    const core = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, seg(16), seg(12))), track(basic(WHITE, 1)));
    const halo = makeHalo(CYAN, 1.6, 0.4);
    node.add(ring, core, halo);
    graph.add(node);

    const ghostGeo = track(new THREE.BufferGeometry().setFromPoints(circlePoints(0.34, seg(48))));
    const ghost = new THREE.LineLoop(ghostGeo, track(lineMat(CYAN, 0)));
    ghost.position.copy(def.pos);
    graph.add(ghost);

    const linkGeo = track(new THREE.BufferGeometry());
    linkGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const link = new THREE.Line(linkGeo, track(lineMat(CYAN, 0)));
    graph.add(link);

    const base = def.pos.clone().add(new THREE.Vector3(0, -0.36, 0));
    const wtCurve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(def.fork, TRUNK_Y, 0),
      new THREE.Vector3(def.fork + 0.2, TRUNK_Y + 1.5, 0.3),
      new THREE.Vector3(base.x - 0.6, base.y - 1.2, base.z),
      base,
    );
    const worktree = new Trace(wtCurve, 0.02, CYAN, 0.8, seg(96));
    const mCurve = new THREE.CubicBezierCurve3(
      base,
      new THREE.Vector3(base.x + 0.7, base.y - 0.9, base.z),
      new THREE.Vector3(def.merge - 0.3, TRUNK_Y + 1.3, 0.2),
      new THREE.Vector3(def.merge, TRUNK_Y, 0),
    );
    const mergeTrace = new Trace(mCurve, 0.024, GREEN, 0.9, seg(96));
    graph.add(worktree.mesh, mergeTrace.mesh);
    [worktree, mergeTrace].forEach((t) => {
      track(t.mesh.geometry);
      track(t.mesh.material);
    });

    const mergePulse = new THREE.Mesh(track(new THREE.SphereGeometry(0.09, 12, 8)), track(basic(WHITE, 0)));
    graph.add(mergePulse);

    const commit = new THREE.Mesh(track(new THREE.OctahedronGeometry(0.16)), track(basic(GREEN, 1)));
    commit.position.set(def.merge, TRUNK_Y, 0);
    commit.scale.setScalar(0.001);
    graph.add(commit);

    const label = addLabel(node, def.id, `${def.role} // ${def.provider}`, 22, -8);
    return { def, node, ring, core, halo, ghost, link, worktree, mergeTrace, mergePulse, commit, label };
  });

  // Hand-off: brain syncs W1's merged change into W3's worktree.
  const w1 = WORKERS[0];
  const w3 = WORKERS[2];
  const syncCurve = new THREE.CubicBezierCurve3(
    new THREE.Vector3(w1.merge, TRUNK_Y, 0),
    new THREE.Vector3(w1.merge + 0.4, TRUNK_Y + 1.6, 0.4),
    new THREE.Vector3(w3.pos.x - 0.4, w3.pos.y - 1.4, 0.2),
    w3.pos.clone().add(new THREE.Vector3(-0.1, -0.36, 0)),
  );
  const syncTrace = new Trace(syncCurve, 0.014, CYAN, 0.9, seg(96));
  graph.add(syncTrace.mesh);
  track(syncTrace.mesh.geometry);
  track(syncTrace.mesh.material);
  const syncPulse = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 12, 8)), track(basic(CYAN, 0)));
  graph.add(syncPulse);

  // Conflict resolver (short-lived worker in the merge worktree).
  const resolver = new THREE.Group();
  const resolverRing = new THREE.Mesh(track(new THREE.TorusGeometry(0.22, 0.025, 8, seg(48))), track(basic(AMBER, 1)));
  const resolverHalo = makeHalo(AMBER, 1.1, 0.5);
  resolver.add(resolverRing, resolverHalo);
  resolver.position.set(w3.merge + 0.75, TRUNK_Y + 0.95, 0.5);
  graph.add(resolver);
  const resolverLabel = addLabel(resolver, 'RESOLVER', 'merge worktree', 18, -8);
  const conflictFlash = makeHalo(RED, 1.6, 0);
  conflictFlash.position.set(w3.merge, TRUNK_Y, 0);
  graph.add(conflictFlash);

  // Attention: W2 -> brain -> user.
  const escalateGeo = track(new THREE.BufferGeometry());
  escalateGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  const escalate = new THREE.Line(escalateGeo, track(lineMat(AMBER, 0)));
  graph.add(escalate);
  const escalatePulse = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 12, 8)), track(basic(AMBER, 0)));
  graph.add(escalatePulse);

  // ---------- State ----------
  let width = 1;
  let height = 1;
  let time = 0;
  let intro = reducedMotion ? 1 : 0;
  let opacity = 1;
  const frame: Frame = { t: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), frameX: 0.5, opacity: 1 };
  const camPos = new THREE.Vector3().copy(FRAMES[0].pos);
  const camLook = new THREE.Vector3().copy(FRAMES[0].look);
  let frameX = FRAMES[0].frameX;
  let smoothStory = 0;
  let frameY = 0.5;
  const camTarget = new THREE.Vector3();
  let frameEma = 1 / 60;
  let slowFor = 0;
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  // Portrait screens see far less width, so the camera pulls back to keep the
  // whole diagram in frame; fog thins out by the same factor.
  let distance = 1;

  function resize(w: number, h: number): void {
    width = Math.max(1, w);
    height = Math.max(1, h);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    distance = clamp(1 / camera.aspect, 1, 2.4);
    fog.density = FOG / distance;
    pMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    for (const l of labelList) l.w = 0;
  }

  /** Steps the pixel ratio down (never back up) while frames keep running long. */
  function adaptResolution(dtRaw: number): void {
    if (dtRaw <= 0 || dtRaw > 0.25 || dpr <= 1) return;
    frameEma = lerp(frameEma, dtRaw, 0.05);
    slowFor = frameEma > 1 / 40 ? slowFor + dtRaw : 0;
    if (slowFor < 1.5) return;
    dpr = Math.max(1, dpr - 0.25);
    renderer.setPixelRatio(dpr);
    resize(width, height);
    slowFor = 0;
    frameEma = 1 / 60;
  }

  const setOpacity = (m: THREE.Material, v: number): void => {
    m.opacity = v;
    m.visible = v > 0.003;
  };

  function update(input: StageInput, dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    if (!reducedMotion) {
      time += dt;
      intro = Math.min(1, intro + dt / 2.4);
    }
    adaptResolution(dtRaw);
    const k = reducedMotion ? 1 : damp(5, dt);
    const aspect = width / height;
    // Portrait and square: the scene sits behind the copy, centered.
    const portrait = aspect < 1.1;
    // Landscape phones: copy on the left half, scene on the right, like desktop.
    const shortLandscape = !portrait && height <= 520;
    const narrow = !portrait && !shortLandscape && width < 960;
    const storyFocus = smoothstep(1.6, 2, input.timeline) * (1 - smoothstep(2.97, 3.1, input.timeline));
    // Worker nodes sit too close for side labels on small screens.
    const labelsBelow = portrait || width < 1100;
    // Outside the story, portrait labels would land on top of section headings.
    const labelGate = portrait || shortLandscape ? storyFocus : 1;
    // Phones on their side pull back outside the story so the hero ring clears the headline.
    const dist = shortLandscape ? lerp(1.3, 1, storyFocus) : distance;

    // Camera framing
    sampleFrames(input.timeline, frame);
    camTarget.subVectors(frame.pos, frame.look).multiplyScalar(dist).add(frame.look);
    camPos.lerp(camTarget, k);
    camLook.lerp(frame.look, k);
    let targetX = frame.frameX;
    if (portrait || narrow) targetX = 0.5;
    else if (width < 1100) targetX = lerp(frame.frameX, Math.max(frame.frameX, 0.74), storyFocus);
    frameX = lerp(frameX, targetX, k);
    // In portrait the story step text docks at the bottom, so lift the diagram
    // into the upper part of the screen while the story plays.
    frameY = lerp(frameY, portrait ? lerp(0.5, height < 700 ? 0.3 : 0.34, storyFocus) : 0.5, k);
    // Behind the copy the scene stays quiet, except in the story where the
    // step text sits on solid cards and the diagram is the point.
    if (portrait) opacity = frame.opacity * lerp(0.38, 0.95, storyFocus);
    else if (shortLandscape) opacity = frame.opacity * lerp(0.6, 1, storyFocus);
    else opacity = frame.opacity * (narrow ? 0.5 : 1);

    const px = reducedMotion ? 0 : input.pointerX * 0.35;
    const py = reducedMotion ? 0 : input.pointerY * 0.2;
    camera.position.set(camPos.x + px, camPos.y - py, camPos.z);
    camera.lookAt(camLook);
    camera.setViewOffset(width, height, -(frameX - 0.5) * width, (0.5 - frameY) * height, width, height);

    // Story progress (scrubbed, lightly smoothed)
    smoothStory = lerp(smoothStory, input.story, reducedMotion ? 1 : damp(8, dt));
    const s = smoothStory;
    const introE = easeOutCubic(intro);

    // Particles
    pMat.uniforms.uIntro.value = intro;
    pMat.uniforms.uTime.value = time;
    particles.rotation.y = time * 0.01;

    // Brain
    const heroBig = 1 - smoothstep(0, 1.6, input.timeline);
    brain.scale.setScalar((0.65 + 0.55 * heroBig) * (0.2 + 0.8 * introE));
    brainSpin.rotation.z = -time * 0.35 + introE * 2.2;
    inner.rotation.x = Math.sin(time * 0.4) * 0.5;
    inner.rotation.y = time * 0.6;
    ticks.rotation.z = time * 0.05;
    orbits[0].rotation.z = time * 0.08;
    orbits[1].rotation.z = -time * 0.05;
    setOpacity(brainHalo.material, 0.35 + 0.15 * Math.sin(time * 1.6) + 0.2 * heroBig);

    // Plan scan ping and attention ping share one ring.
    const planP = range(s, 0.02, 0.17);
    const scanPhase = reducedMotion ? 0.6 : (time * 0.6) % 1;
    const pingStrength = Math.max(planP * (1 - range(s, 0.2, 0.06)), input.attention);
    ping.scale.setScalar(1 + scanPhase * 2.6);
    pingMat.color.copy(input.attention > 0.3 ? AMBER : CYAN);
    setOpacity(pingMat, pingStrength * (1 - scanPhase) * 0.9);

    // Satellites
    const groupsVis = bump(input.timeline, 1, 0.75);
    satellites.forEach((sat, i) => {
      const a = (i / satellites.length) * Math.PI * 2 + time * 0.18;
      const r = 2.05;
      sat.group.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.32, Math.sin(a) * r * 0.9);
      sat.wire.rotation.set(time * 0.7 + i, time * 0.5, 0);
      setOpacity(sat.wire.material as THREE.Material, groupsVis);
      setOpacity(sat.dot.material, groupsVis * 0.6);
      satLabels[i].alpha = groupsVis;
    });

    // Labels for brain
    brainLabel.alpha =
      introE * (1 - groupsVis) * smoothstep(0.2, 0.6, input.timeline) * (1 - smoothstep(3.6, 3.9, input.timeline));

    // Diagram collapses back into the brain after the attention section.
    const graphVis = 1 - smoothstep(3.6, 3.95, input.timeline);
    graph.scale.setScalar(Math.max(0.001, easeOutCubic(graphVis)));
    graph.visible = graphVis > 0.001;
    const detailLabels = graphVis * (1 - smoothstep(3.15, 3.35, input.timeline));

    // Trunk (session branch is created when the session starts)
    const trunkVis = range(s, 0.1, 0.1);
    trunkBase.draw(trunkVis);
    let litTo = 0;

    // Workers
    workers.forEach((w) => {
      const { def } = w;
      const spawnP = easeOutCubic(range(s, def.spawnAt, 0.09));
      const wtP = range(s, def.worktreeAt, 0.1);
      const mergeP = range(s, def.mergeAt, def.conflict ? 0.06 : 0.08);
      const resolved = def.conflict ? range(s, 0.93, 0.04) : 1;
      const merged = mergeP >= 1 && resolved >= 1;

      // Ghost (planned) ring
      w.ghost.lookAt(camera.position);
      setOpacity(w.ghost.material, planP * 0.5 * (1 - spawnP));

      // Node flies out of the brain
      w.node.position.lerpVectors(brain.position, def.pos, spawnP);
      w.node.scale.setScalar(Math.max(0.001, spawnP));
      w.node.visible = spawnP > 0.001;
      w.ring.lookAt(camera.position);
      w.ring.rotation.z += time * 0.4;

      let color = CYAN;
      if (merged) color = GREEN;
      if (def.id === 'W2' && input.attention > 0.25) color = AMBER;
      w.ring.material.color.lerp(color, reducedMotion ? 1 : damp(6, dt));
      w.halo.material.color.copy(w.ring.material.color);
      const pulse = def.id === 'W2' && input.attention > 0.25 && !reducedMotion ? 0.25 * Math.sin(time * 6) : 0;
      setOpacity(w.halo.material, (0.35 + pulse) * spawnP);
      w.label.alpha = spawnP * (1 - groupsVis) * (def.id === 'W2' ? graphVis : detailLabels);
      w.label.below = labelsBelow;
      w.label.el.dataset.tone = color === AMBER ? 'amber' : merged ? 'green' : 'cyan';

      // Brain -> worker link
      const lp = w.link.geometry.attributes.position as THREE.BufferAttribute;
      lp.setXYZ(0, brain.position.x, brain.position.y - 0.25, brain.position.z);
      lp.setXYZ(1, w.node.position.x, w.node.position.y + 0.36 * spawnP, w.node.position.z);
      lp.needsUpdate = true;
      setOpacity(w.link.material, spawnP * (merged ? 0.25 : 0.55));

      // Worktree branch from the session branch up to the worker
      w.worktree.draw(wtP);
      w.worktree.mesh.material.opacity = merged ? 0.3 : 0.8;

      // Merge back
      w.mergeTrace.draw(mergeP);
      const pulseOn = mergeP > 0 && mergeP < 1;
      if (pulseOn) w.mergeTrace.curve.getPointAt(mergeP, w.mergePulse.position);
      setOpacity(w.mergePulse.material, pulseOn ? 1 : 0);

      const commitP = def.conflict ? resolved : range(s, def.mergeAt + 0.08, 0.04);
      w.commit.scale.setScalar(Math.max(0.001, easeOutCubic(commitP)));
      w.commit.rotation.y = time * 1.2;
      if (commitP >= 1) litTo = Math.max(litTo, def.merge);
    });

    // Lit session branch: grows to the latest merge, then to the tip once all are done.
    const allDone = range(s, 0.97, 0.03);
    const litX = lerp(litTo, TRUNK_END, allDone);
    const litFrac = litTo > TRUNK_START ? (litX - TRUNK_START) / (TRUNK_END - TRUNK_START) : 0;
    trunkLit.draw(litTo === 0 ? 0 : litFrac);
    trunkHead.position.set(lerp(TRUNK_START, TRUNK_END, litFrac), TRUNK_Y, 0);
    setOpacity(trunkHead.material, litTo === 0 ? 0 : 0.8);
    trunkLabel.alpha = trunkVis * (1 - groupsVis) * detailLabels;

    // Hand-off sync W1 -> W3
    const syncP = range(s, 0.75, 0.06);
    const syncFade = 1 - range(s, 0.84, 0.05);
    syncTrace.draw(syncP);
    syncTrace.mesh.material.opacity = 0.9 * syncFade;
    if (syncP > 0 && syncP < 1) syncCurve.getPointAt(syncP, syncPulse.position);
    setOpacity(syncPulse.material, syncP > 0 && syncP < 1 ? 1 : 0);

    // Conflict and resolver on W3's merge
    const conflictP = range(s, 0.875, 0.03);
    const resolvedP = range(s, 0.93, 0.04);
    const resolverVis = conflictP * (1 - range(s, 0.985, 0.015));
    resolver.scale.setScalar(Math.max(0.001, easeOutCubic(resolverVis)));
    resolver.visible = resolverVis > 0.001;
    resolverRing.lookAt(camera.position);
    const rc = resolvedP >= 1 ? GREEN : AMBER;
    resolverRing.material.color.copy(rc);
    resolverHalo.material.color.copy(rc);
    resolverLabel.alpha = resolverVis * detailLabels;
    resolverLabel.el.dataset.tone = resolvedP >= 1 ? 'green' : 'amber';
    const flash = conflictP * (1 - resolvedP);
    setOpacity(conflictFlash.material, flash * (0.6 + 0.3 * Math.sin(time * 9)));

    // Escalation path in the attention section
    const att = input.attention;
    const w2 = workers[1];
    const ep = escalate.geometry.attributes.position as THREE.BufferAttribute;
    ep.setXYZ(0, w2.node.position.x, w2.node.position.y + 0.3, w2.node.position.z);
    ep.setXYZ(1, brain.position.x, brain.position.y - 0.2, brain.position.z);
    ep.setXYZ(2, brain.position.x, brain.position.y + 6, brain.position.z);
    ep.needsUpdate = true;
    setOpacity(escalate.material, att * 0.7);
    const travel = reducedMotion ? 0.5 : (time * 0.45) % 1;
    if (travel < 0.5) {
      tmp.set(w2.node.position.x, w2.node.position.y + 0.3, w2.node.position.z);
      tmp2.set(brain.position.x, brain.position.y - 0.2, brain.position.z);
      escalatePulse.position.lerpVectors(tmp, tmp2, travel * 2);
    } else {
      tmp.set(brain.position.x, brain.position.y, brain.position.z);
      tmp2.set(brain.position.x, brain.position.y + 6, brain.position.z);
      escalatePulse.position.lerpVectors(tmp, tmp2, (travel - 0.5) * 2);
    }
    setOpacity(escalatePulse.material, att);

    // Grid
    gridMat.opacity = 0.05 + 0.06 * smoothstep(1.2, 2, input.timeline);

    renderer.render(scene, camera);
    placeLabels(labelGate);
  }

  function placeLabels(gate: number): void {
    for (const l of labelList) {
      const a = clamp(l.alpha) * gate;
      if (a < 0.02) {
        if (l.el.style.visibility !== 'hidden') l.el.style.visibility = 'hidden';
        continue;
      }
      l.anchor.getWorldPosition(tmp);
      tmp.project(camera);
      if (tmp.z > 1) {
        l.el.style.visibility = 'hidden';
        continue;
      }
      if (!l.w) l.w = l.el.offsetWidth;
      const ax = (tmp.x * 0.5 + 0.5) * width;
      const ay = (-tmp.y * 0.5 + 0.5) * height;
      if (l.below) {
        if (l.flipped) {
          l.flipped = false;
          l.el.removeAttribute('data-flip');
        }
        l.el.dataset.below = '';
        const bx = clamp(ax - l.w / 2, 6, Math.max(6, width - l.w - 6));
        l.el.style.visibility = 'visible';
        l.el.style.opacity = a.toFixed(3);
        l.el.style.transform = `translate3d(${bx.toFixed(1)}px, ${(ay + 18).toFixed(1)}px, 0)`;
        continue;
      }
      if ('below' in l.el.dataset) {
        delete l.el.dataset.below;
        l.w = 0;
      }
      if (!l.w) l.w = l.el.offsetWidth;
      // Labels that would run off the right edge flip to the anchor's left side.
      const flip = ax + l.dx + l.w > width - 6;
      if (flip !== l.flipped) {
        l.flipped = flip;
        l.el.toggleAttribute('data-flip', flip);
      }
      const x = clamp(flip ? ax - l.dx - l.w : ax + l.dx, 6, Math.max(6, width - l.w - 6));
      const y = ay + l.dy;
      l.el.style.visibility = 'visible';
      l.el.style.opacity = a.toFixed(3);
      l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  function dispose(): void {
    disposables.forEach((d) => d.dispose());
    renderer.dispose();
    labels.replaceChildren();
  }

  return {
    update,
    resize,
    dispose,
    get opacity() {
      return opacity;
    },
  };
}
