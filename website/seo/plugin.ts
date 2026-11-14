// Vite plugin that fills the seo:* placeholders in index.html and writes the
// generated crawl and LLM files next to it. The dev server serves the same
// files from memory so they can be checked with `pnpm dev`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { PLACEHOLDER_SITE_URL } from './content.ts';
import {
  basePath,
  faqHtml,
  headTags,
  llmsFullTxt,
  llmsTxt,
  noscriptHtml,
  pageMarkdown,
  pageSections,
  robotsTxt,
  sitemapXml,
  webManifest,
} from './render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readDoc = (file: string): string => readFileSync(join(here, 'docs', file), 'utf8');

/** Fonts used above the fold: the h1 (Orbitron 700) and body copy (Rajdhani 500). */
const PRELOAD_FONTS = [/orbitron-latin-700-normal-[\w-]+\.woff2$/, /rajdhani-latin-500-normal-[\w-]+\.woff2$/];

export function normalizeSiteUrl(raw: string | undefined): string {
  const url = new URL(raw?.trim() || PLACEHOLDER_SITE_URL);
  return url.href.replace(/\/+$/, '');
}

/** Last commit date of index.html, so the sitemap only changes when the page does. */
function lastModified(root: string): string {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cs', '--', 'index.html'], { cwd: root, encoding: 'utf8' }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  } catch {
    // Not a git checkout; fall back to today.
  }
  return new Date().toISOString().slice(0, 10);
}

function fillHtml(html: string, siteUrl: string, fontPreloads: string[]): string {
  const fill = (marker: string, value: string): string => {
    const tag = `<!-- seo:${marker} -->`;
    if (!html.includes(tag)) throw new Error(`index.html is missing ${tag}`);
    return html.replace(tag, value);
  };
  html = fill('head', headTags(siteUrl, fontPreloads));
  html = fill('noscript', noscriptHtml(siteUrl));
  html = fill('faq', faqHtml());
  return html;
}

/** All generated files for a filled page, keyed by URL path. */
export function generatedFiles(html: string, siteUrl: string, root: string): Record<string, string> {
  const md = pageMarkdown(html, siteUrl);
  return {
    '/index.md': md,
    '/llms.txt': llmsTxt(siteUrl, pageSections(html)),
    '/llms-full.txt': llmsFullTxt(siteUrl, md, readDoc),
    '/robots.txt': robotsTxt(siteUrl),
    '/sitemap.xml': sitemapXml(siteUrl, lastModified(root)),
    '/site.webmanifest': webManifest(siteUrl),
  };
}

const TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export function seo(rawSiteUrl: string | undefined): Plugin {
  const siteUrl = normalizeSiteUrl(rawSiteUrl);
  let root = process.cwd();
  let outDir = 'dist';
  let finalHtml = '';

  return {
    name: 'arc-seo',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
      if (config.command === 'build' && !rawSiteUrl) {
        config.logger.warn(`\n[arc-seo] SITE_URL is not set; canonical and sitemap URLs use ${PLACEHOLDER_SITE_URL}.\n`);
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {})
          .filter((f) => PRELOAD_FONTS.some((re) => re.test(f)))
          .map((f) => `${basePath(siteUrl)}/${f}`);
        finalHtml = fillHtml(html, siteUrl, fonts);
        return finalHtml;
      },
    },
    async writeBundle() {
      const files = generatedFiles(finalHtml, siteUrl, root);
      await Promise.all(Object.entries(files).map(([path, body]) => writeFile(join(root, outDir, path), body)));
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Plugin middlewares run before Vite strips the base path, so accept both forms.
        const base = basePath(siteUrl);
        const raw = req.url?.split('?')[0] ?? '';
        const path = base && raw.startsWith(`${base}/`) ? raw.slice(base.length) : raw;
        const ext = path.slice(path.lastIndexOf('.'));
        if (!['/index.md', '/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml', '/site.webmanifest'].includes(path)) {
          return next();
        }
        try {
          const html = await server.transformIndexHtml('/', readFileSync(join(root, 'index.html'), 'utf8'));
          res.setHeader('Content-Type', TYPES[ext] ?? 'text/plain; charset=utf-8');
          res.end(generatedFiles(html, siteUrl, root)[path]);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}
