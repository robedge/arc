#!/usr/bin/env python
"""Cut the LivePortrait renders into feathered WebP patches and write manifest.json.

Inputs: source/portrait.png and .cache/frames/*.png (from generate.py).
Outputs (default src/renderer/src/assets/nova/): base.webp (the ORIGINAL portrait resized to
1024 px, never re-rendered), one RGBA WebP patch per pose, manifest.json.

LivePortrait re-renders a 256 px face crop, so a raw render is softer and shifted in tone
against the original. Blend modes (--blend):
  hybrid  (default) L = render, N = neutral render, B = base. Where the pose changed a lot
          (|L-N| large: lips, teeth, cavity, lids) the patch is the render with the base's
          low-frequency tone correction, plus film grain matched to the base; where it did not
          change, the patch is B + (L-N), which keeps the original skin grain exactly.
  delta   patch = B + (L-N) everywhere (fuzzy, grainy cavity at wide open mouth).
  direct  patch = L, mean/std colour-matched to B in the border ring (smooth, grain lost).
All modes mean-shift the patch to the base inside a ring at the patch border (hides tone shifts).
The alpha is a rounded rectangle with a Gaussian feather, so patch corners (jaw edge, brows)
stay untouched.

Run: .cache/venv/bin/python postprocess.py [--blend delta|direct] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
PORTRAIT = HERE / "source" / "portrait.png"
FRAMES = HERE / ".cache" / "frames"
DEFAULT_OUT = HERE.parent.parent / "src" / "renderer" / "src" / "assets" / "nova"

BASE_SIZE = 1024
WEBP_QUALITY = 90
FEATHER = 12  # px at 1024; Gaussian sigma = FEATHER / 2.5 on an inset rectangle
RING = 18  # px: width of the border ring used for colour matching

# Rects [x, y, w, h] at 1024 px. Chosen from the face geometry (mouth corners, eye corners and
# brows) and clipped so no patch touches the cyan lines (head side lines at x<=300 / x>=720 beside
# the eyes, neck lines at x<=356 / x>=661 beside the mouth): see verify.py. Narrower than the
# 360x240 / 520x200 first estimates for that reason.
MOUTH_RECT = (362, 546, 296, 240)
EYE_RECT = (302, 290, 432, 200)

# id -> (kind, rect, manifest extras)
POSES: dict[str, tuple[str, tuple[int, int, int, int], dict]] = {}
MOUTH_LEVELS = 12
for _l in range(1, MOUTH_LEVELS + 1):
    POSES[f"mouth-{_l}"] = ("mouth", MOUTH_RECT, {"level": _l})
# vowel shapes: id -> (vowel, variant); variant 2 is the smaller of the family
VOWELS = {"eee": ("eee", None), "eee-2": ("eee", 2), "aaa": ("aaa", None), "oo": ("oo", None), "oo-2": ("oo", 2)}
for _id, (_v, _var) in VOWELS.items():
    POSES[f"vowel-{_id}"] = ("mouth", MOUTH_RECT, {"vowel": _v, **({"variant": _var} if _var else {})})
POSES["mouth-closed"] = ("mouth", MOUTH_RECT, {"shape": "closed"})
for _s in (1, 2):
    POSES[f"blink-{_s}"] = ("blink", EYE_RECT, {"step": _s})
for _d in ("left", "right", "up", "down", "upleft", "upright"):
    POSES[f"glance-{_d}"] = ("glance", EYE_RECT, {"dir": _d})

# Blink: neutral eyes -> step 1 (almost shut) -> step 2 (shut) -> step 1 -> neutral. Hold time of each frame in ms.
BLINK_SEQUENCE = ["blink-1", "blink-2", "blink-1"]
BLINK_TIMINGS_MS = [45, 70, 60]


def read_rgb(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    return img[..., ::-1]


def to_base_size(rgb: np.ndarray) -> np.ndarray:
    return cv2.resize(rgb, (BASE_SIZE, BASE_SIZE), interpolation=cv2.INTER_AREA)


CORNER = {"mouth": 70, "blink": 40, "glance": 40}  # corner radius of the rounded alpha, px


def feather_alpha(w: int, h: int, feather: int = FEATHER, radius: int = 0) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    x0, y0, x1, y1 = feather, feather, w - feather - 1, h - feather - 1
    r = max(0, min(radius, (x1 - x0) // 2, (y1 - y0) // 2))
    cv2.rectangle(m, (x0 + r, y0), (x1 - r, y1), 255, -1)
    cv2.rectangle(m, (x0, y0 + r), (x1, y1 - r), 255, -1)
    for cx, cy in ((x0 + r, y0 + r), (x1 - r, y0 + r), (x0 + r, y1 - r), (x1 - r, y1 - r)):
        cv2.circle(m, (cx, cy), r, 255, -1)
    return cv2.GaussianBlur(m.astype(np.float32) / 255.0, (0, 0), feather / 2.5)


def ring_mask(w: int, h: int, ring: int = RING) -> np.ndarray:
    m = np.ones((h, w), bool)
    m[ring : h - ring, ring : w - ring] = False
    return m


def grain(base_patch: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Zero-mean noise with the base patch's fine-grain level (luma high-pass std)."""
    g = cv2.cvtColor(base_patch.astype(np.uint8), cv2.COLOR_RGB2GRAY).astype(np.float32)
    sd = float((g - cv2.GaussianBlur(g, (0, 0), 1.5)).std())
    n = cv2.GaussianBlur(rng.standard_normal(base_patch.shape[:2]).astype(np.float32), (0, 0), 0.7)
    return (n / (n.std() + 1e-6) * sd)[..., None]


def build_patch(base, neutral, render, rect, blend: str, radius: int) -> np.ndarray:
    """Returns RGBA uint8 for `rect` (all inputs RGB uint8 at BASE_SIZE)."""
    x, y, w, h = rect
    sl = (slice(y, y + h), slice(x, x + w))
    b = base[sl].astype(np.float32)
    n = neutral[sl].astype(np.float32)
    r = render[sl].astype(np.float32)
    ring = ring_mask(w, h)
    if blend == "direct":
        mu_p, sd_p = r[ring].mean(0), r[ring].std(0) + 1e-3
        mu_b, sd_b = b[ring].mean(0), b[ring].std(0) + 1e-3
        p = (r - mu_p) * np.clip(sd_b / sd_p, 0.7, 1.4) + mu_b
    else:
        corr = b - n  # per-pixel difference of the original to LivePortrait's own neutral render
        if blend == "hybrid":
            change = cv2.GaussianBlur(np.abs(r - n).max(axis=2), (0, 0), 3.0)
            wgt = np.clip((change - 10.0) / 25.0, 0.0, 1.0)[..., None]
            low = cv2.GaussianBlur(corr, (0, 0), 10.0)
            p = r + corr * (1 - wgt) + low * wgt
            p = p + wgt * grain(b, np.random.default_rng(7))
        else:
            p = r + corr
        p = p + (b[ring].mean(0) - p[ring].mean(0))
    p = np.clip(p, 0, 255).astype(np.uint8)
    a = np.round(feather_alpha(w, h, FEATHER, radius) * 255).astype(np.uint8)
    a[a <= 8] = 0  # the Gaussian tail and WebP noise: keep the outermost rows exactly transparent
    return np.dstack([p, a])


def write_webp(path: Path, rgba: np.ndarray) -> None:
    ok = cv2.imwrite(str(path), rgba[..., [2, 1, 0, 3]], [cv2.IMWRITE_WEBP_QUALITY, WEBP_QUALITY])
    if not ok:
        raise SystemExit(f"cannot write {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", choices=["hybrid", "delta", "direct"], default="hybrid")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args()
    out: Path = a.out
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.webp"):
        stale.unlink()

    src = read_rgb(PORTRAIT)
    base_png = to_base_size(src)
    write_webp(out / "base.webp", np.dstack([base_png, np.full(base_png.shape[:2], 255, np.uint8)]))
    # Patches are built against the base as the app will decode it (WebP is lossy).
    base = cv2.imread(str(out / "base.webp"), cv2.IMREAD_COLOR)[..., ::-1]
    neutral = to_base_size(read_rgb(FRAMES / "neutral.png"))

    meta = json.loads((FRAMES / "poses.json").read_text())
    measure, params = meta.get("measure", {}), meta["poses"]
    frames = []
    for pid, (kind, rect, extra) in POSES.items():
        render = to_base_size(read_rgb(FRAMES / f"{pid}.png"))
        patch = build_patch(base, neutral, render, rect, a.blend, CORNER[kind])
        write_webp(out / f"{pid}.webp", patch)
        fr = {"id": pid, "kind": kind, **extra, "src": f"{pid}.webp", "rect": list(rect), "feather": FEATHER}
        if kind == "mouth":  # inner-lip gap / mouth width in px at 1024 and the LivePortrait controls
            fr["opening"] = measure[pid]["opening"]
            fr["width"] = measure[pid]["width"]
            fr["params"] = params[pid]
        frames.append(fr)
        print(f"{pid:16s} {rect} {(out / f'{pid}.webp').stat().st_size / 1024:6.1f} KB")

    manifest = {
        "version": 1,
        "baseSize": BASE_SIZE,
        "bases": [{"id": "base", "src": "base.webp"}],
        "mouthLevels": MOUTH_LEVELS,
        "mouthBaseOpening": measure.get("neutral", {}).get("opening", 0.0),
        "frames": frames,
        "blinkSequence": BLINK_SEQUENCE,
        "blinkTimingsMs": BLINK_TIMINGS_MS,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(p.stat().st_size for p in out.iterdir() if p.is_file())
    print(f"blend={a.blend} wrote {len(frames)} patches + base + manifest to {out}: {total / 1024:.0f} KB")


if __name__ == "__main__":
    main()
