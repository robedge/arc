// Pure renderers for the generated SEO and LLM files. Inputs are the facts in
// seo/content.ts, the final page HTML and the vendored docs, so the outputs
// cannot drift from what the page shows.
import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';
import { faqs, features, fullDocs, requirements, site } from './content.ts';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const stripTags = (s: string): string =>
  s
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

export const OG_IMAGE = { path: '/og-image.png', width: 1200, height: 630 };

/** Absolute URL for a site path; siteUrl has no trailing slash. */
const abs = (siteUrl: string, path: string): string => `${siteUrl}${path}`;

/**
 * Path the site is served under, without a trailing slash: '' at the root of an
 * origin, '/arc' for https://robedge.github.io/arc. Root-relative links in the
 * generated tags are prefixed with it, and vite.config.ts derives `base` from it.
 */
export const basePath = (siteUrl: string): string => new URL(siteUrl).pathname.replace(/\/+$/, '');

// ---------- Head ----------

export function headTags(siteUrl: string, fontPreloads: string[]): string {
  const url = abs(siteUrl, '/');
  const img = abs(siteUrl, OG_IMAGE.path);
  const base = basePath(siteUrl);
  const lines = [
    `<title>${esc(site.title)}</title>`,
    `<meta name="description" content="${esc(site.description)}" />`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />`,
    `<link rel="canonical" href="${url}" />`,
    `<link rel="alternate" type="text/markdown" href="${base}/index.md" title="${esc(site.name)} page as Markdown" />`,
    `<link rel="alternate" type="text/plain" href="${base}/llms.txt" title="llms.txt" />`,
    ...fontPreloads.map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`),
    `<link rel="icon" href="${base}/favicon.ico" sizes="32x32" />`,
    `<link rel="icon" type="image/svg+xml" href="${base}/favicon.svg" />`,
    `<link rel="apple-touch-icon" href="${base}/apple-touch-icon.png" />`,
    `<link rel="manifest" href="${base}/site.webmanifest" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(site.name)}" />`,
    `<meta property="og:locale" content="${site.locale}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${esc(site.title)}" />`,
    `<meta property="og:description" content="${esc(site.description)}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="${OG_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${OG_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${esc(site.ogImageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(site.title)}" />`,
    `<meta name="twitter:description" content="${esc(site.description)}" />`,
    `<meta name="twitter:image" content="${img}" />`,
    `<meta name="twitter:image:alt" content="${esc(site.ogImageAlt)}" />`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd(siteUrl)).replace(/</g, '\\u003c')}</script>`,
  ];
  return lines.join('\n    ');
}

// ---------- JSON-LD ----------

export function jsonLd(siteUrl: string): Record<string, unknown> {
  const url = abs(siteUrl, '/');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${url}#website`,
        url,
        name: site.name,
        description: site.description,
        inLanguage: site.language,
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${url}#software`,
        name: site.name,
        url,
        description: site.summary,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS',
        softwareRequirements: requirements,
        featureList: features,
        image: abs(siteUrl, OG_IMAGE.path),
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        url: `${url}#faq`,
        isPartOf: { '@id': `${url}#website` },
        about: { '@id': `${url}#software` },
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };
}

// ---------- Body fragments ----------

export function faqHtml(): string {
  const items = faqs
    .map(
      (f, i) => `
          <li class="panel faq__item">
            <h3 id="faq-${i + 1}">${esc(f.q)}</h3>
            <p>${esc(f.a)}</p>
          </li>`,
    )
    .join('');
  return `<section class="section faq" id="faq" aria-labelledby="faq-title">
        <header class="section__head">
          <p class="kicker" data-scramble>// FAQ</p>
          <h2 id="faq-title" class="display">Questions, answered from the product docs.</h2>
        </header>
        <ul class="grid grid--2 faq__list" role="list">${items}
        </ul>
      </section>`;
}

export function noscriptHtml(siteUrl: string): string {
  const base = basePath(siteUrl);
  return `<noscript>
        <div class="noscript-note panel">
          <p>${esc(site.summary)}</p>
          <p>The animated diagram needs JavaScript; all of the text below reads without it. Plain-text versions: <a href="${base}/index.md">this page as Markdown</a> and <a href="${base}/llms.txt">llms.txt</a>.</p>
        </div>
      </noscript>`;
}

// ---------- Markdown ----------

function turndown(siteUrl: string): TurndownService {
  const base = basePath(siteUrl);
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_' });
  td.use(tables);
  td.remove(['script', 'style', 'noscript', 'svg', 'button', 'canvas'] as never);
  // Added rules win over remove(), so hidden content is dropped with a rule.
  td.addRule('hidden', {
    filter: (node) =>
      node.getAttribute?.('aria-hidden') === 'true' ||
      (node.getAttribute?.('role') === 'img' && node.nodeName !== 'svg') ||
      node.getAttribute?.('role') === 'tablist',
    replacement: () => '',
  });
  td.addRule('kicker', {
    filter: (node) => node.nodeName === 'P' && /\bkicker\b/.test(node.getAttribute('class') ?? ''),
    replacement: (content) => `\n\n_${content.replace(/^\/\/\s*/, '').trim()}_\n\n`,
  });
  td.addRule('caption', { filter: 'caption', replacement: (content) => `\n\n_${content.trim()}_\n\n` });
  td.addRule('dl', { filter: 'dl', replacement: (content) => `\n\n${content.trim()}\n\n` });
  td.addRule('dlRow', {
    filter: (node) => node.nodeName === 'DIV' && node.parentNode?.nodeName === 'DL',
    replacement: (content) => `${content.trim()}\n`,
  });
  td.addRule('dt', { filter: 'dt', replacement: (content) => `- **${content.trim()}**: ` });
  td.addRule('dd', { filter: 'dd', replacement: (content) => content.trim() });
  td.addRule('anchor', {
    filter: (node) => node.nodeName === 'A' && !!node.getAttribute('href'),
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      // Root-relative links already carry the base path (Vite adds it), so drop it before joining.
      const local = href.startsWith(`${base}/`) ? href.slice(base.length) : href;
      const target = local.startsWith('#') || local.startsWith('/') ? `${siteUrl}/${local.replace(/^\//, '')}` : href;
      return `[${content}](${target})`;
    },
  });
  return td;
}

/** Converts the page's <main> into Markdown. */
export function pageMarkdown(html: string, siteUrl: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? '';
  const body = turndown(siteUrl)
    .turndown(main.replace(/<br\s*\/?>/g, ' '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `<!-- Generated from index.html at build time. Canonical page: ${siteUrl}/ -->

> ${site.summary}

${body}

---

${site.status}
`;
}

// ---------- llms.txt ----------

export interface PageSection {
  id: string;
  title: string;
}

/** Lists sections with an id and a heading, in page order. */
export function pageSections(html: string): PageSection[] {
  const out: PageSection[] = [];
  for (const m of html.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*\baria-labelledby="([^"]+)"/g)) {
    const heading = html.match(new RegExp(`<h[1-3][^>]*\\bid="${m[2]}"[^>]*>([\\s\\S]*?)</h[1-3]>`));
    if (heading) out.push({ id: m[1], title: stripTags(heading[1]) });
  }
  return out;
}

export function llmsTxt(siteUrl: string, sections: PageSection[]): string {
  const link = (path: string): string => abs(siteUrl, path);
  return `# ${site.name}

> ${site.summary}

Arc is a macOS app for a single developer. It needs no API keys: it drives the locally installed Claude Code and Codex CLIs on their logged-in subscriptions, runs everything on the user's Mac, and never pushes or merges into the user's dev branch. A preview (spike) feature lets the brain show interactive panels in the conversation, written in A2UI Express and drawn from Arc's component catalog; a button press returns a "[Surface action]" event to the brain. ${site.status}

## Docs

- [Page as Markdown](${link('/index.md')}): the full text of this site in Markdown
- [Full product facts](${link('/llms-full.txt')}): the page, the FAQ and the product definition and architecture excerpts in one file

## Page sections

${sections.map((s) => `- [${s.title}](${link(`/#${s.id}`)})`).join('\n')}

## FAQ

${faqs.map((f, i) => `- [${f.q}](${link(`/#faq-${i + 1}`)}): ${f.a}`).join('\n')}

## Optional

- [Sitemap](${link('/sitemap.xml')})
- [Open Graph image](${link(OG_IMAGE.path)}): 1200x630 preview card
`;
}

/** Returns the doc with headings shifted down one level so it nests under a section. */
function nest(md: string): string {
  return md.replace(/^(#{1,5}) /gm, '#$1 ');
}

/** Picks whole level-2 sections by title from a markdown doc. */
function pickSections(md: string, headings: readonly string[]): string {
  const parts = md.split(/^(?=## )/m);
  return parts.filter((p) => headings.some((h) => p.startsWith(`## ${h}`))).join('\n').trim();
}

export function llmsFullTxt(
  siteUrl: string,
  pageMd: string,
  readDoc: (file: string) => string,
): string {
  const docs = fullDocs
    .map((d) => {
      const raw = readDoc(d.file);
      const text = d.headings ? pickSections(raw, d.headings) : raw.replace(/^# .*\n/, '').trim();
      return `## ${d.title} (${d.file})\n\n${nest(text).replace(/^---$/gm, '').replace(/\n{3,}/g, '\n\n').trim()}`;
    })
    .join('\n\n');
  return `# ${site.name}: full product facts

> ${site.summary}

Canonical site: ${siteUrl}/
Status: ${site.status}

Items marked _(assumption)_ in the product docs below were drafted from best-practice defaults and still need confirmation. They are kept labeled as such.

## Requirements

${requirements}

## Features

${features.map((f) => `- ${f}`).join('\n')}

## Frequently asked questions

${faqs.map((f) => `### ${f.q}\n\n${f.a}\n\nSource: ${f.source}`).join('\n\n')}

${docs}

## Site content

${nest(pageMd.replace(/^<!--.*-->\n+/, ''))}`;
}

// ---------- Crawl files ----------

/** AI crawlers named explicitly so the allow policy is unambiguous. */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'Amazonbot',
  'meta-externalagent',
  'cohere-ai',
  'DuckAssistBot',
];

export function robotsTxt(siteUrl: string): string {
  return `# Arc showcase site. Everything here is public and may be crawled,
# indexed, quoted and used by search engines and AI systems.
# A Markdown copy of the page is at ${abs(siteUrl, '/index.md')}; a summary for LLMs at ${abs(siteUrl, '/llms.txt')}.

User-agent: *
Allow: /

# AI crawlers and agents: explicitly allowed.
${AI_CRAWLERS.map((ua) => `User-agent: ${ua}`).join('\n')}
Allow: /

Sitemap: ${abs(siteUrl, '/sitemap.xml')}
`;
}

export function sitemapXml(siteUrl: string, lastmod: string): string {
  const entry = (path: string, priority: string): string =>
    `  <url>\n    <loc>${abs(siteUrl, path)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entry('/', '1.0')}
</urlset>
`;
}

export function webManifest(siteUrl: string): string {
  const base = basePath(siteUrl);
  return `${JSON.stringify(
    {
      name: site.name,
      short_name: site.name,
      description: site.description,
      lang: site.language,
      start_url: `${base}/`,
      scope: `${base}/`,
      display: 'browser',
      background_color: site.themeColor,
      theme_color: site.themeColor,
      icons: [
        { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `${base}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: `${base}/favicon.svg`, sizes: 'any', type: 'image/svg+xml' },
      ],
    },
    null,
    2,
  )}\n`;
}
