# Nova face pipeline (spec 016)

Offline scripts that turn the Nova portrait into the face frames the app ships. Nothing here
runs in the app. Method (spike N5, user decision): LivePortrait renders only the mouth and eye
poses; they are cut into feathered patches and laid over the ORIGINAL portrait, so the cyan
ring and lines never change. Head sway is done at runtime (no tilt frames).

- `source/portrait.png`: the 1254x1254 source portrait.
- `setup.sh`: clones LivePortrait into the git-ignored `.cache/`, builds a Python 3.10 venv with uv,
  installs `requirements_macOS.txt`, downloads the human weights (about 630 MB, never committed).
- `generate.py`: renders the poses with LivePortrait (`.cache/frames/*.png`, full 1254 px frames): neutral,
  mouth levels 1-12 (`lip_variation_three` 7 to 90, equal steps in measured inner-lip gap), vowels `eee`, `eee-2`, `aaa`, `oo`, `oo-2` and the pressed-lips `mouth-closed`, blink steps
  (`input_eye_ratio` 0.05 and 0.0), glances (left, right, up, down, upleft, upright). About 25 s.
- `postprocess.py`: base = the original portrait at 1024 px; each patch is cut at 1024 px with a
  12 px Gaussian-feathered rounded alpha, tone-matched to the base in a ring at the border, and
  written as RGBA WebP into `src/renderer/src/assets/nova/` with `manifest.json`. Blend mode
  `hybrid` (default) keeps the original skin grain where a pose does not change the face and uses the
  LivePortrait render, tone-corrected and re-grained, where it does (`--blend delta|direct` are the
  alternatives).
- `verify.py`: composites every patch over the base like the app does and fails on any change outside
  the patch rect, any change of cyan-line pixels, cyan pixels inside a rect, a seam gradient above the
  base's, an oversized folder (limit 2.5 MB) or a malformed manifest. Writes the sign-off page
  `.cache/review/review.html` (not committed; open it in a browser).
- `sweep.py` / `levels.py` / `sheet.py`: candidate sweep with landmark-measured lip gap, the equal-opening level picker, and a contact-sheet helper used to choose the levels and shapes.
- `explore.py`: the N5 contact-sheet spike (kept for reference).

## Commands

```sh
scripts/nova-face/setup.sh                               # once: clone, venv, weights
cd scripts/nova-face
PYTORCH_ENABLE_MPS_FALLBACK=1 .cache/venv/bin/python generate.py          # add --force to re-render
.cache/venv/bin/python postprocess.py                    # writes src/renderer/src/assets/nova/
.cache/venv/bin/python verify.py                         # must print PASS; then open .cache/review/review.html
```

## Manifest notes

`manifest.json` follows tech spec 2.7. Mouth level 0 is the base portrait (no patch); levels 1-12 are
`mouth-1..12` with `opening` (inner-lip gap, px at 1024), `width` and LivePortrait `params`; top-level `mouthLevels: 12`, `mouthBaseOpening`. Shapes: `vowel-eee`, `vowel-eee-2`, `vowel-aaa`, `vowel-oo`, `vowel-oo-2` (kind `mouth`, `vowel`, optional `variant: 2` = the smaller one) and `mouth-closed` (`shape: "closed"`). `blink-1` (lids almost shut) and
`blink-2` (shut) are played as `blinkSequence` with `blinkTimingsMs` hold times. There is no half-open
blink step: LivePortrait's 0.10-0.20 eye ratios render as a wink. The rounded "oo" comes from negative `lip_variation_two` (narrows the corners) plus `lip_variation_three`. Patch rects are narrower than the first 360x240 / 520x200 estimates (296x240 and 432x200 at
1024 px) so they never contain a cyan line.

## Pinned versions

- LivePortrait: `KwaiVGI/LivePortrait` commit `9b294b3d0536135442ea73cb01e6cb3ca7029dd3` (2026-06-02).
- Python 3.10 (uv), torch 2.3.0, `huggingface_hub<1.0` (gradio 5.1 needs `HfFolder`).
- Weights: `KlingTeam/LivePortrait` on Hugging Face (`liveportrait/*`, `insightface/*`).

## Licence

LivePortrait code is MIT. Its InsightFace detector weights are non-commercial: they are used only
locally to make still images and are never shipped. Only the generated images (derived from the
portrait) are committed, never weights.
