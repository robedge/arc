#!/usr/bin/env python
"""Contact sheet of mouth crops from .cache/sweep|frames PNGs. Usage: sheet.py out.png name,name,... [cols]"""
import sys
from pathlib import Path
import cv2
import numpy as np
H = Path(__file__).resolve().parent / ".cache"
s = 1254 / 1024
x, y, w, h = [int(v * s) for v in (362, 546, 296, 240)]
names = sys.argv[2].split(",")
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 4
tiles = []
for n in names:
    p = H / "sweep" / f"{n}.png"
    if not p.exists():
        p = H / "frames" / f"{n}.png"
    im = cv2.imread(str(p))[y:y + h, x:x + w].copy()
    cv2.putText(im, n, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 1, cv2.LINE_AA)
    tiles.append(im)
while len(tiles) % cols:
    tiles.append(np.zeros_like(tiles[0]))
rows = [np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]
cv2.imwrite(sys.argv[1], np.vstack(rows))
