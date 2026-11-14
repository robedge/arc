
import type Lenis from 'lenis';
import { bump, clamp } from './scene/math';
import type { Stage, StageInput } from './scene/types';
import { setupMenu, setupReveal, setupTabs } from './ui';

const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
root.classList.add('js', reducedMotion ? 'motion-reduced' : 'motion-ok');

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

// ---------- Loader ----------

const loader = document.getElementById('loader');
const loaderBar = document.getElementById('loader-bar');
const loaderPct = document.getElementById('loader-pct');
const loaderStatus = document.getElementById('loader-status');
let loadTarget = 0.08;
let loadShown = 0;

function setLoad(target: number, status?: string): void {
  loadTarget = Math.max(loadTarget, target);
  if (status && loaderStatus) loaderStatus.textContent = status;
}

function animateLoader(): Promise<void> {
  return new Promise((resolve) => {
    if (!loader || reducedMotion) {
      resolve();
      return;
    }
    const step = (): void => {
      loadShown += (loadTarget - loadShown) * 0.12 + 0.002;
      loadShown = Math.min(loadShown, loadTarget);
      loaderBar?.style.setProperty('--p', loadShown.toFixed(3));
      if (loaderPct) loaderPct.textContent = String(Math.round(loadShown * 100)).padStart(3, '0');
      if (loadShown >= 0.999) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function hideLoader(): void {
  loader?.classList.add('loader--done');
}

// ---------- Scroll-derived timeline ----------

interface Anchor {
  y: number;
  t: number;
}
let anchors: Anchor[] = [];
let storyStart = 0;
let storyEnd = 1;

const docTop = (el: Element): number => el.getBoundingClientRect().top + window.scrollY;

function measure(): void {
  const vh = window.innerHeight;
  const center = (sel: string): number => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    return docTop(el) + el.getBoundingClientRect().height / 2 - vh / 2;
  };
  const steps = document.querySelector('.steps');
  storyStart = steps ? docTop(steps) - vh * 0.5 : 0;
  storyEnd = steps ? docTop(steps) + steps.getBoundingClientRect().height - vh * 0.5 : 1;
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
  anchors = [
    { y: 0, t: 0 },
    { y: center('#groups'), t: 1 },
    { y: storyStart, t: 2 },
    { y: storyEnd, t: 3 },
    // Half a screen later the steps have scrolled out; small screens fade the diagram over this stretch.
    { y: storyEnd + vh * 0.5, t: 3.1 },
    { y: center('#attention'), t: 3.5 },
    { y: Math.min(center('#download'), maxScroll), t: 4 },
  ];
  // Keep anchors strictly increasing in case of unusual layouts.
  for (let i = 1; i < anchors.length; i++) anchors[i].y = Math.max(anchors[i].y, anchors[i - 1].y + 1);
}

function timelineAt(y: number): number {
  if (y <= anchors[0].y) return anchors[0].t;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (y <= b.y) return a.t + ((y - a.y) / (b.y - a.y)) * (b.t - a.t);
  }
  return anchors[anchors.length - 1].t;
}

const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'));
let activeStep = -1;
function markStep(story: number, inStory: boolean): void {
  const idx = inStory ? Math.min(steps.length - 1, Math.floor(story * steps.length)) : -1;
  if (idx === activeStep) return;
  activeStep = idx;
  steps.forEach((s, i) => s.classList.toggle('is-active', i === idx));
}

// ---------- Boot ----------

const input: StageInput = { timeline: 0, story: 0, attention: 0, pointerX: 0, pointerY: 0 };
let pointerTX = 0;
let pointerTY = 0;

async function boot(): Promise<void> {
  setupTabs(document.querySelector('.modes') as HTMLElement);
  setupMenu(document.querySelector('.site-header') as HTMLElement);

  const loaderDone = animateLoader();
  const minTime = new Promise((r) => setTimeout(r, reducedMotion ? 0 : 900));

  document.fonts?.ready.then(() => setLoad(0.35, 'LOADING TYPE'));

  let lenis: Lenis | null = null;
  if (!reducedMotion) {
    const { default: LenisCtor } = await import('lenis');
    lenis = new LenisCtor({ autoRaf: false, lerp: 0.09, wheelMultiplier: 0.9, anchors: true });
  }

  let stage: Stage | null = null;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const labels = document.getElementById('stage-labels') as HTMLElement;
  // The canvas is sized in CSS to the large viewport (100lvh), so mobile browser
  // chrome sliding in and out does not change it; only real size changes resize.
  let stageW = 0;
  let stageH = 0;
  const resizeStage = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!stage || (w === stageW && h === stageH)) return;
    stageW = w;
    stageH = h;
    stage.resize(w, h);
  };
  if (webglAvailable()) {
    // Let the hero text paint with its web fonts (the LCP element) before the
    // three.js chunk parses and builds the scene, which keeps the main thread busy.
    await document.fonts?.ready;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    setLoad(0.45, 'LINKING BRAIN');
    try {
      const { createStage } = await import('./scene/stage');
      stage = createStage({ canvas, labels, reducedMotion });
      resizeStage();
      setLoad(0.8, 'SPAWNING WORKERS');
      root.classList.add('has-webgl');
    } catch (err) {
      console.warn('WebGL stage unavailable, using static fallback.', err);
      stage = null;
    }
  }
  if (!stage) root.classList.add('no-webgl');

  await Promise.all([document.fonts?.ready, minTime]);
  measure();
  setLoad(1, 'READY');
  await loaderDone;
  hideLoader();
  setupReveal(!reducedMotion);

  window.addEventListener('resize', () => {
    measure();
    resizeStage();
  });
  new ResizeObserver(() => measure()).observe(document.body);

  if (!reducedMotion) {
    // Parallax follows a mouse only; touch drags are scrolls, not pointing.
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        pointerTX = (e.clientX / window.innerWidth) * 2 - 1;
        pointerTY = (e.clientY / window.innerHeight) * 2 - 1;
      },
      { passive: true },
    );
  }

  const header = document.querySelector('.site-header');
  let headerScrolled = false;
  let last = performance.now();
  let lastOpacity = -1;
  const frame = (now: number): void => {
    const dt = (now - last) / 1000;
    last = now;
    lenis?.raf(now);

    const y = window.scrollY;
    input.timeline = timelineAt(y);
    input.story = clamp((y - storyStart) / Math.max(1, storyEnd - storyStart));
    input.attention = bump(input.timeline, 3.5, 0.32);
    input.pointerX += (pointerTX - input.pointerX) * 0.06;
    input.pointerY += (pointerTY - input.pointerY) * 0.06;
    markStep(input.story, input.timeline > 1.9 && input.timeline < 3.1);
    const scrolled = y > 40;
    if (scrolled !== headerScrolled) {
      headerScrolled = scrolled;
      header?.classList.toggle('is-scrolled', scrolled);
    }

    if (stage) {
      stage.update(input, dt);
      const o = Math.round(stage.opacity * 100) / 100;
      if (o !== lastOpacity) {
        canvas.style.setProperty('--stage-opacity', String(o));
        lastOpacity = o;
      }
    }
    if (!document.hidden) requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      last = performance.now();
      requestAnimationFrame(frame);
    }
  });
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  root.classList.add('no-webgl');
  hideLoader();
});
