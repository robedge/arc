#!/usr/bin/env python
"""Spike N5: map LivePortrait's retargeting controls on the Nova portrait.

Loads the portrait once through LivePortrait's GradioPipeline (no Gradio UI), renders
grids for mouth / eyes / gaze / head pose, pastes every result back into the full
1254x1254 frame, and writes .cache/explore/review.html (offline contact sheet), plus a
2D-warp fallback sample (cv2.remap) for side-by-side comparison.

Run: PYTORCH_ENABLE_MPS_FALLBACK=1 .cache/venv/bin/python explore.py
"""
from __future__ import annotations

import contextlib
import html
import io
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

HERE = Path(__file__).resolve().parent
LP = HERE / ".cache" / "LivePortrait"
OUT = HERE / ".cache" / "explore"
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

# Regions in full-frame (1254x1254) coordinates, measured on the source portrait.
MOUTH_RECT = (470, 740, 790, 900)  # x0, y0, x1, y1 (about 320x160)
EYE_RECT = (370, 420, 880, 540)
FACE_RECT = (250, 330, 1010, 1010)  # thumbnail crop

NEUTRAL = dict(
    input_eye_ratio=None,  # filled with the source ratio after init
    input_lip_ratio=None,
    input_head_pitch_variation=0.0,
    input_head_yaw_variation=0.0,
    input_head_roll_variation=0.0,
    mov_x=0.0,
    mov_y=0.0,
    mov_z=1.0,
    lip_variation_zero=0.0,
    lip_variation_one=0.0,
    lip_variation_two=0.0,
    lip_variation_three=0.0,
    smile=0.0,
    wink=0.0,
    eyebrow=0.0,
    eyeball_direction_x=0.0,
    eyeball_direction_y=0.0,
)


def partial_fields(target_class, kwargs):
    return target_class(**{k: v for k, v in kwargs.items() if hasattr(target_class, k)})


class Renderer:
    """Wraps GradioPipeline.execute_image_retargeting.

    The upstream call re-detects and re-crops the face on every invocation. We cache
    `prepare_retargeting_image` per head pose so a pose costs one detection, which is
    what generate.py will do. Cached tensors are cloned because the upstream
    delta_* helpers mutate in place.
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
        self.use_cache = True
        eye, lip = self.pipe.init_retargeting_image(2.5, 0.0, 0.0, str(PORTRAIT))
        self.src_eye, self.src_lip = eye, lip
        NEUTRAL["input_eye_ratio"] = eye
        NEUTRAL["input_lip_ratio"] = lip

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
        if not self.use_cache or key not in self.cache:
            self.cache[key] = self._orig_prepare(input_image, pitch, yaw, roll, scale, flag_do_crop=flag_do_crop)
        return tuple(self._clone(x) for x in self.cache[key])

    def render(self, **over) -> tuple[np.ndarray, float]:
        """Returns (full-frame RGB uint8, seconds)."""
        p = {**NEUTRAL, **over}
        if self.device == "mps":
            torch.mps.synchronize()
        t0 = time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):  # upstream prints lip_delta
            _, full = self.pipe.execute_image_retargeting(
                input_image=str(PORTRAIT), retargeting_source_scale=2.5, **p
            )
        if self.device == "mps":
            torch.mps.synchronize()
        return full, time.perf_counter() - t0


# --------------------------------------------------------------------------- metrics


def region_mask(shape, rect, pad=0):
    m = np.zeros(shape[:2], bool)
    x0, y0, x1, y1 = rect
    m[max(0, y0 - pad) : y1 + pad, max(0, x0 - pad) : x1 + pad] = True
    return m


def cyan_mask(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = (h > 80) & (h < 100) & (s > 120) & (v > 110)
    return cv2.dilate(m.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)


def drift_stats(src: np.ndarray, img: np.ndarray, rect) -> dict:
    d = np.abs(src.astype(np.int16) - img.astype(np.int16)).max(axis=2)
    outside = ~region_mask(src.shape, rect, pad=12)
    cy = cyan_mask(src)
    return {
        "outside_mean": float(d[outside].mean()),
        "outside_p99": float(np.percentile(d[outside], 99)),
        "outside_max": int(d[outside].max()),
        "cyan_mean": float(d[cy].mean()),
        "cyan_max": int(d[cy].max()),
    }


def heatmap(src: np.ndarray, img: np.ndarray, rect, size=(300, 300)) -> np.ndarray:
    d = np.abs(src.astype(np.int16) - img.astype(np.int16)).max(axis=2).astype(np.float32)
    d = np.clip(d * 6, 0, 255).astype(np.uint8)  # gain 6x so small drift is visible
    hm = cv2.applyColorMap(d, cv2.COLORMAP_INFERNO)[..., ::-1].copy()
    x0, y0, x1, y1 = rect
    cv2.rectangle(hm, (x0, y0), (x1, y1), (0, 255, 255), 3)  # mouth rect: excluded from drift
    fx0, fy0, fx1, fy1 = FACE_RECT
    hm = hm[fy0:fy1, fx0:fx1]
    return cv2.resize(hm, size, interpolation=cv2.INTER_AREA)


# --------------------------------------------------------------------------- output


def save_png(path: Path, rgb: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), rgb[..., ::-1], [cv2.IMWRITE_PNG_COMPRESSION, 3])


def crop(rgb: np.ndarray, rect) -> np.ndarray:
    x0, y0, x1, y1 = rect
    return rgb[y0:y1, x0:x1]


def label_img(rgb: np.ndarray, rect, scale: float) -> np.ndarray:
    c = crop(rgb, rect)
    return cv2.resize(c, None, fx=scale, fy=scale, interpolation=cv2.INTER_LANCZOS4)


class Sheet:
    """Collects sections for review.html."""

    def __init__(self) -> None:
        self.sections: list[dict] = []
        self.timings: list[float] = []

    def section(self, title: str, note: str = "") -> dict:
        s = {"title": title, "note": note, "cells": []}
        self.sections.append(s)
        return s


def add_cell(sheet: Sheet, sec: dict, name: str, label: str, src, img, rect, kind: str, sec_time: float | None = None):
    save_png(OUT / "full" / f"{name}.png", img)
    face = cv2.resize(crop(img, FACE_RECT), (300, 272), interpolation=cv2.INTER_AREA)
    save_png(OUT / "face" / f"{name}.png", face)
    cell = {"label": label, "face": f"face/{name}.png", "time": sec_time, "full": f"full/{name}.png"}
    if kind in ("mouth", "eye"):
        z = label_img(img, rect, 1.5 if kind == "mouth" else 1.0)
        save_png(OUT / "zoom" / f"{name}.png", z)
        cell["zoom"] = f"zoom/{name}.png"
    if kind == "mouth":
        save_png(OUT / "heat" / f"{name}.png", heatmap(src, img, rect))
        cell["heat"] = f"heat/{name}.png"
        cell["drift"] = drift_stats(src, img, rect)
    sec["cells"].append(cell)


# --------------------------------------------------------------------------- 2D warp fallback


def warp_mouth_open(src: np.ndarray, open_px: float) -> np.ndarray:
    """Jaw + lower-lip lift with cv2.remap and a drawn dark cavity.

    The lower lip and jaw are pushed down by a smooth field (largest at the lip line,
    gone by the chin, narrow so the mouth corners stay put). The gap this opens between
    the line and the moved lip is exactly open_px*gx(x), a lens, which is then painted
    as a dark cavity with an upper-teeth strip and a hint of tongue.
    """
    h, w = src.shape[:2]
    cx, line_y = 630.0, 812.0  # mouth centre x and the lip line (measured on the portrait)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    gx = np.exp(-(((xx - cx) / 68.0) ** 2))  # horizontal falloff keeps the corners still
    t = np.clip((yy - line_y) / 150.0, 0, 1)
    gy = np.where(yy >= line_y, 0.5 * (1 + np.cos(np.pi * t)), 0.0)  # 1 at the lip line to 0 at the chin
    shift = open_px * gx * gy
    up = open_px * 0.12 * gx  # upper lip rises slightly
    tu = np.clip((line_y - yy) / 40.0, 0, 1)
    shift_up = -up * (yy < line_y) * (1 - tu)
    map_y = (yy - shift - shift_up).astype(np.float32)
    out = cv2.remap(src, xx, map_y, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    if open_px < 2:
        return out
    top = (line_y - up[0, :]).reshape(1, -1)  # per-column top of the gap
    # bottom of the gap: first output row whose source row is past the lip line
    below = map_y[int(line_y) :, :] >= line_y + 1.0
    bot = (int(line_y) + below.argmax(axis=0)).astype(np.float32).reshape(1, -1)
    height = bot - top
    cav = ((yy >= top) & (yy <= bot) & (height > 3.0)).astype(np.float32)
    cav = cv2.GaussianBlur(cav, (0, 0), 1.3)
    col = np.empty((h, w, 3), np.float32)
    col[:] = (36, 13, 17)
    teeth_h = np.clip(height * 0.38, 0, 11)
    strip = np.clip(1 - np.abs(yy - top - teeth_h * 0.5) / (teeth_h * 0.5 + 1e-3), 0, 1)
    strip = np.clip(strip * 2.2, 0, 1) * (height > 4)
    col = col * (1 - strip[..., None] * 0.85) + np.array([208, 200, 192], np.float32) * strip[..., None] * 0.85
    tongue = np.exp(-(((xx - cx) / 55.0) ** 2 + ((yy - (bot - height * 0.22)) / np.maximum(height * 0.35, 1)) ** 2))
    col = col * (1 - tongue[..., None] * 0.6) + np.array([115, 42, 48], np.float32) * tongue[..., None] * 0.6
    res = out.astype(np.float32) * (1 - cav[..., None]) + col * cav[..., None]
    return np.clip(res, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- main


def add_warp_section(sheet: Sheet, src: np.ndarray) -> float:
    sec = sheet.section(
        "2D warp fallback: mouth open levels 1..4 (cv2.remap jaw + lower-lip lift, drawn cavity)",
        "Quick, untuned. The base pixels outside the mouth are the original portrait, so drift outside the patch is exactly zero.",
    )
    wt = []
    for lvl, px in enumerate((10, 24, 40, 56), start=1):
        t1 = time.perf_counter()
        img = warp_mouth_open(src, float(px))
        wt.append(time.perf_counter() - t1)
        add_cell(sheet, sec, f"warp_L{lvl}", f"warp level {lvl} (open {px}px)", src, img, MOUTH_RECT, "mouth", wt[-1])
    return round(1000 * sum(wt) / len(wt), 1)


PATCH_MOUTH = (450, 695, 810, 935)  # about 360x240, as in tech spec 2.7
PATCH_EYES = (370, 410, 890, 610)  # about 520x200


def feather_mask(shape, rect, px=12):
    x0, y0, x1, y1 = rect
    m = np.zeros(shape[:2], np.float32)
    m[y0 + px : y1 - px, x0 + px : x1 - px] = 1.0
    return cv2.GaussianBlur(m, (0, 0), px / 2.5)[..., None]


def composite(src: np.ndarray, lp: np.ndarray, rect) -> np.ndarray:
    m = feather_mask(src.shape, rect)
    return np.clip(src * (1 - m) + lp * m, 0, 255).astype(np.uint8)


def sharpness(rgb: np.ndarray, rect) -> float:
    g = cv2.cvtColor(crop(rgb, rect), cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def add_composites(sheet: Sheet, src: np.ndarray) -> dict:
    """LivePortrait patch (feathered) pasted over the untouched original: what the shipped frames would be."""
    sec = sheet.section(
        "Hybrid: LivePortrait patch (12 px feather) composited over the original portrait",
        "Mouth patch 360x240, eye patch 520x200. Outside the patch the pixels are the original, so cyan ring and lines cannot drift. "
        "Look for seams at the patch border and for softness (LivePortrait renders a 256 px crop, so its patch is blurrier than the 1254 px original).",
    )
    jobs = [
        ("mouth", PATCH_MOUTH, ["lipratio_0.30", "vowel_aaa_a", "vowel_eee_a", "lv3_90", "vowel_ooo_a", "vowel_mmm"]),
        ("eye", PATCH_EYES, ["eye_0.00", "eye_0.10", "eye_0.30", "gazex_-20", "gazex_20", "gazey_20", "gazey_40"]),
    ]
    sharp = {}
    for kind, rect, names in jobs:
        for n in names:
            lp = cv2.cvtColor(cv2.imread(str(OUT / "full" / f"{n}.png")), cv2.COLOR_BGR2RGB)
            comp = composite(src, lp, rect)
            sharp[n] = round(sharpness(lp, rect) / sharpness(src, rect), 2)
            zr = MOUTH_RECT if kind == "mouth" else EYE_RECT
            add_cell(sheet, sec, f"hybrid_{n}", f"hybrid {n} (sharpness vs source {sharp[n]})", src, comp, zr, kind)
    return sharp


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    src = cv2.cvtColor(cv2.imread(str(PORTRAIT)), cv2.COLOR_BGR2RGB)
    if "--html-only" in sys.argv:  # re-render review.html from saved sections.json and notes.html
        sheet = Sheet()
        sheet.sections = json.loads((OUT / "sections.json").read_text())
        meta = json.loads((OUT / "meta.json").read_text())
        if "--composites" in sys.argv:  # needs full/*.png from a previous run
            sheet.sections = [x for x in sheet.sections if not x["title"].startswith("Hybrid")]
            meta["patch_sharpness_ratio"] = add_composites(sheet, src)
            (OUT / "sections.json").write_text(json.dumps(sheet.sections, indent=2))
            (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
        if "--warp-only" in sys.argv:  # regenerate just the warp section (no LivePortrait)
            sheet.sections = [x for x in sheet.sections if not x["title"].startswith("2D warp")]
            meta["warp_ms_per_frame"] = add_warp_section(sheet, src)
            (OUT / "sections.json").write_text(json.dumps(sheet.sections, indent=2))
            (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
        write_html(sheet, meta, src)
        return
    print("portrait", src.shape)
    t0 = time.perf_counter()
    r = Renderer()
    load_s = time.perf_counter() - t0
    print(f"pipeline load + source ratios: {load_s:.1f}s device={r.device} src_eye={r.src_eye} src_lip={r.src_lip}")

    sheet = Sheet()
    timings: dict[str, list[float]] = {}
    meta = {"device": r.device, "load_s": round(load_s, 2), "src_eye_ratio": r.src_eye, "src_lip_ratio": r.src_lip}

    # warm-up (shader compilation, first MPS run) and uncached cost, as the Gradio UI would pay
    _, t_cold = r.render()
    r.use_cache = False
    _, t_uncached = r.render(input_lip_ratio=0.3)
    r.use_cache = True
    r.cache.clear()
    _, t_first_pose = r.render(input_lip_ratio=0.3)  # first call for a pose (crop + detect + render)
    meta.update(cold_first_render_s=round(t_cold, 2), uncached_render_s=round(t_uncached, 2), first_pose_render_s=round(t_first_pose, 2))

    base, _ = r.render()
    save_png(OUT / "source_roundtrip.png", base)
    meta["roundtrip_drift"] = drift_stats(src, base, MOUTH_RECT)

    def run(sec, name, label, kind, rect, **ctl):
        img, dt = r.render(**ctl)
        timings.setdefault(kind, []).append(dt)
        add_cell(sheet, sec, name, label, src, img, rect, kind, dt)
        print(f"{name:34s} {dt*1000:6.0f} ms")

    # ---- mouth ----
    sec = sheet.section(
        "Mouth: input_lip_ratio (target lip-open ratio, slider 0..0.8)",
        "Uses the retargeting network (retarget_lip). Source ratio of this portrait: %.2f." % r.src_lip,
    )
    for v in (0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8):
        run(sec, f"lipratio_{v:.2f}", f"input_lip_ratio={v}", "mouth", MOUTH_RECT, input_lip_ratio=v)

    sec = sheet.section(
        "Mouth: lip_variation_three (lip close <-> open, slider -90..120)",
        "Direct keypoint offset (no network). The main open/close control.",
    )
    for v in (-90, -45, 0, 15, 30, 45, 60, 90, 120):
        run(sec, f"lv3_{v}", f"lip_variation_three={v}", "mouth", MOUTH_RECT, lip_variation_three=float(v))

    sec = sheet.section("Mouth: lip_variation_one (pursing, slider -20..15)", "Negative = narrow/rounded, positive = wide.")
    for v in (-20, -15, -10, -5, 0, 5, 10, 15):
        run(sec, f"lv1_{v}", f"lip_variation_one={v}", "mouth", MOUTH_RECT, lip_variation_one=float(v))

    sec = sheet.section("Mouth: lip_variation_two (grin, slider 0..15)", "Wide corners, teeth-bearing shape.")
    for v in (0, 3, 6, 9, 12, 15):
        run(sec, f"lv2_{v}", f"lip_variation_two={v}", "mouth", MOUTH_RECT, lip_variation_two=float(v))

    sec = sheet.section("Mouth: lip_variation_zero (pouting, slider -0.09..0.09)", "Tiny range: pushes keypoint 19 along x.")
    for v in (-0.09, -0.06, -0.03, 0.0, 0.03, 0.06, 0.09):
        run(sec, f"lv0_{v:+.2f}", f"lip_variation_zero={v}", "mouth", MOUTH_RECT, lip_variation_zero=v)

    sec = sheet.section(
        "Mouth: vowel-like combinations",
        "Hand-picked mixes of the controls above (aaa wide-open, eee grin, ooo pursed).",
    )
    vowels = {
        "aaa_a": ("aaa: lip_ratio 0.35 + lv3 45", dict(input_lip_ratio=0.35, lip_variation_three=45.0)),
        "aaa_b": ("aaa: lip_ratio 0.5 + lv3 60", dict(input_lip_ratio=0.5, lip_variation_three=60.0)),
        "eee_a": ("eee: lv2 10 + lv1 8 + lip_ratio 0.12", dict(lip_variation_two=10.0, lip_variation_one=8.0, input_lip_ratio=0.12)),
        "eee_b": ("eee: lv2 15 + lip_ratio 0.2", dict(lip_variation_two=15.0, input_lip_ratio=0.2)),
        "ooo_a": ("ooo: lv1 -15 + lip_ratio 0.2", dict(lip_variation_one=-15.0, input_lip_ratio=0.2)),
        "ooo_b": ("ooo: lv1 -20 + lv0 -0.06 + lv3 20", dict(lip_variation_one=-20.0, lip_variation_zero=-0.06, lip_variation_three=20.0)),
        "mmm": ("mmm/closed: lip_ratio 0 + lv3 -30", dict(input_lip_ratio=0.0, lip_variation_three=-30.0)),
    }
    for k, (label, ctl) in vowels.items():
        run(sec, f"vowel_{k}", label, "mouth", MOUTH_RECT, **ctl)

    # ---- eyes ----
    sec = sheet.section(
        "Eyes: input_eye_ratio (target eyes-open ratio, slider 0..0.8) for blinks",
        "Source ratio of this portrait: %.2f. Lower = more closed." % r.src_eye,
    )
    for v in (0.0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8):
        run(sec, f"eye_{v:.2f}", f"input_eye_ratio={v}", "eye", EYE_RECT, input_eye_ratio=v)

    # ---- gaze ----
    sec = sheet.section("Gaze: eyeball_direction_x (-30..30)", "Horizontal glance; thinking = look away.")
    for v in (-30, -20, -10, 0, 10, 20, 30):
        run(sec, f"gazex_{v}", f"eyeball_direction_x={v}", "eye", EYE_RECT, eyeball_direction_x=float(v))
    sec = sheet.section(
        "Gaze: eyeball_direction_y (-63..63)", "Vertical. Upstream also adds a blink term proportional to -y/2, so large |y| closes the lids."
    )
    for v in (-63, -40, -20, 0, 20, 40, 63):
        run(sec, f"gazey_{v}", f"eyeball_direction_y={v}", "eye", EYE_RECT, eyeball_direction_y=float(v))
    sec = sheet.section("Gaze: diagonal glances (thinking pose candidates)")
    for x, y in ((-20, -15), (20, -15), (-25, 0), (25, 0), (-15, 20)):
        run(sec, f"gazexy_{x}_{y}", f"x={x}, y={y}", "eye", EYE_RECT, eyeball_direction_x=float(x), eyeball_direction_y=float(y))

    # ---- head pose ----
    sec = sheet.section("Head: relative yaw (+-25), pitch (+-15), roll (+-15)", "Small values only are useful for idle sway.")
    for k, (label, ctl) in {
        "yaw-8": ("yaw -8", dict(input_head_yaw_variation=-8.0)),
        "yaw+8": ("yaw +8", dict(input_head_yaw_variation=8.0)),
        "yaw-16": ("yaw -16", dict(input_head_yaw_variation=-16.0)),
        "yaw+16": ("yaw +16", dict(input_head_yaw_variation=16.0)),
        "pitch-6": ("pitch -6", dict(input_head_pitch_variation=-6.0)),
        "pitch+6": ("pitch +6", dict(input_head_pitch_variation=6.0)),
        "roll-5": ("roll -5", dict(input_head_roll_variation=-5.0)),
        "roll+5": ("roll +5", dict(input_head_roll_variation=5.0)),
    }.items():
        run(sec, f"head_{k}", label, "head", FACE_RECT, **ctl)

    meta["warp_ms_per_frame"] = add_warp_section(sheet, src)
    meta["patch_sharpness_ratio"] = add_composites(sheet, src)

    def stat(v):
        a = np.array(v)
        return {"n": len(v), "mean_ms": round(1000 * a.mean()), "min_ms": round(1000 * a.min()), "max_ms": round(1000 * a.max())}

    meta["timings"] = {k: stat(v) for k, v in timings.items()}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2))
    (OUT / "sections.json").write_text(json.dumps(sheet.sections, indent=2))
    write_html(sheet, meta, src)
    print(json.dumps(meta, indent=2))
    print("wrote", OUT / "review.html")


def write_html(sheet: Sheet, meta: dict, src: np.ndarray) -> None:
    save_png(OUT / "face" / "source.png", cv2.resize(crop(src, FACE_RECT), (300, 272), interpolation=cv2.INTER_AREA))
    save_png(OUT / "zoom" / "source_mouth.png", label_img(src, MOUTH_RECT, 1.5))
    notes_path = OUT / "notes.html"  # written by hand after looking at the grids
    notes = notes_path.read_text() if notes_path.exists() else "<p>(no artifact notes yet)</p>"
    parts = [
        "<!doctype html><meta charset=utf-8><title>Nova face contact sheet (N5)</title>",
        "<style>body{background:#0b0f14;color:#cfe;font:13px system-ui,sans-serif;margin:16px}"
        "h1{font-size:20px}h2{font-size:15px;margin:26px 0 4px;color:#7ee}.note{color:#9ab;margin:0 0 8px}"
        ".row{display:flex;flex-wrap:wrap;gap:10px}.cell{background:#111a22;border:1px solid #23323f;padding:6px;border-radius:4px}"
        ".cell img{display:block;image-rendering:auto}.lbl{font:12px ui-monospace,monospace;color:#bdf;margin:3px 0}"
        ".mono{font:11px ui-monospace,monospace;color:#8ab}.stack{display:flex;gap:6px;align-items:flex-start}"
        "code{color:#fd8}.notes{background:#111a22;border:1px solid #23323f;padding:8px 14px;border-radius:4px;max-width:1100px}"
        "a{color:#7cf}</style>",
        "<h1>Nova face contact sheet (spike N5)</h1>",
        f"<p class=mono>LivePortrait on {html.escape(meta['device'])}; source eye ratio {meta['src_eye_ratio']}, source lip ratio {meta['src_lip_ratio']}; "
        f"render timings: {html.escape(json.dumps(meta['timings']))}; warp {meta['warp_ms_per_frame']} ms/frame. "
        "Heatmaps are absolute difference vs the source, gain 6x, mouth rect outlined in yellow (inside it change is expected). "
        "Click any thumbnail for the full 1254x1254 frame.</p>",
        f"<div class=notes>{notes}</div>",
        "<h2>Source</h2><div class=row><div class=cell><img src=face/source.png><div class=lbl>source (face crop)</div></div>"
        "<div class=cell><img src=zoom/source_mouth.png><div class=lbl>source mouth, 1.5x</div></div></div>",
    ]
    for s in sheet.sections:
        parts.append(f"<h2>{html.escape(s['title'])}</h2>")
        if s["note"]:
            parts.append(f"<p class=note>{html.escape(s['note'])}</p>")
        parts.append("<div class=row>")
        for c in s["cells"]:
            inner = f"<a href='{c['full']}'><img src='{c['face']}' width=300></a>"
            if "zoom" in c:
                inner += f"<img src='{c['zoom']}'>"
            if "heat" in c:
                inner += f"<img src='{c['heat']}' width=300>"
            drift = ""
            if "drift" in c:
                d = c["drift"]
                drift = (
                    f"<div class=mono>outside-mouth drift mean {d['outside_mean']:.2f} p99 {d['outside_p99']:.0f} max {d['outside_max']}"
                    f" | cyan mean {d['cyan_mean']:.2f} max {d['cyan_max']}</div>"
                )
            tm = f" ({c['time']*1000:.0f} ms)" if c.get("time") else ""
            parts.append(f"<div class=cell><div class=stack>{inner}</div><div class=lbl>{html.escape(c['label'])}{tm}</div>{drift}</div>")
        parts.append("</div>")
    (OUT / "review.html").write_text("\n".join(parts))


if __name__ == "__main__":
    main()
