# Arc showcase site

A scroll-driven marketing site for **Arc**, the local-first macOS agent harness that points
your existing Claude and Codex subscriptions at a whole group of repositories.

It lives in the `website/` folder of the Arc repository as a standalone pnpm project with its
own `package.json` and lockfile: run every command below from this folder. The app's lint,
format, tests and packaging skip it. It is published to GitHub Pages; see
[Deploying to GitHub Pages](#deploying-to-github-pages).

The technique (fixed WebGL stage, scroll-scrubbed scene, loader that resolves into the hero,
HUD callouts) is modeled on igloo.inc; see [docs/igloo-analysis.md](docs/igloo-analysis.md).
All code, copy and visuals here are original; content comes from Arc's product docs.

## Run it

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm dev        # local dev server with hot reload
pnpm build      # typecheck (tsc) and production build into dist/
pnpm preview    # serve the production build
```

Visual check (uses the locally installed Google Chrome through Playwright):

```sh
pnpm build && pnpm preview --port 4173 &
pnpm shots      # writes screenshots/*.png and reports horizontal overflow
pnpm touch      # touch-swipe run through the whole page on a phone viewport
```

Both scripts take an optional URL and output folder, for example
`pnpm shots http://localhost:4173/ screenshots/run1`. `SHOTS_ONLY=m320,landscape` limits
the screenshot runs; `TOUCH_W=320 TOUCH_H=568` changes the touch viewport.

Set `PW_CHANNEL=chromium` to use Playwright's bundled Chromium instead
(`pnpm exec playwright install chromium` first).

## How it is built

- **Vite + TypeScript**, no UI framework. `index.html` holds all content as semantic HTML.
- **three.js** stage (`src/scene/stage.ts`), loaded as a lazy chunk. Everything is
  procedural: the Arc ring (brain), worker nodes, worktree branches drawn as progressive
  tubes, merge pulses, commits on the session branch, a conflict resolver, and the amber
  escalation path. A small custom shader handles the intro particle field.
- **Scroll choreography** (`src/main.ts`): section positions map the scroll offset to a
  single `timeline` value (camera framing) and a `story` value (0..1 through the five
  brain-and-workers steps). The scene is a pure function of those values, so scrolling
  back plays it in reverse.
- **Lenis** smooths native scrolling; anchors, keyboard paging and find-in-page still work.
- **HUD identity**: navy ground `#03080F` with a faint grid, cyan primary, amber for
  attention, green for done, red for errors; Orbitron and Rajdhani for display, JetBrains Mono
  for data (bundled with `@fontsource`, Latin subsets); corner-bracket panels; ring logo.

## Mobile

The layout is mobile-first from 320px up and covered by screenshot runs at 320x568,
375x812, 414x896, 768x1024 and 844x390 (landscape phone).

- **Layout**: fluid type and spacing, `viewport-fit=cover` with safe-area padding, `svh`
  for the hero and `lvh` for the fixed canvas so browser chrome sliding in and out never
  resizes the scene. Below 821px the header becomes a menu button (disclosure pattern,
  closes on Escape, link tap or outside tap) plus the download CTA. Tables, the escalation
  chain and the terminal reflow for narrow screens.
- **Scene**: on portrait screens the camera pulls back to fit the whole diagram, the story
  step text docks at the bottom as a solid card, and the diagram plays above it. Elsewhere
  the scene stays dim behind the copy and its labels hide. Landscape phones keep the
  desktop arrangement (copy left, scene right). Small touch devices get a 1.5 pixel ratio
  cap, fewer particles and coarser geometry, and the pixel ratio steps down further if
  frames run long.
- **Touch**: scrolling is native (Lenis only smooths wheel input), so momentum scrolling
  drives the timeline directly. Parallax follows a mouse only. Hover styles apply only on
  hover-capable devices; tap targets are at least 44px.

## Accessibility and fallbacks

- All copy is real HTML with landmarks, headings, lists and a skip link. The canvas and its
  floating labels are `aria-hidden`.
- Keyboard: every interactive element is reachable with a visible focus ring; the spawn-mode
  tabs follow the WAI-ARIA tabs pattern (arrow keys, Home, End).
- `prefers-reduced-motion: reduce` turns off smooth scrolling, the loader, reveal and scramble
  effects, pulsing, pointer parallax and time-based scene motion. The scene still follows
  scroll position.
- Without WebGL a static SVG diagram of brain, workers, worktrees and merges is shown in the
  brain-and-workers section. Without JavaScript `noscript.css` hides the loader at once and
  the page reads normally (see SEO and LLM readability).
- Text colors meet WCAG AA contrast on the navy ground.

## SEO and LLM readability

All page copy is in the raw HTML response, so crawlers and agents need no JavaScript to read it.
Build-time files for search engines and LLMs are generated from a single source, so they cannot
drift from the page or the product docs.

### Setting SITE_URL

`SITE_URL` is the public origin of the site. It sets the canonical link, the Open Graph and
Twitter URLs, the JSON-LD `@id`s, `robots.txt`, `sitemap.xml` and every link in `llms.txt`.
Set it in the environment or in a git-ignored `.env` file (read through Vite's `loadEnv`):

```sh
SITE_URL=https://arc.example.org pnpm build
```

Without it, the build uses the placeholder `https://arc.example.com` and prints a warning.
Trailing slashes are trimmed.

`SITE_URL` may include a path. That path becomes Vite's `base`, so
`SITE_URL=https://robedge.github.io/arc` builds a site whose assets, favicons, manifest, font
preloads and Markdown and llms.txt links all sit under `/arc/`, while a bare origin builds for
the root. `pnpm preview` serves the build under the same path, and `pnpm seo:check` reads the
path from the canonical link, so `SITE_URL=https://robedge.github.io/arc pnpm build` is checked
at `http://localhost:4173/arc/`.

### Where everything comes from

- `seo/content.ts` is the single source of truth: title, meta description, summary, Open
  Graph image alt text, FAQ (each answer cites its doc section), feature list and
  requirements. Facts come from the product docs. Items the docs mark as _(assumption)_ are
  not stated as facts, and `llms-full.txt` keeps those labels. The A2UI panels feature is not
  in the product docs yet; its facts come from the app's source (`src/main/surface/`,
  `src/main/bridge/tools/show-surface.ts` and the `Surface*.svelte` components), and its FAQ
  entry names those files as its source.
- `seo/docs/` holds vendored copies of `product-definition.md` and `architecture.md` from
  Arc's group knowledge folder. To refresh them, run
  `ARC_DOCS_DIR=".../knowledge/Docs" pnpm docs:sync`.
- `seo/render.ts` holds the renderers and `seo/plugin.ts` the Vite plugin (`arc-seo`). The
  plugin fills three placeholders in `index.html`: `<!-- seo:head -->`, `<!-- seo:noscript -->`
  and `<!-- seo:faq -->`. After the bundle is written it converts the final HTML into the text
  files listed below. `pnpm dev` serves the same generated files from memory.

### Files

| File | Produced by | Contents |
| --- | --- | --- |
| `index.html` head | plugin | Title, description, robots meta (`index, follow, max-image-preview:large`), canonical link, markdown and llms.txt alternates, preloads for the two above-the-fold fonts (Orbitron 700, Rajdhani 500), favicon links, Apple touch icon, manifest link, Open Graph and Twitter `summary_large_image` tags, and one JSON-LD block. `lang`, viewport, `theme-color` and `color-scheme` are in `index.html` itself. |
| JSON-LD | plugin | An `@graph` with `WebSite`, `SoftwareApplication` (macOS, `DeveloperApplication`, features, requirements; no offers, ratings or reviews, since the docs have none) and `FAQPage`. The docs name no organization or author, so there is no `Organization` or `Person`. |
| `#faq` section | plugin | The visible FAQ, rendered from the same data as the `FAQPage` JSON-LD, so the two always match. |
| `<noscript>` in `main` | plugin | Product summary and links to the Markdown and llms.txt copies. |
| `/index.md` | plugin | The page's `<main>` as Markdown (turndown with GFM tables). `aria-hidden` decoration and buttons are dropped, and in-page links become absolute. Linked from the head with `rel="alternate" type="text/markdown"`. |
| `/llms.txt` | plugin | [llmstxt.org](https://llmstxt.org) format: H1, blockquote summary, then link sections (Docs, Page sections taken from the HTML headings, FAQ, Optional). |
| `/llms-full.txt` | plugin | Requirements, features, FAQ with sources, the whole product definition, architecture excerpts (deployment, external services, security, observability) and the page Markdown. |
| `/robots.txt` | plugin | Allows everything. Explicitly allows GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, Applebot, Applebot-Extended, CCBot, Bytespider, Amazonbot, meta-externalagent, cohere-ai and DuckAssistBot. Lists the sitemap. |
| `/sitemap.xml` | plugin | The canonical URL. `lastmod` is the last commit date of `index.html`. |
| `/site.webmanifest` | plugin | Name, description, colors and icons. |
| `public/og-image.png` | `pnpm images` | 1200x630 Open Graph card in the HUD style (ring logo, h1, brain-and-workers branch diagram). Original artwork. |
| `public/favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | `pnpm images` | Rendered from `public/favicon.svg`. |
| `public/noscript.css` | hand-written | Loaded only inside `<noscript>`. It hides the loader and the inert spawn-mode tabs and shows the static story diagram. It is an external file because the CSP forbids inline styles. |

`pnpm images` (`scripts/build-images.mjs`) renders the PNGs and ICO through the locally
installed Chrome with the bundled fonts. Run it again after changing the artwork or
`site.ogHeadline`. The images are committed, so `pnpm build` does not need a browser.

### Content without JavaScript

- Every section is semantic HTML in `index.html`. The canvas, its labels and the loader are
  `aria-hidden` overlays, and no copy is `display: none` or `visibility: hidden`.
- Both spawn-mode panels ship visible. Scripts hide the inactive one only once the tabs
  work. With scripts, the hidden Autonomous panel repeats facts that are also in story step 02.
- The loader is a fixed overlay. It never takes layout space, so it causes no layout shift.
  Without scripts it is hidden at once by `noscript.css`.
- Reveal-on-scroll and text scrambling only run with scripts. The real text stays in the DOM.

### Performance

- Fonts use `font-display: swap` (from `@fontsource`). The two fonts used above the fold are
  preloaded with their hashed URLs.
- three.js stays a lazy chunk (`assets/stage-*.js`). It is never preloaded, and it is imported
  only after the hero text has painted with its web fonts, so the LCP element (the h1) is not
  held up by scene setup.
- There are no `<img>` elements. Inline SVG is sized with CSS.

### Checking

```sh
pnpm build && pnpm preview --port 4173 &
pnpm seo:check      # or: pnpm seo:check http://localhost:<port>/
```

`scripts/seo-check.mjs` checks that every file exists in `dist/`, the head tags, that every
root-relative link sits under the base path and the og, sitemap, robots and llms.txt URLs use
the site URL, OG image size, JSON-LD parsing and types, no invented ratings or prices, a single h1 and a heading
outline with no skipped levels, that in-page anchors resolve, landmarks, the skip link,
section ids, llms.txt shape, Markdown coverage of every heading, the robots rules for each
named AI crawler, and the sitemap. It then loads the page in Chrome with JavaScript off and
confirms every text block is visible, the loader is gone and the visible FAQ matches the
FAQPage JSON-LD. Finally it loads the page with JavaScript on and confirms the loader
finishes and no copy is `display: none`.

Lighthouse (12.x, local Chrome) on the production build: SEO 100, accessibility 100 and
best practices 100 on both mobile and desktop presets. Performance is 100 on desktop and
83-99 on simulated mobile (LCP 1.5-1.7s on the h1, CLS under 0.01). Mobile varies with how
WebGL setup lands inside the measurement window.

## Deploying to GitHub Pages

The site is published from this folder by `.github/workflows/pages.yml` in the repository root.

- **When it runs**: on every push to `main` that changes `website/**`, and on manual dispatch
  (Actions > Deploy website to GitHub Pages > Run workflow).
- **What it does**: installs with pnpm (`--frozen-lockfile`), runs `pnpm build` in `website/`,
  uploads `website/dist` with `actions/upload-pages-artifact` and publishes it with
  `actions/deploy-pages`. The job has `pages: write` and `id-token: write`.
- **One-time setup**: in the repository settings, Pages > Build and deployment > Source, choose
  **GitHub Actions**. Until then the workflow fails at its configure step and nothing is
  published.
- **URL**: `https://robedge.github.io/arc/`. The workflow sets `SITE_URL` from the URL Pages
  reports for the repository, so canonical links, Open Graph tags, `sitemap.xml`, `robots.txt`
  and `llms.txt` all point there.
- **Content Security Policy**: the policy only names `'self'`, which is the origin and not a
  path, so it works unchanged under `/arc/`. The build has no inline scripts or styles.
- **robots.txt**: crawlers read `robots.txt` only at the root of a host, so on a project URL
  (`robedge.github.io/arc/robots.txt`) it is not honored. The page's robots meta tag and the
  sitemap still apply. On a custom domain the file sits at the root and works as usual.

### Custom domain

`public/CNAME.example` is a placeholder and is left out of the build. To move the site to your
own domain:

1. Copy it to `public/CNAME` with the domain alone on one line (for example `arc.example.org`)
   and commit it. The workflow then builds with `SITE_URL=https://<that domain>`, so the base
   path becomes `/` and every generated URL uses the domain.
2. Set the same domain under Settings > Pages > Custom domain and point its DNS at GitHub
   Pages. With the GitHub Actions source, that setting is what makes Pages serve the domain;
   the `CNAME` file alone does not.
3. Update the "Pre-release website" line in the repository README.

## Security

Production builds inject a strict Content Security Policy meta tag (`vite.config.ts`):
scripts, styles and fonts from self only, no inline script, no `eval`, no third-party
requests. The site makes no network calls beyond its own assets and has no analytics.

## Notes

- The `#download-link` button in `index.html` points at
  `https://github.com/robedge/arc/releases/latest/download/Arc-macos-arm64.dmg`. The root
  workflow `.github/workflows/release.yml` publishes a GitHub Release on every push to `main`
  (other than website-only or docs-only changes) and uploads the dmg under that stable name, so
  the link always serves the newest build. The nav and hero buttons scroll to `#download`. If the
  repository moves, update the URL in `index.html` (it is not read from `SITE_URL`).
- Usage meter values in the models section are labeled as illustrative.
- No igloo.inc assets are included. Raw captures from the analysis live in the git-ignored
  `.rea/` folder.
