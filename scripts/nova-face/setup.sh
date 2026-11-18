#!/usr/bin/env bash
# Sets up the offline Nova face pipeline (spec 016, tech spec 2.7).
# Everything heavy lives in the git-ignored scripts/nova-face/.cache/ folder:
#   .cache/LivePortrait  pinned clone of KwaiVGI/LivePortrait (MIT code)
#   .cache/venv          Python 3.10 environment (uv)
#   .cache/LivePortrait/pretrained_weights  model weights (never committed)
# LivePortrait's InsightFace detector weights are non-commercial: they are used only
# locally to make still images, and only the generated images are committed.
set -euo pipefail

LIVEPORTRAIT_REPO="https://github.com/KwaiVGI/LivePortrait.git"
LIVEPORTRAIT_SHA="9b294b3d0536135442ea73cb01e6cb3ca7029dd3"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/.cache"
LP="$CACHE/LivePortrait"
VENV="$CACHE/venv"

command -v uv >/dev/null || { echo "uv is required (brew install uv)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)"; exit 1; }
mkdir -p "$CACHE"

if [ ! -d "$LP/.git" ]; then
  git init -q "$LP"
  git -C "$LP" remote add origin "$LIVEPORTRAIT_REPO"
fi
if [ "$(git -C "$LP" rev-parse HEAD 2>/dev/null || true)" != "$LIVEPORTRAIT_SHA" ]; then
  git -C "$LP" fetch --depth 1 origin "$LIVEPORTRAIT_SHA"
  git -C "$LP" checkout -q --force "$LIVEPORTRAIT_SHA"
fi
echo "LivePortrait at $(git -C "$LP" rev-parse HEAD)"

[ -x "$VENV/bin/python" ] || uv venv --python 3.10 "$VENV"
# unsafe-best-match: the torch CPU index does not carry every pinned package.
uv pip install --python "$VENV/bin/python" --index-strategy unsafe-best-match \
  -r "$LP/requirements_macOS.txt"
uv pip install --python "$VENV/bin/python" "huggingface_hub[cli]<1.0"

# Human weights only (the animal weights are not needed).
"$VENV/bin/hf" download KlingTeam/LivePortrait --local-dir "$LP/pretrained_weights" \
  --include "liveportrait/*" --include "insightface/*"

echo "Setup done. Run:"
echo "  PYTORCH_ENABLE_MPS_FALLBACK=1 $VENV/bin/python $HERE/explore.py"
