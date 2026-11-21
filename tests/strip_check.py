#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The bar tabs on Steps, as tests/scenarios/strip.xy filmed them. Each of the four tabs draws its bar's 16 steps as a
4 x 4 grid of 2 px dots (pitch 3), row by row: a hit, a rest, the step playing, and, outside the pattern's loop, a hit
fainter; a step past the pattern's end has no dot. The bar the cells show has a ring round its tab, the bar playing a
bar of ink under its tab. A shot's name says what it shows: t<track>_b<bar viewed, 0-based>[_p<step playing, 0-based>]
[_s<kit sound>][_l<loop from>-<to>][_label]. The patterns are read back from the script's own pat and step lines, as they
stood at each shot. A dot's colour is judged against the others in its shot (a hit is the colour its first hit has), so
no theme or track colour is assumed: the classes must differ from each other and every dot must match its class.
  tests/strip_check.py DIR"""
import copy
import os
import re
import sys

from PIL import Image

TAB_X0, TAB_P, TAB_Y0 = 168, 17, 24   # the first tab's left edge, the tabs' pitch, their top (app/pages.c TAB_X, TAB_P; the main band)
DOT0, PITCH = 2, 3                    # the first dot's offset in its tab, the dots' pitch
UNDER_Y = 16                          # the playing bar's bar of ink: 2 px, from here down, under the tab
NBAR, NSTEP = 4, 64
KITS = {1}                            # T1 is the drum kit: a step is a hit for the sound shown
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scenarios", "strip.xy")
SHOT = re.compile(r"t(\d+)_b(\d)(?:_p(\d+))?(?:_s(\d+))?(?:_l(\d+)-(\d+))?(?:_[a-z]+)?\.png")


def patterns_at_shots():
    """{shot file: {track: (length, {step: note})}} from the script's pat and step lines (steps 1-based, as written)."""
    pats, shots = {}, {}
    for line in open(SCRIPT):
        w = line.split()
        if not w or w[0] == "#":
            continue
        if w[0] == "pat":
            assert w[2] == "1", line
            pats[int(w[1])] = (int(w[3]), pats.get(int(w[1]), (0, {}))[1])
        elif w[0] == "step":
            assert w[2] == "1", line
            notes = pats[int(w[1])][1]
            if int(w[4]) > 0:
                notes[int(w[3])] = int(w[4])
            else:
                notes.pop(int(w[3]), None)
        elif w[0] == "shot":
            shots[w[1]] = copy.deepcopy(pats)
    return shots


def dot(im, b, i):
    """The colour of bar b's step i, or None when its 2 x 2 px are not one flat colour."""
    x, y = TAB_X0 + b * TAB_P + DOT0 + i % 4 * PITCH, TAB_Y0 + DOT0 + i // 4 * PITCH
    px = {im.getpixel((x + dx, y + dy)) for dx in (0, 1) for dy in (0, 1)}
    return px.pop() if len(px) == 1 else None


def wanted(name, pats):
    """The class of each of the 64 steps the shot should show: hit, out (a hit outside the loop), rest, now, none."""
    t, _bar, ph, sound, lf, le = SHOT.fullmatch(name).groups()
    n, notes = pats[int(t)]
    lf, le = (int(lf), int(le)) if lf else (1, n)
    kit = int(t) in KITS
    out = []
    for s in range(NSTEP):
        hit = notes.get(s + 1, 0) == int(sound or 1) if kit else notes.get(s + 1, 0) > 0
        out.append("none" if s >= n else "now" if ph is not None and s == int(ph) else
                   "rest" if not hit else "hit" if lf <= s + 1 <= le else "out")
    return out


def seen(im, want):
    """Each step's class as drawn, by the colours the shot's own first dot of each class has; a problem list with it."""
    cols = [dot(im, s // 16, s % 16) for s in range(NSTEP)]
    fill = im.getpixel((TAB_X0 + 4, TAB_Y0 + DOT0))      # a gap's pixel: the tab's own colour
    cal = {"none": fill}
    for c, col in zip(want, cols):
        cal.setdefault(c, col)
    problems = []
    if len(set(cal.values())) != len(cal):
        problems.append(f"classes share a colour ({[c for c in cal if list(cal.values()).count(cal[c]) > 1]})")
    return [next((c for c, v in cal.items() if col is not None and v == col), "?") for col in cols], cal, problems


def marks(im):
    """The bars with a ring, and the colour of the bar of ink under each tab that has one."""
    ring, under = [], {}
    for b in range(NBAR):
        x = TAB_X0 + b * TAB_P
        ring.append(im.getpixel((x, TAB_Y0 + 7)) != im.getpixel((x + 4, TAB_Y0 + DOT0)))
        u0, u1, bg = (im.getpixel((x + 7, TAB_Y0 + UNDER_Y + k)) for k in (0, 1, 2))
        if u0 != bg or u1 != bg:
            under[b] = u0 if u0 == u1 else None
    return ring, under


def gaps_flat(im):
    """The one pixel between dots, in both directions, is the tab's own colour in every tab."""
    for b in range(NBAR):
        x0, fill = TAB_X0 + b * TAB_P, im.getpixel((TAB_X0 + b * TAB_P + 4, TAB_Y0 + DOT0))
        for g in (4, 7, 10):
            for k in range(DOT0, DOT0 + 11):
                if im.getpixel((x0 + g, TAB_Y0 + k)) != fill or im.getpixel((x0 + k, TAB_Y0 + g)) != fill:
                    return False
    return True


def main(d):
    fails, drawn = [], {}
    shots = patterns_at_shots()
    for name, pats in shots.items():
        t, bar, ph, *_ = SHOT.fullmatch(name).groups()
        im = Image.open(f"{d}/{name}").convert("RGB")
        want = wanted(name, pats)
        got, cal, problems = seen(im, want)
        drawn[name] = got
        ring, under = marks(im)
        bad = [s for s in range(NSTEP) if got[s] != want[s]]
        if bad:
            problems.append(f"{len(bad)} dots differ: " + ", ".join(f"step {s + 1} {want[s]} drawn as {got[s]}" for s in bad[:4]))
        if not gaps_flat(im):
            problems.append("the gaps between the dots are not the tab's colour")
        if ring != [b == int(bar) for b in range(NBAR)]:
            problems.append(f"rings on {[b for b in range(NBAR) if ring[b]]}, bar {bar} is the one shown")
        if ph is None:
            if under:
                problems.append(f"a bar of ink under tabs {sorted(under)} while stopped")
        elif under != {int(ph) // 16: cal.get("now")}:
            problems.append(f"bar of ink under {under}, the playhead (step {ph}) is in tab {int(ph) // 16} in {cal.get('now')}")
        print(f"strip {name}: " + ", ".join(f"{want.count(c)} {c}" for c in ("hit", "out", "rest", "now", "none") if c in want)
              + (": " + "; ".join(problems) if problems else ""))
        fails += [f"{name}: {p}" for p in problems]
    # the opposite pattern draws the opposite dots, and the other sound of a kit its own
    hit = {n: [c == "hit" for c in g] for n, g in drawn.items()}
    if any(a == b for a, b in zip(hit["t2_b2.png"], hit["t3_b2.png"])):
        fails.append("T3 holds a hit wherever T2 has none, yet their tabs do not show opposite dots")
    k1, k2 = hit["t1_b0.png"], hit["t1_b0_s2.png"]
    if not (any(k1) and any(k2)) or any(a and b for a, b in zip(k1, k2)) or any(k1[32:]) or any(k2[32:]):
        fails.append("a kit's two sounds must show their own steps, never the other's, and none past its two bars")
    # nothing past a pattern's end, though steps there hold notes
    n4, notes4 = shots["t4_b2.png"][4]
    if not any(s > n4 for s in notes4) or any(drawn["t4_b2.png"][s] != "none" for s in range(n4, NSTEP)):
        fails.append(f"T4 has notes past its {n4} steps and its tabs must show no dot there")
    print("strip: " + ("FAIL: " + "; ".join(fails) if fails else "ok"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
