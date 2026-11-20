#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The README's art (docs/img/readme-*), every motion from a simulation, the output byte for byte the same each run.

  python3 tools/make_readme_art.py [OUT_DIR] [--demo FRAMES_DIR]

OUT_DIR is docs/img by default. The SVGs (hero, rule, meters, buttons, feature cards) are drawn with fixed constants;
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
    equal to its first; what plays once (the drop, the sprouting) is held at its end.
The letters are the outlines of base/assets/fonts/BarlowSemiCondensed (SIL OFL 1.1), read by a small TrueType reader
below, so the text needs no font on the viewer's side."""

import argparse
import math
import struct
import sys
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


def smil(tag, attr, ts, vs, eps, dur, loop, decimals=2, extra=""):
    """An <animate> / <animateTransform> of the samples (ts in seconds from 0 to dur, vs tuples), thinned."""
    idx = thin(ts, vs, eps)
    kt = ";".join(num(ts[i] / dur, 4) for i in idx)
    vals = ";".join(" ".join(num(c, decimals) for c in vs[i]) for i in idx)
    mode = 'repeatCount="indefinite"' if loop else 'fill="freeze"'
    return f'<{tag} {attr} dur="{num(dur, 3)}s" {mode} calcMode="linear" keyTimes="{kt}" values="{vals}"{extra}/>'


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

    def uid(self, p):
        self.n += 1
        return f"{p}{self.n}"

    def svg(self, rx):
        clip = f'<clipPath id="cp"><rect width="{self.w}" height="{self.h}" rx="{rx}"/></clipPath>'
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" '
            f'height="{self.h}" role="img" aria-labelledby="ti de">\n<title id="ti">{esc(self.title)}</title>\n'
            f'<desc id="de">{esc(self.desc)}</desc>\n<defs>{clip}\n'
            + "\n".join(self.defs)
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


def hero():
    d = Doc(
        HW,
        HH,
        "SoundPlant",
        "SoundPlant turns the M-VAVE FM-1 into a pocket groovebox: eight tracks, eleven engines, "
        "93 factory presets and a 64-step sequencer. Eight plants in the track colours grow under the name; a "
        "pluck travels across them and a pulse crosses the spectrum rule.",
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
        40,
        "A spectrum rule",
        "A thin rule in the eight track colours; a pulse of light travels along it, spreads and fades.",
    )
    d.body.append(rule(d, 40, 1160, 20, 0.2))
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
    fr = [_bezel(im.resize((im.width * scale, im.height * scale), Image.NEAREST)) for im in out]
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
    ap = argparse.ArgumentParser(description="Write the README's art (docs/img/readme-*).")
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
