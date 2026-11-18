#!/usr/bin/env python
"""Render the Nova face poses with LivePortrait (spec 016, tech spec 2.7).

Method chosen in spike N5 (hybrid): LivePortrait renders only provide the mouth and eye
poses. They are pasted back into full-frame coordinates (1254x1254) and saved as PNGs in
.cache/frames/; postprocess.py then cuts feathered patches and lays them over the
ORIGINAL portrait. No head poses are rendered (head sway is done at runtime).

A "neutral" render (all controls at the source values) is saved too: LivePortrait
re-renders the 256 px face crop, so postprocess.py works with the difference between a
pose and the neutral render, which keeps the original skin grain and tone.

Run: PYTORCH_ENABLE_MPS_FALLBACK=1 .cache/venv/bin/python generate.py [--force] [--only id,id]
About 1.3 s per pose on Apple silicon after a ~20 s warm-up.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

HERE = Path(__file__).resolve().parent
LP = HERE / ".cache" / "LivePortrait"
OUT = HERE / ".cache" / "frames"
PORTRAIT = HERE / "source" / "portrait.png"

os.chdir(LP)  # LivePortrait resolves some paths relative to its clone
sys.path.insert(0, str(LP))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from src.config.argument_config import ArgumentConfig  # noqa: E402
from src.config.crop_config import CropConfig  # noqa: E402
from src.config.inference_config import InferenceConfig  # noqa: E402
from src.gradio_pipeline import GradioPipeline  # noqa: E402

# Control values in Gradio slider units (see spikes.md N5 for the usable ranges).
# Mouth open levels 1..12 from lip_variation_three, picked by levels.py so that the measured
# inner-lip gap (203-landmark points 90/102, px at 1024) rises in equal steps from just-parted
# lips (level 1, ~3 px) to the widest clean render (level 12, lip_variation_three 90, ~71 px).
# Level 0 is the base portrait (closed mouth). Re-run sweep.py + levels.py to change them.
MOUTH_LEVELS = {1: 7.0, 2: 11.5, 3: 21.5, 4: 31.0, 5: 38.5, 6: 45.5, 7: 52.5, 8: 60.0, 9: 67.0, 10: 74.0, 11: 82.0, 12: 90.0}
# Vowels and closures (shapes for the driver; levels cannot make them). "eee-2" is a smaller
# eee; "oo" / "oo-2" are rounded and narrow (lip_variation_two negative narrows the corners,
# lip_variation_three opens the round hole); "closed" is a pressed-lips shape for m/b/p.
VOWELS = {
    "eee": dict(lip_variation_two=10.0, lip_variation_one=6.0, input_lip_ratio=0.1),
    "eee-2": dict(lip_variation_two=5.0, lip_variation_one=3.0, input_lip_ratio=0.1),
    "aaa": dict(input_lip_ratio=0.35, lip_variation_three=60.0),
    "oo": dict(lip_variation_two=-12.0, lip_variation_one=8.0, lip_variation_three=55.0),
    "oo-2": dict(lip_variation_two=-14.0, lip_variation_three=40.0),
}
CLOSED = dict(lip_variation_one=14.0)
# Blink steps: input_eye_ratio (0.35 is the source). Ratios 0.10-0.20 render asymmetrically (one eye
# more closed, reads as a wink; confirmed again in this run at 0.20) and a cross-fade of open and
# closed ghosts, so the blink is just two clean closed-lid steps: 0.05 (step 1, lids almost shut)
# and 0.0 (step 2, shut).
BLINK_STEPS = {1: 0.05, 2: 0.0}
# Glances for the thinking state: (eyeball_direction_x, eyeball_direction_y).
# Negative y also closes the lids upstream, so "down" is kept small.
GLANCES = {
    "left": (-18.0, 0.0),
    "right": (18.0, 0.0),
    "up": (0.0, 20.0),
    "down": (0.0, -10.0),
    "upleft": (-15.0, 20.0),
    "upright": (15.0, 20.0),
}


def poses() -> dict[str, dict]:
    p: dict[str, dict] = {"neutral": {}}
    for lvl, v in MOUTH_LEVELS.items():
        p[f"mouth-{lvl}"] = dict(lip_variation_three=v)
    for name, ctl in VOWELS.items():
        p[f"vowel-{name}"] = dict(ctl)
    p["mouth-closed"] = dict(CLOSED)
    for step, ratio in BLINK_STEPS.items():
        p[f"blink-{step}"] = dict(input_eye_ratio=ratio)
    for name, (x, y) in GLANCES.items():
        p[f"glance-{name}"] = dict(eyeball_direction_x=x, eyeball_direction_y=y)
    return p


def partial_fields(target_class, kwargs):
    return target_class(**{k: v for k, v in kwargs.items() if hasattr(target_class, k)})


class Renderer:
    """GradioPipeline.execute_image_retargeting with the crop and detection cached.

    Cached tensors are cloned because the upstream delta helpers mutate them in place.
    """

    def __init__(self) -> None:
        args = ArgumentConfig()
        args.scale = 2.5
        self.pipe = GradioPipeline(
            inference_cfg=partial_fields(InferenceConfig, args.__dict__),
            crop_cfg=partial_fields(CropConfig, args.__dict__),
            args=args,
        )
        self.device = self.pipe.live_portrait_wrapper.device
        self.cache: dict = {}
        self._orig_prepare = self.pipe.prepare_retargeting_image
        self.pipe.prepare_retargeting_image = self._cached_prepare  # type: ignore[method-assign]
        eye, lip = self.pipe.init_retargeting_image(2.5, 0.0, 0.0, str(PORTRAIT))
        self.neutral = dict(
            input_eye_ratio=eye, input_lip_ratio=lip,
            input_head_pitch_variation=0.0, input_head_yaw_variation=0.0, input_head_roll_variation=0.0,
            mov_x=0.0, mov_y=0.0, mov_z=1.0,
            lip_variation_zero=0.0, lip_variation_one=0.0, lip_variation_two=0.0, lip_variation_three=0.0,
            smile=0.0, wink=0.0, eyebrow=0.0, eyeball_direction_x=0.0, eyeball_direction_y=0.0,
        )

    @staticmethod
    def _clone(v):
        if torch.is_tensor(v):
            return v.clone()
        if isinstance(v, dict):
            return {k: Renderer._clone(x) for k, x in v.items()}
        if isinstance(v, np.ndarray):
            return v.copy()
        return v

    def _cached_prepare(self, input_image, pitch, yaw, roll, scale, flag_do_crop=True):
        key = (pitch, yaw, roll)
        if key not in self.cache:
            self.cache[key] = self._orig_prepare(input_image, pitch, yaw, roll, scale, flag_do_crop=flag_do_crop)
        return tuple(self._clone(x) for x in self.cache[key])

    def render(self, **over) -> np.ndarray:
        """Full-frame RGB uint8 (1254x1254), the render pasted back into the portrait."""
        p = {**self.neutral, **over}
        with contextlib.redirect_stdout(io.StringIO()):  # upstream prints lip_delta
            _, full = self.pipe.execute_image_retargeting(input_image=str(PORTRAIT), retargeting_source_scale=2.5, **p)
        return full


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-render poses that already exist")
    ap.add_argument("--only", default="", help="comma-separated pose ids")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = [s for s in a.only.split(",") if s]
    todo = {k: v for k, v in poses().items() if (not wanted or k in wanted) and (a.force or not (OUT / f"{k}.png").exists())}
    manifest_path = OUT / "poses.json"
    if not todo:
        print("nothing to render (use --force)")
    else:
        t0 = time.perf_counter()
        r = Renderer()
        print(f"pipeline ready in {time.perf_counter() - t0:.1f}s on {r.device}; src eye/lip ratio {r.neutral['input_eye_ratio']}/{r.neutral['input_lip_ratio']}")
        r.render()  # warm-up (shader compilation)
        for name, ctl in todo.items():
            t = time.perf_counter()
            img = r.render(**ctl)
            cv2.imwrite(str(OUT / f"{name}.png"), img[..., ::-1])
            print(f"{name:16s} {time.perf_counter() - t:5.2f}s {ctl}")
    # Inner-lip gap / mouth width (px at 1024) of every mouth pose, for the manifest `opening`.
    measure = {}
    r = locals().get("r") or Renderer()
    for name in ["neutral", *[k for k in poses() if k.startswith(("mouth-", "vowel-"))]]:
        lm = r.pipe.cropper.calc_lmk_from_cropped_image(np.ascontiguousarray(cv2.imread(str(OUT / f"{name}.png"))[..., ::-1]))
        if lm is None:
            raise SystemExit(f"no landmarks for {name}")
        lm = np.asarray(lm)
        k = 1024 / 1254
        measure[name] = {
            "opening": round(float(np.linalg.norm(lm[90] - lm[102])) * k, 1),
            "width": round(float(np.linalg.norm(lm[48] - lm[66])) * k, 1),
        }
        print(f"measure {name:14s} {measure[name]}")
    manifest_path.write_text(json.dumps({"source": "source/portrait.png", "poses": poses(), "measure": measure}, indent=2))
    print("done:", OUT)


if __name__ == "__main__":
    main()
