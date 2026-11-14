import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { normalizeSiteUrl, seo } from './seo/plugin.ts';
import { basePath } from './seo/render.ts';

// Strict Content Security Policy, injected only into production builds so the
// Vite dev server (which relies on inline client code) keeps working.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'arc-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

/** public/CNAME.example is a placeholder for a custom domain; it is not part of the site. */
function dropCnameExample(): Plugin {
  let out = 'dist';
  return {
    name: 'arc-drop-cname-example',
    apply: 'build',
    configResolved(config) {
      out = join(config.root, config.build.outDir);
    },
    async closeBundle() {
      await rm(join(out, 'CNAME.example'), { force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  // SITE_URL (from the environment or a .env file) is the public URL of the site,
  // for example https://robedge.github.io/arc or https://arc.example.org. It sets
  // canonical links, Open Graph, JSON-LD, robots.txt, sitemap.xml and llms.txt, and
  // its path becomes Vite's `base`, so assets resolve under a project Pages URL.
  const rawSiteUrl = process.env.SITE_URL ?? loadEnv(mode, process.cwd(), '').SITE_URL;
  return {
    base: `${basePath(normalizeSiteUrl(rawSiteUrl))}/`,
    plugins: [cspMeta(), seo(rawSiteUrl), dropCnameExample()],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 700,
    },
  };
});
