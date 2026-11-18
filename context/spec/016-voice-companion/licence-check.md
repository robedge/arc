# Licence check (spec 016, risk 6)

Arc is licensed GPL-3.0-or-later. Every runtime dependency must be GPL-3.0-compatible.
Source: `pnpm licenses list --prod --json` for what is on `dev` today; the npm registry
`license` field at the pinned versions (spikes.md, tech spec 2.6) for the voice packages, which
are not yet in `package.json` on `dev`.

## Runtime dependencies on dev today (115 packages incl. transitive)

| Licence | Packages | GPL-3.0 compatible |
|---|---|---|
| MIT | 94 (incl. `@modelcontextprotocol/sdk`, `better-sqlite3`, `chokidar`, `electron-log`, `zod`) | Yes |
| BSD-3-Clause | 9 (lit family, `antlr4ng`, `qs`, `fast-uri`) | Yes |
| ISC | 7 | Yes |
| Apache-2.0 | 3 (`@a2ui/agent`, `@a2ui/web_core`, `drizzle-orm`) | Yes (GPLv3 only; not GPLv2) |
| BSD-2-Clause | 2 | Yes |

No unknown, SSPL, BUSL, or non-commercial licences.

## Voice packages (registry, pinned versions)

| Package | Version | Licence | Compatible |
|---|---|---|---|
| `kokoro-js` | 1.2.1 | Apache-2.0 | Yes |
| `phonemizer` (kokoro-js dep; bundles eSpeak NG) | 1.2.1 | npm field says Apache-2.0, embedded eSpeak NG is GPL-3.0-or-later | Yes, and the reason Arc is GPL |
| `@huggingface/transformers` | 3.8.1 | Apache-2.0 | Yes |
| `@huggingface/jinja` | 0.5.x | MIT | Yes |
| `onnxruntime-web` | 1.22.0-dev.20250409-89f8206ba4 | MIT | Yes |
| `onnxruntime-node` (transformers dep) | 1.21.0 | MIT | Yes |
| `@ricky0123/vad-web` | 0.0.31 | ISC | Yes |
| `sherpa-onnx-node`, `sherpa-onnx-darwin-arm64` | 2.0.1 | Apache-2.0 | Yes |
| `@fugood/whisper.node`, `@fugood/node-whisper-darwin-arm64` | 1.2.0-rc.2 | MIT | Yes |
| `sharp` (transformers dep) | 0.34.x | Apache-2.0 | Yes |
| `@img/sharp-libvips-*` (sharp native dep) | - | LGPL-3.0-or-later | Yes (LGPLv3 is compatible with GPLv3) |
| onnxruntime-web deps: `long`, `flatbuffers` | - | Apache-2.0 | Yes |
| onnxruntime-web deps: `protobufjs` | - | BSD-3-Clause | Yes |
| onnxruntime-web deps: `guid-typescript` | - | ISC | Yes |
| onnxruntime-web deps: `platform` | - | MIT | Yes |
| onnxruntime-node deps: `global-agent` | - | BSD-3-Clause | Yes |
| onnxruntime-node deps: `tar` | 7.x | BlueOak-1.0.0 (permissive) | Yes, permissive; note it is not on the FSF list by name |

Models (downloaded, not bundled): Kokoro-82M Apache-2.0, Zipformer en-20M Apache-2.0,
Whisper base.en MIT. Listed in `resources/licenses/NOTICE-VOICE.txt`.

## Flags

- No SSPL, BUSL, non-commercial or unknown licence found in the runtime set.
- Re-run `pnpm licenses list --prod --json` after the voice packages are added in Slice 4 to
  confirm the transitive set (this check used registry metadata for them). `sharp` and
  `onnxruntime-node` are Node-side dependencies of `@huggingface/transformers` that the renderer
  worker does not use; check at packaging time whether they are pruned from the app.
- InsightFace (non-commercial) is used only offline to make portrait frames and is not shipped
  (stated in `NOTICE-VOICE.txt`).
