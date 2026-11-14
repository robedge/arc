# igloo.inc: technique analysis

This note records how https://igloo.inc is built, so the Arc showcase can borrow the
*technique and feel* (not the copy, branding, models, textures or audio). Nothing from
igloo.inc is shipped in this repo; raw captures stay in the git-ignored `.rea/` folder.

## How it was captured

All evidence came from the `rea` CLI (v6.5.0) plus a small Playwright helper that drives
the wheel, because the site ignores keyboard paging.

| Step | Command | Result |
| ---- | ------- | ------ |
| Controlled scenario | `rea capture-browser-scenario .rea/scenario.json` (launch mode, headless Chrome 155, 1440x900, `reduced_motion: no-preference`) | 6 screenshots, 104 requests with headers and bodies, DOM and accessibility tree, 1 console line |
| Script export | `rea export-web-scripts .rea/capture.json .rea/scripts` | `index-*.js` (16.5 KB entry), two workers, the Draco decoder |
| Bundle analysis | `rea analyze-web-bundle http://127.0.0.1:9333 <target> --observation-ms 4000` | chunk graph (`index` -> dynamic import `App3D-*.js`, 1.49 MB), routes `/` and `/portfolio/:project` |
| WebMCP | `rea discover-webmcp-tools ...` | no page-declared WebMCP tools |
| Viewport shots | `rea capture-web-screenshot ...` plus wheel-driven captures at 11 scroll positions | `.rea/shots/` |

The `App3D` chunk was then searched statically (string and identifier counts) to confirm
the libraries and shader patterns below.

## Tech stack

- **Bundler:** Vite (hashed `assets/name-hash.js`, the Vite `modulepreload` polyfill and
  `vite:preloadError` handler are in the entry).
- **UI shell:** Svelte (compiled runtime helpers in the entry chunk). The shell only
  injects global CSS, `@font-face` rules and then dynamically imports the 3D app.
- **3D:** three.js r165 (`window.__THREE__ === "165"`), WebGL2. Everything visible,
  including most text, is drawn in the canvas; `document.body.innerText` is empty and the
  page height equals the viewport.
- **Animation:** GSAP core (tweens, `gsap.matchMedia`) for timeline work; a large number of
  hand-written `lerp`/`damp` calls (108 `lerp` hits) for per-frame easing.
- **Smooth scroll:** no Lenis or ScrollTrigger. A custom virtual-scroll class listens to
  `wheel` (and pointer/touch), accumulates `deltaX/deltaY` into a position vector, derives
  delta and velocity, and emits events. `html, body { overflow: hidden; touch-action: none }`.
  Scroll progress is a number fed to scene uniforms, not a document scroll offset.
- **Assets:** Draco-compressed geometry (`.drc`, ~20 files: terrain, igloo blocks, shattered
  rings, smoke trails, particle clouds), KTX2/Basis textures (~45 files) transcoded in a
  worker, one EXR environment map, MSDF font atlases for in-canvas text (IBM Plex Mono),
  "datatexture" KTX2 files for UI icons, and ~18 OGG audio files decoded in an audio worker.
- **Workers:** image bitmap worker, EXR worker, MSDF worker, audio worker, Draco and Basis
  transcoders. Main-thread work at load is kept small.
- **Credits:** a console line names the studio that built it; no analytics or WebMCP found.

## Layout and section structure

The page is one fixed full-viewport canvas with a thin HTML/canvas HUD on top:

1. **Loader / intro.** A particle cloud (`intro_particles.drc`) materializes into the first
   scene (`uIntroMaterialize`, `uIntroColor` uniforms). The intro is short and leads
   straight into the hero.
2. **Hero: the igloo.** A snow landscape with a glowing igloo, wireframe "constellation"
   lines with numeric labels tracking points on the model, a top-left wordmark, a
   top-right manifesto paragraph, a "Scroll down to discover" hint and a sound toggle at
   bottom-left.
3. **Dive.** Scrolling pushes the camera into the igloo with heavy chromatic aberration and
   blur (scene crossfade through render targets).
4. **Portfolio shards.** Each project is a refractive ice shard (custom transmission shader
   with per-channel IOR offsets) floating in fog, with HUD callouts: scrambled text that
   decodes, a date, "click to explore", thin leader lines and floating numbers.
5. **Ring / logo moments.** A shattered stone ring assembles around a logo; concentric
   rings over a particle sculpture.
6. **Loop.** Scrolling past the end returns to the igloo (the igloo explodes into blocks and
   reassembles), so the experience is a loop rather than a page with a footer.

## Typography

- One family: **IBM Plex Mono** (Medium and Regular) for every label, paragraph and number.
- Small sizes (roughly 12-14 px), uppercase for HUD callouts, sentence case for the
  manifesto, right-aligned blocks at top-right, and `//` / `//////` prefixes as decoration.
- In-canvas text uses MSDF so it can scramble, fade and sit in 3D space.

## Color system

- Ground color `--bgColor: #A0A5B1` (cool grey) shows before the canvas paints.
- The palette is nearly monochrome: snow whites, blue greys and frost blue
  (`uColorFrost #83a1c5`), with white emissive glow. Color comes from lighting, LUT
  grading (`uLUTSize`, `uLUTIntensity`) and chromatic fringing rather than accent hues.

## Interaction and scroll choreography

- Wheel and touch drive a virtual progress value with inertia; each scene maps a sub-range
  of progress to `uProgress`/`uShow`/`uAlpha` uniforms (35 shaders use `uShow`, 29 use
  `uProgress`). Transitions are uniform-driven, so scrubbing backwards plays them in reverse.
- The pointer feeds a small GPU fluid simulation (`uVelocity`, `uPressure`, splat uniforms)
  that disturbs frost and smoke, plus `uMousePos` for parallax and highlights.
- HUD text scrambles in (random glyphs resolve left to right) and numbers tick.
- Sound is off by default with an explicit toggle; UI actions have short sound cues.
- Keyboard handlers exist (`keydown`) for navigation; there is no visible focus UI.

## Asset strategy and performance

- Code split: a 16 KB entry paints immediately; the 1.49 MB 3D chunk loads on demand.
- All heavy assets are compressed for the GPU (Draco, KTX2/Basis), decoded off the main
  thread, and requested in parallel (~100 requests).
- Device pixel ratio is read and capped; many effects are packed into a few full-screen
  passes.

## What the Arc showcase takes from this (and what it does not)

Taken as technique:

- Fixed WebGL canvas behind content, with the camera and object states driven by a single
  smoothed scroll progress value and per-section sub-ranges.
- A short loader that resolves into the hero, scrambled HUD text, thin leader lines and
  numeric callouts, mono typography for data.
- Inertial smooth scrolling and a pointer-reactive scene.
- Small entry chunk, lazy 3D chunk, no large binary assets.

Done differently, on purpose:

- **Real document content.** igloo.inc renders almost everything in the canvas, which is
  invisible to screen readers and keyboard users. The Arc site keeps all copy in semantic
  HTML sections (headings, lists, links) over the canvas, so it reads without WebGL.
- **Lenis on native scroll** instead of a fully virtual scroller, so browser find, anchors,
  keyboard paging and assistive tech keep working.
- **Procedural geometry only.** No downloaded models or textures: the centerpiece is
  built from three.js primitives and small custom shaders.
- **Reduced motion and no-WebGL paths.** `prefers-reduced-motion` disables smooth scroll,
  the loader animation and scene motion; without WebGL a static SVG diagram is shown.
- **No audio.**
- **Arc identity, not igloo's.** Navy HUD ground, cyan/amber/green/red semantics,
  Orbitron/Rajdhani/JetBrains Mono, corner-bracket panels and the ring logo, all from the
  Arc design docs.
