#!/usr/bin/env python
"""Candidate sweep for the mouth series: render lip_variation_three values, measure the
inner-lip gap (px at 1024) from LivePortrait's 203 landmarks, save to .cache/sweep/.

Run: .cache/venv/bin/python sweep.py [--values 0,5,10,...] [--set name:key=val,key=val;...]
Output: .cache/sweep/<name>.png (full frames) and .cache/sweep/measure.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import generate as g  # noqa: E402  (chdirs into LivePortrait)

OUT = g.HERE / ".cache" / "sweep"


def lmk203(r: "g.Renderer", rgb: np.ndarray):
    lm = r.pipe.cropper.calc_lmk_from_cropped_image(np.ascontiguousarray(rgb))
    return None if lm is None else np.asarray(lm)


def opening_px(lm: np.ndarray, scale: float) -> dict:
    # 90/102: upper/lower inner-lip centre; 48/66: mouth corners (LivePortrait lip ratio points)
    gap = float(np.linalg.norm(lm[90] - lm[102]))
    width = float(np.linalg.norm(lm[48] - lm[66]))
    return {"gap": gap * scale, "width": width * scale}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--values", default="0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100")
    ap.add_argument("--sets", default="", help="name:key=val,key=val;name2:...")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    import cv2
    r = g.Renderer()
    r.render()
    scale = 1024 / 1254
    mpath = OUT / "measure.json"
    res = json.loads(mpath.read_text()) if mpath.exists() else {}
    jobs = {}
    for v in [float(x) for x in a.values.split(",") if x]:
        jobs[f"l3_{v:g}"] = dict(lip_variation_three=v)
    for s in [s for s in a.sets.split(";") if s]:
        name, kv = s.split(":")
        jobs[name] = {k: float(v) for k, v in (p.split("=") for p in kv.split(","))}
    if not a.values and a.sets:
        jobs = {k: v for k, v in jobs.items() if k in {s.split(":")[0] for s in a.sets.split(";")}}
    for name, ctl in jobs.items():
        img = r.render(**ctl)
        cv2.imwrite(str(OUT / f"{name}.png"), img[..., ::-1])
        lm = lmk203(r, img)
        m = opening_px(lm, scale) if lm is not None else {"gap": None, "width": None}
        res[name] = {"params": ctl, **m}
        print(f"{name:24s} gap={m['gap']} width={m['width']} {ctl}", flush=True)
    mpath.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
