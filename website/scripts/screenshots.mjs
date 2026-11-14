// Captures the built site at several scroll positions for a visual check, and
// reports horizontal overflow (elements poking past the right edge) per shot.
// Usage: pnpm build && pnpm preview --port 4173 & node scripts/screenshots.mjs [url] [outDir]
// SHOTS_ONLY=m320,landscape limits the runs.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://localhost:4173/';
const outDir = process.argv[3] ?? 'screenshots';
await mkdir(outDir, { recursive: true });

const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const runs = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference', full: true },
  { name: 'reduced', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' },
  { name: 'm320', viewport: { width: 320, height: 568 }, ...phone, full: true },
  { name: 'm375', viewport: { width: 375, height: 812 }, ...phone, deviceScaleFactor: 3, full: true },
  { name: 'm414', viewport: { width: 414, height: 896 }, ...phone, full: true },
  { name: 't768', viewport: { width: 768, height: 1024 }, ...phone, full: true },
  { name: 'landscape', viewport: { width: 844, height: 390 }, ...phone, full: true },
  { name: 'm375-reduced', viewport: { width: 375, height: 812 }, ...phone, reducedMotion: 'reduce' },
  { name: 'm375-nogl', viewport: { width: 375, height: 812 }, ...phone, noWebGL: true },
];
const targets = [
  ['hero', null],
  ['why', '#why'],
  ['groups', '#groups'],
  ['story-1', '.step[data-step="0"]'],
  ['story-3', '.step[data-step="2"]'],
  ['story-4', '.step[data-step="3"]'],
  ['story-5', '.step[data-step="4"]'],
  ['modes', '#modes'],
  ['branches', '#branches'],
  ['attention', '#attention'],
  ['models', '#models'],
  ['sessions', '#sessions'],
  ['terminals', '#terminals'],
  ['bridge', '#bridge'],
  ['security', '#security'],
  ['download', '#download'],
];
const short = ['hero', 'story-1', 'story-4', 'attention', 'download'];

const launch = (extra = []) =>
  chromium.launch({
    channel: process.env.PW_CHANNEL ?? 'chrome',
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', ...extra],
  });
const browser = await launch();
let noGlBrowser = null;
const only = process.env.SHOTS_ONLY?.split(',');
let problems = 0;
for (const run of runs) {
  if (only && !only.includes(run.name)) continue;
  const { name, full, noWebGL, reducedMotion = 'no-preference', ...ctxOpts } = run;
  const b = noWebGL ? (noGlBrowser ??= await launch(['--disable-webgl', '--disable-3d-apis'])) : browser;
  const ctx = await b.newContext({ ...ctxOpts, reducedMotion });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  for (const [shot, sel] of targets) {
    if (!full && !short.includes(shot)) continue;
    await page.evaluate((s) => {
      const y = s
        ? (() => {
            const el = document.querySelector(s);
            const r = el.getBoundingClientRect();
            const top = r.top + window.scrollY;
            return s.startsWith('.step') ? top + r.height / 2 - window.innerHeight / 2 : top - 40;
          })()
        : 0;
      window.scrollTo({ top: y, behavior: 'instant' });
    }, sel);
    await page.waitForTimeout(1200);
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      if (document.documentElement.scrollWidth > vw) out.push(`scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
      for (const el of document.querySelectorAll('main *, header *, footer *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
        if (el.closest('.terminal__body, .sprite, .visually-hidden')) continue;
        if (r.right > vw + 0.5 || r.left < -0.5) {
          out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
        }
      }
      return out.slice(0, 6);
    });
    if (overflow.length) {
      problems++;
      console.log(`  ${name}-${shot} overflow:`, overflow.join('; '));
    }
    await page.screenshot({ path: `${outDir}/${name}-${shot}.png` });
  }
  console.log(name, errors.length ? errors : 'no errors');
  await ctx.close();
}
await browser.close();
await noGlBrowser?.close();
if (problems) console.log(`${problems} shot(s) with horizontal overflow`);
