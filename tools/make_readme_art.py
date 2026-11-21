#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The README's art (docs/img/readme-*), every motion from a simulation, the output byte for byte the same each run.

  python3 tools/make_readme_art.py [OUT_DIR] [--demo FRAMES_DIR]

OUT_DIR is docs/img by default. The SVGs (hero, rule, meters, scope, physics panels, buttons, feature cards) are drawn with fixed constants;
--demo FRAMES_DIR also builds readme-demo.png, an animated PNG, from the 240x240 captures of the host simulator in it
(f000.png, f001.png, ... 33 ms apart; see build_demo). Needs Pillow for that, nothing else.

The motion is sampled at 60 Hz from the simulation, thinned to what a straight line between keyframes (SMIL values and
keyTimes) can carry within a fraction of a pixel, and written into the SVG: a GitHub page shows it with no script.
  - springs: the firmware's critically damped spring (app/gfx_soundplant.c spring_step, closed form) and its under-damped form
    (overshoot) for the playful parts;
  - the letters fall under gravity and bounce on a floor (restitution), each impact squashing them on a spring;
  - the plants are cantilevers: two bending modes each (Euler-Bernoulli shapes), each a driven damped oscillator, the
    joint angles of four links read off the bent shape; a pluck travels across the picture at a fixed speed, damped
    along the way and reflected at the far end, and every plant (and letter, and meter-light of the rule) is excited
    when the front reaches it: the delay between them is the travelling wave;
  - what repeats is the periodic steady state of those oscillators (run for many periods first), its last keyframe
    equal to its first; what plays once (the drop, the sprouting) is held at its end;
  - the ground line is a string: the pluck is a pulse that runs along it and returns upside down from the fixed end
    (d'Alembert's solution: the pulse and its mirror image across the end add to zero there), and the rule below the
    sections is a string drawn as its first eight standing waves;
  - the scope draws the factory samples (app/samples, read with the standard wave module) from a rising zero crossing,
    as a scope's trigger does, with their spectra (a Hann-windowed discrete Fourier transform written here) as bars;
  - the physics panels are closed forms: a string's four standing waves and their sum, a resonant low-pass's response
    and its ring after one tap, a critically damped and an under-damped spring, and frequency modulation as wheels
    riding one another whose sizes are the Bessel functions that set the strength of each sideband.
The letters are the outlines of base/assets/fonts/BarlowSemiCondensed (SIL OFL 1.1), read by a small TrueType reader
below, so the text needs no font on the viewer's side."""

import argparse
import itertools
import math
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "base" / "assets" / "fonts"

BG, PANEL, PANEL2, LINE = "#06070f", "#0e1022", "#1a1d3a", "#242850"
TEXT, MUTED = "#eef1ff", "#8e96cd"
INKS = (
    "#ff4081",
    "#ff911e",
    "#ffe628",
    "#3cff78",
    "#00e1ff",
    "#3c78ff",
    "#a05cff",
    "#eb40ff",
)
FPS = 60
STEPS = 4  # simulation steps per frame: h = 1/240 s


# ---- numbers and colours -------------------------------------------------------------------------------------------
def num(x, p=2):
    s = f"{x:.{p}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def rgb(h):
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


def hexc(c):
    return "#" + "".join(f"{max(0, min(255, round(v))):02x}" for v in c)


def mix(a, b, t):
    return hexc(tuple(x + (y - x) * t for x, y in zip(rgb(a), rgb(b))))


def ink_at(u):
    p = max(0.0, min(1.0, u)) * (len(INKS) - 1)
    i = min(int(p), len(INKS) - 2)
    return mix(INKS[i], INKS[i + 1], p - i)


def esc(s):
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ---- TrueType outlines ---------------------------------------------------------------------------------------------
class Font:
    """The glyf outlines of a TrueType file (simple glyphs; a composite one is refused), as SVG path data."""

    def __init__(self, path):
        d = Path(path).read_bytes()
        self.d = d
        count = struct.unpack_from(">H", d, 4)[0]
        self.t = {}
        for i in range(count):
            tag, _, off, _ln = struct.unpack_from(">4sIII", d, 12 + 16 * i)
            self.t[tag.decode("latin1")] = off
        head = self.t["head"]
        self.upm = struct.unpack_from(">H", d, head + 18)[0]
        self.long_loca = struct.unpack_from(">h", d, head + 50)[0] == 1
        self.nhm = struct.unpack_from(">H", d, self.t["hhea"] + 34)[0]
        self.cmap = self._cmap()
        self._cache = {}

    def _cmap(self):
        d, c = self.d, self.t["cmap"]
        for i in range(struct.unpack_from(">H", d, c + 2)[0]):
            pid, eid, off = struct.unpack_from(">HHI", d, c + 4 + 8 * i)
            s = c + off
            if (pid, eid) not in ((3, 1), (0, 3), (0, 4)) or struct.unpack_from(
                ">H", d, s
            )[0] != 4:
                continue
            segx2 = struct.unpack_from(">H", d, s + 6)[0]
            seg = segx2 // 2
            ends = struct.unpack_from(f">{seg}H", d, s + 14)
            starts = struct.unpack_from(f">{seg}H", d, s + 16 + segx2)
            deltas = struct.unpack_from(f">{seg}h", d, s + 16 + 2 * segx2)
            ro = s + 16 + 3 * segx2
            offs = struct.unpack_from(f">{seg}H", d, ro)
            m = {}
            for k in range(seg):
                for ch in range(starts[k], ends[k] + 1):
                    if ch == 0xFFFF:
                        continue
                    if offs[k] == 0:
                        g = (ch + deltas[k]) & 0xFFFF
                    else:
                        g = struct.unpack_from(
                            ">H", d, ro + 2 * k + offs[k] + 2 * (ch - starts[k])
                        )[0]
                        g = (g + deltas[k]) & 0xFFFF if g else 0
                    m[ch] = g
            return m
        raise ValueError("no format 4 cmap")

    def glyph_of(self, ch):
        if ord(ch) not in self.cmap or self.cmap[ord(ch)] == 0:
            raise ValueError(f"no glyph for {ch!r}")
        return self.cmap[ord(ch)]

    def advance(self, g):
        return struct.unpack_from(
            ">H", self.d, self.t["hmtx"] + 4 * min(g, self.nhm - 1)
        )[0]

    def _composite(self, p):
        """The contours of a composite glyph whose components start at byte p: each moved by its offset (and
        scaled, when it says so)."""
        d, out = self.d, []
        while True:
            flags, comp = struct.unpack_from(">HH", d, p)
            p += 4
            if flags & 1:
                dx, dy = struct.unpack_from(">hh", d, p)
                p += 4
            else:
                dx, dy = struct.unpack_from(">bb", d, p)
                p += 2
            if not flags & 2:
                raise ValueError("composite glyph placed by points")
            m = (1.0, 0.0, 0.0, 1.0)
            if flags & 8:
                s = struct.unpack_from(">h", d, p)[0] / 16384
                m = (s, 0.0, 0.0, s)
                p += 2
            elif flags & 0x40:
                a, e = (v / 16384 for v in struct.unpack_from(">hh", d, p))
                m = (a, 0.0, 0.0, e)
                p += 4
            elif flags & 0x80:
                m = tuple(v / 16384 for v in struct.unpack_from(">hhhh", d, p))
                p += 8
            for pts in self._points(comp):
                out.append(
                    [
                        (
                            m[0] * x + m[2] * y + dx,
                            m[1] * x + m[3] * y + dy,
                            on,
                        )
                        for x, y, on in pts
                    ]
                )
            if not flags & 0x20:
                return out

    def _points(self, g):
        if g in self._cache:
            return self._cache[g]
        d, loca = self.d, self.t["loca"]
        if self.long_loca:
            a, b = struct.unpack_from(">II", d, loca + 4 * g)
        else:
            a, b = (v * 2 for v in struct.unpack_from(">HH", d, loca + 2 * g))
        contours = []
        if b > a:
            p = self.t["glyf"] + a
            nc = struct.unpack_from(">h", d, p)[0]
            if nc < 0:
                contours = self._composite(p + 10)
                self._cache[g] = contours
                return contours
            ends = struct.unpack_from(f">{nc}H", d, p + 10)
            p += 10 + 2 * nc
            p += 2 + struct.unpack_from(">H", d, p)[0]
            npts = ends[-1] + 1
            flags = []
            while len(flags) < npts:
                f = d[p]
                p += 1
                flags.append(f)
                if f & 8:
                    flags.extend([f] * d[p])
                    p += 1
            coords = []
            for short, same in ((2, 16), (4, 32)):
                v, out = 0, []
                for f in flags:
                    if f & short:
                        dv = d[p]
                        p += 1
                        v += dv if f & same else -dv
                    elif not f & same:
                        v += struct.unpack_from(">h", d, p)[0]
                        p += 2
                    out.append(v)
                coords.append(out)
            first = 0
            for e in ends:
                contours.append(
                    [
                        (coords[0][i], coords[1][i], bool(flags[i] & 1))
                        for i in range(first, e + 1)
                    ]
                )
                first = e + 1
        self._cache[g] = contours
        return contours

    def outline(self, g, scale, dx=0.0, dy=0.0):
        """SVG path data of glyph g, y up in the font and down in the picture, its origin at (dx, dy)."""

        def pt(x, y):
            return f"{num(dx + x * scale, 1)} {num(dy - y * scale, 1)}"

        out = []
        for pts in self._points(g):
            if not any(p[2] for p in pts):
                m = ((pts[-1][0] + pts[0][0]) / 2, (pts[-1][1] + pts[0][1]) / 2, True)
                pts = [m] + pts
            k = next(i for i, p in enumerate(pts) if p[2])
            pts = pts[k:] + pts[:k]
            out.append("M" + pt(*pts[0][:2]))
            ctrl = None
            for p in pts[1:] + [pts[0]]:
                if p[2]:
                    out.append(
                        ("L" + pt(*p[:2]))
                        if ctrl is None
                        else ("Q" + pt(*ctrl) + " " + pt(*p[:2]))
                    )
                    ctrl = None
                else:
                    if ctrl is not None:
                        out.append(
                            "Q"
                            + pt(*ctrl)
                            + " "
                            + pt((ctrl[0] + p[0]) / 2, (ctrl[1] + p[1]) / 2)
                        )
                    ctrl = p[:2]
            out.append("Z")
        return "".join(out)

    def run(self, s, size, tracking=0.0, dx=0.0):
        """(path data, width) of the string s, baseline at y 0, starting at x dx."""
        sc, x, parts = size / self.upm, dx, []
        for ch in s:
            g = self.glyph_of(ch)
            parts.append(self.outline(g, sc, x, 0.0))
            x += self.advance(g) * sc + tracking
        return "".join(parts), x - dx - tracking


_fonts = {}


def font(weight):
    if weight not in _fonts:
        _fonts[weight] = Font(FONTS / f"BarlowSemiCondensed-{weight}.ttf")
    return _fonts[weight]


# ---- physics -------------------------------------------------------------------------------------------------------
def spring_cd(x, v, to, w, dt):
    """The firmware's critically damped spring (app/gfx_soundplant.c spring_step), closed form: no overshoot."""
    e = x - to
    k = v + w * e
    ex = math.exp(-w * dt)
    return to + (e + k * dt) * ex, (v - w * k * dt) * ex


class Osc:
    """x'' = -w^2 (x - to) - 2 z w x', z < 1, stepped in closed form by h while the target holds: the under-damped
    form of the spring above (overshoot e^(-pi z / sqrt(1 - z^2)))."""

    def __init__(self, w, z, h):
        wd = w * math.sqrt(1 - z * z)
        ex, c, s, k = (
            math.exp(-z * w * h),
            math.cos(wd * h),
            math.sin(wd * h),
            z * w / wd,
        )
        self.h = h
        self.a, self.b = ex * (c + s * k), ex * s / wd
        self.c, self.d = -ex * s * w * w / wd, ex * (c - s * k)

    def step(self, x, v, to):
        e = x - to
        return to + self.a * e + self.b * v, self.c * e + self.d * v


def settle(w, z, x0, to, t_start, t_end, hold=None):
    """Frame samples (t, x) of x0 -> to on an under-damped spring that is released at t_start (held at x0 before)."""
    o = Osc(w, z, 1.0 / FPS)
    x, v, out = x0, 0.0, []
    for k in range(round(t_end * FPS) + 1):
        t = k / FPS
        if t >= t_start - 1e-9 and k > 0 and t > t_start + 1e-9:
            x, v = o.step(x, v, to)
        out.append((t, x))
    return out


def periodic(osc, target, n, cycles=8):
    """Samples q[0..n] (n frames of one period) of an oscillator following target(t), t in seconds, whose period is n
    frames: the steady state, after running `cycles` periods first. q[n] = q[0] is checked, then made exact."""
    h = osc.h
    fc = [target((j + 0.5) * h) for j in range(n * STEPS)]
    q = v = 0.0
    for _ in range(cycles):
        for f in fc:
            q, v = osc.step(q, v, f)
    out = [q]
    for j in range(n):
        for s in range(STEPS):
            q, v = osc.step(q, v, fc[j * STEPS + s])
        out.append(q)
    if abs(out[n] - out[0]) > 1e-6:
        raise ValueError(f"not periodic: {out[0]} -> {out[n]}")
    out[n] = out[0]
    return out


def pulses(arrivals, tau, period):
    """A forcing that repeats every `period`: a half sine of length tau at each (time, amplitude)."""

    def f(t):
        s = 0.0
        for a, amp in arrivals:
            u = (t - a) % period
            if u < tau:
                s += amp * math.sin(math.pi * u / tau)
        return s

    return f


# The pluck: a front that leaves the left (X0) at T_PLUCK and crosses to X1 at SPEED, damped by LAMBDA on the way (e^(-d/LAMBDA)),
# reflected at X1 with RHO of its force, spreading (S0 wide, DIFF px^2/s) as it goes.
P, T_PLUCK, SPEED = 6.0, 3.0, 620.0
X0, X1, LAMBDA, RHO = -150.0, 1350.0, 1500.0, 0.55
S0, DIFF = 26.0, 3000.0


def arrivals(x, amp):
    """When the front (forward, then reflected) reaches x, and with what force."""
    span = X1 - X0
    fwd = x - X0
    back = span + (X1 - x)
    return [
        ((T_PLUCK + fwd / SPEED) % P, amp * math.exp(-fwd / LAMBDA)),
        ((T_PLUCK + back / SPEED) % P, amp * RHO * math.exp(-back / LAMBDA)),
    ]


def front(u):
    """The front u seconds after the pluck: (x, sigma, strength), None before it and after it has gone."""
    d, span = SPEED * u, X1 - X0
    if d < 0 or d > 2 * span:
        return None
    x = X0 + d if d <= span else X1 - (d - span)
    sig = math.sqrt(S0 * S0 + 2 * DIFF * u)
    return (
        x,
        sig,
        math.exp(-d / LAMBDA) * (RHO if d > span else 1.0) * math.sqrt(S0 / sig),
    )


# Cantilever bending modes (Euler-Bernoulli): shape phi(xi), xi along the stem 0 (clamped) .. 1 (free), phi(1) = 1.
_BETA, _SIGMA = (1.8751040687, 4.6940911330), (0.7340955137, 1.0184672213)


def _shape(m, xi, deriv):
    b, s = _BETA[m], _SIGMA[m]
    if not deriv:
        f = lambda x: (
            math.cosh(b * x)
            - math.cos(b * x)
            - s * (math.sinh(b * x) - math.sin(b * x))
        )
        return f(xi) / f(1.0)
    f = lambda x: (
        b
        * (
            math.sinh(b * x)
            + math.sin(b * x)
            - s * (math.cosh(b * x) - math.cos(b * x))
        )
    )
    g = lambda x: (
        math.cosh(b * x) - math.cos(b * x) - s * (math.sinh(b * x) - math.sin(b * x))
    )
    return f(xi) / g(1.0)


# ---- keyframes -----------------------------------------------------------------------------------------------------
def thin(ts, vs, eps):
    """Indices of the samples to keep: the fewest for which straight lines between them stay within eps (per
    component) of every sample (Ramer-Douglas-Peucker over time)."""
    n = len(ts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            f = (ts[i] - ts[a]) / (ts[b] - ts[a])
            e = max(
                abs(vs[i][k] - (vs[a][k] + f * (vs[b][k] - vs[a][k]))) / eps[k]
                for k in range(len(eps))
            )
            if e > worst:
                worst, wi = e, i
        if worst > 1.0:
            keep[wi] = True
            stack += [(a, wi), (wi, b)]
    return [i for i in range(n) if keep[i]]


def keys(tag, attr, ts, vs, dur, loop, decimals=2, extra=""):
    """An <animate> / <animateTransform> through the keyframes (ts in seconds from 0 to dur, vs tuples), as given."""
    kt = ";".join(num(t / dur, 4) for t in ts)
    vals = ";".join(" ".join(num(c, decimals) for c in v) for v in vs)
    mode = 'repeatCount="indefinite"' if loop else 'fill="freeze"'
    return f'<{tag} {attr} dur="{num(dur, 3)}s" {mode} calcMode="linear" keyTimes="{kt}" values="{vals}"{extra}/>'


def smil(tag, attr, ts, vs, eps, dur, loop, decimals=2, extra=""):
    """An <animate> / <animateTransform> of the samples (ts in seconds from 0 to dur, vs tuples), thinned."""
    idx = thin(ts, vs, eps)
    return keys(
        tag,
        attr,
        [ts[i] for i in idx],
        [vs[i] for i in idx],
        dur,
        loop,
        decimals,
        extra,
    )


def tr(kind, ts, vs, eps, dur, loop, decimals=2):
    return smil(
        "animateTransform",
        f'attributeName="transform" type="{kind}"',
        ts,
        vs,
        eps,
        dur,
        loop,
        decimals,
    )


def at(name, ts, vs, eps, dur, loop, decimals=3):
    return smil("animate", f'attributeName="{name}"', ts, vs, eps, dur, loop, decimals)


def frames(n):
    return [k / FPS for k in range(n + 1)]


class Doc:
    def __init__(self, w, h, title, desc):
        self.w, self.h, self.title, self.desc = w, h, title, desc
        self.defs, self.body, self.n = [], [], 0
        self.glyphs = {}

    def uid(self, p):
        self.n += 1
        return f"{p}{self.n}"

    def text(self, weight, s, size, x, y, fill, anchor="start", tracking=0.0, extra=""):
        """The string s as <use>s of outlined glyphs (each glyph's path is written once per picture), baseline at
        y, anchored at x (start, middle or end)."""
        f = font(weight)
        sc, pos, parts = size / f.upm, 0.0, []
        for ch in s:
            g = f.glyph_of(ch)
            if f._points(g):
                gid = f"{weight[0]}{num(size, 1)}_{ord(ch)}"
                if gid not in self.glyphs:
                    self.glyphs[gid] = f'<path id="{gid}" d="{f.outline(g, sc)}"/>'
                parts.append(
                    f'<use href="#{gid}"'
                    + (f' x="{num(pos, 1)}"' if pos else "")
                    + "/>"
                )
            pos += f.advance(g) * sc + tracking
        dx = {"start": 0.0, "middle": -(pos - tracking) / 2, "end": -(pos - tracking)}[
            anchor
        ]
        return f'<g transform="translate({num(x + dx, 1)} {num(y, 1)})" fill="{fill}"{extra}>{"".join(parts)}</g>'

    def svg(self, rx):
        clip = f'<clipPath id="cp"><rect width="{self.w}" height="{self.h}" rx="{rx}"/></clipPath>'
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" '
            f'height="{self.h}" role="img" aria-labelledby="ti de">\n<title id="ti">{esc(self.title)}</title>\n'
            f'<desc id="de">{esc(self.desc)}</desc>\n<defs>{clip}\n'
            + "\n".join(self.defs + list(self.glyphs.values()))
            + "\n</defs>\n"
            f'<g clip-path="url(#cp)">\n<rect width="{self.w}" height="{self.h}" fill="{BG}"/>\n'
            + "\n".join(self.body)
            + f'\n</g>\n<rect x=".5" y=".5" width="{self.w - 1}" height="{self.h - 1}" rx="{rx}" fill="none" '
            f'stroke="{LINE}"/>\n</svg>\n'
        )


def lin(i, x1, y1, x2, y2, stops, units=""):
    s = "".join(
        f'<stop offset="{num(o, 3)}" stop-color="{c}"'
        + (f' stop-opacity="{num(a, 2)}"' if a < 1 else "")
        + "/>"
        for o, c, a in stops
    )
    return f'<linearGradient id="{i}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"{units}>{s}</linearGradient>'


def rad(i, stops, extra=""):
    s = "".join(
        f'<stop offset="{num(o, 3)}" stop-color="{c}"'
        + (f' stop-opacity="{num(a, 2)}"' if a < 1 else "")
        + "/>"
        for o, c, a in stops
    )
    return f'<radialGradient id="{i}"{extra}>{s}</radialGradient>'


def rainbow(i, x0, x1):
    stops = [(k / 7, INKS[k], 1) for k in range(8)]
    return lin(i, x0, 0, x1, 0, stops, ' gradientUnits="userSpaceOnUse"')


# ---- the rule under a title (the app draws one under its header), its pulse a travelling, spreading, damped front ----
def rule(d, x0, x1, y, t_open):
    """The spectrum rule across x0..x1 at y: the eight inks, a dim echo under it, eight lamps. A pulse travels along
    it, spreads and fades; the rule itself opens with a critically damped spring from the middle."""
    rg, hg = d.uid("rg"), d.uid("hg")
    d.defs += [
        rainbow(rg, x0, x1),
        rad(hg, [(0, "#ffffff", 1), (0.35, "#ffffff", 0.55), (1, "#ffffff", 0)]),
        f'<clipPath id="rc{rg}"><rect x="{x0 - 8}" y="{y - 14}" width="{x1 - x0 + 16}" height="28"/></clipPath>',
    ]
    cx, T0 = (x0 + x1) / 2, 3.6
    # opening: scale about the middle
    ts, sx, x, v = frames(round(T0 * FPS)), [], 0.001, 0.0
    for t in ts:
        if t > t_open:
            x, v = spring_cd(x, v, 1.0, 7.0, 1.0 / FPS)
        sx.append((x, 1.0))
    body = [
        (
            f'<g transform="translate({num(cx, 1)} {y})"><g>{tr("scale", ts, sx, (0.002, 0.002), T0, False, 3)}'
            f'<g transform="translate({num(-cx, 1)} {-y})">'
        ),
        f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="url(#{rg})" stroke-width="11" stroke-linecap="round" opacity=".16"/>',
        f'<line x1="{x0}" y1="{y + 7}" x2="{x1}" y2="{y + 7}" stroke="url(#{rg})" stroke-width="1" opacity=".3"/>',
        f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}" stroke="url(#{rg})" stroke-width="3" stroke-linecap="round"/>',
    ]
    n = round(P * FPS)
    # the pulse: position, width, strength, and each lamp's flash
    tsp = frames(n)
    xs, sg, am = [], [], []
    lamps = [x0 + (x1 - x0) * k / 7 for k in range(8)]
    flash = [[] for _ in lamps]
    for t in tsp:
        st = front((t - T_PLUCK) % P)
        x_, s_, a_ = st if st else (X0, S0, 0.0)
        xs.append((x_,))
        sg.append((2.4 * s_,))
        am.append((min(1.0, a_),))
        for k, lx in enumerate(lamps):
            flash[k].append(
                (min(1.0, a_ * 1.4 * math.exp(-((x_ - lx) ** 2) / (2 * s_ * s_))),)
            )
    for a in (xs, sg, am, *flash):
        a[-1] = a[0]
    body.append(
        f'<g clip-path="url(#rc{rg})"><ellipse cx="{X0}" cy="{y}" rx="{num(2.4 * S0, 1)}" ry="9" fill="url(#{hg})" opacity="0">'
    )
    body.append(at("cx", tsp, xs, (0.1,), P, True, 1))
    body.append(at("rx", tsp, sg, (0.1,), P, True, 1))
    body.append(at("opacity", tsp, am, (0.01,), P, True, 3))
    body.append("</ellipse></g>")
    for k, lx in enumerate(lamps):
        body.append(
            f'<circle cx="{num(lx, 1)}" cy="{y}" r="4.5" fill="{INKS[k]}" opacity=".5"/>'
        )
        body.append(
            f'<circle cx="{num(lx, 1)}" cy="{y}" r="6" fill="#fff" opacity="0">'
            + at("opacity", tsp, flash[k], (0.02,), P, True, 2)
            + "</circle>"
        )
    body.append("</g></g></g>")
    return "\n".join(body)


# ---- hero ----------------------------------------------------------------------------------------------------------
HW, HH = 1200, 740
BASE_Y = HH - 14
STEM_X = [600 + (i - 3.5) * 136 for i in range(8)]
STEM_L = [226, 262, 238, 270, 244, 266, 232, 252]
STEM_LEAN = [-4, 3, -2, 4, -3, 2, -4, 3]
T_INTRO = 3.6


def tint(ink, t):  # toward the ground at t = 0, the ink at t = 1
    return mix(mix(ink, BG, 0.5), ink, t**0.85)


def flower(d, n_petals, uid):
    r = 30.0
    parts = []
    for k in range(n_petals):
        parts.append(
            f'<ellipse cy="{num(-r * 0.56, 1)}" rx="{num(r * 0.25, 1)}" ry="{num(r * 0.5, 1)}" '
            f'transform="rotate({num(360 * k / n_petals, 2)})" fill="currentColor" fill-opacity=".9"/>'
        )
    for k in range(n_petals):
        parts.append(
            f'<ellipse cy="{num(-r * 0.36, 1)}" rx="{num(r * 0.15, 1)}" ry="{num(r * 0.3, 1)}" '
            f'transform="rotate({num(360 * (k + 0.5) / n_petals, 2)})" fill="#fff" fill-opacity=".42"/>'
        )
    parts.append(f'<circle r="{num(r * 0.2, 1)}" fill="#fff" fill-opacity=".95"/>')
    d.defs.append(f'<g id="{uid}">' + "".join(parts) + "</g>")


def leaf(length, rot, flip, fill):
    k = length
    path = f"M0 0C{num(k * 0.25)} {num(-k * 0.3)} {num(k * 0.72)} {num(-k * 0.3)} {num(k)} 0C{num(k * 0.72)} {num(k * 0.3)} {num(k * 0.25)} {num(k * 0.3)} 0 0Z"
    sc = " scale(-1 1)" if flip else ""
    return f'<path transform="rotate({rot}){sc}" d="{path}" fill="{fill}"/>'


def plant(d, i, ink):
    x, L, lean = STEM_X[i], STEM_L[i], STEM_LEAN[i]
    fr = [0.30, 0.28, 0.24, 0.18]
    lens = [L * f for f in fr]
    wid = [12.0, 9.6, 7.6, 6.0, 4.8]
    mids = [(sum(lens[:j]) + lens[j] / 2) / L for j in range(4)]
    n = round(P * FPS)
    tsp = frames(n)
    # two bending modes, a driven damped oscillator each; the pluck's arrivals plus a slow wind of one cycle per half period
    f1 = (240.0 / L) ** 2
    pl = pulses(arrivals(x, 1.0), 0.12, P)
    wind = lambda t: 0.011 * math.sin(2 * math.pi * 2 * t / P + 0.9 * i)
    q1 = periodic(
        Osc(2 * math.pi * f1, 0.10, 1 / (FPS * STEPS)),
        lambda t: 0.23 * pl(t) + wind(t),
        n,
    )
    q2 = periodic(
        Osc(2 * math.pi * 6.267 * f1, 0.16, 1 / (FPS * STEPS)),
        lambda t: 0.05 * pl(t),
        n,
    )
    slope = [
        [
            q1[k] * _shape(0, mids[j], True) + q2[k] * _shape(1, mids[j], True)
            for k in range(n + 1)
        ]
        for j in range(4)
    ]
    # the blossom's pulse: the front makes it swell
    qb = periodic(
        Osc(2 * math.pi * 3.0, 0.22, 1 / (FPS * STEPS)), lambda t: 0.16 * pl(t), n
    )
    # the plant rises (once), then the blossom opens (once)
    t0 = 0.12 + 0.09 * i
    rise = settle(2 * math.pi * 1.15, 0.62, 0.001, 1.0, t0, T_INTRO)
    pop = settle(2 * math.pi * 2.0, 0.36, 0.001, 1.0, t0 + 0.6, T_INTRO)
    ts_i = [r[0] for r in rise]

    g = [
        f'<g transform="translate({num(x, 1)} {BASE_Y})"><g>'
        + tr("scale", ts_i, [(r[1],) for r in rise], (0.003,), T_INTRO, False, 3)
    ]
    side = 1 if i % 2 == 0 else -1
    closing = ""
    for j in range(4):
        rel = [
            (slope[j][k] - (slope[j - 1][k] if j else 0.0)) * 180 / math.pi + lean / 4
            for k in range(n + 1)
        ]
        g.append("<g>" + tr("rotate", tsp, [(a,) for a in rel], (0.05,), P, True, 2))
        c0, c1 = tint(ink, j / 4), tint(ink, (j + 1) / 4)
        gid = d.uid("st")
        d.defs.append(lin(gid, 0, 1, 0, 0, [(0, c0, 1), (1, c1, 1)]))
        l, w0, w1 = lens[j], wid[j], wid[j + 1]
        g.append(
            f'<path d="M{num(-w0 / 2, 1)} 0L{num(-w1 / 2, 1)} {num(-l, 1)}L{num(w1 / 2, 1)} {num(-l, 1)}L{num(w0 / 2, 1)} 0Z" fill="url(#{gid})"/>'
            f'<circle cy="{num(-l, 1)}" r="{num(w1 / 2, 1)}" fill="{c1}"/>'
        )
        if j in (0, 1, 2):
            sz = (50, 44, 34)[j]
            lc = mix(ink, BG, 0.38 + 0.1 * j)
            g.append(
                f'<g transform="translate(0 {num(-l * 0.9, 1)})">{leaf(sz, -34 * side if j % 2 == 0 else 34 * side, side < 0 if j % 2 == 0 else side > 0, lc)}</g>'
            )
        g.append(f'<g transform="translate(0 {num(-l, 1)})">')
        closing += "</g></g>"
    # the tip: blossom
    halo = d.uid("ha")
    d.defs.append(rad(halo, [(0, ink, 0.55), (0.45, ink, 0.2), (1, ink, 0)]))
    g.append(
        "<g>"
        + tr("scale", ts_i, [(p[1],) for p in pop], (0.003,), T_INTRO, False, 3)
        + "<g>"
    )
    g.append(tr("scale", tsp, [(1 + q,) for q in qb], (0.004,), P, True, 3))
    g.append(
        f'<circle r="66" fill="url(#{halo})"/><use href="#fl{6 + i % 3}" color="{ink}"/>'
        "</g></g>"
    )
    g.append(closing + "</g></g>")
    return "\n".join(g)


GROUND_Y, BUMP_H, U_END = HH - 18, 44.0, 2 * (X1 - X0) / SPEED


def ground_string(d):
    """The ground line as a string held at both ends. The pluck is a bump on it that runs at the front's speed, spreads
    and weakens, meets the fixed end past the right edge and comes back upside down (d'Alembert: the bump that runs on
    and its inverted image). One path, drawn twice, each moved by translate and scale; the height is the square root
    of the strength so the return is still there to see."""
    bid = d.uid("bp")
    f = lambda t: math.exp(-t * t / 2)
    unit = curve(f, lambda t: -t * f(t), span_t(-3.6, 3.6, 8), 1.0, -1.0, 0.0, 0.0, 3)
    d.defs.append(f'<path id="{bid}" d="{unit}" vector-effect="non-scaling-stroke"/>')
    # the line fades out toward the bump's feet, in the bump's own units, so it reads as the string lifting
    gid, col = d.uid("bg"), mix(TEXT, INKS[6], 0.25)
    d.defs.append(
        lin(
            gid,
            -3.6,
            0,
            3.6,
            0,
            [(0, col, 0), (0.3, col, 1), (0.7, col, 1), (1, col, 0)],
            ' gradientUnits="userSpaceOnUse"',
        )
    )
    tsp = frames(round(P * FPS))
    rows = [[], []]
    for t in tsp:
        u = (t - T_PLUCK) % P
        for k, (c, s, a) in enumerate(pulse_parts(u, RHO)):
            rows[k].append(
                ((c, GROUND_Y), (s, BUMP_H * math.copysign(math.sqrt(abs(a)), a)))
            )
    # gone by the time it has crossed the string twice; fading over the last 0.8 s
    env = [(max(0.0, min(1.0, (U_END - (t - T_PLUCK) % P) / 0.8)),) for t in tsp]
    bumps = "".join(
        "<g>"
        + tr("translate", tsp, [r[0] for r in rr], (0.3, 0.05), P, True, 1)
        + "<g>"
        + tr("scale", tsp, [r[1] for r in rr], (0.4, 0.1), P, True, 2)
        + f'<use href="#{bid}" stroke-width="9" opacity=".22"/><use href="#{bid}" stroke-width="3"/></g></g>'
        for rr in rows
    )
    return (
        f'<g opacity="0" fill="none" stroke="url(#{gid})" stroke-linecap="round">'
        + at("opacity", tsp, env, (0.01,), P, True, 2)
        + bumps
        + "</g>"
    )


def hero():
    d = Doc(
        HW,
        HH,
        "SoundPlant",
        "SoundPlant turns the M-VAVE FM-1 into a pocket groovebox: eight tracks, eleven engines, "
        "93 factory presets and a 64-step sequencer. Eight plants in the track colours grow along a string under the "
        "name; a pluck runs along it as a pulse, sways each plant as it passes and comes back upside down from the "
        "far end, while a pulse crosses the spectrum rule.",
    )
    bold, semi, med = font("Bold"), font("SemiBold"), font("Medium")
    n = round(P * FPS)
    tsp = frames(n)
    ti = frames(round(T_INTRO * FPS))
    d.defs += [
        rad("gv", [(0, "#a05cff", 0.30), (0.55, "#3c78ff", 0.09), (1, "#06070f", 0)]),
        rad("gr", [(0, "#ff4081", 0.20), (1, "#06070f", 0)]),
        rad("gc", [(0, "#00e1ff", 0.18), (1, "#06070f", 0)]),
        rad("fade", [(0, "#fff", 1), (0.7, "#fff", 0.55), (1, "#000", 0)]),
        f'<mask id="fm"><rect width="{HW}" height="{HH}" fill="url(#fade)"/></mask>',
        f'<pattern id="dots" width="30" height="30" patternUnits="userSpaceOnUse"><circle cx="15" cy="15" r="1.3" fill="{MUTED}" fill-opacity=".34"/></pattern>',
        '<filter id="bl" x="-10%" y="-400%" width="120%" height="900%"><feGaussianBlur stdDeviation="9"/></filter>',
    ]
    for k in range(3):
        flower(d, 6 + k, f"fl{6 + k}")
    b = d.body
    b.append(
        f'<rect width="{HW}" height="{HH}" fill="url(#dots)" mask="url(#fm)" opacity=".7"/>'
    )
    b.append('<ellipse cx="600" cy="210" rx="640" ry="300" fill="url(#gv)"/>')
    b.append('<ellipse cx="90" cy="760" rx="420" ry="260" fill="url(#gr)"/>')
    b.append('<ellipse cx="1110" cy="760" rx="420" ry="260" fill="url(#gc)"/>')

    # the plants, behind the text
    for i in range(8):
        b.append(plant(d, i, INKS[i]))
    for i in range(8):
        b.append(
            f'<ellipse cx="{num(STEM_X[i], 1)}" cy="{BASE_Y + 3}" rx="30" ry="9" fill="{PANEL2}"/>'
            f'<ellipse cx="{num(STEM_X[i], 1)}" cy="{BASE_Y + 1}" rx="22" ry="5" fill="{mix(INKS[i], BG, 0.7)}"/>'
        )
    b.append(f'<rect y="{HH - 18}" width="{HW}" height="18" fill="#090b18"/>')
    d.defs.append(rainbow("rb", 0, HW))
    b.append(
        f'<rect y="{HH - 19}" width="{HW}" height="2" fill="url(#rb)" opacity=".55"/>'
    )
    b.append(ground_string(d))

    # the name: ten letters drop in, bounce on the floor, squash on each impact; the front lifts them as it passes
    word, size, BASE = "SoundPlant", 176.0, 252
    sc = size / bold.upm
    advs = [bold.advance(bold.glyph_of(c)) * sc for c in word]
    total = sum(advs)
    x = (HW - total) / 2
    d.defs.append(rainbow("wr", x, x + total))
    glow = [(0.0,) if t < 0.9 else (0.7 * min(1.0, (t - 0.9) / 0.8),) for t in ti]
    b.append(
        f'<rect x="{num(x + 30, 1)}" y="{BASE + 14}" width="{num(total - 60, 1)}" height="6" rx="3" fill="url(#wr)" filter="url(#bl)" opacity=".7">'
        + at("opacity", ti, glow, (0.01,), T_INTRO, False, 3)
        + "</rect>"
    )
    GRAV, EPS, H0 = 3000.0, 0.24, BASE + 40.0
    osc_sq = Osc(2 * math.pi * 4.6, 0.28, 1 / (FPS * STEPS))
    for i, ch in enumerate(word):
        adv = advs[i]
        cx = x + adv / 2
        x += adv
        ink = ink_at(i / (len(word) - 1))
        gid = d.uid("lg")
        d.defs.append(
            lin(gid, 0, 0, 0, 1, [(0, mix(ink, "#ffffff", 0.3), 1), (1, ink, 1)])
        )
        t_drop = 0.04 + 0.06 * i
        tf = math.sqrt(2 * H0 / GRAV)
        v_imp = GRAV * tf
        imp = [(t_drop + tf, v_imp)]
        v, tt = EPS * v_imp, t_drop + tf
        while v > 12:
            tt += 2 * v / GRAV
            imp.append((tt, v))
            v *= EPS
        ys, sq = [], []
        s_x = s_v = 0.0
        ii = 0
        for k in range(len(ti)):
            t = ti[k]
            u = t - t_drop
            if u < 0:
                y = -H0
            elif u < tf:
                y = -H0 + 0.5 * GRAV * u * u
            else:
                u -= tf
                vv, y = EPS * v_imp, 0.0
                while vv > 12:
                    if u < 2 * vv / GRAV:
                        y = -(vv * u - 0.5 * GRAV * u * u)
                        break
                    u -= 2 * vv / GRAV
                    vv *= EPS
            ys.append((0.0, y))
            for st in range(STEPS):
                tsub = t + (st + 0.5) / (FPS * STEPS)
                while ii < len(imp) and imp[ii][0] <= tsub:
                    s_v += 0.0055 * imp[ii][1]
                    ii += 1
                if k < len(ti) - 1:
                    s_x, s_v = osc_sq.step(s_x, s_v, 0.0)
            sq.append((1.0 + 0.45 * s_x, 1.0 - s_x))
        bounce = periodic(
            Osc(2 * math.pi * 2.3, 0.13, 1 / (FPS * STEPS)),
            pulses(arrivals(cx, 3.6), 0.12, P),
            n,
        )
        path = bold.outline(bold.glyph_of(ch), sc, -adv / 2, 0.0)
        b.append(
            f'<g transform="translate({num(cx, 1)} {BASE})"><g>'
            + tr(
                "translate", tsp, [(0.0, -q) for q in bounce], (0.05, 0.05), P, True, 2
            )
            + "<g>"
            + tr("translate", ti, ys, (0.05, 0.05), T_INTRO, False, 1)
            + "<g>"
            + tr("scale", ti, sq, (0.003, 0.003), T_INTRO, False, 3)
            + f'<path d="{path}" fill="url(#{gid})"/></g></g></g></g>'
        )
    # the rule
    b.append(rule(d, 190, 1010, 292, 0.7))

    # the lines under it fade up, riding a spring
    def reveal(content, t_on, rise_px=18.0):
        ser = settle(2 * math.pi * 1.4, 0.55, rise_px, 0.0, t_on, T_INTRO)
        op = [(0.0,) if t < t_on else (min(1.0, (t - t_on) / 0.5),) for t, _ in ser]
        return (
            "<g>"
            + tr(
                "translate",
                ti,
                [(0.0, s[1]) for s in ser],
                (0.05, 0.05),
                T_INTRO,
                False,
                2,
            )
            + "<g>"
            + at("opacity", ti, op, (0.01,), T_INTRO, False, 3)
            + content
            + "</g></g>"
        )

    over, ow = semi.run("FIRMWARE FOR THE M-VAVE FM-1", 19, 5.2)
    b.append(
        reveal(
            f'<path transform="translate({num((HW - ow) / 2, 1)} 80)" d="{over}" fill="{MUTED}"/>',
            0.6,
        )
    )
    tag, tw = med.run("Turn your FM-1 into a pocket groovebox.", 36)
    b.append(
        reveal(
            f'<path transform="translate({num((HW - tw) / 2, 1)} 358)" d="{tag}" fill="{TEXT}"/>',
            1.0,
        )
    )
    stats = [
        ("8", "tracks"),
        ("11", "engines"),
        ("93", "factory presets"),
        ("64", "steps"),
    ]
    items, tot = [], 0.0
    for k, (nm, lb) in enumerate(stats):
        nd, nw = bold.run(nm, 38)
        ld, lw = med.run(lb, 22, 0.4, dx=nw + 9)
        items.append((nd, ld, nw + 9 + lw))
        tot += nw + 9 + lw
    gap = 58.0
    sx = (HW - tot - gap * 3) / 2
    for k, (nd, ld, w_) in enumerate(items):
        b.append(
            reveal(
                f'<g transform="translate({num(sx, 1)} 416)"><path d="{nd}" fill="{INKS[k]}"/><path d="{ld}" fill="{MUTED}"/></g>',
                1.15 + 0.12 * k,
                12.0,
            )
        )
        sx += w_ + gap
    return d.svg(28)


# ---- divider: the rule alone, in a slim dark band --------------------------------------------------------------------
def divider():
    d = Doc(
        1200,
        110,
        "A vibrating string",
        "A string fixed at both ends, in the eight track colours along its length. It is drawn as its first eight "
        "standing waves, vibrating at whole-number multiples of the lowest, and how strongly each one sounds drifts "
        "slowly.",
    )
    x0, x1, cy = 44.0, 1156.0, 55.0
    rid = d.uid("rg")
    d.defs.append(rainbow(rid, x0, x1))
    d.body.append(
        f'<line x1="{x0}" y1="{cy}" x2="{x1}" y2="{cy}" stroke="url(#{rid})" stroke-width="1.6" '
        'stroke-dasharray="1 7" stroke-linecap="round" opacity=".35"/>'
    )
    for k in range(1, 9):
        f = lambda s, k=k: mode_shape(k, s)
        df = lambda s, k=k: k * math.pi * math.cos(k * math.pi * s)
        wave_d = curve(
            f, df, span_t(0.0, 1.0, 4 * k), x1 - x0, -RULE_AMP / k**0.9, x0, 0.0, 1
        )
        pid = d.uid("st")
        d.defs.append(
            f'<path id="{pid}" d="{wave_d}" vector-effect="non-scaling-stroke"/>'
        )
        rows = [
            (1.0, rule_swing(k, RULE_PERIOD * j / (24 * k))) for j in range(24 * k + 1)
        ]
        w = max(1.6, 3.6 - 0.45 * k)
        d.body.append(
            f'<g transform="translate(0 {cy})" fill="none" stroke="url(#{rid})" stroke-linecap="round" '
            f'stroke-linejoin="round" opacity="{num(1.0 - 0.07 * k, 2)}"><g>'
            + cycle(
                "animateTransform",
                'attributeName="transform" type="scale"',
                rows,
                RULE_PERIOD,
                3,
            )
            + f'<use href="#{pid}" stroke-width="{num(3 * w, 1)}" opacity=".14"/><use href="#{pid}" stroke-width="{num(w, 1)}"/></g></g>'
        )
    for x in (x0, x1):
        d.body.append(
            f'<circle cx="{x}" cy="{cy}" r="5.5" fill="{PANEL2}" stroke="{MUTED}" stroke-width="1.8"/>'
        )
    return d.svg(20)


# ---- meters: eight level meters on a beat, springy, their peak caps falling under gravity -----------------------------
METER_P = 4.0
STEP_S = 0.125
# per track: ((step, strength), ...) over 32 steps of 1/8 s, and the decay of one hit in seconds
METER_TRACKS = (
    (tuple((s, 1.0) for s in range(0, 32, 4)), 0.20),
    (((4, 0.9), (12, 0.9), (20, 0.9), (28, 0.9), (15, 0.35), (31, 0.55)), 0.16),
    (tuple((s, 0.55 if s % 4 == 2 else 0.32) for s in range(0, 32, 2)), 0.07),
    (
        (
            (0, 0.9),
            (3, 0.7),
            (6, 0.8),
            (8, 0.9),
            (11, 0.7),
            (14, 0.8),
            (16, 0.9),
            (19, 0.7),
            (22, 0.8),
            (24, 0.9),
            (27, 0.7),
            (30, 0.85),
        ),
        0.2,
    ),
    (((0, 0.8), (16, 0.8)), 1.3),
    (tuple((s, 0.3 + 0.35 * ((s * 5) % 4) / 3) for s in range(32)), 0.1),
    (
        (
            (2, 0.85),
            (5, 0.6),
            (9, 0.85),
            (13, 0.6),
            (18, 0.85),
            (21, 0.6),
            (25, 0.85),
            (29, 0.7),
        ),
        0.3,
    ),
    (
        ((0, 0.75), (6, 0.8), (10, 0.7), (16, 0.75), (22, 0.8), (26, 0.7), (30, 0.6)),
        0.12,
    ),
)


def meters():
    W_, H_ = 1200, 300
    d = Doc(
        W_,
        H_,
        "Eight level meters",
        "Eight level meters in the track colours move to a beat: each bar rides a spring and overshoots, "
        "each peak cap rises with it and falls under gravity.",
    )
    semi = font("SemiBold")
    n = round(METER_P * FPS)
    tsp = frames(n)
    BAR_H, BAR_W, BOT = 190, 62, 236
    h = 1.0 / (FPS * STEPS)
    osc = Osc(2 * math.pi * 5.5, 0.5, h)
    G, E = 2.6, 0.38
    d.body.append(
        f'<rect x="20" y="20" width="{W_ - 40}" height="{H_ - 40}" rx="18" fill="{PANEL}"/>'
    )
    for k, (hits, tau) in enumerate(METER_TRACKS):
        ink = INKS[k]
        cx = 75 + 150 * k
        lv = []
        for j in range(n * STEPS):
            t = (j + 0.5) * h
            s = 0.0
            for hs, vel in hits:
                for cyc in (-3, -2, -1, 0):
                    th = hs * STEP_S + cyc * METER_P
                    if t >= th:
                        s += vel * math.exp(-(t - th) / tau)
            lv.append(min(1.0, s))
        bar = cap = u = 0.0
        v = 0.0
        hold = 0.0
        out_b, out_c = [], []
        for cyc in range(7):
            for j in range(n * STEPS):
                bar, v = osc.step(bar, v, lv[j])
                bar = max(0.0, bar)
                if bar >= cap:
                    cap, u, hold = bar, 0.0, 0.14
                elif hold > 0:
                    hold -= h
                else:
                    u -= G * h
                    cap += u * h
                    if cap < bar:
                        cap = bar
                        u = -E * u if u < -0.5 else 0.0
                if cyc == 6 and j % STEPS == STEPS - 1:
                    out_b.append((bar,))
                    out_c.append((cap,))
        # frame 0 is the state at the period's start
        first_b, first_c = out_b[-1], out_c[-1]
        out_b = [first_b] + out_b[:-1] + [first_b]
        out_c = [first_c] + out_c[:-1] + [first_c]
        if abs(out_b[1][0] - lv[STEPS - 1]) > 1.5:
            raise ValueError("meter state off the target")
        gid = d.uid("mg")
        d.defs.append(
            lin(
                gid,
                0,
                0,
                0,
                1,
                [
                    (0, mix(ink, "#ffffff", 0.35), 1),
                    (0.45, ink, 1),
                    (1, mix(ink, BG, 0.45), 1),
                ],
            )
        )
        d.body.append(
            f'<rect x="{cx - BAR_W // 2 - 6}" y="{BOT - BAR_H - 14}" width="{BAR_W + 12}" height="{BAR_H + 20}" rx="10" fill="{BG}"/>'
        )
        d.body.append(
            f'<g transform="translate({cx} {BOT})"><g>'
            + tr(
                "scale",
                tsp,
                [(1.0, min(1.05, b_[0])) for b_ in out_b],
                (0.004, 0.004),
                METER_P,
                True,
                3,
            )
            + f'<rect x="{-BAR_W // 2}" y="{-BAR_H}" width="{BAR_W}" height="{BAR_H}" fill="url(#{gid})"/></g>'
        )
        gaps = "".join(
            f'<rect x="{-BAR_W // 2}" y="{-y}" width="{BAR_W}" height="2.4"/>'
            for y in range(10, BAR_H, 10)
        )
        d.body.append(f'<g fill="{BG}">{gaps}</g>')
        d.body.append(
            "<g>"
            + tr(
                "translate",
                tsp,
                [(0.0, -min(1.04, c_[0]) * BAR_H) for c_ in out_c],
                (0.05, 0.05),
                METER_P,
                True,
                2,
            )
            + f'<rect x="{-BAR_W // 2}" y="-5" width="{BAR_W}" height="4" rx="1.5" fill="{mix(ink, "#ffffff", 0.7)}"/></g></g>'
        )
        lab, lw = semi.run(f"T{k + 1}", 22, 1.2)
        d.body.append(
            f'<path transform="translate({num(cx - lw / 2, 1)} {BOT + 36})" d="{lab}" fill="{MUTED}"/>'
        )
        d.body.append(f'<circle cx="{cx}" cy="{BOT + 12}" r="3" fill="{ink}"/>')
    return d.svg(26)


# ---- buttons -------------------------------------------------------------------------------------------------------
def button(label, c0, c1):
    semi = font("SemiBold")
    path, tw = semi.run(label, 25, 0.6)
    w_, h_ = round(tw + 44 + 40), 60
    d = Doc(w_, h_, label, f"A button: {label}.")
    gid, glint = d.uid("bg"), d.uid("gl")
    d.defs += [
        lin(gid, 0, 0, 1, 0, [(0, c0, 1), (1, c1, 1)]),
        lin(glint, 0, 0, 1, 0, [(0, "#fff", 0), (0.5, "#fff", 0.5), (1, "#fff", 0)]),
        f'<clipPath id="bc"><rect x="1" y="1" width="{w_ - 2}" height="{h_ - 2}" rx="{h_ / 2 - 1}"/></clipPath>',
    ]
    n = round(5.0 * FPS)
    tsp = frames(n)
    xs, op = [], []
    x, v, started = -90.0, 0.0, False
    for k, t in enumerate(tsp):
        u = t - 0.6
        if u >= 0:
            x, v = (
                spring_cd(x, v, w_ + 90.0, 3.4, 1.0 / FPS) if started else (-90.0, 0.0)
            )
            started = True
        else:
            x, v = -90.0, 0.0
        xs.append((x,))
        op.append((0.0 if x < -60 or x > w_ + 60 or u < 0 else 1.0,))
    # the spring never quite arrives; the glint is gone before it matters
    xs[-1] = xs[0] = (-90.0,)
    op[-1] = op[0] = (0.0,)
    d.body += [
        f'<rect x="1.5" y="1.5" width="{w_ - 3}" height="{h_ - 3}" rx="{h_ / 2 - 1.5}" fill="{PANEL}" stroke="url(#{gid})" stroke-width="2"/>',
        (
            f'<g clip-path="url(#bc)"><g>{tr("translate", tsp, [(a[0], 0.0) for a in xs], (0.1, 0.1), 5.0, True, 1)}'
            f'<rect x="-30" y="0" width="60" height="{h_}" fill="url(#{glint})" transform="skewX(-20)" opacity="0">{at("opacity", tsp, op, (0.02,), 5.0, True, 2)}</rect></g></g>'
        ),
        f'<path transform="translate(24 {num(h_ / 2 + 9, 1)})" d="{path}" fill="{TEXT}"/>',
        f'<path d="M{num(w_ - 38)} {h_ / 2 - 7}L{num(w_ - 26)} {h_ / 2}L{num(w_ - 38)} {h_ / 2 + 7}Z" fill="{c1}"/>',
    ]
    return d.svg(h_ // 2)


# ---- feature cards: a knob that is turned by a spring from value to value --------------------------------------------
CARDS = (
    ("tracks", "Eight tracks"),
    ("engines", "Eleven engines"),
    ("sequencer", "64-step sequencer"),
    ("players", "Players"),
    ("weave", "Weave"),
    ("throws", "Throws"),
    ("conductor", "Conductor"),
    ("effects", "Effects and mixer"),
    ("song", "Scenes and song"),
    ("midi", "MIDI"),
    ("backup", "Backup and mirror"),
    ("samples", "Your samples"),
)


def card(idx, title):
    W_, H_ = 480, 96
    ink = INKS[idx % 8]
    d = Doc(
        W_,
        H_,
        title,
        f"{title}: feature {idx + 1} of {len(CARDS)}; a knob turns from setting to setting on a spring.",
    )
    bold, semi = font("Bold"), font("SemiBold")
    n = round(6.0 * FPS)
    tsp = frames(n)
    h = 1.0 / (FPS * STEPS)
    osc = Osc(2 * math.pi * 2.1, 0.42, h)
    seed = 7919 * (idx + 1)
    targets = []
    for _ in range(4):
        seed = (seed * 1103515245 + 12345) % 2147483648
        targets.append(-125 + 250 * ((seed >> 8) % 1000) / 999.0)
    tg = lambda t: targets[int(t / 1.5) % 4]
    ang = periodic(osc, tg, n)
    cx, cy = 52, 48
    gid, bar = d.uid("cg"), d.uid("cb")
    d.defs += [
        lin(gid, 0, 0, 1, 0, [(0, ink, 0.95), (1, ink, 0)]),
        rad(bar, [(0, ink, 0.35), (1, ink, 0)]),
    ]
    ring = (
        f'<path d="M{num(cx + 27 * math.sin(math.radians(-135)), 2)} {num(cy - 27 * math.cos(math.radians(-135)), 2)}'
        f'A27 27 0 1 1 {num(cx + 27 * math.sin(math.radians(135)), 2)} {num(cy - 27 * math.cos(math.radians(135)), 2)}" '
        f'fill="none" stroke="{LINE}" stroke-width="4" stroke-linecap="round"/>'
    )
    d.body += [
        f'<rect width="{W_}" height="{H_}" fill="{PANEL}"/>',
        f'<circle cx="{cx}" cy="{cy}" r="46" fill="url(#{bar})"/>',
        ring,
        f'<circle cx="{cx}" cy="{cy}" r="18" fill="{PANEL2}" stroke="{ink}" stroke-width="2"/>',
        (
            f'<g transform="translate({cx} {cy})"><g>{tr("rotate", tsp, [(a,) for a in ang], (0.15,), 6.0, True, 1)}'
            f'<line y1="-5" y2="-15" stroke="{ink}" stroke-width="4" stroke-linecap="round"/></g></g>'
        ),
    ]
    path, _ = bold.run(title, 36, 0.4)
    d.body.append(
        f'<path transform="translate(104 {num(H_ / 2 + 13, 1)})" d="{path}" fill="{ink}"/>'
    )
    nd, nw = semi.run(f"{idx + 1:02d}", 20, 1.5)
    d.body.append(
        f'<path transform="translate({num(W_ - 24 - nw, 1)} 34)" d="{nd}" fill="{MUTED}" fill-opacity=".7"/>'
    )
    d.body.append(
        f'<rect x="0" y="{H_ - 4}" width="{W_}" height="4" fill="url(#{gid})"/>'
    )
    return d.svg(18)


# ---- sound and waves: pure functions the pictures and the tests share ---------------------------------------------------
SAMPLES = ROOT / "app" / "samples"


def read_wav(path):
    """(samples in [-1, 1), rate in Hz) of a 16-bit PCM mono WAV; every other format is refused."""
    with wave.open(str(path), "rb") as w:
        ch, width, rate, n = (
            w.getnchannels(),
            w.getsampwidth(),
            w.getframerate(),
            w.getnframes(),
        )
        if ch != 1 or width != 2 or w.getcomptype() != "NONE":
            raise ValueError(
                f"{path}: need 16-bit PCM mono, found {ch} channel(s) of {8 * width} bits"
            )
        raw = w.readframes(n)
    return [v / 32768.0 for v in struct.unpack(f"<{n}h", raw)], rate


def fft(re, im):
    """In-place radix-2 discrete Fourier transform of re + i im (the length a power of two)."""
    n = len(re)
    if n < 2 or n & (n - 1):
        raise ValueError(f"length {n} is not a power of two")
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
    size = 2
    while size <= n:
        half = size // 2
        wr = [math.cos(2 * math.pi * k / size) for k in range(half)]
        wi = [-math.sin(2 * math.pi * k / size) for k in range(half)]
        for a in range(0, n, size):
            for k in range(half):
                p, q = a + k, a + k + half
                tr_ = re[q] * wr[k] - im[q] * wi[k]
                ti_ = re[q] * wi[k] + im[q] * wr[k]
                re[q], im[q] = re[p] - tr_, im[p] - ti_
                re[p], im[p] = re[p] + tr_, im[p] + ti_
        size *= 2


def spectrum(x, rate, n=4096, taps=2048, start=0):
    """Amplitudes of bins 0..n/2 (bin k is k * rate / n Hz) of the `taps` samples of x from index `start` (fewer if
    x ends first) under a Hann window, zero-padded to n: a sine of amplitude 1 reads about 1 at its own frequency."""
    taps = min(taps, len(x) - start, n)
    if taps < 2:
        raise ValueError("no samples to analyse")
    win = [0.5 - 0.5 * math.cos(2 * math.pi * i / taps) for i in range(taps)]
    re = [x[start + i] * win[i] for i in range(taps)] + [0.0] * (n - taps)
    im = [0.0] * n
    fft(re, im)
    g = 2.0 / sum(win)
    return [g * math.hypot(re[k], im[k]) for k in range(n // 2 + 1)]


def log_bars(mag, rate, n, bars, f_lo, f_hi):
    """`bars` values from the bins of a spectrum, on a log frequency scale f_lo..f_hi: each the strongest bin in its
    band (a band narrower than a bin reads the line between the two bins around its middle), zero above rate / 2."""
    df = rate / n
    edges = [f_lo * (f_hi / f_lo) ** (j / bars) for j in range(bars + 1)]
    out = []
    for j in range(bars):
        a, b = edges[j], edges[j + 1]
        if a >= rate / 2:
            out.append(0.0)
            continue
        k0, k1 = math.ceil(a / df), min(math.ceil(b / df), len(mag))
        if k1 > k0:
            out.append(max(mag[k0:k1]))
        else:
            c = math.sqrt(a * b) / df
            k, f = int(c), c - int(c)
            out.append(mag[k] * (1 - f) + mag[min(k + 1, len(mag) - 1)] * f)
    return out


def bar_levels(vals, floor_db=-54.0):
    """Bar heights 0..1 on a decibel scale: the strongest value 1, one `floor_db` below it 0."""
    top = max(vals)
    if top <= 0:
        raise ValueError("a silent spectrum")
    return [
        max(0.0, 1.0 + 20 * math.log10(v / top) / -floor_db) if v > 0 else 0.0
        for v in vals
    ]


def trigger(x, start=0):
    """Where x first rises through zero at or after sample `start`, as a fractional sample index: a scope's trigger."""
    for i in range(max(start, 1), len(x)):
        if x[i - 1] < 0 <= x[i]:
            return i - 1 + -x[i - 1] / (x[i] - x[i - 1])
    raise ValueError(f"no rising zero crossing after sample {start}")


def trace(x, rate, start, span, cols):
    """(trigger time in s, `cols` heights in [-1, 1]) of the `span` seconds of x that follow the first rising zero
    crossing after `start` seconds, read at evenly spaced instants and scaled so that the largest is 1."""
    p0 = trigger(x, round(start * rate))
    step = span * rate / (cols - 1)
    if p0 + step * (cols - 1) > len(x) - 1:
        raise ValueError("the window runs past the end of the sample")
    ys = []
    for j in range(cols):
        p = p0 + j * step
        i = int(p)
        ys.append(x[i] + (p - i) * (x[i + 1] - x[i]) if i + 1 < len(x) else x[i])
    peak = max(abs(v) for v in ys)
    return p0 / rate, [v / peak for v in ys]


def mode_shape(n, s):
    """Standing wave n of a string fixed at s = 0 and s = 1: zero at its n + 1 nodes s = k / n."""
    return math.sin(n * math.pi * s)


def pluck_amp(n, p, width=0.07):
    """How much of mode n a string plucked at p (0..1 of its length) starts with when the pick is a bump `width` wide
    (a Gaussian, in string lengths): sin(n pi p) at the pick, and a wider pick leaves less of the high modes."""
    return math.sin(n * math.pi * p) * math.exp(-((n * math.pi * width) ** 2) / 2)


STRING_F1, STRING_DAMP = 0.75, 0.17


def mode_decay(n):
    """The damping of mode n in 1/s: it grows as n squared, so the high modes die first."""
    return STRING_DAMP * n * n


def mode_motion(n, t):
    """Mode n's share of its start, t seconds after the release: a damped cosine at n times the base frequency."""
    return math.exp(-mode_decay(n) * t) * math.cos(2 * math.pi * n * STRING_F1 * t)


RULE_PERIOD, RULE_AMP = 12.0, 46.0


def rule_swing(n, t):
    """How far standing wave n of the divider's string is swung t seconds into the loop, as a share of its full height:
    n times the lowest frequency (once in 6 s), and how strongly it sounds drifts once around in RULE_PERIOD."""
    drift = 0.35 + 0.65 * (
        0.5 + 0.5 * math.cos(2 * math.pi * (t / RULE_PERIOD + n / 8))
    )
    return drift * math.cos(2 * math.pi * (n * t / (RULE_PERIOD / 2) + 0.15 * n))


def pulse_parts(u, rho=1.0):
    """d'Alembert's solution for the pluck u seconds after it left the string's near end at the front's speed:
    (centre, width, height) of the Gaussian that runs on, and of its image across the far fixed end X1, which has
    the opposite sign (the end sends the pulse back upside down, rho of it), the two together zero at X1."""
    d = SPEED * u
    if d < 0:
        return []
    sig = math.sqrt(S0 * S0 + 2 * DIFF * u)
    a = math.exp(-d / LAMBDA) * math.sqrt(S0 / sig)
    xf = X0 + d
    return [(xf, sig, a), (2 * X1 - xf, sig, -rho * a)]


def string_pulse(x, u, rho=1.0):
    """The displacement of the hero's string at x, u seconds after the pluck."""
    return sum(
        a * math.exp(-((x - c) ** 2) / (2 * s * s)) for c, s, a in pulse_parts(u, rho)
    )


def critical_offset(t, w):
    """How far a critically damped spring (the firmware's) is from its target t seconds after it was let go at rest
    one unit away: it never reaches zero."""
    return (1 + w * t) * math.exp(-w * t)


def ringing_offset(t, w, z):
    """The same for an under-damped spring (damping ratio z < 1): it overshoots and rings."""
    wd = w * math.sqrt(1 - z * z)
    return math.exp(-z * w * t) * (math.cos(wd * t) + z * w / wd * math.sin(wd * t))


def lowpass_db(r, q):
    """A two-pole resonant low-pass's gain in dB at r times its cutoff, resonance q: a peak of about q at r = 1."""
    return -10 * math.log10((1 - r * r) ** 2 + (r / q) ** 2)


def ring_wave(tau, q):
    """That filter's impulse response against tau = cutoff angle * time: a sine inside a decay of q cycles."""
    return math.exp(-tau / (2 * q)) * math.sin(tau)


def bessel_j(n, x, terms=40):
    """Bessel function of the first kind J_n(x), integer n, by its power series: the strength of the n-th sideband
    when a modulator of index x turns a carrier's phase."""
    m = abs(n)
    s = 0.0
    for k in range(terms):
        s += (
            (-1) ** k
            * (x / 2) ** (2 * k + m)
            / (math.factorial(k) * math.factorial(k + m))
        )
    return -s if n < 0 and m % 2 else s


# ---- drawing helpers for the new pictures ---------------------------------------------------------------------------
def numder(f, h=1e-5):
    return lambda t: (f(t + h) - f(t - h)) / (2 * h)


def curve(f, df, ts, fx=1.0, fy=1.0, ox=0.0, oy=0.0, dec=2):
    """SVG path data of the points (ox + fx * t, oy + fy * f(t)), t in ts: one cubic piece between neighbours, its
    end tangents those of the function (df is f's derivative), so a few pieces trace a smooth wave."""
    pt = lambda x, y: f"{num(x, dec)} {num(y, dec)}"
    out = [f"M{pt(ox + fx * ts[0], oy + fy * f(ts[0]))}"]
    for a, b in itertools.pairwise(ts):
        dx = fx * (b - a) / 3
        out.append(
            f"C{pt(ox + fx * a + dx, oy + fy * (f(a) + df(a) * (b - a) / 3))} "
            f"{pt(ox + fx * b - dx, oy + fy * (f(b) - df(b) * (b - a) / 3))} "
            f"{pt(ox + fx * b, oy + fy * f(b))}"
        )
    return "".join(out)


def span_t(a, b, n):
    return [a + (b - a) * k / n for k in range(n + 1)]


def cycle(tag, attr, rows, dur, decimals=3, extra=""):
    """A looping <animate>/<animateTransform> through `rows` (value tuples, evenly spaced in time, the last equal to
    the first) once every `dur` seconds."""
    vals = ";".join(" ".join(num(c, decimals) for c in r) for r in rows)
    return f'<{tag} {attr} dur="{num(dur, 3)}s" repeatCount="indefinite" calcMode="linear" values="{vals}"{extra}/>'


def morph(ts, ds, dur):
    """A looping <animate> of a path's data through the strings `ds` (the same commands in each) at the times `ts`."""
    kt = ";".join(num(t / dur, 4) for t in ts)
    return (
        f'<animate attributeName="d" dur="{num(dur, 3)}s" repeatCount="indefinite" calcMode="linear" '
        f'keyTimes="{kt}" values="{";".join(ds)}"/>'
    )


def head(d, title, tag, ink):
    """The frame the four physics panels share: the card, a glow of its ink, the title and what it is tied to."""
    gid = d.uid("hg")
    d.defs.append(rad(gid, [(0, ink, 0.22), (1, ink, 0)]))
    d.body += [
        f'<rect width="{d.w}" height="{d.h}" fill="{PANEL}"/>',
        f'<ellipse cx="0" cy="0" rx="{d.w * 0.7}" ry="230" fill="url(#{gid})"/>',
        d.text("Bold", title, 42, 36, 68, TEXT),
        d.text("SemiBold", tag, 25, d.w - 36, 66, MUTED, "end", 0.4),
        f'<rect y="{d.h - 5}" width="{d.w}" height="5" fill="{ink}" opacity=".85"/>',
    ]


# ---- the scope: real samples drawn as a beam draws them -------------------------------------------------------------
SC_W, SC_H = 1200, 590
SC_X, SC_Y, SC_GW, SC_GH = (
    36,
    104,
    1128,
    300,
)  # the screen: ten divisions across, six down
SC_COLS = SC_GW // 2 + 1  # one point every 2 px
SC_SLOT, SC_SWEEP, SC_TAU = 3.6, 1.5, 0.85
SP_X, SP_Y, SP_H, SP_BARS = 36, 430, 100, 48  # the spectrum strip
SP_F0, SP_F1 = 50.0, 10000.0
# the file, its name on the screen, where the trace starts (s) and how long it runs (s), its ink
SCOPE_SAMPLES = (
    ("909_kick", "909 kick", 0.0, 0.100, 0),
    ("piano", "piano", 0.12, 0.030, 4),
    ("909_snare", "909 snare", 0.0, 0.040, 1),
    ("strings", "strings", 0.2, 0.030, 6),
    ("909_clap", "909 clap", 0.0, 0.090, 2),
    ("flute", "flute", 0.2, 0.012, 3),
    ("909_hat", "909 hat", 0.0, 0.030, 5),
    ("upright", "upright bass", 0.1, 0.060, 7),
)


def sc_env(u):
    """The phosphor: a trace is bright while the beam draws it, then dims by e^(-u / tau), and is gone at the slot's
    end."""
    if u < 0 or u > SC_SLOT:
        return 0.0
    if u < 0.12:
        return u / 0.12
    g = 1.0 if u < 0.12 + SC_SWEEP else math.exp(-(u - 0.12 - SC_SWEEP) / SC_TAU)
    return g * min(1.0, (SC_SLOT - u) / 0.15)


def poly_path(xs, ys, eps):
    """Relative polyline through the points, thinned to within eps px, from rounded coordinates: (path data, the
    kept (x, y), the length of the line up to each kept point)."""
    pts = [(round(x, 1), round(y, 1)) for x, y in zip(xs, ys)]
    keep = thin([p[0] for p in pts], [(p[1],) for p in pts], (eps,))
    kept = [pts[i] for i in keep]
    out = [f"M{num(kept[0][0], 1)} {num(kept[0][1], 1)}"]
    cum, s = [0.0], 0.0
    for (xa, ya), (xb, yb) in itertools.pairwise(kept):
        out.append(f"l{num(xb - xa, 1)} {num(yb - ya, 1)}")
        s += math.hypot(xb - xa, yb - ya)
        cum.append(s)
    return "".join(out), kept, cum


def arc_at(kept, cum, xq):
    """How far along a polyline (its points `kept`, the length up to each in `cum`) the point at x = xq lies, 0..1."""
    for k in range(1, len(kept)):
        if kept[k][0] >= xq:
            xa, xb = kept[k - 1][0], kept[k][0]
            f = (xq - xa) / (xb - xa) if xb > xa else 0.0
            return (cum[k - 1] + f * (cum[k] - cum[k - 1])) / cum[-1]
    return 1.0


def scope():
    d = Doc(
        SC_W,
        SC_H,
        "Sound you can see",
        "An oscilloscope draws the factory samples one after another: a beam sweeps each waveform across the screen "
        "from a rising zero crossing and the trace fades like phosphor, while the sample's spectrum rises below it "
        "as bars on a log frequency scale.",
    )
    tot = SC_SLOT * len(SCOPE_SAMPLES)
    fr = frames(round(tot * FPS))
    cy0 = SC_Y + SC_GH / 2
    amp = 0.88 * SC_GH / 2
    body = d.body
    d.defs += [
        rad(
            "scr", [(0, "#131a3a", 1), (1, "#080a17", 1)], ' cx="50%" cy="50%" r="75%"'
        ),
        rad("halo", [(0, "#ffffff", 0.9), (0.3, "#ffffff", 0.35), (1, "#ffffff", 0)]),
        f'<clipPath id="scrc"><rect x="{SC_X}" y="{SC_Y}" width="{SC_GW}" height="{SC_GH}" rx="12"/></clipPath>',
    ]
    body += [
        f'<rect x="{SC_X}" y="{SC_Y}" width="{SC_GW}" height="{SC_GH}" rx="12" fill="url(#scr)" stroke="{LINE}" stroke-width="2"/>'
    ]
    # graticule: ten divisions across and six down, the centre lines ticked five times to the division
    gx, gy = SC_GW / 10, SC_GH / 6
    grid = "".join(
        f"M{num(SC_X + gx * i, 1)} {SC_Y}v{SC_GH}" for i in range(1, 10)
    ) + "".join(f"M{SC_X} {num(SC_Y + gy * j, 1)}h{SC_GW}" for j in range(1, 6))
    ticks = "".join(
        f"M{num(SC_X + gx * i / 5, 1)} {num(cy0 - 5, 1)}v10"
        for i in range(1, 50)
        if i % 5
    ) + "".join(
        f"M{num(SC_X + SC_GW / 2 - 5, 1)} {num(SC_Y + gy * j / 5, 1)}h10"
        for j in range(1, 30)
        if j % 5
    )
    body += [
        f'<path d="{grid}" stroke="{LINE}" stroke-width="1.4" fill="none" opacity=".9"/>',
        f'<path d="M{SC_X} {num(cy0, 1)}h{SC_GW}M{num(SC_X + SC_GW / 2, 1)} {SC_Y}v{SC_GH}" stroke="{mix(LINE, MUTED, 0.3)}" stroke-width="1.6" fill="none"/>',
        f'<path d="{ticks}" stroke="{mix(LINE, MUTED, 0.3)}" stroke-width="1.4" fill="none"/>',
        # the trigger mark: where the trace starts, on the centre line
        f'<path d="M{SC_X - 2} {num(cy0 - 9, 1)}l15 9l-15 9z" fill="{MUTED}" opacity=".8"/>',
    ]
    body.append(
        d.text(
            "SemiBold",
            "FACTORY SAMPLES",
            19,
            SC_X,
            40,
            MUTED,
            "start",
            3.0,
            ' opacity=".75"',
        )
    )
    # the spectrum strip
    pitch = SC_GW / SP_BARS
    bw = pitch - 6
    d.defs.append(
        f'<clipPath id="spc"><rect x="{SP_X}" y="{SP_Y}" width="{SC_GW}" height="{SP_H}" rx="12"/></clipPath>'
    )
    body += [
        f'<rect x="{SP_X}" y="{SP_Y}" width="{SC_GW}" height="{SP_H}" rx="12" fill="{PANEL}" stroke="{LINE}" stroke-width="2"/>'
    ]
    base = SP_Y + SP_H - 12
    for k in range(SP_BARS):
        body.append(
            f'<rect x="{num(SP_X + 3 + pitch * k, 1)}" y="{base - 3}" width="{num(bw, 1)}" height="3" fill="{LINE}"/>'
        )
    lx = lambda f: SP_X + SC_GW * math.log(f / SP_F0) / math.log(SP_F1 / SP_F0)
    for f, lab in ((100, "100 Hz"), (1000, "1 kHz"), (10000, "10 kHz")):
        x = min(lx(f), SP_X + SC_GW - 34)
        body.append(
            f'<path d="M{num(lx(f), 1)} {SP_Y + SP_H}v8" stroke="{MUTED}" stroke-width="1.6"/>'
        )
        body.append(d.text("SemiBold", lab, 24, x, SP_Y + SP_H + 33, MUTED, "middle"))
    body.append(
        d.text(
            "SemiBold",
            "SPECTRUM",
            19,
            SP_X + SC_GW - 16,
            SP_Y + 28,
            MUTED,
            "end",
            3.0,
            ' opacity=".75"',
        )
    )

    # the samples
    osc = Osc(2 * math.pi * 2.0, 0.5, 1.0 / FPS)
    bar_keys = [
        ([], []) for _ in range(SP_BARS)
    ]  # per bar: its height at the kept instants of the loop
    labels = []
    for idx, (fname, name, start, span, ink_i) in enumerate(SCOPE_SAMPLES):
        ink = INKS[ink_i]
        x, rate = read_wav(SAMPLES / f"{fname}.wav")
        t0, ys = trace(x, rate, start, span, SC_COLS)
        px = [SC_X + 2.0 * j for j in range(SC_COLS)]
        py = [cy0 - amp * v for v in ys]
        pid = d.uid("wv")
        path, kept, cum = poly_path(px, py, 0.3)
        d.defs.append(f'<path id="{pid}" d="{path}"/>')
        a, b = idx * SC_SLOT + 0.12, idx * SC_SLOT + 0.12 + SC_SWEEP
        # the clip that shows the part of the trace the beam has drawn, and the one that shows its bright head
        w_ts, w_v = [0, a, b, tot], [(0,), (0,), (float(SC_GW),), (float(SC_GW),)]
        c_end = b + 0.09
        head_w = 70.0
        c_ts = [0, a, b, c_end, tot]
        c_v = [
            (SC_X - head_w,),
            (SC_X - head_w,),
            (SC_X + SC_GW - head_w,),
            (SC_X + SC_GW,),
            (SC_X + SC_GW,),
        ]
        d.defs.append(
            f'<clipPath id="cw{idx}"><rect x="{SC_X}" y="{SC_Y}" height="{SC_GH}" width="0">'
            + smil("animate", 'attributeName="width"', w_ts, w_v, (0.01,), tot, True, 1)
            + "</rect></clipPath>"
        )
        d.defs.append(
            f'<clipPath id="ch{idx}"><rect y="{SC_Y}" height="{SC_GH}" width="{num(head_w, 1)}" x="{SC_X - head_w}">'
            + smil("animate", 'attributeName="x"', c_ts, c_v, (0.01,), tot, True, 1)
            + "</rect></clipPath>"
        )
        env = [(sc_env(t - idx * SC_SLOT),) for t in fr]
        body.append(
            f'<g clip-path="url(#scrc)" opacity="0">{at("opacity", fr, env, (0.01,), tot, True, 2)}'
            f'<g clip-path="url(#cw{idx})" fill="none" stroke="{ink}" stroke-linejoin="round" stroke-linecap="round">'
            f'<use href="#{pid}" stroke-width="10" opacity=".12"/><use href="#{pid}" stroke-width="5" opacity=".25"/>'
            f'<use href="#{pid}" stroke-width="2" opacity=".9"/></g>'
            f'<g clip-path="url(#ch{idx})" fill="none" stroke="{mix(ink, "#ffffff", 0.65)}" stroke-linejoin="round" stroke-linecap="round">'
            f'<use href="#{pid}" stroke-width="8" opacity=".3"/><use href="#{pid}" stroke-width="2.6"/></g></g>'
        )
        # the beam's dot rides the trace itself; keyPoints give it a constant sweep across the screen
        m = 70
        kt = [0.0] + [(a + SC_SWEEP * k / m) / tot for k in range(m + 1)] + [1.0]
        kp = (
            [0.0]
            + [arc_at(kept, cum, SC_X + SC_GW * k / m) for k in range(m + 1)]
            + [1.0]
        )
        dot_op = [0, a, a + 0.03, b, b + 0.06, tot]
        dot_v = [(0,), (0,), (1,), (1,), (0,), (0,)]
        body.append(
            f'<g opacity="0">{at("opacity", dot_op, dot_v, (0.01,), tot, True, 2)}'
            f'<animateMotion dur="{num(tot, 3)}s" repeatCount="indefinite" calcMode="linear" keyPoints="{";".join(num(v, 4) for v in kp)}" '
            f'keyTimes="{";".join(num(v, 4) for v in kt)}"><mpath href="#{pid}"/></animateMotion>'
            f'<circle r="16" fill="url(#halo)" opacity=".55"/><circle r="4.4" fill="#ffffff"/></g>'
        )
        # the label of this slot: the sample, and the time it shows
        info = f"{t0 * 1000:.0f} to {(t0 + span) * 1000:.0f} ms   {span * 100:g} ms/div"
        lab_ts = [
            0,
            idx * SC_SLOT,
            idx * SC_SLOT + 0.2,
            (idx + 1) * SC_SLOT - 0.2,
            (idx + 1) * SC_SLOT,
            tot,
        ]
        lab_v = [(0,), (0,), (1,), (1,), (0,), (0,)]
        lab = d.text("Bold", name, 44, SC_X, 88, ink) + d.text(
            "SemiBold", info, 25, SC_X + SC_GW, 86, MUTED, "end", 0.3
        )
        labels.append(
            f'<g opacity="0">{at("opacity", lab_ts, lab_v, (0.01,), tot, True, 2)}{lab}</g>'
        )
        # its spectrum: bars on springs, each following the phosphor
        mag = spectrum(x, rate, 4096, 2048, int(t0 * rate))
        lv = bar_levels(log_bars(mag, rate, 4096, SP_BARS, SP_F0, SP_F1))
        slot = frames(round(SC_SLOT * FPS))
        for k in range(SP_BARS):
            xk = vk = 0.0
            rise = 0.27 + 0.012 * k
            vs = []
            for u in slot:
                if u >= rise:
                    xk, vk = osc.step(xk, vk, 1.0)
                vs.append((max(0.0, xk) * lv[k] * sc_env(u),))
            kept_k = thin(slot, vs, (0.03,))
            kt_, kv_ = bar_keys[k]
            for i in kept_k[1 if idx else 0 :]:
                kt_.append(idx * SC_SLOT + slot[i])
                kv_.append(vs[i])
    body += labels
    top = SP_H - 12 - 12
    for k in range(SP_BARS):
        col = ink_at(k / (SP_BARS - 1))
        kt_, kv_ = bar_keys[k]
        body.append(
            f'<g transform="translate({num(SP_X + 3 + pitch * k, 1)} {SP_Y + SP_H - 12})"><g>'
            + keys(
                "animateTransform",
                'attributeName="transform" type="scale"',
                kt_,
                [(1.0, v[0]) for v in kv_],
                tot,
                True,
                2,
            )
            + f'<rect y="{-top}" width="{num(bw, 1)}" height="{top}" fill="{col}"/></g></g>'
        )
    gaps = "".join(f"M{SP_X} {SP_Y + SP_H - 12 - y}h{SC_GW}" for y in range(8, top, 8))
    body.append(f'<path d="{gaps}" stroke="{PANEL}" stroke-width="2.6" fill="none"/>')
    return d.svg(26)


# ---- the physics panels: four pictures of what the sound is made of ---------------------------------------------------
PH_W, PH_H = 820, 540
PH_X0, PH_X1 = 36, 784  # the content's left and right edge
SCREEN = "#080a17"


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def inset(d, x, y, w, h, label=None, rx=14):
    """A dark screen on the card with a small heading; the id of its clip path."""
    cid = d.uid("ic")
    d.defs.append(
        f'<clipPath id="{cid}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/></clipPath>'
    )
    d.body.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{SCREEN}" stroke="{LINE}" stroke-width="2"/>'
    )
    if label:
        d.body.append(
            d.text(
                "SemiBold",
                label,
                25,
                x + 18,
                y + 33,
                MUTED,
                "start",
                2.2,
                ' opacity=".85"',
            )
        )
    return cid


def glow(pid, w, op=0.2, ink=None):
    """The path `pid` stroked twice: wide and faint under (in `ink`, else the group's stroke), thin and sharp over."""
    return (
        f'<use href="#{pid}" stroke-width="{num(3 * w, 1)}" opacity="{num(op, 2)}"'
        + (f' stroke="{ink}"' if ink else "")
        + f'/><use href="#{pid}" stroke-width="{num(w, 1)}"/>'
    )


def poly_d(ys, dx):
    """Path data of a polyline from (0, ys[0]) with a step of dx in x, from the rounded heights."""
    ys = [round(y, 1) for y in ys]
    return f"M0 {num(ys[0], 1)}" + "".join(
        f"l{num(dx, 2)} {num(b - a, 1)}" for a, b in itertools.pairwise(ys)
    )


# ---- a plucked string ----------------------------------------------------------------------------------------------
STR_P, STR_L, STR_REL, STR_MUTE = 0.3, 6.2, 0.9, 5.4
STR_MODES, STR_PX = 4, 64.0
STR_NORM = max(
    sum(pluck_amp(n, STR_P) * mode_shape(n, k / 200) for n in range(1, STR_MODES + 1))
    for k in range(201)
)  # the first four waves added make a bump this high at the release: the picture's unit


def string_coeff(n, t):
    """Mode n's height t seconds into the loop, 1 being the bump the pick pulls up: pulled aside (all the waves at
    once) until the release, then each rings at its own pace; a finger damps the string at the end."""
    a = pluck_amp(n, STR_P) / STR_NORM
    if t < STR_REL:
        return a * smoothstep(t / 0.55)
    return a * mode_motion(n, t - STR_REL) * (1 - smoothstep((t - STR_MUTE) / 0.6))


def physics_string():
    d = Doc(
        PH_W,
        PH_H,
        "A plucked string",
        "A string fixed at both ends, plucked and let go, in slow motion. Underneath it, its first four standing waves: "
        "each swings at a whole multiple of the lowest frequency, stands still at its nodes, and dies away n squared "
        "times faster than the lowest, so the high ones go first. The plucked string on top is the four added up.",
    )
    head(d, "A plucked string", "cane, the pluck model", INKS[1])
    body, ends = d.body, (PH_X0 + 60.0, float(PH_X1))
    x0, wid = ends[0], ends[1] - ends[0]
    steps = 43
    assert wid == 16.0 * steps
    sum_y = 180.0
    rows = (264.0, 330.0, 396.0, 462.0)
    inks = (INKS[4], INKS[3], INKS[2], INKS[0])
    hot = mix(INKS[1], "#ffffff", 0.55)
    fr = frames(round(STR_L * FPS))

    rest = mix(LINE, MUTED, 0.3)
    for y in (sum_y, *rows):
        body.append(
            f'<path d="M{num(x0, 1)} {y}H{ends[1]}" stroke="{rest}" stroke-width="1.6" stroke-dasharray="1 7" '
            'stroke-linecap="round" fill="none" opacity=".7"/>'
        )
    body.append(
        d.text(
            "SemiBold",
            "SUM",
            25,
            PH_X0,
            sum_y + 8,
            MUTED,
            "start",
            2.5,
            ' opacity=".85"',
        )
    )
    for n, (y, ink) in enumerate(zip(rows, inks), 1):
        body.append(d.text("Bold", "f" if n == 1 else f"{n}f", 32, PH_X0, y + 11, ink))

    # the standing waves: one unit path each, scaled in height by the wave's own share
    for n, (y, ink) in enumerate(zip(rows, inks), 1):
        pid = d.uid("md")
        f = lambda s, n=n: mode_shape(n, s)
        df = lambda s, n=n: n * math.pi * math.cos(n * math.pi * s)
        d.defs.append(
            f'<path id="{pid}" d="{curve(f, df, span_t(0.0, 1.0, 4 * n), wid, -STR_PX, 0.0, 0.0, 1)}" '
            'vector-effect="non-scaling-stroke"/>'
        )
        vs = [(1.0, string_coeff(n, t)) for t in fr]
        body.append(
            f'<g transform="translate({num(x0, 1)} {y})" fill="none" stroke="{ink}" stroke-linecap="round" '
            f'stroke-linejoin="round"><g>{tr("scale", fr, vs, (0.01, 0.002), STR_L, True, 4)}{glow(pid, 3.4)}</g></g>'
        )
        for k in range(n + 1):  # its nodes, where it never moves
            body.append(
                f'<circle cx="{num(x0 + wid * k / n, 1)}" cy="{y}" r="5.2" fill="{SCREEN}" stroke="{ink}" stroke-width="2"/>'
            )

    # the string itself: the four added up (the one path that changes shape)
    ys = [
        [
            -STR_PX
            * sum(
                string_coeff(n, t) * mode_shape(n, j / steps)
                for n in range(1, STR_MODES + 1)
            )
            for j in range(steps + 1)
        ]
        for t in fr
    ]
    keep = thin(fr, ys, (0.5,) * (steps + 1))
    sid = d.uid("sm")
    d.defs.append(
        f'<path id="{sid}" d="{poly_d(ys[0], 16)}" vector-effect="non-scaling-stroke">'
        + morph([fr[i] for i in keep], [poly_d(ys[i], 16) for i in keep], STR_L)
        + "</path>"
    )
    body.append(
        f'<g transform="translate({num(x0, 1)} {sum_y})" fill="none" stroke="{hot}" stroke-linecap="round" '
        f'stroke-linejoin="round">{glow(sid, 4.4, 0.17, INKS[1])}</g>'
    )

    # the pick holds the string aside until it lets go
    hid = d.uid("hl")
    d.defs.append(
        rad(hid, [(0, "#ffffff", 0.8), (0.35, "#ffffff", 0.3), (1, "#ffffff", 0)])
    )
    tip = lambda t: (
        -STR_PX
        * sum(
            string_coeff(n, t) * mode_shape(n, STR_P) for n in range(1, STR_MODES + 1)
        )
    )
    pk = [t for t in fr if t <= STR_REL + 0.25]
    pk_ts = pk + [STR_L]
    pk_y = [(0.0, tip(t)) for t in pk]
    pk_op = [
        (min(1.0, t / 0.15) * (1.0 - smoothstep((t - STR_REL) / 0.25)),) for t in pk
    ]
    body.append(
        f'<g transform="translate({num(x0 + wid * STR_P, 1)} {sum_y})" opacity="0">'
        + at("opacity", pk_ts, pk_op + [(0.0,)], (0.01,), STR_L, True, 2)
        + "<g>"
        + tr("translate", pk_ts, pk_y + [pk_y[-1]], (0.1, 0.2), STR_L, True, 1)
        + f'<circle r="22" fill="url(#{hid})"/><circle r="6" fill="#ffffff"/></g></g>'
    )
    body += [
        f'<circle cx="{PH_X0 + 7}" cy="511" r="6" fill="{SCREEN}" stroke="{MUTED}" stroke-width="2"/>',
        d.text("SemiBold", "node: it never moves", 25, PH_X0 + 24, 519, MUTED),
        d.text(
            "SemiBold",
            "slow motion, the high waves die first",
            25,
            PH_X1,
            519,
            MUTED,
            "end",
        ),
    ]
    return d.svg(26)


# ---- a filter that rings -------------------------------------------------------------------------------------------
RES_L, RES_Q = 9.0, 8.0
RES_F0, RES_F1 = 60.0, 2400.0  # the acid's cutoff knob, lowest and highest (Hz)
RES_LO, RES_DEC, RES_DB = (
    40.0,
    374.0,
    2.5,
)  # the plot: left edge (Hz), px per decade, px per dB
RES_WIN, RES_TAU, RES_AMP = (
    0.040,
    80.0,
    60.0,
)  # the ring's window (s), its path's length (rad), height (px)


def res_cutoff(t):
    """The cutoff in Hz t seconds into the loop: swept up the log scale and back, slow at both ends."""
    return RES_F0 * (RES_F1 / RES_F0) ** (0.5 - 0.5 * math.cos(2 * math.pi * t / RES_L))


def physics_resonance():
    d = Doc(
        PH_W,
        PH_H,
        "A filter that rings",
        "A resonant low-pass filter whose cutoff sweeps from 60 Hz to 2.4 kHz, as the acid's cutoff knob does. On top, "
        "the frequencies it lets through: a hump at the cutoff, slid along a log scale. Below, how it rings after one "
        "tap: a sine at the cutoff frequency that dies away, so a higher cutoff rings faster.",
    )
    ink = INKS[4]
    head(d, "A filter that rings", "acid, 60 Hz to 2.4 kHz", ink)
    body, tt = d.body, frames(round(RES_L * FPS))
    cut = [res_cutoff(t) for t in tt]
    hid = d.uid("hl")
    d.defs.append(
        rad(hid, [(0, "#ffffff", 0.8), (0.35, "#ffffff", 0.3), (1, "#ffffff", 0)])
    )

    # what it lets through: one hump, slid along the log frequency scale (the shape stays, only its place changes)
    rx, ry, rw, rh = PH_X0, 100, 748, 218
    inset(d, rx, ry, rw, rh, "WHAT IT LETS THROUGH")
    top, bot, y0 = 138.0, 268.0, 193.0
    clip = d.uid(
        "pc"
    )  # the plot's own window: the hump leaves it at the bottom, above the axis labels
    d.defs.append(
        f'<clipPath id="{clip}"><rect x="{rx + 1}" y="{top - 2}" width="{rw - 2}" height="{bot - top + 2}"/></clipPath>'
    )
    xf = lambda f: rx + RES_DEC * math.log10(f / RES_LO)
    grid = "".join(
        f"M{num(xf(m * 10**k), 1)} {top}V{bot}"
        for k in (1, 2, 3)
        for m in range(1, 10)
        if RES_LO < m * 10**k < RES_LO * 100 and m != 1
    )
    body += [
        f'<path d="{grid}" stroke="{LINE}" stroke-width="1.4" fill="none" opacity=".8"/>',
        f'<path d="M{num(xf(100), 1)} {top}V{bot}M{num(xf(1000), 1)} {top}V{bot}" stroke="{mix(LINE, MUTED, 0.3)}" stroke-width="1.8" fill="none"/>',
        f'<path d="M{rx} {y0 - 50}H{rx + rw}M{rx} {y0 + 50}H{rx + rw}" stroke="{LINE}" stroke-width="1.4" fill="none" opacity=".8"/>',
        f'<path d="M{rx} {y0}H{rx + rw}" stroke="{mix(LINE, MUTED, 0.45)}" stroke-width="1.8" stroke-dasharray="6 7" fill="none"/>',
        d.text("SemiBold", "100 Hz", 25, xf(100), 308, MUTED, "middle"),
        d.text("SemiBold", "1 kHz", 25, xf(1000), 308, MUTED, "middle"),
    ]
    g = lambda u: lowpass_db(math.exp(u), RES_Q)
    ts = span_t(-4.6, -1.0, 9) + span_t(-1.0, 1.0, 40)[1:] + span_t(1.0, 4.6, 9)[1:]
    k_e = RES_DEC / math.log(10)  # px per e-fold of the frequency
    hump = curve(g, numder(g), ts, k_e, -RES_DB, 0.0, 0.0, 1)
    pid, fid = d.uid("hp"), d.uid("hf")
    d.defs += [
        f'<path id="{pid}" d="{hump}" vector-effect="non-scaling-stroke"/>',
        lin(
            fid,
            0,
            -RES_DB * 20,
            0,
            80,
            [(0, ink, 0.55), (1, ink, 0.03)],
            ' gradientUnits="userSpaceOnUse"',
        ),
    ]
    peak = -RES_DB * 20 * math.log10(RES_Q)
    xs = [(xf(c), 0.0) for c in cut]
    body.append(
        f'<g clip-path="url(#{clip})"><g transform="translate(0 {y0})"><g>'
        + tr("translate", tt, xs, (0.3, 0.1), RES_L, True, 1)
        + f'<path d="{hump}V130H{num(k_e * ts[0], 1)}Z" fill="url(#{fid})"/>'
        f'<path d="M0 {num(peak, 1)}V{num(bot - y0, 1)}" stroke="{ink}" stroke-width="2" stroke-dasharray="3 6" '
        'opacity=".7" fill="none"/>'
        f'<g fill="none" stroke="{ink}" stroke-linecap="round" stroke-linejoin="round">{glow(pid, 3.6)}</g>'
        f'<circle cy="{num(peak, 1)}" r="22" fill="url(#{hid})" opacity=".7"/><circle cy="{num(peak, 1)}" r="5.5" fill="#ffffff"/>'
        + d.text("SemiBold", "cutoff", 25, 0, bot - y0 - 6, TEXT, "middle")
        + "</g></g></g>"
    )

    # how it rings: the filter's answer to one tap, a sine at the cutoff inside a decay; the time scale stays, so
    # a higher cutoff packs more swings into the same window
    ty, th = 330, 186
    cy, x0 = 443.0, 64.0
    clip2 = inset(d, rx, ty, rw, th, "HOW IT RINGS AFTER ONE TAP")
    wv = lambda tau: ring_wave(tau, RES_Q)
    env = lambda tau: math.exp(-tau / (2 * RES_Q))
    ring = curve(wv, numder(wv), span_t(0.0, RES_TAU, 51), 1.0, -RES_AMP, 0.0, 0.0, 2)
    bound = curve(
        env, numder(env), span_t(0.0, RES_TAU, 12), 1.0, -RES_AMP, 0.0, 0.0, 2
    ) + curve(env, numder(env), span_t(0.0, RES_TAU, 12), 1.0, RES_AMP, 0.0, 0.0, 2)
    rid, eid = d.uid("rw"), d.uid("re")
    d.defs += [
        f'<path id="{rid}" d="{ring}" vector-effect="non-scaling-stroke"/>',
        f'<path id="{eid}" d="{bound}" vector-effect="non-scaling-stroke"/>',
    ]
    px_s = (rx + rw - 20 - x0) / RES_WIN
    sx = [(px_s / (2 * math.pi * c), 1.0) for c in cut]
    body += [
        f'<path d="M{rx + 14} {cy}H{rx + rw - 14}" stroke="{mix(LINE, MUTED, 0.3)}" stroke-width="1.6" fill="none"/>',
        f'<g clip-path="url(#{clip2})"><g transform="translate({x0} {cy})"><g>'
        + tr("scale", tt, sx, (0.02, 0.1), RES_L, True, 3)
        + f'<use href="#{eid}" fill="none" stroke="{MUTED}" stroke-width="1.6" stroke-dasharray="4 7" opacity=".8"/>'
        f'<g fill="none" stroke="{ink}" stroke-linecap="round" stroke-linejoin="round">{glow(rid, 3.2)}</g>'
        "</g></g></g>",
        d.text("SemiBold", "40 ms", 25, rx + rw - 18, ty + th - 16, MUTED, "end"),
    ]
    return d.svg(26)


# ---- two springs ---------------------------------------------------------------------------------------------------
SPR_L, SPR_W, SPR_Z = (
    4.2,
    7.0,
    0.18,
)  # the loop (s), the spring's stiffness (1/s), the ringing one's damping ratio
SPR_PULL, SPR_REL, SPR_WIN = (
    0.5,
    0.9,
    2.4,
)  # pulled down until, let go at, and the plot's time span (s)
SPR_DROP, SPR_TGT, SPR_PPS = (
    110.0,
    290.0,
    96.0,
)  # how far it is pulled (px), the target's height, plot px per s
SPR_CEIL, SPR_HALF = (
    112.0,
    18.0,
)  # the ceiling the spring hangs from, half the mass's height


def spring_column(d, cx, ink, offset, name, sub):
    """A mass on a spring and its height against time, both from the release; offset(u) is how far it is from the
    target u seconds after it was let go at rest one unit away."""
    mx, xp = cx + 62.0, cx + 128.0
    tt = frames(round(SPR_L * FPS))

    def off(t):
        if t < SPR_PULL:
            return smoothstep(t / SPR_PULL)
        return 1.0 if t < SPR_REL else offset(t - SPR_REL)

    ys = [SPR_TGT + SPR_DROP * off(t) for t in tt]
    body = d.body
    fade = [0.0, 3.7, SPR_L]
    # the target and the place it is let go from
    body += [
        f'<path d="M{cx + 18} {SPR_TGT}H{cx + 358}" stroke="{mix(LINE, MUTED, 0.5)}" stroke-width="1.8" stroke-dasharray="6 7" fill="none"/>',
        f'<path d="M{num(xp, 1)} {SPR_TGT + SPR_DROP}h{SPR_WIN * SPR_PPS}" stroke="{LINE}" stroke-width="1.8" stroke-dasharray="6 7" fill="none"/>',
        f'<rect x="{cx + 18}" y="{SPR_CEIL - 12}" width="88" height="12" rx="4" fill="{MUTED}" opacity=".55"/>',
    ]
    # the plot's one second
    body += [
        f'<path d="M{num(xp, 1)} 440h{SPR_PPS}M{num(xp, 1)} 433v14M{num(xp + SPR_PPS, 1)} 433v14" stroke="{MUTED}" stroke-width="2" fill="none"/>',
        d.text("SemiBold", "1 s", 25, xp + SPR_PPS + 12, 449, MUTED),
    ]
    # the trail: the height against time, drawn as the time goes by, with a dot at its head
    f = lambda u: offset(u)
    tid = d.uid("tr")
    d.defs.append(
        f'<path id="{tid}" d="{curve(f, numder(f), span_t(0.0, SPR_WIN, 24), SPR_PPS, SPR_DROP, xp, SPR_TGT, 1)}" '
        'vector-effect="non-scaling-stroke"/>'
    )
    cid, hid = d.uid("tc"), d.uid("hl")
    wts = [0.0, SPR_REL, SPR_REL + SPR_WIN, SPR_L]
    d.defs += [
        f'<clipPath id="{cid}"><rect x="{num(xp - 4, 1)}" y="200" height="240" width="0">'
        + at(
            "width",
            wts,
            [(0.0,), (0.0,), (SPR_WIN * SPR_PPS + 8,), (SPR_WIN * SPR_PPS + 8,)],
            (0.01,),
            SPR_L,
            True,
            1,
        )
        + "</rect></clipPath>",
        rad(hid, [(0, "#ffffff", 0.8), (0.35, "#ffffff", 0.3), (1, "#ffffff", 0)]),
    ]
    body.append(
        f'<g opacity="1" clip-path="url(#{cid})">'
        + at("opacity", fade, [(1.0,), (1.0,), (0.0,)], (0.01,), SPR_L, True, 2)
        + f'<g fill="none" stroke="{ink}" stroke-linecap="round" stroke-linejoin="round">{glow(tid, 3.6)}</g></g>'
    )
    dot_x = lambda t: xp + SPR_PPS * min(max(t - SPR_REL, 0.0), SPR_WIN)
    body.append(
        '<g opacity="1">'
        + at(
            "opacity",
            [0.0, 0.25, 3.7, SPR_L],
            [(1.0,), (1.0,), (1.0,), (0.0,)],
            (0.01,),
            SPR_L,
            True,
            2,
        )
        + "<g>"
        + tr(
            "translate",
            tt,
            [(dot_x(t), y) for t, y in zip(tt, ys)],
            (0.2, 0.15),
            SPR_L,
            True,
            1,
        )
        + f'<circle r="20" fill="url(#{hid})" opacity=".8"/><circle r="5.5" fill="#ffffff"/></g></g>'
    )
    # the spring: eight turns between the ceiling and the mass, stretched or squeezed as one with it
    zig = ["M0 0V0.06"]
    for i in range(8):
        zig.append(
            f"L{16 if i % 2 == 0 else -16} {num(0.06 + 0.88 * (i + 0.5) / 8, 3)}"
        )
    zid = d.uid("zg")
    d.defs.append(
        f'<path id="{zid}" d="{"".join(zig)}L0 0.94V1" vector-effect="non-scaling-stroke"/>'
    )
    body.append(
        f'<g transform="translate({num(mx, 1)} {SPR_CEIL})" fill="none" stroke="{ink}" stroke-linecap="round" '
        f'stroke-linejoin="round"><g>'
        + tr(
            "scale",
            tt,
            [(1.0, y - SPR_HALF - SPR_CEIL) for y in ys],
            (0.01, 0.15),
            SPR_L,
            True,
            2,
        )
        + glow(zid, 3.4, 0.2)
        + "</g></g>"
    )
    body.append(
        f'<g transform="translate({num(mx, 1)} 0)"><g>'
        + tr("translate", tt, [(0.0, y) for y in ys], (0.1, 0.15), SPR_L, True, 1)
        + f'<rect x="-36" y="-26" width="72" height="52" rx="16" fill="{ink}" opacity=".2"/>'
        f'<rect x="-28" y="-18" width="56" height="36" rx="10" fill="{PANEL2}" stroke="{ink}" stroke-width="3.4"/>'
        f'<path d="M-16 -8H16" stroke="{mix(ink, "#ffffff", 0.5)}" stroke-width="3" stroke-linecap="round" opacity=".7"/>'
        "</g></g>"
    )
    body += [
        d.text("Bold", name, 32, cx, 490, ink),
        d.text("SemiBold", sub, 25, cx, 520, MUTED),
    ]


def physics_springs():
    d = Doc(
        PH_W,
        PH_H,
        "Two springs",
        "Two masses on springs of the same stiffness, pulled down together and let go. The one on the left is critically "
        "damped, as every glide on the FM-1's screen is: it slides to its target and never crosses it. The one on the "
        "right is under-damped, like the plucked lines beside a knob: it overshoots and rings. A trace beside each "
        "spring draws its height against time.",
    )
    head(d, "Two springs", "same pull, different damping", INKS[6])
    spring_column(
        d,
        PH_X0,
        INKS[4],
        lambda u: critical_offset(u, SPR_W),
        "Critically damped",
        "every glide on the screen",
    )
    spring_column(
        d,
        PH_X1 - 360,
        INKS[0],
        lambda u: ringing_offset(u, SPR_W, SPR_Z),
        "Under-damped",
        "the knob's plucked strings",
    )
    return d.svg(26)


# ---- circle on a circle: frequency modulation ----------------------------------------------------------------------
FM_L, FM_TM, FM_R, FM_N = (
    12.0,
    3.0,
    3.5,
    5,
)  # the loop and the modulator's period (s), the ratio, sidebands per side


def fm_index(t):
    """The modulation index (how far the modulator swings the carrier's phase, in radians) t seconds into the loop:
    from almost none up to 3.2 and back, as a turning 'bright' knob would."""
    return 1.75 - 1.45 * math.cos(2 * math.pi * t / FM_L)


def physics_fm():
    d = Doc(
        PH_W,
        PH_H,
        "Circle on a circle",
        "Frequency modulation as wheels. A carrier's circle, and the sideband wheels that ride one another, each turning "
        "at its own whole multiple of the modulator's rate; where the last one ends is always on the carrier's circle, "
        "swung back and forth by the modulator. Beside it the sidebands as bars, at the carrier plus or minus whole "
        "multiples of the modulator, at a ratio of 3.5 to 1 as in the rayon glass bell; each bar is as tall as its wheel "
        "is big, and the bright knob's sweep makes them breathe.",
    )
    ink = INKS[3]
    head(d, "Circle on a circle", "rayon, ratio 3.5:1", ink)
    body = d.body
    tt = frames(round(FM_L * FPS))
    beta = [fm_index(t) for t in tt]
    tints = (
        TEXT,
        INKS[4],
        INKS[3],
        INKS[2],
        INKS[1],
        INKS[0],
    )  # by |n|: the carrier, then each sideband pair
    order = [0] + [s * k for k in range(1, FM_N + 1) for s in (1, -1)]
    hid = d.uid("hl")
    d.defs.append(
        rad(hid, [(0, "#ffffff", 0.8), (0.35, "#ffffff", 0.3), (1, "#ffffff", 0)])
    )

    # the wheels
    ix, iy, iw, ih = PH_X0, 100, 320, 372
    cid = inset(d, ix, iy, iw, ih, "THE CIRCLE")
    cx, cy, rad_ = ix + iw / 2, iy + 206.0, 108.0
    spoke, wheel = d.uid("sk"), d.uid("wh")
    d.defs += [
        f'<path id="{spoke}" d="M0 0H1" vector-effect="non-scaling-stroke"/>',
        f'<circle id="{wheel}" r="1" vector-effect="non-scaling-stroke"/>',
    ]
    body += [
        f'<path d="M{ix + 10} {cy}H{ix + iw - 10}M{cx} {iy + 46}V{iy + ih - 10}" stroke="{LINE}" stroke-width="1.4" fill="none"/>',
        f'<circle cx="{cx}" cy="{cy}" r="{rad_}" fill="none" stroke="{mix(LINE, MUTED, 0.45)}" stroke-width="2"/>',
    ]
    # how far the modulator swings the point along the circle: an arc of the circle, from -index to +index
    arc_op = [(min(360.0, 2 * math.degrees(b)), -math.degrees(b)) for b in beta]
    keep = thin(tt, arc_op, (0.5, 0.25))
    ats = [tt[i] for i in keep]
    body.append(
        f'<g transform="translate({cx} {cy})"><g>'
        + keys(
            "animateTransform",
            'attributeName="transform" type="rotate"',
            ats,
            [(arc_op[i][1],) for i in keep],
            FM_L,
            True,
            1,
        )
        + f'<circle r="{rad_}" pathLength="360" fill="none" stroke="{ink}" stroke-width="9" opacity=".4" stroke-dasharray="0 720">'
        + keys(
            "animate",
            'attributeName="stroke-dasharray"',
            ats,
            [(arc_op[i][0], 720.0) for i in keep],
            FM_L,
            True,
            1,
        )
        + "</circle></g></g>"
    )
    tip = f'<circle r="20" fill="url(#{hid})" opacity=".85"/><circle r="6" fill="#ffffff"/>'
    chain = tip
    for i in reversed(range(len(order))):
        n = order[i]
        col = tints[abs(n)]
        lens = [(rad_ * bessel_j(n, b),) for b in beta]
        dn = n - (order[i - 1] if i else 0)
        spin = (
            keys(
                "animateTransform",
                'attributeName="transform" type="rotate"',
                [0.0, FM_L],
                [(0.0,), (-dn * 360.0 * FM_L / FM_TM,)],
                FM_L,
                True,
                1,
            )
            if dn
            else ""
        )
        chain = (
            f"<g>{spin}"
            f'<g fill="none" stroke="{col}" stroke-linecap="round">'
            + tr("scale", tt, [(v[0], v[0]) for v in lens], (0.4, 0.4), FM_L, True, 2)
            + f'<use href="#{wheel}" stroke-width="1.6" opacity=".5"/>'
            + glow(spoke, 3.0 if n else 3.8, 0.22)
            + "</g><g>"
            + tr(
                "translate", tt, [(v[0], 0.0) for v in lens], (0.4, 0.1), FM_L, True, 2
            )
            + chain
            + "</g></g>"
        )
    body.append(
        f'<g clip-path="url(#{cid})"><g transform="translate({cx} {cy})">{chain}</g></g>'
    )

    # the sidebands as bars, at the carrier plus or minus n times the modulator, each as tall as its wheel is big
    sx, sy, sw = ix + iw + 16, iy, PH_X1 - ix - iw - 16
    inset(d, sx, sy, sw, ih, "WHAT YOU HEAR")
    base, top = sy + ih - 54.0, 232.0
    u = (sx + sw - 24 - (sx + 26)) / (1 + FM_N * FM_R)
    body.append(
        f'<path d="M{sx + 12} {base}H{sx + sw - 12}" stroke="{mix(LINE, MUTED, 0.3)}" stroke-width="1.8" fill="none"/>'
    )
    for n in order:
        x = sx + 26 + u * abs(1 + n * FM_R)
        col = tints[abs(n)]
        vals = [(1.0, abs(bessel_j(n, b))) for b in beta]
        body.append(
            f'<g transform="translate({num(x, 1)} {base})"><g>'
            + tr("scale", tt, vals, (0.01, 0.004), FM_L, True, 3)
            + f'<rect x="-4" y="{-top}" width="8" height="{top}" rx="3" fill="{col}"/></g></g>'
        )
        body.append(
            d.text(
                "SemiBold",
                "0" if n == 0 else f"{n:+d}",
                25,
                x,
                base + 29,
                col,
                "middle",
            )
        )
    body += [
        d.text("SemiBold", "each wheel rides the last", 25, ix, 512, MUTED),
        d.text(
            "SemiBold", "bar n: carrier + n x modulator", 25, PH_X1, 512, MUTED, "end"
        ),
    ]
    return d.svg(26)


# ---- the demo clip: the real app, an animated PNG -------------------------------------------------------------------
DEMO_FIRST, DEMO_LAST, DEMO_FADE = 0, 183, 8


DEMO_BEZEL, DEMO_RADIUS = 14, 30


def _bezel(im):
    """The screen in a dark bezel with rounded, anti-aliased corners (the corners transparent)."""
    from PIL import Image, ImageDraw

    w, h = im.width + 2 * DEMO_BEZEL, im.height + 2 * DEMO_BEZEL
    out = Image.new("RGBA", (w, h), rgb(PANEL) + (255,))
    out.paste(im, (DEMO_BEZEL, DEMO_BEZEL))
    k = 4
    big = Image.new("L", (w * k, h * k), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, w * k - 1, h * k - 1), radius=DEMO_RADIUS * k, fill=255
    )
    out.putalpha(big.resize((w, h), Image.LANCZOS))
    return out


def build_demo(frames_dir, scale=2):
    """readme-demo.png: the host simulator's captures (240x240, 33 ms apart; a run of the sim with PLAY pressed on
    the Steps page, one `shot` per frame), the last DEMO_FADE frames dissolved into the first ones so that the loop
    has no seam; scaled by NEAREST (the pixels stay sharp); loops forever."""
    import io

    from PIL import Image

    src = [
        Image.open(Path(frames_dir) / f"f{i:03d}.png").convert("RGB")
        for i in range(DEMO_FIRST, DEMO_LAST + 1)
    ]
    n = len(src)
    out = src[DEMO_FADE:]
    out = out[: n - 2 * DEMO_FADE] + [
        Image.blend(src[n - DEMO_FADE + j], src[j], (j + 1) / DEMO_FADE)
        for j in range(DEMO_FADE)
    ]
    fr = [
        _bezel(im.resize((im.width * scale, im.height * scale), Image.NEAREST))
        for im in out
    ]
    buf = io.BytesIO()
    fr[0].save(
        buf,
        format="PNG",
        save_all=True,
        append_images=fr[1:],
        duration=33,
        loop=0,
        optimize=True,
    )
    return buf.getvalue()


# ---- all of it -----------------------------------------------------------------------------------------------------
def render_all():
    files = {
        "readme-hero.svg": hero(),
        "readme-rule.svg": divider(),
        "readme-meters.svg": meters(),
        "readme-scope.svg": scope(),
        "readme-physics-string.svg": physics_string(),
        "readme-physics-resonance.svg": physics_resonance(),
        "readme-physics-springs.svg": physics_springs(),
        "readme-physics-fm.svg": physics_fm(),
    }
    for name, c0, c1 in (
        ("manual", INKS[2], INKS[1]),
        ("browser", INKS[4], INKS[5]),
        ("install", INKS[3], INKS[4]),
        ("releases", INKS[6], INKS[7]),
    ):
        label = {
            "manual": "Read the manual",
            "browser": "Try it in your browser",
            "install": "Install",
            "releases": "Releases",
        }[name]
        files[f"readme-button-{name}.svg"] = button(label, c0, c1)
    for i, (key, title) in enumerate(CARDS):
        files[f"readme-card-{key}.svg"] = card(i, title)
    return {k: v.encode("utf-8") for k, v in files.items()}


def main(argv):
    ap = argparse.ArgumentParser(
        description="Write the README's art (docs/img/readme-*)."
    )
    ap.add_argument("out", nargs="?", default=str(ROOT / "docs" / "img"))
    ap.add_argument(
        "--demo",
        metavar="FRAMES_DIR",
        help="also build readme-demo.png from the captured frames",
    )
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for name, data in sorted(render_all().items()):
        (out / name).write_bytes(data)
        print(f"{name}: {len(data)} B")
    if a.demo:
        data = build_demo(a.demo)
        (out / "readme-demo.png").write_bytes(data)
        print(f"readme-demo.png: {len(data)} B")


if __name__ == "__main__":
    main(sys.argv[1:])
