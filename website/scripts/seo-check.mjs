// Checks the production build for the SEO and LLM-readability contract:
// generated files exist, head tags and JSON-LD are valid, the visible FAQ
// matches the FAQPage JSON-LD, the heading outline and anchors are sound, and
// all copy is visible with JavaScript off and is not stuck behind the loader.
// Usage: pnpm build && pnpm preview --port 4173 & pnpm seo:check [url]
// Without a url it uses http://localhost:4173 plus the base path the build was made for.
import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const read = (f) => readFileSync(new URL(f, dist), 'utf8');
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

// ---------- Files ----------

const files = [
  'index.html', 'index.md', 'llms.txt', 'llms-full.txt', 'robots.txt', 'sitemap.xml', 'site.webmanifest',
  'og-image.png', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'icon-maskable-512.png', 'noscript.css',
];
for (const f of files) check(existsSync(new URL(f, dist)), `dist/${f} exists`);

const html = read('index.html');
const head = html.slice(0, html.indexOf('</head>'));
const pngSize = (f) => {
  const b = readFileSync(new URL(f, dist));
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};
check(pngSize('og-image.png') === '1200x630', 'og-image.png is 1200x630');

// ---------- Head ----------

const meta = (attr, name) => head.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];
const title = head.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
const description = meta('name', 'description') ?? '';
check(title.length >= 30 && title.length <= 65, `title length ${title.length} (30-65)`);
check(description.length >= 70 && description.length <= 160, `meta description length ${description.length} (70-160)`);
check(/<html lang="en">/.test(html), 'html lang');
check(/name="viewport"/.test(head) && /name="theme-color"/.test(head), 'viewport and theme-color');
check(/^index, follow/.test(meta('name', 'robots') ?? ''), 'robots meta allows indexing');
const canonical = head.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? '';
check(/^https?:\/\/.+\/$/.test(canonical), `canonical ${canonical}`);
// The path of the canonical URL is the base path the site is served under ('' or '/arc').
const base = canonical ? new URL(canonical).pathname.replace(/\/+$/, '') : '';
const url = process.argv[2] ?? `http://localhost:4173${base}/`;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rootRefs = [...html.matchAll(/\s(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
const offBase = rootRefs.filter((r) => !r.startsWith(`${base}/`));
check(offBase.length === 0, `all ${rootRefs.length} root-relative links sit under the base path "${base}/" ${offBase.join(' ')}`);
const ogImage = meta('property', 'og:image') ?? '';
check(ogImage === `${canonical}og-image.png`, `og:image ${ogImage}`);
check(meta('property', 'og:url') === canonical, 'og:url matches the canonical URL');
for (const p of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt']) {
  check(!!meta('property', p), `meta ${p}`);
}
for (const n of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) check(!!meta('name', n), `meta ${n}`);
check(new RegExp(`rel="alternate" type="text/markdown" href="${reEsc(base)}/index\\.md"`).test(head), 'markdown alternate link');
check(/rel="manifest"/.test(head) && /rel="apple-touch-icon"/.test(head), 'manifest and touch icon links');
check(/rel="preload"[^>]+as="font"/.test(head), 'critical fonts preloaded');
check(!/modulepreload[^>]+stage-/.test(html) && !/src="[^"]*stage-/.test(html), 'three.js stage chunk stays lazy');

// ---------- JSON-LD ----------

const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let graph = [];
try {
  graph = ldBlocks.flatMap((b) => JSON.parse(b)['@graph'] ?? []);
  check(true, 'JSON-LD parses');
} catch (err) {
  check(false, `JSON-LD parses: ${err.message}`);
}
const byType = (t) => graph.find((n) => n['@type'] === t);
check(!!byType('WebSite'), 'JSON-LD WebSite');
const app = byType('SoftwareApplication');
check(app?.operatingSystem === 'macOS', 'JSON-LD SoftwareApplication on macOS');
check(!app?.aggregateRating && !app?.review && !app?.offers, 'no invented ratings, reviews or prices');
const faqLd = byType('FAQPage')?.mainEntity ?? [];
check(faqLd.length >= 4, `JSON-LD FAQPage with ${faqLd.length} questions`);

// ---------- Built HTML structure ----------

const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
check((html.match(/<h1\b/g) ?? []).length === 1, 'exactly one h1');
let level = 1;
let skipped = '';
for (const m of main.matchAll(/<h([1-6])\b/g)) {
  const l = Number(m[1]);
  if (l > level + 1) skipped ||= `h${level} -> h${l}`;
  level = l;
}
check(!skipped, `heading outline has no skipped levels ${skipped}`);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const badAnchors = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]).filter((id) => !ids.has(id));
check(badAnchors.length === 0, `in-page links resolve ${badAnchors.join(' ')}`);
check(/class="skip-link" href="#main"/.test(html), 'skip link');
check(/<header\b/.test(html) && /<nav\b/.test(html) && /<main\b/.test(html) && /<footer\b/.test(html), 'landmarks');
const sectionsNoId = [...main.matchAll(/<section\b(?![^>]*\bid=)[^>]*>/g)];
check(sectionsNoId.length === 0, 'every section has an id');
const imgsNoAlt = [...html.matchAll(/<img\b(?![^>]*\balt=)[^>]*>/g)];
const imgsNoSize = [...html.matchAll(/<img\b(?![^>]*\bwidth=)[^>]*>/g)];
check(imgsNoAlt.length === 0 && imgsNoSize.length === 0, 'images have alt, width and height');
check(!/<[a-z]+\b[^>]*\shidden[\s>]/.test(main), 'no content hidden with the hidden attribute');
check(!/style="[^"]*(display:\s*none|visibility:\s*hidden)/.test(main), 'no inline display:none or visibility:hidden');
check(/<noscript>[\s\S]*?<\/noscript>/.test(main), 'noscript fallback in main');

// ---------- Generated text files ----------

const llms = read('llms.txt');
check(/^# .+\n\n> .+/.test(llms) && /\n## /.test(llms), 'llms.txt has title, summary blockquote and sections');
const md = read('index.md');
const h2s = [...main.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
const mdFlat = md.replace(/[_*\\]/g, '');
check(h2s.every((h) => mdFlat.includes(h)), `index.md has all ${h2s.length} section headings`);
const full = read('llms-full.txt');
check(full.includes('(assumption)') && full.includes('## Frequently asked questions'), 'llms-full.txt keeps assumption labels and the FAQ');
const robots = read('robots.txt');
for (const bot of ['GPTBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Applebot-Extended']) {
  check(new RegExp(`User-agent: ${bot}\\n[\\s\\S]*?Allow: /`).test(robots), `robots.txt allows ${bot}`);
}
check(robots.includes(`\nSitemap: ${canonical}sitemap.xml\n`), 'robots.txt lists the sitemap under the site URL');
check(llms.includes(`(${canonical}index.md)`) && llms.includes(`(${canonical}#faq-1)`), 'llms.txt links use the site URL');
check(read('sitemap.xml').includes(`<loc>${canonical}</loc>`), 'sitemap lists the canonical URL');
const manifest = JSON.parse(read('site.webmanifest'));
check(manifest.start_url === `${base}/` && manifest.icons.every((i) => i.src.startsWith(`${base}/`)), 'site.webmanifest parses and uses the base path');
check(readdirSync(dist).every((f) => !f.endsWith('.map')), 'no source maps shipped');
check(!existsSync(new URL('CNAME.example', dist)), 'the CNAME placeholder is not shipped');

// ---------- Browser: no JS, then with JS ----------

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
try {
  const noJs = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
  await noJs.goto(url, { waitUntil: 'load' });
  const report = await noJs.evaluate(() => {
    const loader = document.getElementById('loader');
    const texts = [...document.querySelectorAll('main h1, main h2, main h3, main p, main li, main td, main dt, main dd, main figcaption')]
      .filter((el) => !el.closest('[aria-hidden="true"], .visually-hidden'))
      .filter((el) => el.textContent.trim());
    const hidden = texts.filter((el) => !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    const faq = [...document.querySelectorAll('#faq .faq__item')].map((li) => ({
      q: li.querySelector('h3').textContent.trim(),
      a: li.querySelector('p').textContent.trim(),
    }));
    return {
      loaderVisible: !!loader && loader.checkVisibility({ visibilityProperty: true }),
      total: texts.length,
      hidden: hidden.map((el) => el.textContent.trim().slice(0, 60)),
      faq,
    };
  });
  check(!report.loaderVisible, 'no JS: loader is not shown');
  check(report.hidden.length === 0, `no JS: all ${report.total} text blocks visible ${report.hidden.join(' | ')}`);
  const same =
    report.faq.length === faqLd.length &&
    report.faq.every((f, i) => f.q === faqLd[i].name && f.a === faqLd[i].acceptedAnswer.text);
  check(same, `visible FAQ (${report.faq.length}) matches FAQPage JSON-LD (${faqLd.length})`);

  const js = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await js.goto(url, { waitUntil: 'load' });
  await js.waitForFunction(() => document.getElementById('loader')?.classList.contains('loader--done'), null, { timeout: 8000 });
  const jsHidden = await js.evaluate(() =>
    [...document.querySelectorAll('main h1, main h2, main h3, main p, main li')]
      .filter((el) => !el.closest('[aria-hidden="true"], .visually-hidden, [role="tabpanel"][hidden], .story__fallback'))
      .filter((el) => el.textContent.trim() && !el.checkVisibility())
      .map((el) => el.textContent.trim().slice(0, 60)),
  );
  check(jsHidden.length === 0, `with JS: no copy is display:none ${jsHidden.join(' | ')}`);
} finally {
  await browser.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
