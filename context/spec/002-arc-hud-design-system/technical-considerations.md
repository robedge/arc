# Technical Specification: Arc HUD Design System and Restyle

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

The work is mostly in the renderer.

- **Shared tokens and components:**
  - A single Tailwind v4 `@theme` token file replaces every literal palette class.
  - The default Tailwind palette is reset, so leftover `neutral-*` or `sky-*` classes stop compiling.
  - A small HUD component library is built under `src/renderer/src/lib/components/ui/`. Every screen from spec 001 is moved onto it in vertical slices that keep the app working.
- **Fonts:** bundled from `@fontsource` (latin subset, woff2), because the CSP allows only `'self'`.
- **Motion:** pure CSS. A single `prefers-reduced-motion` media query feeds both the CSS and a small motion store.
- **Main process:**
  - The window gets a minimum size, an always-dark native theme and a hidden-inset title bar.
  - A custom application menu adds Help › Design Preview.
  - The Design Preview opens as a separate static window. It is a second renderer entry with no IPC.
- **Packaging:** an SVG icon master is rendered to `.icns` by a committed generation script. The installer gets the icon, and the OFL font licenses are bundled.
- **Behavior:** no IPC contracts, stores or behavior from spec 001 change.

Existing components and test locators are reused deliberately:
- **Names and props:** `Button`, `Modal`, `TextField`, `Toaster`, `SaveIndicator` and `DropZone` keep their names and remain backward compatible.
- **Native elements:** they stay in the DOM (custom radios and checkboxes wrap a visually hidden native input).
- **Accessible names, roles and visible text:** unchanged, so the roughly 620 `getByRole`, `getByLabel` and `getByText` locators and the `.cm-content` selector keep working.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1. Design tokens (`src/renderer/src/styles/tokens.css`)

Tokens are imported by `app.css`, which every renderer entry loads.
- `@theme { --color-*: initial; }` first, then semantic tokens. They generate both the utilities (`bg-surface-panel`) and the CSS variables (`var(--color-accent)`).
- `:root { color-scheme: dark }`, with no `dark:` variants.

| Token | Value | Use |
|---|---|---|
| `--color-ground` | `#03080F` | Window background |
| `--color-grid-line` | `rgba(0,229,255,.05)` | 40px grid (two `linear-gradient`s on `body`) |
| `--color-surface-panel` | `rgba(6,22,36,.72)` (about `#05121E` on ground) | Panels, dialogs |
| `--color-surface-raised` | `#0A2233` | Inputs, framed viewer backdrops |
| `--color-surface-code` | `#020609` | Code blocks |
| `--color-surface-hover` / `-selected` | cyan at 8% / 14% | Row and tab states |
| `--color-surface-scrim` | `rgba(2,6,12,.65)` | Dialog backdrop (plus `backdrop-blur`) |
| `--color-border` | `rgba(0,229,255,.18)` | Decorative panel outline |
| `--color-border-strong` | `rgba(0,229,255,.45)`, raised to meet 3:1 if the contrast test requires | Functional outlines: inputs, checkbox, radio, toggle |
| `--color-text` / `-bright` / `-muted` | `#CFEFF7` / `#E8FCFF` / `#7FB3C4` | Text |
| `--color-text-faint` | `#6A9FB0` | Hints and timestamps. The mockup's `#4F8698` fails 4.5:1 on hovered and selected rows, so it stays only as `--color-line-faint` for dividers |
| `--color-accent` / `-ink` | `#00E5FF` / `#02161C` | Active, primary, info, focus / text on solid cyan |
| `--color-attention` / `-ink` / `-text` | `#FFB74D` / `#1A1206` / `#FFE2B8` | Waiting on the user, warnings |
| `--color-success` | `#6EE7B7` | Done, saved |
| `--color-danger` / `-ink` | `#FF6B6B` / `#1A0606` | Errors, destructive actions (7.24:1 on ground; confirmed) |
| Fonts | `--font-display` Orbitron, `--font-sans` Rajdhani, `--font-mono` JetBrains Mono | `--font-sans` override makes Rajdhani the body default |
| Radii | `--radius-hud` 2px, `--radius-control` 3px, `--radius-pill` | |
| Glows | `--shadow-glow-accent`, `--shadow-glow-attention`, `--shadow-glow-danger`, `--shadow-focus` (a 2px ground gap plus a 2px cyan ring) | |
| Motion | `--duration-fast` 120ms, `--duration-base` 200ms, `--duration-draw` 300ms (the entrance cap); ambient: `--duration-pulse` 2400ms, `--duration-idle-spin` 24s; `--ease-hud` | |
| Sizes | `--size-hit` 44px, `--size-bracket` 14px, `--size-sidebar` 18rem; tracking `--tracking-label` .16em, `--tracking-title` .22em | |

**Kind table.** One lookup table in `ui/kinds.ts` maps the message kinds `info | success | warning | error` and the button variants `primary | secondary | danger | attention` to their token, icon and tone. Toast, Banner, Button and fields all use it, so color meaning can't drift between components.

**Contrast.** The computed ratios are in §4. The contrast test is the source of truth.

### 2.2. Fonts (`src/renderer/src/styles/fonts.css`)

**Packages:** exact pinned versions, per-weight latin subsets.
- `@fontsource/orbitron`: 500 and 700. Used for the wordmark and titles only, at 14px and above.
- `@fontsource/rajdhani`: 400, 500 and 600. Body text uses 500. Nothing is set below 12px, and text under 16px is never lighter than 500.
- `@fontsource/jetbrains-mono`: 400 and 600.

**Inlining:** `build.assetsInlineLimit: 0` keeps fonts from being inlined as `data:` URIs, which `default-src 'self'` would block.

**Loading:** `<html>` gets `.fonts-ready` after `document.fonts.ready`, so the draw-in never shows fallback text. Interaction is not delayed.

**CSP:** no change. Bundled assets count as `'self'`.

### 2.3. Component library (`src/renderer/src/lib/components/ui/`)

Each component uses Svelte 5 `$props()` and a typed props interface. Callbacks are props.

| Component | New / changed | Contract |
|---|---|---|
| `Panel` | new | `brackets: 'diag' \| 'none'`, `title?`, `as?`, `scroll?` (body `min-h-0 flex-1 overflow-auto`), `tone?: default \| accent \| attention`, `drawIn?`, `header`/`footer` snippets. The corner brackets are `aria-hidden` spans with `pointer-events: none` and `data-bracket` |
| `Button` | changed | variants `primary \| secondary \| danger \| attention`; `busy` sets `aria-busy` and blocks clicks while keeping the label; `size: md \| icon`; at least 44px |
| `IconButton` | new | `label` is required and becomes `aria-label`, so an unlabeled icon button is a type error; `icon`, `variant` |
| `TextField`, `TextArea`, `Select`, `Toggle` (`role="switch"`), `Checkbox`, `Radio` | changed / new | the existing `error` wording and `role="alert"` are kept; `aria-invalid` and `aria-describedby` are added; native inputs stay in the DOM |
| `Modal` | changed | API kept. Adds the scrim and blur, a `Panel` frame, draw-in, `size: sm \| md \| lg` (replacing `w-96`), `busy` (Escape ignored while busy, preserving `DialogHost`'s current rule) and `closeable`. The focus trap and Escape logic are reused, not rewritten |
| `Toaster` | changed | toast store entries gain an optional `kind` (default `info`); each toast shows an icon and the text |
| `Banner` | new | `kind: warning \| error \| info`, `title?`, `actions` snippet. Replaces `banners/ChangedOnDiskBanner` and `banners/StorageMissingBanner` markup with the same text and buttons |
| `AttentionBadge` | new | `count`, `onclick`; visible text is the count and "Needs attention"; `aria-label` is "Needs attention, N waiting"; pulses unless motion is reduced (`data-pulse`) |
| `attention/AttentionDialog` | new | `open` (bindable), `requests: AttentionRequest[]`, `onApprove(id)`, `onDeny(id)`, `onAnswer(id, text)`, `onClose`. Escape and Close only call `onClose` |
| `attention/PermissionCard` / `QuestionCard` | new | `from`, `action` (mono box), `reason`, `onApprove`/`onDeny` / `from`, `question`, `onSend`; Send is disabled while the answer is empty |
| `Icon` + `icons.ts` | new | about 12 hand-authored 24×24 stroke icons (1.75 stroke, `currentColor`); decorative by default, `title` makes them `role="img"`; no icon library and no emoji |
| `Wordmark`, `RingLogo` | new | the ring and "ARC" in Orbitron; `RingLogo` spins slowly unless reduced (`data-spin`) |

`AttentionRequest` is a renderer type (`{ id, kind: 'permission' | 'question', from, action?, reason?, question? }`). The sessions spec feeds it real data later, and only this type needs to agree with that spec.

**Raw elements to replace** (roles, `aria-selected` and labels kept):

| Where | Replacement |
|---|---|
| `SectionNav` tabs | `.hud-tab` |
| `GroupSidebar`, `ItemList`, `ProjectRow` | `.hud-row` with `data-selected`, plus `IconButton` for row actions |
| `LinksSection` | `TextField`, `Button`, `IconButton` |
| `ItemDetail` inputs | `TextField` |
| `ItemSection` textarea | `TextArea` |
| `UnlinkDialog`, `LinkFolderDialog` radios | `Radio` |
| `ImportConflictDialog` checkbox | `Checkbox` |

Text that tests match with `getByText` stays in a single text node.

### 2.4. Motion (`src/renderer/src/lib/motion.ts`, `lib/stores/motion.svelte.ts`)

- **Decorative effects use CSS keyframes:** the draw-in (an outline trace plus bracket scale, animating `opacity`, `transform` and `clip-path` only), the badge pulse (glow intensity between 0.55 and 1.0 every 2.4 s, not an on/off flash) and the logo spin (24 s).
- **`svelte/transition`** is used only where an exit must stay mounted: `Modal` and `Toaster`. They use a `hudDraw` transition whose duration comes from the motion store.
- **One reduced-motion source:**
  - `@media (prefers-reduced-motion: reduce)` turns off all animations and transitions.
  - `motion.reduced` mirrors the same media query through `matchMedia` with a change listener, and sets `data-motion="reduced"` on `<html>`.
  - Chromium maps macOS "Reduce motion" to this query. Main forwards nothing.
- **Interaction during entrance:** entrances never set `pointer-events: none`, never use `inert`, and never wait for `animationend` before allowing input. Focus moves synchronously on mount.

### 2.5. Fixed-height layout

- `html`, `body` and `#app` are `h-full overflow-hidden`. `body` gets the ground color and the grid.
- `App.svelte` uses a grid of `[--size-sidebar] minmax(0,1fr)` with gap and padding.
- The main column is `flex min-h-0 flex-col`: the group header and `SectionNav` are `shrink-0`, and the content is `min-h-0 flex-1`. The content is item-list `Panel scroll` beside editor `Panel scroll`.
- Every flex or grid ancestor of a scroller gets `min-h-0` (and `min-w-0`).
- Remove `max-h-[70vh]` and wrapper `h-screen` classes. CodeMirror's `.cm-scroller` is the editor's only scroller.
- The renderer is laid out and checked at 1100×720, which main enforces as the minimum size (§2.8).
- **Title bar (confirmed):** the main window uses `hiddenInset`.
  - A full-width title bar (`ui/TitleBar`, 40px, `--size-titlebar`) runs across the top of the window, above the sidebar and main column. The traffic lights sit vertically centered inside it on the left, and nothing else is placed in their area. The bar has a faint surface fill and a hairline bottom border so it reads as the place to grab. It is `-webkit-app-region: drag` end to end, double-click zooms the window (native behavior), and any interactive child is `no-drag`. The panel grid starts below it, so no panel or bracket sits under the traffic lights.
  - Dialog overlays never sit under a drag region.
  - In fullscreen there are no traffic lights, and the reserved gap is accepted.

### 2.6. Editor, preview and viewers

- **CodeMirror** (`lib/editor/hud-theme.ts`):
  - `hudTheme` is `EditorView.theme({...}, {dark: true})` plus `syntaxHighlighting(hudHighlight)`. It reads token variables.
  - Transparent background, mono font for code languages, and Rajdhani 16px for Markdown.
  - The focus ring sits on the container through `:focus-within`.
  - Highlight colors: strings green, keywords cyan, numbers amber, comments muted, invalid danger. All of them are included in the contrast test.
  - Both `MarkdownEditor` and `TextDocEditor` get the theme from one shared extension factory.
- **Markdown preview:**
  - Rules move to `styles/markdown-preview.css`, keeping the `.markdown-preview` class.
  - Headings use the display font, uppercase, tracked and bright, with h1 at 24px or more.
  - Body text is Rajdhani 16/1.6. Code is mono on `surface-code`. Links are cyan and underlined. Blockquotes get a cyan rule, and tables use border tokens.
- **PDF (confirmed):** pages stay white on a framed `surface-raised` backdrop with a thin cyan border. The fixed 720px width and `max-h-[70vh]` are removed, the panel scrolls, and the controls become `IconButton`s.
- **Image:** `object-contain`, filling the panel.
- **Text viewer:** mono on `surface-code`.

### 2.7. Design Preview (second renderer entry)

- **Files:**
  - `src/renderer/preview.html`, with the same head as `index.html` and `<title>Design Preview</title>`.
  - `src/renderer/src/preview.ts`, which imports `app.css` and mounts `lib/preview/DesignPreview.svelte`.
- **Build:** `electron.vite.config.ts` sets `renderer.build.rollupOptions.input` to `{ index, preview }`. `cspMeta()` already runs once per HTML entry.
- **Content:** only `ui/` components with local `$state`:
  - the wordmark
  - color and type swatches
  - every button variant, with disabled and busy states
  - every field, including the error "Group name is required."
  - banner kinds
  - toast triggers, with each message prefixed "Sample:"
  - panels, including a scrolling one
  - a sample modal
  - `AttentionBadge` with count 2 and an `AttentionDialog` holding one permission card (`git push origin arc/sample`) and one question card. Approve, Deny and Send only update a local "last action" line, and the count never changes.
  - the live `motion.reduced` state
- **Labels:** every sample is labeled "Sample".
- **Purity:** `ui/` stays IPC-free, so the preview needs no preload.

### 2.8. Main process

| Area | Change |
|---|---|
| `src/main/app/window-options.ts` (new, pure) | `mainWindowOptions(preload)`: `minWidth: 1100`, `minHeight: 720`, `backgroundColor: HUD_BACKGROUND ('#03080F')`, `titleBarStyle: 'hiddenInset'`, `trafficLightPosition`, plus the existing hardened `webPreferences` |
| `bootstrap.ts` | `nativeTheme.themeSource = 'dark'` before windows open. The application menu is installed before `createWindow`. `activate` checks `getMainWindow()` rather than `getAllWindows().length`. Dev builds only: `app.dock.setIcon(resources/icon.png)`, guarded |
| `src/main/app/lockdown.ts` (new) | `lockDownWindow(win, ownUrl)`, extracted from `createWindow`: deny `setWindowOpenHandler`, restrict `will-navigate` (full-URL match for the preview, so it can't navigate to the main app), prevent `will-attach-webview`. Main window behavior is unchanged |
| `src/main/app/app-menu.ts` (new, pure builder) | `buildAppMenuTemplate({ isDev, appName, openDesignPreview })`. **App:** about, hide, hide others, unhide, quit (quit still routes through `before-quit` and the close gate). **File:** close. **Edit:** all clipboard, undo and select-all roles (required for editor shortcuts). **View:** reload, force reload and dev tools only when `isDev`, plus full screen; zoom items removed to protect the fixed layout (confirmed). **Window:** minimize, zoom, front. **Help:** `id: 'help-design-preview'`, label "Design Preview" |
| `src/main/app/preview-window.ts` (new) | `openDesignPreview()` keeps a single instance and focuses or restores it on repeat. 1000×760, minimum 720×520, `titleBarStyle: 'default'`, no parent, same hardened `webPreferences` and **no preload**, `lockDownWindow` applied. Dev loads `${ELECTRON_RENDERER_URL}/preview.html`; production loads `../renderer/preview.html` with `loadFile`. No close-gate listener, and never passed to `setMainWindow` |
| IPC | No change. `register.ts` trusts only the main window's top frame, and `emit()` targets only the main window, so the preview can't call or receive IPC. A comment documents this |

### 2.9. Icon and packaging

- **Sources (committed):**
  - `resources/icon/arc-icon.svg`: 1024 canvas, an Apple-template squircle about 824px wide with a corner radius of about 185px, a navy gradient from the tokens, a cyan ring about 62% of the width with a stroke of about 70 units, and a glow built from SVG primitives (a wider low-opacity stroke plus `feGaussianBlur`).
  - `resources/icon/arc-icon-small.svg`: used for 16–64px. It has a stroke of about 110 units, a reduced halo and no shadow.
  - The SVGs contain no `<text>`, CSS filters or blend modes.
- **Generation:**
  - `scripts/build-icons.mjs`, run as `pnpm icons`, uses the pinned devDependency `@resvg/resvg-js` (N-API prebuilds, no network needed).
  - It renders the Apple `.iconset` sizes (16 to 512@2x), then runs `iconutil -c icns` to write `resources/icon.icns` and a 1024px `resources/icon.png`. Both outputs are committed, so `pnpm package` never needs the tool.
  - The script is macOS-only, and exits non-zero with a clear message when `iconutil` is missing.
- **`electron-builder.yml`:**
  - `directories.buildResources: resources` and `mac.icon: resources/icon.icns`.
  - A `dmg:` block with `icon`, a 540×380 window, an icon size of 96, Arc and `/Applications` positions, and the title "Arc".
  - A HUD DMG background (confirmed in scope): a navy grid with a cyan arrow pointing to Applications and no baked-in text. It is rendered at 1x and 2x by the same resvg script (`resources/dmg/background.svg`), combined with `tiffutil -cathidpicheck` into `resources/dmg/background.tiff`, and referenced as `dmg.background`.
  - Ad hoc signing (`afterPack`) already runs after the icon is copied into the app, so it is unchanged.
- **Fonts in the package:**
  - The woff2 files land in `out/renderer/assets` inside `app.asar`, with no `asarUnpack` needed.
  - `resources/licenses/FONTS-OFL.txt`, with copyright strings copied from each package's `LICENSE`, goes into `extraResources` under `licenses/`.
  - The README gains a "Third-party fonts" section.

### 2.10. Delivery slices

Each slice leaves the app building and every test passing.

1. **Tokens, fonts and shell:**
   - tokens, the palette reset, fonts, the grid
   - `Panel`, `Icon`, `Wordmark`/`RingLogo` and the motion store
   - the fixed-height shell
   - a mechanical sweep that replaces every literal palette class, one folder at a time
   - main window options, the dark theme and the hidden-inset title bar with drag regions
2. **Controls:** `Button` variants and busy state, `IconButton`, fields, focus ring, 44px targets, and the raw-element replacements.
3. **Dialogs:** the `Modal` restyle, then the 8 dialogs in `DialogHost`, one at a time, with markup and class changes only.
4. **Messages:** toast kinds with icons, `Banner`, and `SaveIndicator` (the word plus a check).
5. **Items, editors and viewers:** the CodeMirror theme, the preview CSS, and the PDF, image and text viewers. Notes, Playbooks, Docs, Links and custom sections.
6. **Storage, settings and projects:** the storage settings and progress, and the Projects states.
7. **Attention and Design Preview:** the attention components and the preview entry on the renderer side, plus the menu, preview window and lockdown in main.
8. **Icon and packaging:** the SVGs, `pnpm icons`, the builder config, the dev Dock icon and the font licenses.
9. **Accessibility audit:** the Tab-order pass, the VoiceOver label sweep, the contrast test made final, the reduced-motion check, and screenshots.

---

## 3. Impact and Risk Analysis

**System dependencies:**
- **Renderer:** all ~40 renderer components are touched, but their logic is not.
- **Main:** the window, menu and preview changes touch `bootstrap.ts` lifecycle code that the close gate depends on.
- **Packaging:** the packaging config changes.
- **Sessions spec:** it will consume `AttentionRequest`, `AttentionBadge`, `AttentionDialog` and `Panel`.

| Risk | Mitigation |
|---|---|
| Locators break because roles, labels or text move | Native elements stay; text stays in one node; every slice runs the full renderer and e2e suites; the e2e specs from spec 001 must pass unmodified |
| Leftover default styling | Palette reset makes old classes stop compiling; a unit test greps `src/renderer` for `neutral-`, `sky-` and other default palette classes |
| The whole window scrolls (a missing `min-h-0`) | One layout recipe; an e2e test asserts `document.scrollingElement` doesn't scroll |
| Fonts blocked by the CSP, inlined, or working only in dev | `assetsInlineLimit: 0`; packaged-build verification with `document.fonts.check()` and a screenshot |
| Faint or functional-border contrast fails | Adjusted tokens; contrast unit test covering every declared pair |
| Drag region swallows clicks | `no-drag` on interactive children; e2e clicks on the first sidebar controls; plain title bar as a fallback |
| Custom menu breaks Cmd+C/V/Z, or reload races the close gate | Edit roles; reload in dev only; unit test on the menu template; e2e paste and select-all |
| Preview trusted by IPC, navigating away, or blocking quit | No preload; full-URL navigation lock; no close-gate listener; e2e checks quit with the preview open and that `window.harness` is undefined there |
| E2E fixtures pick up the preview as `firstWindow()` | Fixtures pick windows by URL (`index.html`) |
| Reduce Motion not updating live in Electron 44 | A manual toggle check is recorded; fall back to reading the setting at load |
| Rajdhani and Orbitron hard to read at small sizes | Minimum sizes and weights (§2.2) |
| `backdrop-filter` jank | Scrim only while a dialog is open; plain scrim fallback |
| Icon blurry at 16px; macOS icon cache | Small-size variant plus manual review; `touch` the app and `killall Dock` and Finder; verify a fresh copy in `/Applications` |
| Missing OFL attribution | `FONTS-OFL.txt` in `extraResources` plus a README section (required) |
| `DialogHost` (309 lines) is the largest single change | One dialog at a time, markup only |

---

## 4. Testing Strategy

**Unit (`tests/unit`, node):**
- **`contrast.test.ts`:** parses `tokens.css` and computes WCAG ratios for a declared pair list. Panel colors are alpha-composited before measuring.
  - **Text** (normal, bright, muted, faint, accent, attention, attention text, success, danger) on the ground, panel, hover and selected surfaces must reach 4.5:1.
  - **Ink on solid fills** must reach 4.5:1.
  - **Functional borders and large headings** must reach 3:1.
  - **Highlight colors** on the panel must reach 4.5:1.
  - **Measured so far:**
    - text 15.6 on the panel
    - muted 8.23 on the panel and 6.11 on the selected surface
    - faint `#6A9FB0` 4.81 on the selected surface
    - accent 12.3 on the panel
    - amber 10.9 on the panel
    - danger 6.81 on the panel
    - ink on amber 10.7
- **Guards:**
  - the motion cap: no entrance duration over 300ms, with the ambient group exempt
  - no default palette classes in `src/renderer`
  - a denylist of Marvel names in `src/renderer`, `src/main` menu labels and `resources`
- **Main:** `window-options.test.ts`, `app-menu.test.ts` (Help item, Edit roles, no reload when not dev, no banned labels), `preview-window.test.ts` (single instance, no preload, no close handler, reference cleared on close), `lockdown.test.ts`. The existing `close-gate` and IPC sender tests must still pass.

**Renderer component tests (`tests/renderer`, jsdom):**
- **Button:** variants, `busy` sets `aria-busy` and blocks clicks, and disabled blocks clicks.
- **Fields:** error wording, `aria-invalid` and `aria-describedby`.
- **Radio, Checkbox, Toggle:** keyboard use and accessible names.
- **Modal:**
  - focus stays trapped
  - Escape closes it, but is ignored while busy
  - Tab and Enter work immediately after opening, without advancing timers
- **Reduced motion:** with `matchMedia` mocked, `data-motion` is set, transitions take zero time, and there is no `data-pulse` or `data-spin`.
- **Focus ring contract:** a table-driven test checks that every interactive `ui` root has the `focus-visible` shadow class.
- **Toasts and banners:** each kind shows an icon and text.
- **Attention:**
  - Escape and Close call only `onClose`
  - the close button is named "Close"
  - the action is shown in mono, and the Approve and Deny buttons carry the 44px class
  - the badge shows the count and "Needs attention"

**E2E (Playwright `_electron`):**
- **Window:** minimum size `[1100, 720]`, background `#03080F`, and `nativeTheme.shouldUseDarkColors` is true.
- **Menu:** Help › Design Preview is present, and select-all, cut and paste work through the Edit roles in an editor.
- **Preview:**
  - Opened by clicking `help-design-preview` through `app.evaluate`. A second click still leaves exactly two windows.
  - `window.harness` is undefined, and the CSP meta is present in the built page.
  - The badge shows 2, and clicking it opens a permission card and a question card. Escape closes the dialog and the count stays 2.
  - The Approve and Deny bounding boxes are at least 44px tall.
  - Closing the preview leaves the app running, and quitting with both windows open exits promptly.
- **Layout:** with 60 notes only the item list scrolls, the document never scrolls, and nothing clips at 1100×720.
- **Reduced motion:** `page.emulateMedia({ reducedMotion: 'reduce' })` on both pages. A dialog appears at full opacity at once, `getAnimations()` on the badge is empty, and `data-motion="reduced"` is set.
- **Regression:** the full spec 001 e2e suite (49 specs) runs unmodified.

**Packaged build:**
- `CFBundleIconFile` is `icon.icns`, and `codesign --verify --deep --strict` passes.
- The woff2 fonts are in the asar, and `licenses/FONTS-OFL.txt` is present.
- The mounted DMG shows the icon.
- In the launched app, `document.fonts.check()` passes for all three families.
- A manual check confirms the icon reads as a ring at the smallest Finder list size.

**Not adding:** Playwright pixel-comparison screenshots. The look is still being tuned, and glow and blur rendering isn't pixel-stable across machines. Instead, verify-ui screenshots are saved per slice to the session scratchpad for manual review. This can be revisited later, scoped to the Design Preview with motion off.

**Manual checks, recorded during verify:**
- macOS Light appearance still shows the dark HUD.
- Toggling Reduce Motion while the app runs updates it live.
- VoiceOver reads "Close" on the attention dialog's close button.
