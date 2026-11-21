#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The Master page's scope, as tests/scenarios/scope.xy filmed it (one frame every 16 ms): the plot behind the EQ curve.
Playing and smooth, the master output's wave moves in it from frame to frame; stopped (once the tail is quiet), and
playing under MOTION still, the plot is the same in every frame.
  tests/scope_check.py DIR"""
import sys
from glob import glob

from PIL import Image, ImageChops

PLOT = (20, 40, 220, 116)            # inside the EQ plot (app/pages.c draw_master: x 16..224, y 12..96 below the 24 px header)
MIN_MOVING = 4                       # smooth and playing: at least this many frame pairs differ in the plot (a kick every
MIN_PIXELS = 12                      # half second, then its tail is too quiet to draw) by at least this many pixels


def pairs(d, name, want):
    paths = sorted(glob(f"{d}/{name}_*.png"))
    assert len(paths) == want, f"{name}: {len(paths)} frames (scope.xy writes {want})"
    ims = [Image.open(p).convert("RGB").crop(PLOT) for p in paths]
    return [sum(1 for px in ImageChops.difference(a, b).convert("L").getdata() if px) for a, b in zip(ims, ims[1:])]


def main(d):
    fails = []
    moving = pairs(d, "playing", 24)
    held_stopped = pairs(d, "stopped", 12)
    held_still = pairs(d, "still", 24)
    moved = sum(1 for n in moving if n >= MIN_PIXELS)
    print(f"scope playing: changed pixels per frame pair {moving}")
    print(f"scope stopped: {held_stopped}")
    print(f"scope still:   {held_still}")
    if moved < MIN_MOVING:
        fails.append(f"playing and smooth: the plot moved in {moved} of {len(moving)} frame pairs (want {MIN_MOVING} or more)")
    if any(held_stopped):
        fails.append("stopped: the plot changed while nothing sounded")
    if any(held_still):
        fails.append("MOTION still: the plot changed while a song played")
    print("scope: " + ("FAIL: " + "; ".join(fails) if fails else "ok"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
