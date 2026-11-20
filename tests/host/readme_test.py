#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""README.md and its art (tools/make_readme_art.py writes docs/img/readme-*): every relative link and image resolves,
no art file is left unused, the SVGs are well-formed animations with no script and nothing loaded from outside, the
demo clip is a looping APNG under 2.5 MB whose loop has no seam, the committed art is byte for byte what the generator
writes (twice the same), the README holds the facts and credits it must, and the name SoundPlant was forked from
appears on one credit line near the top and nowhere else. Each check also runs on a broken sample to show it can fail.
  tests/host/readme_test.py [ROOT]  (tests/run_tests.sh runs it; ROOT: another tree holding the same files)"""

import io
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = (
    Path(sys.argv[1]).resolve()
    if len(sys.argv) > 1
    else Path(__file__).resolve().parents[2]
)
sys.path.insert(0, str(ROOT / "tools"))
import make_readme_art as art
from PIL import Image

IMG = ROOT / "docs" / "img"
SVG_MAX = 400 * 1024
APNG_MAX = 2_500_000
CREDIT_LINES = 12
OLD = re.compile(r"(?<![A-Za-z])" + "lo" + "om" + r"(?![A-Za-z])", re.IGNORECASE)
CREDIT = (
    "SoundPlant is a fork of LO"
    + "OM-8 by Charles Vestal (https://github.com/charlesvestal/fm1-"
    + "lo"
    + "om)"
)
ANIMATION = {"animate", "animateTransform", "animateMotion", "set"}
FACTS = (
    "eleven engines",
    "93 factory presets",
    "64-step",
    "step tricks and parameter locks",
    "knit, rayon, jacquard, bellows, cane, voile and acid, a tb-303",
    "a sample player, a break slicer, a drum kit, and midi out to drive another synth",
    "arp, strum and hold",
    "bar by bar, step by step, or one's rhythm with the other's notes",
    "momentary effects",
    "a conductor that moves the song through a progression",
    "the playstation's reverbs among its modes",
    "a mixer with eq, and a compressor on the master",
    "midi over usb, bluetooth and the trs jack",
    "usb midi host for a keyboard or synth (through a powered hub)",
    "backed up to a computer and put back",
    "the screen mirrored to it",
    "tools/soundplant_samples.py",
    "at your own risk",
    "can put m-vave's firmware back",
    "starts in a safe mode",
    "clone with `--recursive`",
    "`tests/run_tests.sh` runs everything on the host, silently",
    "gpl-3.0-only as a whole (`copying`)",
    "mpl-2.0 (`license`), each on its own",
    "docs/superpowers/specs/2026-10-15-xy1-design.md",
    "built on [fm1-base]",
    "x0x's sequencer discipline and polly's menu paradigm",
    "not affiliated with teenage engineering",
)
CREDITS = (
    "Leo Kuroshita",
    "Hügelton Instruments",
    "felucca-bsp#4",
    "Emilie Gillet",
    "Robin Schmidt",
    "midilab",
    "Dave Mollen",
    "PSXVerb",
    "Omodaka9375",
    "Matt Estela",
    "digisophie",
    "u/FCTRYBEATS",
    "athousanddetails",
    "Optimist",
    "Matthew Cieplak",
    "Versilian Studios Chamber",
    "Orchestra 2 Community Edition (CC0)",
    "Barlow and Terminus (SIL OFL 1.1)",
    "Melodee (keremimo) and Jangada (zednaked)",
    "Adrien Tibi and Kerem Kilic",
    "Henri David",
    "Kenneth MacKay (BSD-2-Clause)",
    "JieLi's AC79 SDK (Apache-2.0)",
    "Groove OS",
    "teenage engineering's OP-XY",
)

bad = 0


def check(what, ok):
    global bad
    print(f"{what:<88} {'ok' if ok else 'FAIL'}")
    bad += not ok


def targets(text):
    """every link and image target of a markdown / HTML README"""
    return [
        a or b
        for a, b in re.findall(
            r"""\]\(([^)\s]+)[^)]*\)|\b(?:href|src)=["']([^"']+)["']""", text
        )
    ]


def broken_links(text, root):
    """the relative targets that name nothing under root"""
    rel = [t for t in targets(text) if not re.match(r"(?i)[a-z][a-z0-9+.-]*:|#|//", t)]
    return [t for t in rel if not (root / t.split("#")[0]).exists()]


def svg_problems(raw):
    """why an SVG is not a self-contained animation (empty when it is)"""
    try:
        tree = ET.fromstring(raw)
    except ET.ParseError as e:
        return [f"not XML: {e}"]
    out = []
    tags = {el.tag.rsplit("}", 1)[-1] for el in tree.iter()}
    if not tags & ANIMATION:
        out.append("no animation element")
    if tags & {"script", "foreignObject"}:
        out.append("script or foreignObject")
    for el in tree.iter():
        for k, v in el.attrib.items():
            name = k.rsplit("}", 1)[-1]
            if name in ("href", "src") and re.match(r"(?i)(https?:)?//|https?:", v):
                out.append(f"external {name}: {v}")
            if name.lower().startswith("on"):
                out.append(f"event handler {name}")
    if re.search(rb"(?i)url\(\s*[\"']?(https?:)?//|@import", raw):
        out.append("external resource in a style")
    if len(raw) >= SVG_MAX:
        out.append(f"{len(raw)} bytes")
    return out


def apng_problems(raw):
    """why a file is not a looping animated PNG under the size cap (empty when it is)"""
    out = []
    if len(raw) > APNG_MAX:
        out.append(f"{len(raw)} bytes")
    with Image.open(io.BytesIO(raw)) as im:
        if im.format != "PNG" or getattr(im, "n_frames", 1) < 2:
            return out + ["not an animated PNG"]
        if im.info.get("loop") != 0:
            out.append(f"loops {im.info.get('loop')} times, not forever")
        for k in range(im.n_frames):
            im.seek(k)
            if im.info["duration"] < 20:
                out.append(f"frame {k} lasts {im.info['duration']} ms")
                break
    return out


def old_name_lines(text):
    return [n for n, ln in enumerate(text.splitlines(), 1) if OLD.search(ln)]


def unsafe_markup(text):
    """tags and attributes GitHub strips or that run code"""
    out = []
    for tag in re.findall(r"<[a-zA-Z/][^>]*>", text):
        if re.match(
            r"</?\s*(script|style|iframe|object|embed|form)\b", tag, re.IGNORECASE
        ) or re.search(r"\s(style|on[a-z]+)\s*=", tag, re.IGNORECASE):
            out.append(tag)
    return out


def imgs_without_alt(text):
    """<img> tags with no alt attribute, or an empty one (the rule is decoration: empty is right)"""
    out = []
    for tag in re.findall(r"<img\b[^>]*>", text):
        m = re.search(r"""\balt=(["'])(.*?)\1""", tag)
        if m is None or (not m.group(2) and "readme-rule.svg" not in tag):
            out.append(tag)
    return out


def flat(text):
    """the visible words in one line, lower case (a reflow or a tag between them changes nothing)"""
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).lower()


readme = (ROOT / "README.md").read_text(encoding="utf-8")

# ---- links and images
rel = [t for t in targets(readme) if not re.match(r"(?i)[a-z][a-z0-9+.-]*:|#|//", t)]
check(f"the README has links to look at ({len(rel)} relative)", len(rel) >= 20)
check("every relative link and image resolves", not broken_links(readme, ROOT))
check(
    "a link to a missing file is caught",
    broken_links("see [x](docs/no-such-page.md#top)", ROOT) == ["docs/no-such-page.md#top"],
)
check(
    "an image of a missing file is caught",
    broken_links('<img src="docs/img/readme-nope.svg" alt="x">', ROOT)
    == ["docs/img/readme-nope.svg"],
)
used = {Path(t).name for t in targets(readme) if t.startswith("docs/img/readme-")}
have = {p.name for p in IMG.glob("readme-*")}
check(
    f"every docs/img/readme-* file is used, and none is missing ({len(have)})",
    used == have,
)
check("every image has alt text", not imgs_without_alt(readme))
check(
    "an image with no alt text is caught",
    len(imgs_without_alt('<img src="a.svg"><img src="b.svg" alt="b"><img src="c.svg" alt="">'))
    == 2,
)
check("no script, style or event handler in the README", not unsafe_markup(readme))
sample = unsafe_markup('<script>x</script>\n<p style="color:red">y</p>')
check(
    "a script tag and a style attribute in it are caught",
    "<script>" in sample and '<p style="color:red">' in sample,
)

# ---- the SVGs
svgs = sorted(IMG.glob("readme-*.svg"))
check(f"there is art to check ({len(svgs)} SVGs)", len(svgs) >= 19)
for p in svgs:
    probs = svg_problems(p.read_bytes())
    check(f"{p.name}: animated, no script, nothing external, under 400 KB", not probs)
    if probs:
        print("   ", "; ".join(probs))
good = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><defs/>'
    b'<rect width="4" height="4"><animate attributeName="opacity" values="0;1" dur="1s"/></rect></svg>'
)
check("the sample SVG the next checks break is clean", svg_problems(good) == [])
check(
    "an SVG with a script tag is caught",
    "script or foreignObject"
    in svg_problems(good.replace(b"<defs/>", b"<script>x()</script>")),
)
check(
    "an SVG that loads an outside image is caught",
    any(
        p.startswith("external")
        for p in svg_problems(
            good.replace(b"<defs/>", b'<image href="https://example.org/a.png"/>')
        )
    ),
)
check(
    "an SVG with a handler is caught",
    svg_problems(good.replace(b"<defs/>", b'<g onload="x()"/>'))
    == ["event handler onload"],
)
check(
    "an SVG with no animation is caught",
    svg_problems(re.sub(rb"<animate[^>]*/>", b"", good)) == ["no animation element"],
)
check("an SVG that is not XML is caught", svg_problems(good[:-8]) != [])
check(
    "an SVG of 400 KB is caught",
    any("bytes" in p for p in svg_problems(good + b" " * SVG_MAX)),
)

# ---- the demo clip
demo = IMG / "readme-demo.png"
raw = demo.read_bytes()
check(
    f"readme-demo.png: animated, loops forever, under 2.5 MB ({len(raw)} B)",
    not apng_problems(raw),
)
with Image.open(demo) as im:
    check(
        f"its frames ({im.n_frames}) and size {im.size}: many, and square",
        im.n_frames > 100 and im.width == im.height,
    )
still = io.BytesIO()
Image.new("RGB", (8, 8)).save(still, format="PNG")
check(
    "a still PNG is caught", apng_problems(still.getvalue()) == ["not an animated PNG"]
)
twice = io.BytesIO()
frames = [Image.new("RGB", (8, 8), (k * 40, 0, 0)) for k in range(3)]
frames[0].save(
    twice, format="PNG", save_all=True, append_images=frames[1:], duration=33, loop=2
)
check(
    "a clip that stops after two loops is caught",
    any("not forever" in p for p in apng_problems(twice.getvalue())),
)
check(
    "a clip over 2.5 MB is caught",
    any("bytes" in p for p in apng_problems(raw + b"\0" * APNG_MAX)),
)

# the encoder, on stand-in frames: frame i is the flat grey i, so a frame's grey says which source frame it came from
with tempfile.TemporaryDirectory() as d:
    for i in range(art.DEMO_FIRST, art.DEMO_LAST + 1):
        Image.new("RGB", (16, 16), (i, i, i)).save(Path(d) / f"f{i:03d}.png")
    one, two = art.build_demo(d), art.build_demo(d)
    n_src = art.DEMO_LAST - art.DEMO_FIRST + 1
    mid = art.DEMO_BEZEL + 16
    with Image.open(io.BytesIO(one)) as im:
        grey = []
        for k in range(im.n_frames):
            im.seek(k)
            grey.append(im.convert("RGBA").getpixel((mid, mid))[0])
        corner = im.convert("RGBA").getpixel((0, 0))[3]
        seam = grey[0] - grey[-1]
        frames_n, loop = im.n_frames, im.info.get("loop")
check("the encoder writes the same bytes twice", one == two)
check(
    f"the clip drops {art.DEMO_FADE} frames and loops forever ({frames_n} frames)",
    frames_n == n_src - art.DEMO_FADE and loop == 0,
)
check(
    f"the loop's seam is one source frame (last {grey[-1]}, first {grey[0]}), not a jump",
    seam == 1,
)
check(
    "the bezel's corners are transparent and its screen is not",
    corner == 0 and grey[0] > 0,
)
fade = art.DEMO_FADE
blends = [
    (n_src - fade + j) * (1 - (j + 1) / fade) + j * (j + 1) / fade for j in range(fade)
]
check(
    "its last frames are blends of the clip's end into its start",
    all(abs(g - e) <= 1 for g, e in zip(grey[-fade:], blends)),
)

# ---- the committed art is what the generator writes
with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
    for out in (a, b):
        subprocess.run(
            [sys.executable, str(ROOT / "tools" / "make_readme_art.py"), out],
            check=True,
            capture_output=True,
        )
    made_a = {p.name: p.read_bytes() for p in Path(a).iterdir()}
    made_b = {p.name: p.read_bytes() for p in Path(b).iterdir()}
    check(
        f"the generator writes the same {len(made_a)} files twice, byte for byte",
        made_a == made_b and made_a,
    )
    committed = {p.name: p.read_bytes() for p in svgs}
    check(
        "the committed SVGs are the generator's, no more, no fewer", committed == made_a
    )
    stale = [n for n in made_a if committed.get(n) != made_a[n]]
    if stale:
        print("    differ:", ", ".join(sorted(stale)))

# ---- the words
check("the README names SoundPlant", "SoundPlant" in readme)
lines = old_name_lines(readme)
check(
    f"the old name is on one line only (lines {lines}), within the first {CREDIT_LINES}",
    len(lines) == 1 and lines[0] <= CREDIT_LINES,
)
check(
    "and that line is the fork credit, word for word",
    len(lines) == 1 and readme.splitlines()[lines[0] - 1].strip() == CREDIT,
)
check(
    "a second line with the old name is caught",
    old_name_lines(CREDIT + "\n\nthe LO" + "OM-8 manual\n") == [1, 3],
)
check(
    "a word that only holds the old name is not",
    old_name_lines("a bloom of blossoms") == [],
)
facts = flat(readme)
missing = [f for f in FACTS if f not in facts]
check(f"the facts of the old README are all there ({len(FACTS)})", not missing)
if missing:
    print("    missing:", "; ".join(missing))
lost = [c for c in CREDITS if c not in readme.replace("\n", " ")]
check(f"every credit is kept ({len(CREDITS)} names)", not lost)
if lost:
    print("    missing:", "; ".join(lost))
print("README:", "all ok" if not bad else f"{bad} FAILED")
sys.exit(1 if bad else 0)
