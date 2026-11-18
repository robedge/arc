#!/usr/bin/env python
"""Pick the 12 lip_variation_three values that give equal steps in inner-lip gap (px at 1024).

Reads .cache/sweep/measure.json (from sweep.py), interpolates gap(l3) and prints the
MOUTH_LEVELS dict to paste into generate.py. Level 1 = just parted lips, level 12 = widest.
"""
import json
import sys
from pathlib import Path

import numpy as np

m = json.loads((Path(__file__).resolve().parent / ".cache" / "sweep" / "measure.json").read_text())
pts = sorted((v["params"]["lip_variation_three"], v["gap"]) for k, v in m.items() if k.startswith("l3_"))
x = np.array([p[0] for p in pts]); y = np.maximum.accumulate(np.array([p[1] for p in pts]))
lo, hi, n = float(sys.argv[1]), float(sys.argv[2]), 12
targets = np.linspace(lo, hi, n)
vals = [round(float(np.interp(t, y, x)) * 2) / 2 for t in targets]
print({i + 1: v for i, v in enumerate(vals)})
print([round(float(np.interp(v, x, y)), 1) for v in vals])
