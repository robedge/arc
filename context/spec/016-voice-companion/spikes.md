# Spikes: Voice Companion (Nova)

## Summary

All five gating spikes ran on 2026-11-17 on an Apple M1 Pro with Electron 44.8.0. Feature slices can start.

| Spike | Outcome | Chosen path |
|---|---|---|
| N1 Native addons | Pass | `sherpa-onnx-node` 2.0.1 and `@fugood/whisper.node` 1.2.0-rc.2 load, sign and run from the packaged app. Port the packaging changes from `6cad867`. No fallback. Both engines need about 0.5 s of audio before speech. |
| N2 Kokoro in a worker | Pass with WebGPU fp32 | `dtype: 'fp32'` on WebGPU (326 MB). fp16, q8 and q4f16 are garbled on WebGPU. WASM is intelligible but 6-12 s per sentence, a degraded fallback only. |
| N3 Echo and barge-in | Pass | Chromium AEC cancels Nova's own playback on built-in speakers (0 false starts with AEC on). Keep AEC on and the mitigated barge-in rule. No functional-spec amendment. |
| N4 Microphone prompt | Pass | The prompt shows with the intended text, Allow and Deny both behave, an ad hoc rebuild resets the grant to `not-determined` (re-prompt, no silent deny). |
| N5 Face contact sheet | Pass, user chose hybrid | LivePortrait mouth and eye patches over the original portrait, head sway at runtime by CSS or canvas transform. |

Voice model download is now about 520 MB (Kokoro fp32 326 MB, Zipformer 44 MB, Whisper base.en 148 MB), not about 300 MB.

## N1: Native addons in the packaged app

Run once on 2026-11-17 (Apple M1 Pro, Electron 44.8.0). Result: **PASS, no fallback needed.**

**Branch and commit:** `spike/016-n1-native`, commit `6cad867`, in the worktree `/private/tmp/claude-501/-Users-redgell-Development-harness/206e6a33-440e-47b8-96e6-f519acbce68c/scratchpad/n1-worktree`. Not pushed, not merged into `dev`.

**Versions (exact, `pnpm add -E`):**
- `sherpa-onnx-node` 2.0.1 (pulls `sherpa-onnx-darwin-arm64` 2.0.1)
- `@fugood/whisper.node` 1.2.0-rc.2 (pulls `@fugood/node-whisper-darwin-arm64` 1.2.0-rc.2, plus `node-whisper-wasm`)

**Packaging changes:**
- `electron-builder.yml`: `asarUnpack` gains `**/sherpa-onnx-darwin-arm64/*.dylib` (the `**/*.node` pattern already existed). `files:` gains two exclusions that drop the other-platform `@fugood/node-whisper-*` packages (win32, linux, darwin-x64, and the wasm build) and the other-platform `sherpa-onnx-*` packages (win, linux, darwin-x64). `npmRebuild: false` unchanged.
- `scripts/adhoc-sign.mjs`: before the existing `codesign --force --deep` of the `.app`, it walks `Contents/Resources/app.asar.unpacked`, collects every `.node` and `.dylib`, and signs each one with `codesign --force --sign -`. The final `--verify --deep --strict` is kept. All of these files (including `better-sqlite3`'s) log "replacing existing signature" in the build output.

**Commands and results:**
1. `pnpm package` (exit 0). Unpacked natives present: `sherpa-onnx-darwin-arm64/{sherpa-onnx.node,libonnxruntime.dylib,libsherpa-onnx-c-api.dylib,libsherpa-onnx-cxx-api.dylib}`, `@fugood/node-whisper-darwin-arm64/index.node`, `better-sqlite3/prebuilds/darwin-arm64.node`. No other-platform voice packages in the bundle.
2. Require from the packaged unpacked path with `ELECTRON_RUN_AS_NODE=1 Arc.app/Contents/MacOS/Arc <script>`:
   - `OK app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node [ 'createOnlineRecognizer', ... ] 11ms`
   - `OK app.asar.unpacked/node_modules/@fugood/node-whisper-darwin-arm64/index.node [ 'WhisperContext', 'WhisperVadContext', 'ParakeetContext', ... ]`
3. `codesign --verify --deep --strict Arc.app` printed nothing and exited 0 (`CODESIGN_OK`).
4. utilityProcess test: a throwaway Electron main (the worktree's `node_modules/.bin/electron`, not committed, deleted afterwards) forked a utilityProcess that loaded `sherpa-onnx-node` and `@fugood/whisper.node` through `Arc.app/Contents/Resources/app.asar/node_modules/...`. The wrappers resolve the addons to `app.asar.unpacked`, so both engines ran from the packaged bundle.

**Test clip:** `say -o x.aiff "Please open the settings panel and show me the latest build."` then `afconvert -f WAVE -d LEI16@16000 -c 1`, 3.07 s. I padded 0.5 s of silence before and after (4.07 s fed to the engines), as a VAD-bounded utterance would be. Without the leading pad both engines clipped the first word, and Whisper returned empty or `[Music]`, so N2/N3 and the worker should keep the padding.

**Numbers:**
| Engine | Model | Load | Transcribe | Text |
|---|---|---|---|---|
| sherpa-onnx streaming Zipformer | `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17`, int8, 2 threads | 425-513 ms (4 runs) | 67-95 ms decode of the whole clip fed in 200 ms chunks, 9 distinct partials | `S OPEN THE SETTINGS PANEL AND SHOW ME THE LATEST BUILD` |
| whisper.cpp | `ggml-base.en.bin` (148 MB) | 151-296 ms warm; 5818 ms on the very first run | 3.07 s clip (padded 4.07 s): 457 ms first call, 359 ms second | ` Please open the Settings panel and show me the latest build.` |

Notes:
- The first Whisper load took 5.8 s because ggml Metal compiled its embedded shaders (`loaded 35 libraries ... in 5.597 sec`). Later loads were 0.15-0.3 s. Worth a warm-up at first model install, and the "engine ready" state must tolerate a slow first start.
- Whisper was initialised with `useGpu: false` but ggml still initialised the Metal device. Not investigated further.
- `transcribeData` takes an `ArrayBuffer` of **PCM16 little-endian bytes** (a Float32Array view is also accepted); passing a Float32 `.buffer` gave an empty result. Context option is `filePath`, not `model`.
- The Zipformer drops or mangles the first word ("Please" became "S"), so it suits live words, with Whisper as the final text, as the spec plans.

**App size:** unpacked `Arc.app` was 315 MB before (an earlier `pnpm package` of `dev` in the main checkout's `release/`) and 393 MB after, about +78 MB, within the 60-80 MB estimate in tech spec 2.6.

**Gates in the worktree:** `pnpm lint` 0 problems; `pnpm typecheck` exit 0 (`tsc -b` clean; the `website/` svelte-check step could not load `turndown` because the worktree has no `website/` install, which is unrelated); `pnpm format:check` clean.

**Outcome:** both addons load, sign and run from the packaged app. The packaging changes are kept on the branch. `whisper-cpp-node` and the Whisper-final-only fallback were not needed. Slice 4 can port these changes from `6cad867`.

## N2: Kokoro in a renderer worker

Run on 2026-11-17 (Apple M1 Pro, 10 cores, Electron 44.8.0, packaged `Arc.app`), redone the same day. Result: **PASS with WebGPU `fp32`**, intelligible and under 2 s. The WASM fallback is intelligible but too slow.

**Correction to the first N2 run.** The first run chose WebGPU `fp16` and reported about 0.8 s per sentence. That output was garbled speech: the check only confirmed the buffers were non-silent with a plausible duration, so the timings measured broken audio. The redo adds an objective check (below) and shows that on WebGPU, `fp16`, `q8` and `q4f16` all produce unintelligible audio, while `fp32` is clean. The earlier WASM `q8` result was valid audio, but its timings are superseded by this run. The earlier recommendation of `fp16` is withdrawn.

**Branches:** `spike/016-n2-kokoro` (first run, commit `6a1d715`) and `spike/016-n2b-kokoro` (this redo), in the worktree `/private/tmp/claude-501/-Users-redgell-Development-harness/206e6a33-440e-47b8-96e6-f519acbce68c/scratchpad/n1-worktree`. Not pushed. The harness is throwaway: `src/renderer/spike-n2.html`, `src/renderer/src/spike-n2.ts`, `src/renderer/src/spike-n2-worker.ts`, `src/main/protocol/spike-voice-model.ts`, the CSP and scheme edits, and an env-gated `loadFile` swap in `bootstrap.ts` (`ARC_SPIKE_N2=1`, `ARC_VOICE_MODEL_DIR=<folder>`).

**Versions (exact):** `kokoro-js` 1.2.1, `@huggingface/transformers` 3.8.1 (added as a direct exact dependency so the worker can set `env`), `onnxruntime-web` 1.22.0-dev.20250409-89f8206ba4.

**Model:** `onnx-community/Kokoro-82M-v1.0-ONNX` at revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231`. Files: `config.json`, `tokenizer.json`, `tokenizer_config.json`, `voices/af_heart.bin` (522,240 bytes), and `onnx/model.onnx` (fp32, 325,532,232 bytes), `model_fp16.onnx` (163,234,740), `model_quantized.onnx` (q8, 92,361,116), `model_q4f16.onnx` (154,586,422). All in `scratchpad/voice-models/kokoro/`.

**CSP (packaged meta tag), unchanged from the first run:**
`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: arc-knowledge: arc-attachment:; connect-src 'self' arc-knowledge: arc-voice-model:; object-src 'none'; base-uri 'none'; form-action 'none'`.
Zero `securitypolicyviolation` events in every run. The module worker loaded from the `file://` page under `worker-src 'self'`, no `blob:` worker was needed, and the eSpeak phonemizer ran under `'wasm-unsafe-eval'` (phonemes for sentence 1: `ɡˈʊd mˈɔːɹnɪŋ, aɪ hæv fˈɪnɪʃt ðə ɹᵻvjˈuː ænd ˈɛvɹɪθˌɪŋ lˈʊks ɡˈʊd tədˈeɪ.`). Console output was empty apart from ORT's "nodes not assigned to the preferred execution provider" warnings (logged at `error` level) on some WebGPU runs; no run logged a remote fetch (`remoteAttempts` empty).

**Protocol handler approach:** `arc-voice-model` is a privileged scheme (standard, secure, supportFetchAPI, stream, corsEnabled). A temporary `protocol.handle` serves `ARC_VOICE_MODEL_DIR/<host>/<path>`, GET only, with `Range` and CORS `*` (the page origin is `file://`). Transformers.js in the worker: `env.allowRemoteModels = false`, `allowLocalModels = true`, `localModelPath = 'arc-voice-model://'`, `useBrowserCache = false`, model id `'kokoro'`. ORT WASM: `env.backends.onnx.wasm.wasmPaths = { mjs, wasm }` for `ort-wasm-simd-threaded.jsep.{mjs,wasm}` imported with Vite `?url`. `kokoro-js` hardcodes `https://huggingface.co/.../resolve/main/voices/<voice>.bin` for voices, so the worker overrides `fetch` to rewrite it to `arc-voice-model://kokoro/voices/<voice>.bin`. The real worker needs the same override.

**Intelligibility check (new).** Each synthesised sentence is converted to 16 kHz mono PCM16 (linear resample from the 24 kHz output, with 0.5 s of silence padding each side), transcribed offline by whisper.cpp `ggml-base.en.bin` through `@fugood/whisper.node` run from the packaged app with `ELECTRON_RUN_AS_NODE`, and scored by word error rate against the input text (lower-cased, punctuation stripped). Pass = WER under 15%. The app ran with `--mute-audio` and no `AudioContext` was created, so nothing was played. Sentences: S0 "Good morning, I have finished the review and everything looks good today." (13 words), S1 "Your build finished and all the tests passed on the first run.", S2 "I merged the branch and nothing needs your attention right now.", S3 "The review found two small issues, and both are already fixed."

**Results** (module Web Worker, voice `af_heart`, times in ms, per-sentence times are S0 / S1 / S2 / S3):

| Backend, dtype | Intelligible (WER per sentence) | Cold load | Sentence times | Notes |
|---|---|---|---|---|
| WebGPU fp32 | **Pass**, 0 / 0 / 0 / 0 | 2212-2401 | 978 / 820 / 788 / 824 after a "Hello there." warm-up (1878); 1368 / 859 / 828 / 827 with no warm-up | Meets both criteria |
| WebGPU fp16 | Fail, 0.83 / 1.00 / 0.82 / 1.00 | 1638 | 947 / 782 / 744 / 804 | Garbled |
| WebGPU q8 | Fail, 1.25 / 1.00 / 1.00 / 1.00 | 1315 | 9657 / 7091 / 8264 / 9864 | Garbled and slow |
| WebGPU q4f16 | Fail, 0.83 / 1.00 / 0.82 / 1.00 | 1673 | 940 / 872 / 811 / 840 | Garbled |
| WASM fp32 (1 thread) | Pass, 0 / 0 / 0 / 0 | 2209 | 7603 / 6326 / 6308 / 6915 | Intelligible, 6x too slow |
| WASM q8 (1 thread) | Pass, 0 / 0 / 0 / 0 | 2248 | 12045 / 10560 / 10581 / 10855 | Intelligible, 5x too slow |

Whisper transcripts (the audio is 3.8-4.5 s per sentence, 24 kHz):
- WebGPU fp32, WASM fp32, WASM q8: `"Good morning. I have finished the review and everything looks good today."`, `"Your build finished and all the tests passed on the first run."`, `"I merged the branch, and nothing needs your attention right now."`, `"The review found two small issues, and both are already fixed."` (all four sentences, all three backends, same text).
- WebGPU fp16: `"Good morning."`, `"You did it!"`, `"I love the dance."`, `"I give you any tea smooses."`
- WebGPU q8: `"I thought that's my language, yeah, yeah, yeah, yeah, ..."`, `"[speaking in foreign language]"`, `"Thank you for watching! I hope you enjoyed this video!"`, `"(speaking in foreign language)"`
- WebGPU q4f16: `"Good morning."`, `"(music)"`, `"I love the b*tch."`, `"you"`

**Cause of the garbled output.** On the WebGPU provider, ORT with the reduced-precision and quantised Kokoro models (`fp16`, `q8`, `q4f16`) produces wrong waveforms, while `fp32` is correct; the same `q8` file on WASM is correct. The other suspects are cleared by the passing runs: the voice file is `af_heart.bin` via the `fetch` override (the same override ran in the passing fp32 and WASM runs), the sample rate returned by kokoro-js is 24000, and the phonemizer output above is right under the CSP. I did not look inside ORT to explain why fp16 fails on WebGPU, so treat the cause as established by elimination, not by inspection. `q8f16` was downloaded but not tested (transformers.js 3.8.1 has no dtype name for it).

**Other findings:**
- `crossOriginIsolated` is `false` and `SharedArrayBuffer` is undefined, so ORT ran one thread (`hardwareConcurrency` 10). Threaded WASM would need isolation, which the `file://` page cannot get; not attempted.
- `tts.stream(string)` never finishes: kokoro-js holds back the last sentence until the splitter is closed. Pass a `TextSplitterStream`, push the text and call `close()`, or use `generate()`. My first harness hung on this.
- Main thread: with `fp32`, a requestAnimationFrame monitor saw a 9.4 ms max gap idle and 11.5 ms during synthesis, so synthesis in the worker does not disturb the main thread (the 106-180 ms gaps in the first run came from the broken-output harness and are not repeated).
- GPU shader cache: the very first WebGPU run on a machine is slower (the first run measured 3.9 s for the first sentence with fp16 against 1.2 s later). Later launches here were warm, so a truly first run with fp32 was not measured; assume it can be several seconds and keep the warm-up synth.

**Chosen backend and fallback:**
- Primary: WebGPU, `dtype: 'fp32'` (model `onnx/model.onnx`, 326 MB). Voice models total therefore grow by about 230 MB over the q8 plan; update the model manifest and the "about 300 MB" download copy (Slice 2).
- Fallback when no WebGPU adapter is available: WASM `fp32` or `q8`, single thread, intelligible but 6-12 s per 4 s sentence, so it cannot keep ahead of playback. Treat it as degraded (a "preparing speech" state or the `tts-failed` banner). `fp32` is the faster WASM dtype here, `q8` the smaller file. A faster no-WebGPU path (Node CPU in the speech utility process) is not tested.
- Shorter first chunk (splitting the first sentence on commas) and `q8f16` were not needed, since `fp32` already meets the target.

**Does the 2 s first-sentence target hold?** Yes on WebGPU fp32: first sentence 0.98 s after a warm-up synth and 1.37 s without one, then about 0.8 s per sentence (about 5x faster than real time). Model load is 2.2-2.4 s, so cold end to end from panel open is about 3.6 s without warm-up, and the load plus a short throwaway synth must start when the panel opens. The spec already plans this, and the user speaks and the brain thinks for several seconds before the first sentence is needed.

**Gates in the worktree:** `pnpm lint` 0 problems; `tsc -b` exit 0. `pnpm typecheck` still fails only in the `website/` svelte-check step (unresolved `turndown`, no `website/` install), as in N1.

## N3: Echo and barge-in on laptop speakers

Run on 2026-11-17 by the orchestrator with the user at the Mac (built-in MacBook speakers and microphone, normal volume, quiet room). Result: **PASS. Chromium echo cancellation removes Nova's own voice, so interrupt-by-talking works without headphones.**

**Branch and commit:** `spike/016-n3-n4-mic-b`, commit `8cc8ea2`, in the worktree `/private/tmp/claude-501/-Users-redgell-Development-harness/206e6a33-440e-47b8-96e6-f519acbce68c/scratchpad/n1-worktree`. Runner: `scratchpad/n3n4-run.sh`. Not pushed. The result JSON was overwritten by later runs, so the numbers below are the recorded ones from run 2.

**Versions:** Electron 44.8.0, Kokoro WebGPU fp32 (N2 setup), `@ricky0123/vad-web` 0.0.31 (Silero VAD).

**Setup:** Kokoro speech played through one `AudioContext` while the mic was captured in the same renderer, with `getUserMedia` constraints `echoCancellation`, `noiseSuppression` and `autoGainControl` all true (AEC on) or `echoCancellation: false` (AEC off). The VAD ran at 0.5 (plain rule) and at 0.65 with a 400 ms continuous-speech gate (mitigated rule).

**Results, echo (mic level while Nova speaks):**

| Case | Duration | Mic RMS mean / p50 / p95 / peak (dBFS) | Max speech prob | Frames over 0.5 | Speech starts at 0.5 | Library speech starts | Barge-ins (0.65 for 400 ms) |
|---|---|---|---|---|---|---|---|
| AEC on, playing | 60.1 s | -59.9 / -62 / -55.8 / -42.1 | 0.063 | 0 | 0 per min | 0 | 0 per min |
| AEC on, baseline (nothing playing) | 5 s | not recorded | 0.081 | 0 | not recorded | not recorded | not recorded |
| AEC off, playing | 30 s | -25.4 / -35 / -18.5 / -12.4 (baseline mean -57.4) | 1.0 | 663 (650 over 0.65) | 22 per min | 2 per min | 26 per min |

With AEC off Nova would interrupt itself 26 times a minute. With AEC on even the unmitigated 0.5 rule gave zero false starts.

**Results, real interruption** (AEC on, mitigated rule; the user said "Nova, stop." on a red INTERRUPT NOW cue):

| Trial | Cue to first speech frame | Cue to barge-in | Barge-in to flush |
|---|---|---|---|
| 1 | 713 ms | 1102 ms | 0.2 ms |
| 2 | 773 ms | 1151 ms | 0.1 ms |
| 3 | 690 ms | 1079 ms | 0.1 ms |

3 of 3 detected, 0 false barge-ins before the cue, all sources stopped after the flush. Detection comes about 390 ms after the user starts speaking (the 400 ms gate) and playback stops within 1 ms of detection. The cue-to-speech time is the user's reaction time, not the system's.

**Outcome:** no functional-spec amendment. The spec's "Nova stops speaking within half a second" holds when measured from the start of the user's speech (about 0.4 s), not from a visual cue. Keep AEC on, keep the mitigated rule (0.65, 400 ms) as a safety margin, and the headphones-only fallback in tech spec risk 3 is not needed. Slice 6 uses these thresholds.

## N4: Microphone prompt

Run on 2026-11-17 by the orchestrator with the user at the Mac, in the packaged ad hoc signed app from the same harness as N3 (`spike/016-n3-n4-mic-b`, commit `8cc8ea2`, runner `scratchpad/n3n4-run.sh`, flag `--rebuild-check` for the last step). Result: **PASS. The prompt shows with the right text, Allow and Deny behave, and an ad hoc rebuild re-prompts rather than silently denying.**

**Setup:** `mac.extendInfo.NSMicrophoneUsageDescription` set to "Arc listens to your voice when you talk to Nova." and a minimal permission handler on the default session. Status was read with `systemPreferences.getMediaAccessStatus('microphone')` and the prompt triggered with `askForMediaAccess('microphone')`.

**Results:**
- First attempt (planned Don't Allow): the prompt appeared and the user confirmed its text matched the string above, but clicked Allow. `askResult` true, status `not-determined` to `granted`, `askMs` 2798.
- Run 2 (Allow): granted, prompt text matched.
- Retry (Don't Allow): status `not-determined` to `denied`, `askResult` false, prompt text matched.
- Rebuild check (`--rebuild-check`): after an ad hoc rebuild the cdhash changed (`e16d69be7a78...` to `88804d8162e1...`) and `getMediaAccessStatus` returned `not-determined` (not `denied`, not `granted`). macOS forgets the grant and re-prompts, so there is no silent deny. The `--same-bits` variant (rebuild to identical bits) was not run.
- Permission handler log: audio-only `media` requests and checks from the app's own `file://` origin were granted. Checks with no `mediaType`, speaker-selection and background-sync were denied. Nothing broke.
- After the test the orchestrator ran `tccutil reset Microphone dev.redgell.arc` so the machine is back to a clean state.

**Outcome:** tech spec 2.5 stands. Each ad hoc rebuild resets the grant to `not-determined`, so a developer simply sees the prompt again. The `tccutil` hint in the denied state is optional. The System Settings button stays.

## N5: Face contact sheet

Run once on 2026-11-17 (approved). Machine: Apple silicon, MPS. Contact sheet for the user: `/Users/redgell/Development/harness/scripts/nova-face/.cache/explore/review.html` (open in a browser; relative image paths; 14 sections, 100 full frames in `full/`, 101 face thumbnails, 93 mouth/eye zooms, 56 drift heatmaps, about 155 MB, git-ignored).

**Versions and setup**
- LivePortrait `KwaiVGI/LivePortrait` commit `9b294b3d0536135442ea73cb01e6cb3ca7029dd3` (2026-06-02), pinned in `scripts/nova-face/setup.sh` and `README.md`.
- Python 3.10.19 venv made by `uv venv --python 3.10` in `scripts/nova-face/.cache/venv`; `requirements_macOS.txt` installs torch 2.3.0 and `onnxruntime-silicon`. Weights from `KlingTeam/LivePortrait` (human `liveportrait/*` and `insightface/*`, 632 MB) via `hf download`.
- Two setup gotchas, both fixed in `setup.sh`: (1) uv needs `--index-strategy unsafe-best-match` because the pinned `--extra-index-url` torch index hides other pinned packages (`tqdm`); (2) `huggingface_hub[cli]` must be `<1.0` (the latest release removed `HfFolder`, which gradio 5.1 imports even though we never open the UI). The current `hf download` also wants `--exclude` repeated per pattern. `setup.sh` ran clean on re-run (exit 0) and the pinned-SHA shallow fetch works from an empty repo.
- `explore.py` calls `GradioPipeline.execute_image_retargeting` directly (no UI), with `PYTORCH_ENABLE_MPS_FALLBACK=1`, crop scale 2.5, stitching and paste-back on, output pasted into the full 1254x1254 frame.
- Source ratios measured on this portrait: eye 0.35, lip 0.00 (closed). Slider ranges are from `app.py`.

**Timings on MPS** (`aten::grid_sampler_3d` falls back to the CPU, which dominates)
- Pipeline load plus source analysis: 6.2 s. Very first render (shader and warm-up): 17 s.
- Per render once a pose is prepared (crop and detect cached, as `generate.py` would do): mouth 1.25 s mean (1.1 to 1.8), eyes and gaze 1.44 s mean (1.1 to 2.3). First render of a new head pose, or the upstream call with no caching: 4.8 to 5.6 s; head-pose grid renders 1.9 to 3.8 s each.
- Whole run of 100 renders plus the sheet: about 3.5 minutes. A full frame set of a few hundred frames is therefore a 10-minute offline job.
- 2D warp: 140 ms per frame on CPU.

**Control mapping and usable range** (values are the Gradio slider units)

| Control | Range tried | Result | Usable |
|---|---|---|---|
| `input_lip_ratio` (0..0.8) | 0 to 0.8 | 0.05-0.1 a sliver of teeth; 0.2-0.4 teeth but no cavity (grin or talking); 0.5-0.6 dark cavity, aaa-like; 0.8 shouting | 0 to 0.6. Lip corner folds from 0.5. |
| `lip_variation_three` close/open (-90..120) | -90 to 120 | Smoothest open/close: 15 slight, 30 small teeth, 45 to 60 open with cavity, 90 wide, 120 shouting with the lower lip clipped. Negative values drag the mouth up and make it vanish. | 0 to 90 (best "aaa" control). Do not go negative. |
| `lip_variation_two` grin (0..15) | 0 to 15 | Wider corners and upper teeth: eee-like at 9 to 12. Teeth go speckled at 12 to 15. | 0 to 12 |
| `lip_variation_one` pursing (-20..15) | -20 to 15 | Positive presses lips together; negative gives an asymmetric smirk. No rounded, protruding "oo". | 0 to 15 for a lip squeeze; negative not useful |
| `lip_variation_zero` pout (-0.09..0.09) | full | One-sided lip bite or pull, not a pout | Do not use |
| `input_eye_ratio` (0..0.8) | 0 to 0.8 | 0.0 and 0.05 clean closed lids; 0.10-0.20 asymmetric (reads as a wink); 0.30 to 0.35 natural; 0.5+ bulging cartoon eyes | 0.0 to 0.35. Blink steps 0.35, 0.2, 0.05, 0.0, 0.05, 0.2 (check 0.2 in motion). |
| `eyeball_direction_x` (-30..30) | full | Natural to about +-20; +-30 strained with a lot of sclera | -20 to 20 |
| `eyeball_direction_y` (-63..63) | full | Positive looks up (fine to 40); negative also closes the lids (upstream adds a blink term), so "down" is a half blink | 0 to 40. For a thinking glance, x=-15, y=20 looks natural. |
| head `yaw` / `pitch` / `roll` (+-25 / +-15 / +-15) | +-16, +-6, +-5 | Clean to yaw +-8, pitch +-6, roll +-5; yaw +-16 slides the jaw edge and cyan lines | Small idle sway only |

Vowels: aaa = `lip_variation_three` 45 to 60 (with `input_lip_ratio` about 0.35). eee = `lip_variation_two` 10 to 15 with a little `lip_variation_one`. ooo = not achievable; the best combination (`lip_variation_one` -15 to -20) gives a smirk or a grin. mmm = ratio 0 with `lip_variation_one` positive. The functional spec does not require word-matched mouth shapes, so open levels 0 to 5 from `lip_variation_three` (0, 15, 30, 45, 60, 90) cover speaking.

**Artifacts observed (I looked at the grids, hybrids and heatmaps)**
- Whole-frame drift: LivePortrait re-renders the whole face crop at 256 px, so every frame differs from the source far outside the mouth. Outside the mouth rect the mean absolute difference is about 5 of 255 (p99 about 47, max about 185); inside the cyan-line pixels the mean is about 24 and the peak about 170. A no-op round trip already does this. The heatmaps show the jaw and neck outline, the silver-cyan edge lines, the eyes and the nose lighting up. LivePortrait frames cannot be used whole, which matches the plan in tech spec 2.7 (patches over the original base).
- Softness: the LivePortrait patch has 1 to 3 percent of the source's Laplacian variance (the skin grain disappears). At thumbnail size the feathered hybrids look fine; at 1:1 the patch is visibly smoother than the surrounding skin. A light grain overlay in `postprocess.py` may hide it.
- Teeth: plausible but slightly fused, crooked or speckled at the ends of the range; nothing identity-breaking.
- Cyan ring and lines: unchanged in the hybrids by construction (outside the patch the pixels are the original). Inside LivePortrait whole frames the lines near the jaw edge distort (flicker not tested, no sequences rendered).
- Seams: a 12 px feather on a 360x240 mouth patch and a 520x200 eye patch showed no visible seam in the hybrid thumbnails (aaa, eee, closed and half-blink); I did not inspect a moving sequence.
- Identity: eyes and mouth keep the portrait's look. Open eyes at 0.5+ and the vertical-gaze blink term are the main deviations.

**2D warp comparison (quick, untuned sample, levels 1 to 4)**
- `cv2.remap` jaw and lower-lip lift (open 10, 24, 40, 56 px) with a drawn dark cavity, teeth strip and tongue. Zero drift outside the jaw region and 140 ms per frame.
- It looks synthetic next to LivePortrait: a flat teeth strip, a hard straight upper edge of the cavity, no lower teeth. The jaw field reaches about y=960, so a warp patch must include the chin, not only the 160 px mouth rect. It would need a curved upper lip, shaded teeth and corner handling to reach parity. I did not tune it beyond a few passes.

**Recommendation: hybrid, LivePortrait patches over the original base.** Use LivePortrait only for the mouth and eye patches (as tech spec 2.7 already plans) and keep the original portrait, resized, as the base so the cyan lights never change.
- Mouth: `lip_variation_three` 0, 15, 30, 45, 60, 90 for levels 0 to 5, with `lip_variation_two` and `input_lip_ratio` for the vowels the spec does not require. Cap at 90. The mouth is clearly better than the warp sample.
- Blink: `input_eye_ratio` 0.05 and 0.0 closed frames (plus 0.2 as a half step if it does not read as a wink in motion). Eyes are the strongest LivePortrait result.
- Glance: `eyeball_direction_x` about +-20 with `eyeball_direction_y` about 20 for "thinking".
- Head sway: skip LivePortrait for it (it moves the cyan lines); use a small CSS transform in the panel instead.
- Fallback: the warp stays as the fallback for the mouth only if the user dislikes LivePortrait's softness; it needs tuning first.
- Open choice for the user: LivePortrait hybrid (recommended), or the 2D warp fallback. Slice 7 uses the choice.

**Files:** `scripts/nova-face/{setup.sh,explore.py,README.md,source/portrait.png}`; `.gitignore` gained `scripts/nova-face/.cache/`. Nothing committed.

**User decision (2026-11-17):** hybrid chosen: LivePortrait mouth and eye patches over the original portrait, head sway done at runtime.
