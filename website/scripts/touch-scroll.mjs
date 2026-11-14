// Drives the built site with emulated touch: swipes (with fling momentum) from
// top to bottom and back, checking that the scroll-driven story advances and
// reverses, nothing pans sideways, and the header menu works by tap.
// Usage: pnpm build && pnpm preview --port 4173 & node scripts/touch-scroll.mjs [url] [outDir]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'screenshots/touch';
await mkdir(outDir, { recursive: true });

const viewport = { width: Number(process.env.TOUCH_W ?? 375), height: Number(process.env.TOUCH_H ?? 812) };
const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(3500);
const cdp = await ctx.newCDPSession(page);

// Frame counter and a log of every story step change, both in the page so
// fast flings that cross a whole step between samples are still seen.
await page.evaluate(() => {
  const w = window;
  w.__steps = [];
  new MutationObserver(() => {
    const active = document.querySelector('.step.is-active');
    const step = active ? Number(active.dataset.step) : -1;
    if (step >= 0 && w.__steps[w.__steps.length - 1] !== step) w.__steps.push(step);
  }).observe(document.querySelector('.steps'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  w.__frames = [];
  let last = performance.now();
  const tick = (now) => {
    w.__frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const state = () =>
  page.evaluate(() => {
    const active = document.querySelector('.step.is-active');
    return {
      y: Math.round(window.scrollY),
      x: window.scrollX,
      max: document.documentElement.scrollHeight - window.innerHeight,
      step: active ? Number(active.dataset.step) : -1,
      opacity: getComputedStyle(document.getElementById('stage')).getPropertyValue('--stage-opacity').trim(),
      webgl: document.documentElement.classList.contains('has-webgl'),
    };
  });

const swipe = (dy, dx = 0) =>
  cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(viewport.width / 2),
    y: Math.round(viewport.height * (dy < 0 ? 0.75 : 0.25)),
    xDistance: dx,
    yDistance: dy,
    speed: 1400,
    gestureSourceType: 'touch',
    preventFling: false,
  });

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

const takeSteps = () => page.evaluate(() => window.__steps.splice(0).join(''));

// Down the page.
await takeSteps();
let s = await state();
let lastStep = -1;
let guard = 0;
let shot = 0;
while (s.y < s.max - 2 && guard++ < 200) {
  await swipe(-Math.round(viewport.height * 0.6));
  await page.waitForTimeout(250);
  s = await state();
  if (s.step >= 0 && s.step !== lastStep) {
    lastStep = s.step;
    await page.screenshot({ path: `${outDir}/down-${String(shot++).padStart(2, '0')}-step${s.step}.png` });
  }
  if (s.x !== 0) break;
}
const downSteps = await takeSteps();
console.log('down: active steps in order', downSteps.split('').join(' '), `| reached ${s.y}/${s.max} in ${guard} swipes`);
check(s.webgl, 'WebGL stage is running');
check(s.y >= s.max - 2, 'touch swipes reach the bottom of the page');
check(downSteps === '01234', 'story steps activate 0..4 in order while swiping down');

// Sideways swipe must not pan the page.
await swipe(0, -200);
await page.waitForTimeout(300);
s = await state();
check(s.x === 0,`no horizontal pan after a sideways swipe (scrollX ${s.x})`);

// Back up.
await takeSteps();
guard = 0;
while (s.y > 0 && guard++ < 200) {
  await swipe(Math.round(viewport.height * 0.6));
  await page.waitForTimeout(250);
  s = await state();
}
const upSteps = await takeSteps();
console.log('up: active steps in order', upSteps.split('').join(' '));
check(s.y === 0, 'touch swipes return to the top');
check(upSteps === '43210', 'story steps reverse 4..0 while swiping up');

// Menu: open by tap, follow a link, menu closes and the page scrolls there.
const toggle = page.locator('.nav-toggle');
if (await toggle.isVisible()) {
  const box = await toggle.boundingBox();
  check(box.width >= 44 && box.height >= 44, `menu button is at least 44px (${Math.round(box.width)}x${Math.round(box.height)})`);
  await toggle.tap();
  await page.waitForTimeout(200);
  check((await toggle.getAttribute('aria-expanded')) === 'true', 'menu opens on tap');
  await page.screenshot({ path: `${outDir}/menu-open.png` });
  const link = page.locator('.nav a[href="#security"]');
  const lb = await link.boundingBox();
  check(lb.height >= 44, `menu links are at least 44px tall (${Math.round(lb.height)})`);
  await link.tap();
  await page.waitForTimeout(1500);
  check((await toggle.getAttribute('aria-expanded')) === 'false', 'menu closes after a link tap');
  const top = await page.evaluate(() => document.getElementById('security').getBoundingClientRect().top);
  check(top > -10 && top < 200, `link scrolls to its section (top ${Math.round(top)})`);
}

const fps = await page.evaluate(() => {
  const f = window.__frames.slice(5).filter((d) => d < 1000);
  const avg = f.reduce((a, b) => a + b, 0) / f.length;
  const sorted = [...f].sort((a, b) => a - b);
  return { avg: 1000 / avg, p95ms: sorted[Math.floor(sorted.length * 0.95)] };
});
console.log(`frame rate: ${fps.avg.toFixed(1)} fps average, p95 frame ${fps.p95ms.toFixed(1)} ms (software GL in headless Chrome)`);
check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);

await browser.close();
if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all touch checks passed');
