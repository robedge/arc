// Renders the committed raster images in public/: the 1200x630 Open Graph card
// in the Arc HUD style, the PNG app icons for the web manifest and Apple touch
// icon, and favicon.ico. Everything is drawn from inline SVG/HTML with the
// bundled @fontsource fonts, through the locally installed Chrome (Playwright).
// Run after changing the artwork or seo/content.ts: pnpm images
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { site } from '../seo/content.ts';

const require = createRequire(import.meta.url);
// Inlined as data URLs: a page set from a string may not load file:// fonts.
const fontUrl = (pkg, file) =>
  `data:font/woff2;base64,${readFileSync(require.resolve(`@fontsource/${pkg}/files/${file}`)).toString('base64')}`;
const fontFaces = [
  ['Orbitron', 700, fontUrl('orbitron', 'orbitron-latin-700-normal.woff2')],
  ['Rajdhani', 500, fontUrl('rajdhani', 'rajdhani-latin-500-normal.woff2')],
  ['Rajdhani', 700, fontUrl('rajdhani', 'rajdhani-latin-700-normal.woff2')],
  ['JetBrains Mono', 500, fontUrl('jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2')],
]
  .map(([family, weight, src]) => `@font-face{font-family:'${family}';font-weight:${weight};src:url('${src}') format('woff2');}`)
  .join('');

const C = { ground: '#03080F', cyan: '#38E1FF', amber: '#FFB547', green: '#4BE08A', text: '#DCEBF5', muted: '#8FA7BA' };

const ring = (cx, cy, r, stroke = C.cyan) => `
  <g fill="none" stroke="${stroke}">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="${r * 0.16}" stroke-dasharray="${r * 5.05} ${r * 1.23}" stroke-linecap="round" transform="rotate(-62 ${cx} ${cy})"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.58}" stroke-width="${r * 0.1}" opacity=".7"/>
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.17}" fill="${stroke}"/>`;

// Brain at the top, three workers, worktree branches dropping to a session branch.
const diagram = `
  <g stroke="${C.cyan}" stroke-width="2" fill="none" opacity=".55">
    <path d="M880 170 L760 300 M880 170 L880 300 M880 170 L1000 300"/>
  </g>
  <g stroke="${C.cyan}" stroke-width="2.5" fill="none" opacity=".9">
    <path d="M730 470 C730 400 760 360 760 315 M850 470 C850 400 880 360 880 315 M970 470 C970 400 1000 360 1000 315"/>
  </g>
  <g stroke="${C.green}" stroke-width="2.5" fill="none" stroke-dasharray="6 6">
    <path d="M760 315 C775 380 795 430 810 470 M880 315 C895 380 915 430 930 470 M1000 315 C1015 380 1035 430 1050 470"/>
  </g>
  <line x1="680" y1="470" x2="1110" y2="470" stroke="${C.cyan}" stroke-width="3"/>
  ${ring(880, 150, 38)}
  <circle cx="760" cy="306" r="13" fill="${C.ground}" stroke="${C.cyan}" stroke-width="3"/>
  <circle cx="880" cy="306" r="13" fill="${C.ground}" stroke="${C.amber}" stroke-width="3"/>
  <circle cx="1000" cy="306" r="13" fill="${C.ground}" stroke="${C.cyan}" stroke-width="3"/>
  <g fill="${C.green}"><circle cx="810" cy="470" r="7"/><circle cx="930" cy="470" r="7"/><circle cx="1050" cy="470" r="7"/></g>
  <g font-family="JetBrains Mono" font-weight="500" font-size="15" fill="${C.muted}" letter-spacing="1">
    <text x="935" y="156" fill="${C.cyan}">BRAIN</text>
    <text x="712" y="282">W1 api</text>
    <text x="840" y="282" fill="${C.amber}">W2 infra</text>
    <text x="966" y="282">W3 web</text>
    <text x="680" y="500">dev</text>
    <text x="1110" y="500" text-anchor="end" fill="${C.cyan}">arc/session</text>
  </g>`;

const corners = (x, y, w, h, l = 26) => `
  <path d="M${x} ${y + l} V${y} H${x + l} M${x + w - l} ${y} H${x + w} V${y + l} M${x + w} ${y + h - l} V${y + h} H${x + w - l} M${x + l} ${y + h} H${x} V${y + h - l}"
    fill="none" stroke="${C.cyan}" stroke-width="3"/>`;

const [lead, tail] = site.ogHeadline.split('whole group');
const ogHtml = `<!doctype html><html><head><style>${fontFaces}
  html,body{margin:0;width:1200px;height:630px;background:${C.ground};overflow:hidden}
  .copy{position:absolute;left:84px;top:150px;width:600px;color:${C.text}}
  h1{font:700 50px/1.12 Orbitron;margin:0;letter-spacing:.01em}
  h1 em{font-style:normal;color:${C.cyan}}
  p{font:500 27px/1.3 Rajdhani;color:${C.muted};margin:26px 0 0}
  .kicker{font:500 17px JetBrains Mono;color:${C.cyan};letter-spacing:.14em;margin:0 0 22px}
  .readout{position:absolute;left:84px;bottom:66px;font:500 16px JetBrains Mono;color:${C.muted};letter-spacing:.06em}
  .readout b{color:${C.cyan};font-weight:500}
</style></head><body>
  <svg width="1200" height="630" style="position:absolute;inset:0">
    <defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${C.cyan}" stroke-opacity=".07"/></pattern>
    <radialGradient id="v" cx="70%" cy="40%" r="80%"><stop offset="40%" stop-color="${C.ground}" stop-opacity="0"/><stop offset="100%" stop-color="${C.ground}" stop-opacity=".85"/></radialGradient></defs>
    <rect width="1200" height="630" fill="url(#g)"/>
    <rect width="1200" height="630" fill="url(#v)"/>
    ${corners(36, 36, 1128, 558)}
    ${ring(108, 96, 22)}
    <text x="144" y="107" font-family="Orbitron" font-weight="700" font-size="30" letter-spacing="6" fill="${C.text}">ARC</text>
    ${diagram}
  </svg>
  <div class="copy">
    <p class="kicker">// LOCAL-FIRST AGENT HARNESS FOR MACOS</p>
    <h1>${lead}<em>whole group</em>${tail}</h1>
    <p>Your Claude Code, Codex and Cursor subscriptions, pointed at every repo in a group. No API keys. No cloud.</p>
  </div>
  <div class="readout"><b>PROVIDERS</b> Claude Code + Codex + Cursor CLIs &nbsp;//&nbsp; <b>RUNS ON</b> Your Mac &nbsp;//&nbsp; <b>TELEMETRY</b> None</div>
</body></html>`;

/** App icon: the favicon artwork, or full-bleed for the maskable variant. */
async function iconHtml(size, maskable) {
  const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  const inner = maskable
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}"><rect width="48" height="48" fill="${C.ground}"/><g transform="translate(24 24) scale(.72) translate(-24 -24)">${svg.replace(/<svg[^>]*>|<\/svg>|<rect[^>]*\/>/g, '')}</g></svg>`
    : svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${inner}</body></html>`;
}

/** favicon.ico holding PNG images (supported by every current browser). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
const shot = async (html, width, height, transparent = false) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((f) => f.load()));
    await document.fonts.ready;
  });
  const buf = await page.screenshot({ type: 'png', omitBackground: transparent });
  await page.close();
  return buf;
};

const out = (name) => new URL(`../public/${name}`, import.meta.url);
await writeFile(out('og-image.png'), await shot(ogHtml, 1200, 630));
await writeFile(out('apple-touch-icon.png'), await shot(await iconHtml(180, true), 180, 180));
await writeFile(out('icon-192.png'), await shot(await iconHtml(192, false), 192, 192, true));
await writeFile(out('icon-512.png'), await shot(await iconHtml(512, false), 512, 512, true));
await writeFile(out('icon-maskable-512.png'), await shot(await iconHtml(512, true), 512, 512));
const small = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await shot(await iconHtml(size, false), size, size, true) })));
await writeFile(out('favicon.ico'), ico(small));
await browser.close();
console.log('wrote public/og-image.png, icons and favicon.ico');
