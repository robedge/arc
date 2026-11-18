# Technical Specification: Voice Companion (Nova)

- **Functional Specification:** [functional-spec.md](./functional-spec.md)
- **Status:** Completed
- **Author(s):** redgell

---

## 1. High-Level Technical Approach

Nova is a renderer feature built on the session's existing brain plumbing, plus a local speech stack. It adds no new provider path.

- **Talking to the brain:** a spoken turn is an ordinary `sessions:send-message` call with a new `spoken` flag. Answers are the existing `session:message` and `session:brain-state` events. No new orchestration is involved.
- **Hearing (speech to text, STT):** the renderer captures the microphone, detects speech with Silero VAD (`@ricky0123/vad-web`), and streams 16 kHz PCM to a new Electron `utilityProcess`. The utility process runs two native, N-API speech engines:
  - **sherpa-onnx** streaming Zipformer for live partial words;
  - **whisper.cpp** (`@fugood/whisper.node`) for the final transcript of the finished utterance.

  The final transcript is what gets sent to the brain.
- **Speaking (text to speech, TTS):** Kokoro-82M through `kokoro-js` runs in a renderer Web Worker (WebGPU fp32; WASM only as a slow, degraded fallback, see 2.4). Answers are synthesised one sentence at a time and played through a single `AudioContext` in the same renderer that owns the mic, so Chromium's echo cancellation has the playback reference. An `AnalyserNode` gives the speech level that drives the face.
- **Face:** a frame set generated once, offline, from the user's portrait with LivePortrait. It is a base image plus mouth and eye patches, committed to the repo. A canvas compositor blends the patches from the smoothed audio level and adds random blinks, thinking glances and micro-motion.
- **Models:** the speech models (Kokoro fp32 326 MB, Zipformer en-20M 44 MB, Whisper base.en 148 MB; about 520 MB in total) are downloaded on first use, after the user confirms, into `userData/voice-models/`. They are served to the renderer through a read-only custom protocol. Models are never bundled in the app.
- **What the user hears:** a local pure function turns each brain answer into a short spoken version. The brain is not asked to summarise, so there is no extra token cost or delay.

Systems affected:
- the renderer (session screen, a new Nova store and components, Settings);
- shared IPC contract;
- main process (permissions, speech host, model manager, a new protocol, CSP);
- database (one column);
- packaging (native addons, `Info.plist`, licences);
- a new offline asset script.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Architecture changes

| Area | New / changed | Responsibility |
|---|---|---|
| Renderer | `src/renderer/src/lib/nova/` | Nova state machine, audio, TTS worker, face driver, spoken-text shaping |
| Renderer | `src/renderer/src/lib/components/nova/` | Panel UI |
| Main | `src/main/app/permissions.ts` | Media permission handlers (audio only, own origin) |
| Main | `src/main/voice/speech-host.ts` | Supervise the speech `utilityProcess` (lazy start, idle stop, one restart on crash) |
| Utility process | `src/main/voice/speech-worker.ts` | Load sherpa-onnx and whisper.cpp; turn PCM into partial and final text |
| Main | `src/main/voice/speech-protocol.ts` | zod-typed messages between main and the speech worker |
| Main | `src/main/voice/model-manager.ts`, `model-manifest.ts` | Pinned model manifest, download, resume, checksum, progress |
| Main | `src/main/protocol/voice-model-request.ts` | `arc-voice-model:` read-only handler, modelled on `knowledge-request.ts` |
| Main | `src/main/ipc/handlers/voice.ts` | `voice:*` IPC handlers |
| Shared | `src/shared/spoken-text.ts` | Pure spoken-version shaper (shared so both sides can test it) |
| Tooling | `scripts/nova-face/` | One-off LivePortrait frame generation; not part of the build |
| Assets | `src/renderer/src/assets/nova/` | Generated `manifest.json`, base and patch WebP files (budget ≤ 2.5 MB) |

The speech process is a separate entry in electron-vite's main build (`out/main/speech-worker.js`), started with `utilityProcess.fork`. Native addons never load in the sandboxed renderer or in the main process.

### 2.2 Data model and settings

**Database:** one migration, `0033_message_spoken.sql`.

| Table | Change | Notes |
|---|---|---|
| `messages` | Add `spoken INTEGER NOT NULL DEFAULT 0` | Set only on user messages sent from Nova. Mapped to `SessionMessage.spoken?: boolean` in `src/shared/types/session.ts`. |

Also update the Drizzle schema in `src/main/db/schema/sessions.ts`, `messagesRepo.append`, the row mapper and the migration journal.

**App settings:** these are new keys in the `app_settings` KV table, following the dotted pattern of `approvals.skipAllByDefault`. They are added to:
- `app-settings-repo.ts` schemas, defaults and `getAll()`;
- `AppSettings` in `src/shared/types/provider.ts`;
- the `settings:set` schema;
- the settings handler patch;
- the `DesignPreview` fixture.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `voice.voiceId` | string (Kokoro voice id) | `af_heart` | Selected voice |
| `voice.speed` | number 0.7–1.3 | `1` | Speaking speed |
| `voice.speakPolicy` | `'all' \| 'spoken-only'` | `'all'` | Speak every answer, or only answers to spoken questions |
| `voice.muted` | boolean | `false` | Mute persists across panel opens |
| `voice.endPauseMs` | number 500–2000 | `800` | Pause that ends a turn (tunable, not in Settings UI for v1) |

**Model storage:** `userData/voice-models/<id>@<version>/…`. Partial downloads go to `<id>.partial` with a `.meta` file holding the offset, and are renamed atomically after a sha256 check. Nothing goes in SQLite.

### 2.3 IPC contracts

All channels are declared in `src/shared/ipc/contract.ts` with zod.

**Changed channel**
- `sessions:send-message` gains `spoken?: boolean` (still `.strict()`). The renderer's local insert in `activeSession.send(text, { spoken })` sets the same flag. `MessageBubble` shows a small mic marker on spoken messages.

**New invoke channels (renderer to main)**

| Channel | Request | Response |
|---|---|---|
| `voice:mic-status` | `{}` | `{ status: 'granted' \| 'denied' \| 'restricted' \| 'not-determined' }` |
| `voice:ask-mic` | `{}` | `{ granted: boolean }` (calls `systemPreferences.askForMediaAccess`) |
| `voice:open-mic-settings` | `{}` | `{}` (main opens a hard-coded `x-apple.systempreferences:…Privacy_Microphone` URL) |
| `voice:models-status` | `{}` | `{ models: { id, kind, state: 'missing' \| 'downloading' \| 'ready' \| 'failed', bytes }[] }` |
| `voice:download-models` | `{}` | `{}` (progress arrives as events) |
| `voice:delete-models` | `{}` | `{}` |
| `voice:open` / `voice:close` | `{}` | `{}` (start or stop the speech host) |
| `voice:begin-utterance` | `{ utteranceId }` | `{}` |
| `voice:end-utterance` | `{ utteranceId }` | `{ text: string }` (Whisper final; empty string means nothing was understood) |
| `voice:cancel-utterance` | `{ utteranceId }` | `{}` |

**New fire-and-forget channel**
- `voice:pcm` `{ utteranceId, seq, samples: ArrayBuffer }`. Samples are mono Int16 at 16 kHz in 100 ms chunks (3,200 bytes). Validation checks only `byteLength` (≤ 1 s of audio) and integer `seq`. This needs a new allow-listed `send` method on `window.arc`, because the preload currently exposes only `invoke` and `on`.

**New events (main to renderer)**
- `voice:partial {utteranceId, text}`
- `voice:engine-state {state: 'off'|'starting'|'ready'|'failed'}`
- `voice:model-progress {id, receivedBytes, totalBytes, state}`
- `voice:error {code, utteranceId?}`

**Error codes**

| Code | Panel behaviour |
|---|---|
| `mic-denied` | Spec message plus the System Settings button |
| `mic-unavailable` | "No microphone found." |
| `offline` | Retry |
| `model-corrupt` | One automatic redownload, then an error |
| `engine-crashed` | One automatic restart, then an error |
| `tts-failed` | Fall back to text only |

**Speech worker protocol** (main and utility process, `postMessage`)
- Main to worker:
  - `init {modelPaths}`
  - `begin {utteranceId}`
  - `pcm {utteranceId, seq}` (with the transferred buffer)
  - `end {utteranceId}`
  - `cancel {utteranceId}`
  - `shutdown`
- Worker to main:
  - `ready`
  - `partial {utteranceId, text}`
  - `final {utteranceId, text}`
  - `error {utteranceId?, code, message}`

### 2.4 Component breakdown (renderer)

**Panel and layout**
- **`components/nova/NovaPanel.svelte`** is a `Panel` (`brackets='diag'`, `as='aside'`) containing:
  - `NovaFace` (canvas);
  - the state label and live transcript (`aria-live="polite"`);
  - controls: Start/End conversation, Cancel, Stop, Mute, Close;
  - a status banner for mic and model-download states, with the download confirm and progress.
- **Session screen:**
  - `SessionScreen.svelte` adds a third body column only while Nova is open, sized with a container query on the session body: the chat column never goes below 480 px, Nova shrinks first (340 px down to 240 px), and when the body is narrower than the three columns plus gaps (1044 px) the Brain/workers/event-log column is hidden (still mounted) until Nova closes or the window widens. The class constants go into `tests/unit/session-layout-classes.test.ts`.
  - The panel stays mounted under the review overlay.
  - The existing session-change `$effect` calls `nova.closeAndStop()`.
- **`SessionHeader.svelte`:** a Nova `IconButton` (`aria-pressed`) next to `UsageChip`.

**State machine**
- **`nova/machine.ts`** is a pure transition function, so it can be tested without Svelte or audio.
  - States: `idle | listening | thinking | speaking`, plus `conversationRunning` and `error`.
  - Events: `start`, `speechStart`, `partial`, `speechEnd`, `final`, `empty`, `brainSettled`, `speakDone`, `bargeIn`, `cancel`, `stop`, `end`, `silenceTimeout`, `mute`, `attentionNew`, `brainError`.
- **`stores/nova.svelte.ts`** is a thin `$state` shell around the machine.
  - It watches `activeSession.messages`: brain messages with `state === 'complete'` after the turn started are collected, and `stopped` ones are skipped.
  - When `activeSession.brainState` leaves `thinking` for `idle` **or `waiting`** (plan or ask_user), the collected text goes through `shapeSpoken()` into the TTS queue. The `waiting` case stops Nova sitting in "Thinking" forever.
  - The speak policy gate uses `voice.speakPolicy` and whether the turn was spoken.
  - Attention announcements reuse the "seed known ids, announce new ones" pattern from `ConversationTabs.svelte:116-141`.
  - Brain errors are taken from new `error`/`brain-stopped` entries in `activeSession.events`, deduplicated by event id.

**Audio** (`nova/audio/`)
- **`mic.ts`**
  - Calls `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })`, never `echoCancellation: 'all'`.
  - An AudioWorklet (`mic-worklet.ts`) resamples to 16 kHz Int16 and posts 100 ms chunks.
  - A second analyser gives the mic level for the "Listening" glow.
  - The mic is opened only after `voice:mic-status` says granted. A missing or denied mic does not block TTS, model download or the panel.
- **`vad.ts`** wraps `MicVAD`.
  - Thresholds: positive 0.5, negative 0.35.
  - Timing: `redemptionMs = voice.endPauseMs` (800), `minSpeechMs` 250, pre-speech padding 500 ms (N1: both engines need about 0.5 s of audio before speech, and the Zipformer mangled the first word without it). The pre-roll buffer is included in the PCM sent for the final pass, so the first word is not cut off.
  - While Nova is speaking, the threshold rises to 0.65 and barge-in needs 400 ms of continuous speech.
  - A 10 s silence timer runs while listening.
- **`stt-client.ts`**
  - Sends `begin` on VAD speech start, streams `voice:pcm`, then sends `end` on VAD speech end.
  - If `end-utterance` returns an empty string, the machine fires `empty`. That makes Nova say "Sorry, I didn't catch that." and listen again; nothing is dropped silently.
- **`tts.worker.ts` and `tts-engine.ts`**
  - A module Web Worker loads `kokoro-js` (1.2.1) with `env.allowRemoteModels = false`, model paths on `arc-voice-model:`, and local onnxruntime WASM paths. `@huggingface/transformers` 3.8.1 is a direct exact dependency so the worker can set `env`.
  - `kokoro-js` hardcodes huggingface URLs for voice files, so the worker overrides `fetch` to rewrite them to `arc-voice-model://kokoro/voices/<voice>.bin`.
  - Primary backend is WebGPU with `dtype: 'fp32'` (`onnx/model.onnx`, 326 MB, Hugging Face revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`). N2 found fp16, q8 and q4f16 produce garbled audio on WebGPU.
  - With no WebGPU adapter it falls back to WASM fp32 (or q8), single thread (no cross-origin isolation, so no threaded WASM). That is intelligible but 6-12 s per sentence, so it is a degraded mode (a "preparing speech" state or `tts-failed`), not a real fallback.
  - Streaming: close the `TextSplitterStream` after pushing text, or use `generate()`, because `tts.stream(string)` never finishes.
  - Interface: `synth(sentence, voiceId, speed) → Float32Array`. It synthesises one sentence ahead of playback.
  - The model is warmed when the panel opens, with a throwaway short synth (N2: load 2.2-2.4 s, first sentence about 1.0 s warm and 1.4 s without a warm-up, then about 0.8 s per sentence).
- **`playback.ts`**
  - One `AudioContext` plays a queue of `AudioBufferSourceNode`s through an `AnalyserNode` (FFT 512).
  - It exposes `level` (RMS, 0..1).
  - `flush()` stops all sources within one audio quantum.

**Face**
- **`nova/face-driver.ts`** is pure, `(dt, inputs) → pose`.
  - Envelope follower: 60 ms attack, 120 ms release.
  - The level is mapped to mouth levels 0–5 with a noise gate and hysteresis.
  - Optional vowel patch when the level is above 3.
  - Random blink every 3–6 s, skipped when the mouth level is above 4.
  - Thinking glances every 1.5–3 s.
  - Micro-motion: 1–2 px sine offset and 0.3 % "breathing" scale.
- **`NovaFace.svelte`**
  - One `requestAnimationFrame` loop draws the base image, then the two adjacent mouth patches blended by `globalAlpha` from the fractional level, then the eye patch.
  - The cyan glow is a CSS overlay driven by the mic or speech level, not baked into the frames.
  - The loop pauses when the panel is hidden.
  - When `motion.reduced` is set, it draws the base only and drives just the glow and label.
  - If the manifest fails to load, it shows the plain base image.

**Spoken text and Settings**
- **`src/shared/spoken-text.ts`** exports `shapeSpoken(markdown) → { text, droppedContent }`.
  - It strips fenced and inline code, tables, diff lines, URLs and paths, headings and list markers.
  - It splits sentences with an abbreviation guard and caps the result at 3 sentences or about 350 characters.
  - The caller appends "The details are in the chat." when `droppedContent` is true.
- **Settings:**
  - New `components/settings/VoiceSettings.svelte` page, registered in the `SettingsView` pages array, the `{#if}` chain and the `SettingsPage` union.
  - It has a voice `Select`, a speed slider, Preview (using the same TTS singleton), the speak-policy choice, model status, Download and Delete voice models, and a link to the voice licence notice.

### 2.5 Main process details

**Permissions (`src/main/app/permissions.ts`)**
- `setPermissionRequestHandler` and `setPermissionCheckHandler` on the default session grant only `media` with `mediaTypes` exactly `['audio']` from the app's own origin. They reuse the own-navigation check from `lockdown.ts`. `setDevicePermissionHandler` denies.
- The design-preview window never gets the mic.
- `askForMediaAccess('microphone')` is called from main, only when the status is `not-determined`, and only when the user clicks Start conversation.
- **Confirmed by N4:** the prompt shows the `NSMicrophoneUsageDescription` text, Allow gives `granted`, Don't Allow gives `denied`. Each ad hoc rebuild changes the cdhash and resets the grant to `not-determined`, so macOS re-prompts and never denies silently. The `tccutil reset Microphone dev.redgell.arc` hint in the denied state is therefore optional; the Open System Settings button stays.

**`Info.plist`**
- Add `mac.extendInfo.NSMicrophoneUsageDescription`: "Arc listens to your voice when you talk to Nova."
- With `hardenedRuntime: false`, no audio-input entitlement is needed.

**Speech host**
- The process is forked when Nova opens and the models are ready, so the first Whisper load (about 5.8 s while ggml Metal compiles its shaders, 0.15-0.3 s afterwards) happens before the user speaks. The "engine ready" state must tolerate that slow first start.
- `@fugood/whisper.node` `transcribeData` takes PCM16 little-endian bytes (an `ArrayBuffer`) and the context option is `filePath`, not `model`.
- The process stops after 60 s idle, on panel close, on session switch, or `before-quit`.
- If it crashes, the host restarts it once automatically, then reports `engine-crashed`.

**Model manager**
- The pinned manifest lists `{ id, kind: 'tts'|'stt-stream'|'stt-final', files[], url, sha256, bytes }`.
- URLs are Hugging Face `resolve/<commit-sha>` or GitHub release tags, never `main` or `latest`.
- Downloads use Node `fetch` with `Range` resume and 3 retries with backoff.
- On a checksum mismatch the file is deleted and redownloaded once.
- Downloads start only after the user confirms "Download voice models (about 520 MB)". The functional spec does not mention the size; its wording is updated in Slice 8.

**`arc-voice-model:` protocol**
- Registered as privileged (`standard`, `secure`, `supportFetchAPI`, `stream`) before `app.ready`.
- GET only, with Range support.
- The id must be in the manifest and the file in its file list, so path traversal isn't possible.

**CSP (`src/main/app/csp.ts`, the dev header and the packaged meta tag)**
- `script-src 'self' 'wasm-unsafe-eval'`
- `worker-src 'self' blob:`
- `media-src 'self' blob:`
- `connect-src` adds `arc-voice-model:`

The renderer never connects to the internet; only main downloads. `tests/unit/csp.test.ts` is updated, and the architecture doc's Security section records the change.

**Logging**
- electron-log scope `voice`: lifecycle, permission decisions, model download states and error codes.
- Never audio or transcripts. A privacy test asserts this, as for attachments.

**Brain context**
- No per-turn hint. **Assumption:** the brain is not told a message was spoken, because the local shaper handles the spoken form and a hint would cost tokens every turn.

### 2.6 Packaging

- **Dependencies:** `sherpa-onnx-node` 2.0.1 (pulls `sherpa-onnx-darwin-arm64`, 33 MB, with `.node` and dylibs), `@fugood/whisper.node` 1.2.0-rc.2, `kokoro-js` 1.2.1, `@huggingface/transformers` 3.8.1 (direct, so the worker can set `env`), `@ricky0123/vad-web` 0.0.31. All are pinned to exact versions (`pnpm add -E`).
- **N-API check (done):** both `sherpa-onnx.node` and `@fugood/node-whisper-darwin-arm64/index.node` export `napi_register_module_v1`, so they need no Electron rebuild. `npmRebuild: false` stays.
- **Unpacking:** `asarUnpack` adds `**/sherpa-onnx-darwin-arm64/*.dylib`. The `.node` file has `LC_RPATH @loader_path`, so the dylibs resolve when they sit beside it. No `DYLD_LIBRARY_PATH` or `install_name_tool` is needed.
- **Pruning:** `files:` excludes other-platform `@fugood/node-whisper-*` and `sherpa-onnx-*` packages.
- **Signing:** `scripts/adhoc-sign.mjs` signs the unpacked dylibs and `.node` files individually, inside-out, before the final app sign.
- **Renderer assets:** the VAD worklet, Silero ONNX and one onnxruntime WASM variant (`ort-wasm-simd-threaded`) are copied into the renderer output with `vite-plugin-static-copy`, or imported as `?url`. Kokoro's onnxruntime is pointed at the same local WASM, so nothing is fetched from jsdelivr.
- **Size:** the app grows by about 60–80 MB (N1 measured +78 MB). Models are not bundled.
- **Licences:** `resources/licenses/NOTICE-VOICE.txt` covers:
  - eSpeak NG (GPL-3.0-or-later);
  - Kokoro-82M (Apache-2.0);
  - sherpa-onnx (Apache-2.0);
  - the Zipformer model;
  - whisper.cpp and the Whisper weights (MIT);
  - Silero VAD (MIT);
  - onnxruntime (MIT).

  It is shipped through `extraResources` like `FONTS-OFL.txt`.
- **Arc's own licence:** GPL-3.0-or-later. Add a root `LICENSE` and a `package.json` `license` field (risk 6).

### 2.7 Face asset pipeline (`scripts/nova-face/`, offline, run once)

- **Decision (N5, user chose 2026-11-17):** hybrid. LivePortrait renders only the mouth and eye patches, laid over the original portrait. Head sway is a small CSS or canvas transform in the panel at runtime, because LivePortrait head poses move the cyan lines.
- **Control mapping (from `spikes.md` N5, Gradio slider units):** mouth open levels 0-5 from `lip_variation_three` 0, 15, 30, 45, 60, 90 (0..90 usable, never negative); `lip_variation_two` up to about 12 for an eee vowel; no usable oo (the best try gives a smirk), so vowels are optional; blink from `input_eye_ratio` 0.35, 0.2, 0.05, 0.0, 0.05, 0.2 (0.0 and 0.05 are clean closed lids; 0.2 is checked in motion); glances from `eyeball_direction_x` up to about 20 with `eyeball_direction_y` about 20 (negative y also closes the lids). LivePortrait softens skin grain inside the patch, so `postprocess.py` may add a light grain overlay.
- **Setup:**
  - `setup.sh` clones `KwaiVGI/LivePortrait` into a git-ignored `.cache/` at pinned commit `9b294b3d0536135442ea73cb01e6cb3ca7029dd3`, recorded in the README.
  - It creates a Python 3.10 environment and installs `requirements_macOS.txt`.
  - It downloads the weights, which are never committed.
- **Generation:** `generate.py` runs with `PYTORCH_ENABLE_MPS_FALLBACK=1`.
  - It loads and crops the portrait once.
  - It renders each pose through LivePortrait's retargeting controls: lip ratio and lip variation for mouth levels 0–5 and vowels, eye ratio for the blink steps, eyeball direction for glances, and no head-tilt bases (head sway is done at runtime, see below).
  - It pastes every result back into full-frame coordinates.
- **Post-processing:** `postprocess.py`
  - crops mouth (about 360×240) and eye (about 520×200) patches at 1024 px with 8–12 px feathered alpha masks;
  - writes WebP and `manifest.json`;
  - uses the original portrait, resized, as the base, so the cyan ring and lines never change.
- **Verification:** `verify.py` fails the run on pixel drift outside the patch rects or in the cyan regions. It writes a contact-sheet `review.html` for sign-off before commit.
- **Manifest:** `{ version, baseSize, bases[], frames[{id, kind: mouth|blink|glance, level?, vowel?, step?, dir?, src, rect, feather}], blinkSequence, blinkTimingsMs }`.
- **Licence:** LivePortrait code is MIT. Its InsightFace detector is non-commercial and is used only locally to make the stills. Only the generated images are committed.
- **Fallback (not needed so far):** if the contact sheet shows artifacts, especially teeth or the cyborg lines confusing keypoints, use a hand-tuned 2D jaw and lower-lip warp (`cv2.remap`) with a drawn mouth cavity, written into the same manifest format.

---

## 3. Impact and Risk Analysis

### System dependencies
- **Brain events:** relies on the existing `session:message`, `session:brain-state`, `session:attention` and `session:event-logged` events and `activeSession`; none change shape.
- **Typed messages:** `sessions:send-message` gains one optional field. Existing callers (Composer, BrainSurface) are unaffected.
- **Security posture:** the CSP is loosened (`wasm-unsafe-eval`, `blob:` workers and media), and the first permission handlers and first `utilityProcess` are added. These need entries in the architecture doc.
- **Disk:** about 520 MB in the user's data folder once models are downloaded.

### Risks and mitigations

Slice 1 is a set of gating spikes. Each runs in a **packaged** build and has a named fallback. Feature slices start only after they pass.

| # | Risk | Spike / mitigation | Fallback |
|---|---|---|---|
| 1 | Native addons fail to load or sign inside the `.app` | **Resolved (N1):** both `.node` files load from `app.asar.unpacked`, per-file signing passes `codesign --verify --deep --strict`, both transcribe from a `utilityProcess`. | Not needed. (`whisper-cpp-node`, or Whisper-final only with a level meter, would have been the fallbacks.) |
| 2 | Kokoro in a worker fails under the packaged meta-tag CSP or without cross-origin isolation (threaded WASM needs `SharedArrayBuffer`) | **Resolved (N2):** works under the proposed CSP with no violations; WebGPU fp32 is intelligible and gives 0.98 s (warm) to 1.37 s first sentence, about 0.8 s per sentence after. fp16, q8 and q4f16 are garbled on WebGPU. | WASM fp32/q8, single thread, is intelligible but 6-12 s per sentence (degraded mode only). Warm on panel open. |
| 3 | Echo: Chromium may not cancel Web Audio playback on laptop speakers, so Nova interrupts itself | **Resolved (N3):** with AEC on, 60 s of Kokoro speech gave a max speech probability of 0.063 and 0 false starts; with AEC off 26 false barge-ins a minute. Real "Nova, stop." interruptions were detected 3 of 3 about 0.4 s after speech began and playback flushed in under 1 ms. | Keep AEC on and the mitigated rule (0.65, 400 ms) as margin. No functional-spec amendment needed. |
| 4 | No mic prompt, or a silent deny, in the ad hoc signed build | **Resolved (N4):** the prompt shows with the intended text, Allow and Deny work, and an ad hoc rebuild resets the status to `not-determined` (re-prompt, no silent deny). | The `tccutil reset Microphone dev.redgell.arc` hint in the denied state is optional. |
| 5 | LivePortrait output looks wrong on this cyborg portrait | **Resolved (N5):** contact sheet reviewed; the user chose the hybrid (LivePortrait mouth and eye patches over the original portrait, section 2.7). | 2D warp stays a mouth-only fallback if the patch softness is disliked. |
| 6 | **GPL:** `kokoro-js` bundles `phonemizer` (eSpeak NG compiled to JS, GPL-3.0-or-later). The `arc` repo is public and `release.yml` publishes the DMG on GitHub Releases, so this is distribution. | **Decided (2026-11-17):** Arc is licensed GPL-3.0-or-later. Add a `LICENSE` file at the repo root, set `"license": "GPL-3.0-or-later"` in `package.json`, and ship `NOTICE-VOICE.txt`. The public repo is the source offer. Check that every other dependency's licence is GPL-compatible (MIT, ISC, Apache-2.0, BSD and OFL fonts all are). | None needed. |
| 7 | Whisper final pass adds delay after the user stops | base.en with Metal on short utterances; measured in N1: 359-457 ms for a 3 s clip warm, 5.8 s only on the very first load (start the host on panel open). | Use the Zipformer final text. |
| 8 | Model download is large or fails offline | Explicit confirm, resume, retry and a clear offline message. Typing in the chat is never blocked. | None. |
| 9 | Hands-free cuts the user off mid-thought | Configurable `voice.endPauseMs` (default 800 ms). | Raise the default after use. |

**Functional-spec gap (assumption):** the first-use model download (confirm, progress, offline retry) is not described in the functional spec. It follows the user's "download on first use" decision. Add it to the spec's Change Log when it is approved.

---

## 4. Testing Strategy

Following the project rule, slice checks run only touched tests, full suites run once at the end, and every new test is shown RED first.

### Unit (`tests/unit/`, node)
- `nova-machine.test.ts`: the full transition table with fake timers, covering the hands-free loop, 10 s silence, cancel, barge-in, mute, end, `waiting` flush, empty utterance → "didn't catch that", and error announcement.
- `spoken-text.test.ts`: table-driven cases for code, tables, diffs, paths, URLs, caps and the `droppedContent` flag.
- `face-driver.test.ts`: envelope, hysteresis, blink scheduling, and reduced motion.
- `permissions.test.ts`: the pure decision function across media types, origins and windows.
- `voice-model-request.test.ts`: traversal, Range and method.
- `model-manager.test.ts`: an injected `fetch` double for resume, checksum mismatch and offline.
- `speech-protocol.test.ts`: zod parsing.
- Migration 0033 and the new settings defaults.
- `csp.test.ts` and `session-layout-classes.test.ts` updates.
- A voice log-privacy test: no transcripts or audio in logs.

### Renderer (`tests/renderer/`, jsdom)
An injectable `AudioEngines` interface (`nova/engines.ts`) provides fake mic, VAD, STT and TTS that emit scripted events and give a deterministic level. Tests cover:
- panel states and controls;
- header button and layout column;
- speak policy;
- attention announcement once per new item;
- mic-denied and no-mic banners;
- Voice settings page and Preview;
- the spoken marker on `MessageBubble`.

### End-to-end (Playwright Electron, `tests/e2e/nova*.spec.ts`)
- **Setup:**
  - `HARNESS_VOICE_ENGINE=fake` makes the speech host fork `fake-speech-worker` (fixed partial and final).
  - `HARNESS_VOICE_MODELS=fake` treats the manifest as installed with stub files, and the fake TTS returns a tone buffer.
  - Chromium runs with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<fixture.wav>`.
- **Scenarios** (new `nova-*` fake-claude folders):
  - a spoken turn creates a chat message marked spoken;
  - a code-block answer shows "Speaking" and its spoken text ends with the details line;
  - a typed message is spoken under the `all` policy and not under `spoken-only`;
  - switching session closes the panel;
  - an attention item is announced;
  - a brain error is announced.

### Packaged smoke (Slice 1, plus a CI step in `release.yml`)
- `require` both native addons from the packaged app with `ELECTRON_RUN_AS_NODE`.
- `codesign --verify --deep --strict`.

### Real-engine checks (manual, approved once like earlier spikes)
- A real Kokoro, Zipformer and Whisper round trip on the dev Mac.
- The echo/barge-in check on laptop speakers.
- First-sentence latency.
- These are recorded as notes, not run in CI.
