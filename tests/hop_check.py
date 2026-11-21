#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Struck steps, as tests/scenarios/hop.xy filmed them: the Steps page of a synth track at 120 BPM, one frame every 16 ms,
once smooth and once with MOTION still. Row 2's cells are 9..16, step 12 empty. A cell the playhead reaches hops up into
the 4 px gap above it, rings back to rest and settles; the empty cell never moves; under still nothing moves at all.
  tests/hop_check.py DIR"""
import sys
from glob import glob
from statistics import mode

from PIL import Image

COLS = 8
CELL_X0, CELL_W = 4, 29              # the cells' left edge and pitch (app/pages.c ST_X, ST_CW)
GAP_Y0, GAP_Y1 = 92, 106             # row 2's top edge is looked for from the gap above it down this far
EMPTY_COL = 3                        # step 12: no note
MAX_HOP = 3                          # the gap is 4 px: a cell stays inside it


def frames(d, name):
    paths = sorted(glob(f"{d}/{name}_*.png"))
    assert len(paths) >= 24, f"{name}: {len(paths)} frames (hop.xy writes 32)"
    return [Image.open(p).convert("RGB") for p in paths]


def tops(im):
    """Each cell's top edge in row 2: the first row from the gap down that differs from the screen's background."""
    px = im.load()
    bg = px[1, GAP_Y0 + 2]
    out = []
    for c in range(COLS):
        x = CELL_X0 + c * CELL_W + 13
        out.append(next((y for y in range(GAP_Y0, GAP_Y1) if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > 25), GAP_Y1))
    return out


def lit_changes(ims, col):
    """How many frames the cell's body differs from the frame before it: the playhead lighting and leaving it."""
    x = CELL_X0 + col * CELL_W + 4
    return sum(1 for a, b in zip(ims, ims[1:]) if a.getpixel((x, 126)) != b.getpixel((x, 126)))


def rings_back(col_tops, rest):
    """The column leaves its rest height upward and is at rest or below it again later."""
    went = next((i for i, y in enumerate(col_tops) if y < rest), None)
    return went is not None and any(y >= rest for y in col_tops[went:])


def main(d):
    fails = []
    for name in ("smooth", "still"):
        ims = frames(d, name)
        t = [tops(im) for im in ims]
        rest = [mode(f[c] for f in t) for c in range(COLS)]
        up = [max(rest[c] - f[c] for f in t) for c in range(COLS)]
        down = [max(f[c] - rest[c] for f in t) for c in range(COLS)]
        print(f"hop {name}: rest {rest}, up {up}, down {down}")
        if len(set(rest)) != 1 or rest[0] >= GAP_Y1:
            fails.append(f"{name}: row 2's eight cells are not on screen at one height")
            continue
        if not any(lit_changes(ims, c) for c in range(COLS)):
            fails.append(f"{name}: the playhead never reached row 2")
        if name == "smooth":
            hopped = [c for c in range(COLS) if up[c] >= 1]
            if len(hopped) < 2:
                fails.append(f"smooth: only {len(hopped)} cells hopped (want 2 or more)")
            if max(up) > MAX_HOP or max(down) > MAX_HOP:
                fails.append(f"smooth: a cell moved {max(up)} up / {max(down)} down (the gap is {MAX_HOP + 1} px)")
            if up[EMPTY_COL] or down[EMPTY_COL]:
                fails.append(f"smooth: the empty step moved ({up[EMPTY_COL]} up, {down[EMPTY_COL]} down)")
            if not lit_changes(ims, EMPTY_COL):
                fails.append("smooth: the playhead never crossed the empty step, so its stillness proves nothing")
            if not any(rings_back([f[c] for f in t], rest[c]) for c in hopped):
                fails.append("smooth: no cell came back to rest after its hop")
        else:
            if any(up) or any(down):
                fails.append(f"still: cells moved (up {up}, down {down})")
    print("hop: " + ("FAIL: " + "; ".join(fails) if fails else "ok"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
