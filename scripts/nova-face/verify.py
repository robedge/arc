#!/usr/bin/env python
"""Verify the committed Nova face assets and write the review page.

For every frame in manifest.json the WebP patch is composited over base.webp exactly as the
app will blend it (out = base*(1-a) + patch*a, rounded) and checked:
  1. outside the patch rect: zero change (exact);
  2. the cyan ring and lines (HSV hue band, dilated) never change by more than CYAN_TOL, and
     no patch rect contains cyan pixels at all;
  3. seam: gradient magnitude in a band along the rect border does not exceed the base's
     (mean + SEAM_MEAN_TOL, p99 + SEAM_P99_TOL), and the alpha at the rect border is ~0;
  4. the base is the original portrait resized (mean abs difference <= BASE_TOL);
  5. the asset folder is <= 2.5 MB, all manifest files exist and the manifest has the schema.
Exits 1 on any violation. Writes .cache/review/review.html (offline, relative paths).

Run: .cache/venv/bin/python verify.py [--assets DIR] [--review DIR]
"""
from __future__ import annotations

import argparse
import html
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
PORTRAIT = HERE / "source" / "portrait.png"
ASSETS = HERE.parent.parent / "src" / "renderer" / "src" / "assets" / "nova"
REVIEW = HERE / ".cache" / "review"

CYAN_TOL = 2  # max abs per-channel change allowed on cyan pixels
SEAM_MEAN_TOL = 1.5  # mean gradient in the border band vs the base
SEAM_P99_TOL = 10.0
BORDER_ALPHA_MAX = 4  # of 255, at the outermost rect pixels
BASE_TOL = 2.0  # mean abs difference of base.webp vs the resized original
MAX_BYTES = 2_500_000
BAND = 3  # px each side of the rect border for the seam band


def cyan_mask(rgb: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = ((h > 80) & (h < 100) & (s > 120) & (v > 110)).astype(np.uint8)
    return cv2.dilate(m, np.ones((9, 9), np.uint8)).astype(bool)


def grad_mag(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)) / 8.0


def border_band(shape, rect) -> np.ndarray:
    x, y, w, h = rect
    outer = np.zeros(shape[:2], np.uint8)
    inner = np.zeros(shape[:2], np.uint8)
    outer[y - BAND : y + h + BAND, x - BAND : x + w + BAND] = 1
    inner[y + BAND : y + h - BAND, x + BAND : x + w - BAND] = 1
    return (outer - inner).astype(bool)


def read_rgb(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    return img[..., ::-1]


def composite(base: np.ndarray, patch_rgba: np.ndarray, rect) -> np.ndarray:
    x, y, w, h = rect
    out = base.copy()
    a = patch_rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = patch_rgba[..., 2::-1].astype(np.float32)
    out[y : y + h, x : x + w] = np.clip(np.round(base[y : y + h, x : x + w] * (1 - a) + rgb * a), 0, 255).astype(np.uint8)
    return out


def lap_var(rgb: np.ndarray) -> float:
    return float(cv2.Laplacian(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), cv2.CV_64F).var())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", type=Path, default=ASSETS)
    ap.add_argument("--review", type=Path, default=REVIEW)
    a = ap.parse_args()
    assets: Path = a.assets
    review: Path = a.review
    problems: list[str] = []

    manifest = json.loads((assets / "manifest.json").read_text())
    for key in ("version", "baseSize", "bases", "frames", "blinkSequence", "blinkTimingsMs"):
        if key not in manifest:
            problems.append(f"manifest missing {key}")
    ids = {f["id"] for f in manifest["frames"]}
    for fid in manifest["blinkSequence"]:
        if fid not in ids:
            problems.append(f"blinkSequence references unknown frame {fid}")
    if len(manifest["blinkSequence"]) != len(manifest["blinkTimingsMs"]):
        problems.append("blinkSequence and blinkTimingsMs differ in length")
    size = manifest["baseSize"]

    base = read_rgb(assets / manifest["bases"][0]["src"])
    if base.shape[:2] != (size, size):
        problems.append(f"base is {base.shape[:2]}, manifest says {size}")
    orig = cv2.resize(read_rgb(PORTRAIT), (size, size), interpolation=cv2.INTER_AREA)
    base_err = float(np.abs(base.astype(np.int16) - orig.astype(np.int16)).mean())
    if base_err > BASE_TOL:
        problems.append(f"base differs from the resized original by {base_err:.2f} (> {BASE_TOL})")

    cyan = cyan_mask(base)
    grad_base = grad_mag(base)

    total = sum(p.stat().st_size for p in assets.iterdir() if p.is_file())
    if total > MAX_BYTES:
        problems.append(f"asset folder is {total} bytes (> {MAX_BYTES})")

    # review folder: copies of the assets (for the animated preview) and composites
    if review.exists():
        shutil.rmtree(review)
    (review / "assets").mkdir(parents=True)
    (review / "comp").mkdir()
    for p in assets.iterdir():
        if p.is_file():
            shutil.copy2(p, review / "assets" / p.name)

    rows = []
    for f in manifest["frames"]:
        rect = tuple(f["rect"])
        x, y, w, h = rect
        patch = cv2.imread(str(assets / f["src"]), cv2.IMREAD_UNCHANGED)
        if patch is None or patch.shape != (h, w, 4):
            problems.append(f"{f['id']}: patch missing or not {w}x{h} RGBA")
            continue
        comp = composite(base, patch, rect)
        diff = np.abs(comp.astype(np.int16) - base.astype(np.int16)).max(axis=2)

        outside = np.ones(diff.shape, bool)
        outside[y : y + h, x : x + w] = False
        out_max = int(diff[outside].max())
        cyan_in_rect = int(cyan[y : y + h, x : x + w].sum())
        cyan_max = int(diff[cyan].max())
        band = border_band(base.shape, rect)
        seam_mean = float(grad_mag(comp)[band].mean())
        base_mean = float(grad_base[band].mean())
        seam_p99 = float(np.percentile(grad_mag(comp)[band], 99))
        base_p99 = float(np.percentile(grad_base[band], 99))
        alpha = patch[..., 3]
        edge_alpha = int(max(alpha[0].max(), alpha[-1].max(), alpha[:, 0].max(), alpha[:, -1].max()))
        changed = float((diff > 6).mean() * 100)
        sharp = lap_var(comp[y : y + h, x : x + w]) / lap_var(base[y : y + h, x : x + w])

        if out_max != 0:
            problems.append(f"{f['id']}: {out_max} change outside the patch rect")
        if cyan_max > CYAN_TOL:
            problems.append(f"{f['id']}: cyan pixels changed by {cyan_max} (> {CYAN_TOL})")
        if cyan_in_rect:
            problems.append(f"{f['id']}: {cyan_in_rect} cyan pixels inside the patch rect")
        if seam_mean > base_mean + SEAM_MEAN_TOL or seam_p99 > base_p99 + SEAM_P99_TOL:
            problems.append(f"{f['id']}: seam gradient mean {seam_mean:.2f}/p99 {seam_p99:.1f} vs base {base_mean:.2f}/{base_p99:.1f}")
        if edge_alpha > BORDER_ALPHA_MAX:
            problems.append(f"{f['id']}: alpha at the rect border is {edge_alpha} (> {BORDER_ALPHA_MAX})")

        cv2.imwrite(str(review / "comp" / f"{f['id']}_crop.png"), comp[y : y + h, x : x + w][..., ::-1])
        cv2.imwrite(str(review / "comp" / f"{f['id']}_full.jpg"), comp[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 88])
        rows.append(
            dict(id=f["id"], kind=f["kind"], rect=list(rect), kb=round((assets / f["src"]).stat().st_size / 1024, 1),
                 out_max=out_max, cyan_max=cyan_max, cyan_in_rect=cyan_in_rect, seam_mean=round(seam_mean, 2),
                 base_seam_mean=round(base_mean, 2), seam_p99=round(seam_p99, 1), base_seam_p99=round(base_p99, 1),
                 edge_alpha=edge_alpha, changed_pct=round(changed, 2), sharp=round(sharp, 2))
        )
        print(
            f"{f['id']:16s} outside_max={out_max} cyan_max={cyan_max} cyan_in_rect={cyan_in_rect} "
            f"seam={seam_mean:.2f} (base {base_mean:.2f}) p99={seam_p99:.1f} (base {base_p99:.1f}) edge_alpha={edge_alpha}"
        )

    write_review(review, manifest, rows, base_err, total, problems)
    print(f"base vs resized original: mean abs diff {base_err:.2f}; assets {total / 1024:.0f} KB; review {review / 'review.html'}")
    if problems:
        print("FAIL:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print(f"PASS: {len(rows)} frames verified")


def write_review(review: Path, manifest: dict, rows: list[dict], base_err: float, total: int, problems: list[str]) -> None:
    e = html.escape
    cards = []
    for r in rows:
        cards.append(
            f"""<section class="card"><h3>{e(r['id'])} <small>{e(r['kind'])} {r['kb']} KB</small></h3>
<div class="pair"><a href="comp/{e(r['id'])}_full.jpg"><img class="full" src="comp/{e(r['id'])}_full.jpg" alt="{e(r['id'])} full"></a>
<img class="crop" src="comp/{e(r['id'])}_crop.png" alt="{e(r['id'])} 1:1 crop"></div>
<table><tr><td>change outside rect</td><td>{r['out_max']}</td><td>cyan max change</td><td>{r['cyan_max']}</td></tr>
<tr><td>cyan px in rect</td><td>{r['cyan_in_rect']}</td><td>edge alpha</td><td>{r['edge_alpha']}/255</td></tr>
<tr><td>seam grad mean</td><td>{r['seam_mean']} (base {r['base_seam_mean']})</td><td>seam p99</td><td>{r['seam_p99']} (base {r['base_seam_p99']})</td></tr>
<tr><td>px changed &gt; 6</td><td>{r['changed_pct']}%</td><td>patch sharpness vs base</td><td>{r['sharp']}</td></tr></table></section>"""
        )
    import cv2
    x, y, w, h = manifest["frames"][0]["rect"]
    base_img = cv2.imread(str(review / "assets" / "base.webp"))
    cv2.imwrite(str(review / "comp" / "base_mouth_crop.png"), base_img[y : y + h, x : x + w])
    fr = {f["id"]: f for f in manifest["frames"]}
    def tile(pid, label, crop):
        return f'<figure><img src="comp/{crop}" alt="{e(pid)}"><figcaption>{e(label)}</figcaption></figure>'
    strip = tile("base", f"0 base {manifest.get('mouthBaseOpening', 0)} px", "base_mouth_crop.png") + "".join(
        tile(f"mouth-{i}", f"{i}: {fr[f'mouth-{i}']['opening']} px", f"mouth-{i}_crop.png") for i in range(1, manifest["mouthLevels"] + 1))
    shapes = "".join(tile(f["id"], f"{f['id']} {f['opening']} px", f"{f['id']}_crop.png") for f in manifest["frames"] if f["kind"] == "mouth" and not f.get("level"))
    status = "PASS" if not problems else "FAIL: " + "; ".join(problems)
    page = f"""<!doctype html><meta charset="utf-8"><title>Nova face review</title>
<style>
body{{background:#05080d;color:#cfe;font:14px/1.4 system-ui,sans-serif;margin:24px}}
h1,h2{{font-weight:600}} small{{color:#7aa;font-weight:400}}
.status{{padding:8px 12px;border:1px solid {'#2a6' if not problems else '#c33'};display:inline-block}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(640px,1fr));gap:16px}}
.card{{border:1px solid #1d3a44;padding:12px}} .pair{{display:flex;gap:12px;align-items:flex-start}}
.full{{width:260px;height:260px}} .crop{{max-width:360px;image-rendering:auto}}
table{{border-collapse:collapse;margin-top:8px;font-size:12px}} td{{padding:2px 8px;border-bottom:1px solid #12262c}}
canvas{{background:#000;width:512px;height:512px}} button,label{{margin-right:8px}}
.strip{{display:flex;flex-wrap:wrap;gap:6px}} figure{{margin:0}} figure img{{width:240px;display:block}} figcaption{{font-size:12px;color:#7aa}}
#stage{{display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start}}
</style>
<h1>Nova face frame set</h1>
<p class="status">verify.py: {e(status)}</p>
<p>{len(rows)} patches, base {manifest['baseSize']} px, assets {total/1024:.0f} KB (limit 2500 KB). Base vs resized original: mean abs diff {base_err:.2f}.
Every image below is the real patch composited over the base the way the app blends it. Cyan ring and lines are the original pixels.</p>
<h2>Mouth strip: base + 12 levels (1:1 crops, opening in px at 1024)</h2>
<div class="strip">{strip}</div>
<h2>Other shapes</h2>
<div class="strip">{shapes}</div>
<h2>Animated preview</h2>
<div id="stage"><div><canvas id="cv" width="1024" height="1024"></canvas></div>
<div><p><button id="talk">Talk (smooth, random)</button><button id="sweep">Smooth sweep 0 - 12 - 0</button><button id="steps">Stepped sweep (nearest level, no blend)</button><button id="blinkBtn">Blink</button><button id="think">Thinking glances</button><button id="stop">Stop</button></p>
<p>opening <input type="range" id="open" min="0" max="72" step="0.1" value="0" style="width:320px"> <span id="ov">0.0 px</span></p>
<p>shapes (crossfaded from the current mouth): <span id="shapebtns"></span></p>
<p><label><input type="checkbox" id="sway" checked> head sway (CSS, like the runtime)</label><label><input type="checkbox" id="auto" checked> auto blink every 3-6 s</label></p>
<p id="pose">pose: base</p><p>Blink sequence: {e(', '.join(manifest['blinkSequence']))} for {e(', '.join(str(t) for t in manifest['blinkTimingsMs']))} ms.</p>
<p>Smooth modes interpolate the opening (px) between the two neighbouring level patches by drawing the lower level at alpha 1 and the upper at alpha t. Level 0 is the base.</p></div></div>
<h2>Frames</h2><div class="grid">{''.join(cards)}</div>
<h2>Base</h2><img src="assets/base.webp" width="512" alt="base">
<script>
const M={json.dumps(manifest)};
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
const imgs={{}};const load=s=>new Promise(r=>{{const i=new Image();i.onload=()=>r(i);i.src='assets/'+s}});
const byId=Object.fromEntries(M.frames.map(f=>[f.id,f]));
// Level table: index 0 = base (no patch), 1..N = mouth-1..N, with the measured opening in px.
const L=[{{id:null,o:M.mouthBaseOpening||0}}];for(let i=1;i<=M.mouthLevels;i++)L.push({{id:'mouth-'+i,o:byId['mouth-'+i].opening}});
const MAXO=L[L.length-1].o;
// mouth = {{a: lowerId|null, b: upperId|null, t: 0..1}}, or a shape id fully drawn.
let opening=0,shape=null,shapeMix=0,eye=null,mode='idle',t0=performance.now(),nextBlink=3000,blinkAt=-1,glance=null,target=0,tgtTimer=0,vel=0;
function levelPair(o){{let i=0;while(i<L.length-2&&o>=L[i+1].o)i++;const lo=L[i],hi=L[i+1];return {{a:lo.id,b:hi.id,t:Math.max(0,Math.min(1,(o-lo.o)/(hi.o-lo.o)))}}}}
function patch(id,alpha){{if(!id||alpha<=0)return;const f=byId[id];ctx.globalAlpha=alpha;ctx.drawImage(imgs[id],f.rect[0],f.rect[1]);ctx.globalAlpha=1}}
let stepped=false;
function draw(){{ctx.globalAlpha=1;ctx.drawImage(imgs.base,0,0);
 let desc;
 if(stepped){{let k=0;for(let i=1;i<L.length;i++)if(Math.abs(L[i].o-opening)<Math.abs(L[k].o-opening))k=i;patch(L[k].id,1);desc='level '+k+' (stepped)'}}
 else{{const p=levelPair(opening);patch(p.a,1);patch(p.b,p.t);desc=(p.a||'base')+' -> '+p.b+' t='+p.t.toFixed(2)}}
 if(shape)patch(shape,shapeMix);
 const e=eye;if(e)patch(e,1);
 document.getElementById('pose').textContent='opening '+opening.toFixed(1)+' px: '+desc+(shape?' + '+shape+' '+shapeMix.toFixed(2):'')+' eye='+(eye||'base');
 document.getElementById('ov').textContent=opening.toFixed(1)+' px';}}
function tick(now){{const t=now-t0,dt=16;
 if(document.getElementById('sway').checked){{const a=Math.sin(t/2300)*0.6,b=Math.sin(t/3100)*0.4;cv.style.transform='translate('+(a*4)+'px,'+(b*3)+'px) rotate('+(a*0.5)+'deg)'}}else cv.style.transform='';
 if(mode==='sweep'||mode==='steps'){{const ph=(t%4000)/4000;opening=MAXO*(0.5-0.5*Math.cos(ph*2*Math.PI))}}
 if(mode==='talk'){{if(t>tgtTimer){{target=Math.random()<0.18?0:Math.random()*MAXO*(Math.random()<.3?1:.65);tgtTimer=t+90+Math.random()*110}}
  // critically damped follow so the mouth glides to each target
  const k=180,c=2*Math.sqrt(k);vel+=(k*(target-opening)-c*vel)*dt/1000;opening=Math.max(0,opening+vel*dt/1000)}}
 if(mode==='think'&&t>tgtTimer){{const d=['left','right','up','upleft','upright','down'];glance='glance-'+d[Math.floor(Math.random()*d.length)];tgtTimer=t+1200}}
 if(document.getElementById('auto').checked&&t>nextBlink&&blinkAt<0){{blinkAt=t;nextBlink=t+3000+Math.random()*3000}}
 eye=glance;
 if(blinkAt>=0){{let e=t-blinkAt,i=0,done=true;for(;i<M.blinkSequence.length;i++){{if(e<M.blinkTimingsMs[i]){{eye=M.blinkSequence[i];done=false;break}}e-=M.blinkTimingsMs[i]}}if(done){{blinkAt=-1;eye=glance}}}}
 if(mode==='manual')opening=+document.getElementById('open').value;
 draw();requestAnimationFrame(tick)}}
Promise.all([load('base.webp').then(i=>imgs.base=i),...M.frames.map(f=>load(f.src).then(i=>imgs[f.id]=i))]).then(()=>{{draw();requestAnimationFrame(tick)}});
const set=(m,st)=>()=>{{mode=m;stepped=!!st;tgtTimer=0;glance=null;shape=null;if(m!=='talk'&&m!=='sweep'&&m!=='steps'&&m!=='manual')opening=0}};
document.getElementById('talk').onclick=set('talk');document.getElementById('sweep').onclick=set('sweep');document.getElementById('steps').onclick=set('steps',true);
document.getElementById('think').onclick=set('think');document.getElementById('stop').onclick=set('idle');
document.getElementById('open').oninput=()=>{{set('manual')();mode='manual'}};
document.getElementById('blinkBtn').onclick=()=>{{blinkAt=performance.now()-t0}};
// shape buttons: ramp a shape patch in over the base/level mouth, then back out
const sb=document.getElementById('shapebtns');
M.frames.filter(f=>f.kind==='mouth'&&!f.level).forEach(f=>{{const b=document.createElement('button');b.textContent=f.id.replace('vowel-','')+' ('+f.opening+' px)';
 b.onclick=()=>{{mode=mode==='manual'?'manual':'idle';opening=mode==='manual'?opening:0;shape=f.id;shapeMix=0;const s=performance.now();const step=()=>{{const x=(performance.now()-s)/1600;shapeMix=x<.35?x/.35:x<.65?1:Math.max(0,1-(x-.65)/.35);if(x<1)requestAnimationFrame(step);else shape=null}};step()}};sb.appendChild(b)}});
</script>"""
    (review / "review.html").write_text(page)


if __name__ == "__main__":
    main()
