# SPDX-License-Identifier: MPL-2.0
"""The site tools/make_pages.py makes for GitHub Pages: every section is there, every link between its pages lands on a
file, the emulator has what it loads, the Backup page's demo songs card finds the demos where the emulator keeps them, and
before the first release nothing offers a download or an installer that is not there. With a directory it checks that site (CI checks what it deploys); without one it makes the no-release site
first, from the emulator ./build.sh --web built.
  tests/host/site_test.py [SITE_DIR]      (tests/run_tests.sh runs it)"""

import json
import re
import struct
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "base" / "tools"))
import fm1_backup  # fm1-base's backup file format

SECTIONS = ("emu", "manual", "install", "backup", "mirror", "samples", "project")
EMU_FILES = (
    "index.html",
    "app.wasm",
    "worklet.js",
    "app_worklet.js",
    "app.js",
    "app_own.js",
    "garden.js",
    "garden_core.js",
    "garden_gl.js",
    "presets.js",
    "presets.json",
)
# a project's first part in each of the three slots (APP_BACKUP_OBJS: the presets, then 7 parts a slot)
DEMO_PARTS = (2, 9, 16)
PROJ_MAGIC = 0x384D4F4C  # "LOM8", a project's first word
# the format the firmware writes (app/app.h): the Backup page's card puts only this one on the FM-1
_format = re.search(
    r"#define PROJ_FORMAT (\d+)u", (ROOT / "app" / "app.h").read_text(encoding="utf-8")
)
if not _format:
    raise SystemExit("site_test: app/app.h has no PROJ_FORMAT")
PROJ_FORMAT = int(_format.group(1))
bad = 0


def check(what, ok):
    global bad
    print(f"{what:<88} {'ok' if ok else 'FAIL'}")
    bad += not ok


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k in ("href", "src") and v:
                self.urls.append(v)


def dead_links(site):
    """(page, url) for every link between the site's own files that lands on nothing"""
    dead = []
    for page in sorted(site.rglob("*.html")):
        links = Links()
        links.feed(page.read_text(encoding="utf-8"))
        for url in links.urls:
            u = urlsplit(url)
            if u.scheme or u.netloc or not u.path:
                continue
            target = (page.parent / unquote(u.path)).resolve()
            if u.path.endswith("/"):
                target = target / "index.html"
            if not target.is_file():
                dead.append((str(page.relative_to(site)), url))
    return dead


def image_problem(image):
    """why a demo's file is not a backup this firmware restores whole (CRCs, magic, 22 parts, a project in each slot), or ''"""
    try:
        _, objs = fm1_backup.parse(image)
    except fm1_backup.BackupError as e:
        return str(e)
    if image[:4] != b"LM8B" or len(objs) != 22:
        return f"magic {image[:4]!r} with {len(objs)} parts"
    empty = [o for o, d in objs if o in DEMO_PARTS and not d]
    return f"no project in parts {empty}" if empty else ""


def project_format(image):
    """the format word of the project in a demo's first slot (its settings part: "LOM8", then the format), None when the file is not a backup with one"""
    try:
        _, objs = fm1_backup.parse(image)
    except fm1_backup.BackupError:
        return None
    settings = dict(objs).get(DEMO_PARTS[0], b"")
    if len(settings) < 8:
        return None
    magic, fmt = struct.unpack_from("<II", settings)
    return fmt if magic == PROJ_MAGIC else None


def demo_image(fmt):
    """a backup whose first slot holds a project of format fmt"""
    settings = struct.pack("<II", PROJ_MAGIC, fmt) + bytes(56)
    parts = [(o, settings if o == DEMO_PARTS[0] else b"") for o in range(1, 23)]
    return fm1_backup.build(parts, magic=b"LM8B", version=1)


def make_site():
    out = ROOT / "app" / "build" / "tests" / "site"
    run = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "make_pages.py"),
            "--no-release",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    check("make_pages.py --no-release makes the site", run.returncode == 0)
    if run.returncode:
        print(run.stdout + run.stderr)
        sys.exit(1)
    return out


def refused_dev_package():
    """a development package (identity FM-1_0...00) is refused: the installer checks a release's identity"""
    pkg = ROOT / "app" / "build" / "soundplant.fwsc"
    if not pkg.exists():
        print(
            "skip: a development package is refused (no app/build/soundplant.fwsc: ./build.sh)"
        )
        return
    out = ROOT / "app" / "build" / "tests" / "site_dev"
    run = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "make_pages.py"),
            str(pkg),
            "0.1",
            str(out),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    check(
        "a development package is refused, naming the release build",
        run.returncode != 0 and "release build" in run.stdout + run.stderr,
    )


site = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else make_site()
for sec in SECTIONS:
    check(f"{sec}/index.html is on the site", (site / sec / "index.html").is_file())
check("the front page is on the site", (site / "index.html").is_file())
check(
    "the words files and the pictures are on the site",
    (site / "words").is_dir() and (site / "img").is_dir(),
)
emu = [f for f in EMU_FILES if not (site / "emu" / f).is_file()]
check(f"the emulator has what it loads (missing: {', '.join(emu) or 'none'})", not emu)
demo_dir = site / "emu" / "demos"
listing = demo_dir / "demos.json"
demos = json.loads(listing.read_text(encoding="utf-8")) if listing.is_file() else []
check(
    f"emu/demos/demos.json lists the demos ({len(demos)})",
    len(demos) >= 10
    and all(
        isinstance(d.get("bpm"), int) and d.get("genre") and d.get("blurb")
        for d in demos
    )
    and len({d["id"] for d in demos}) == len(demos),
)
problems = {
    d["file"]: image_problem(
        (demo_dir / d["file"]).read_bytes() if (demo_dir / d["file"]).is_file() else b""
    )
    for d in demos
}
check(
    f"every listed demo is a whole backup with a project in all three slots ({[f for f, p in problems.items() if p][:3]})",
    demos and not any(problems.values()),
)
files = {f.name for f in demo_dir.iterdir()} if demo_dir.is_dir() else set()
check(
    f"emu/demos/ holds the list and the demos and nothing else ({sorted(files - {d['file'] for d in demos} - {'demos.json'})})",
    files == {d["file"] for d in demos} | {"demos.json"},
)
first = (demo_dir / demos[0]["file"]).read_bytes() if demos else b""
damaged = bytearray(first)
damaged[len(damaged) // 2] ^= 0xFF
check(
    "a demo with one byte changed is not a whole backup, nor is one cut short, nor an empty file",
    first
    and not image_problem(first)
    and image_problem(bytes(damaged))
    and image_problem(first[:-1])
    and image_problem(b""),
)
emu_page = (
    (site / "emu" / "index.html").read_text(encoding="utf-8")
    if (site / "emu" / "index.html").is_file()
    else ""
)
emu_app = (
    (site / "emu" / "app_own.js").read_text(encoding="utf-8")
    if (site / "emu" / "app_own.js").is_file()
    else ""
)
check(
    "emu/ has the demo picker, and its code loads the list from demos/demos.json",
    all(
        f'id="{i}"' in emu_page
        for i in ("demos", "demo-play", "demo-load", "demo-undo", "demos-confirm")
    )
    and "demos/demos.json" in emu_app,
)
check(
    f"every demo is what the Backup page's card reads: file, genre and blurb as text, the tempo a number ({len(demos)})",
    demos
    and all(
        isinstance(d.get("file"), str)
        and isinstance(d.get("genre"), str)
        and isinstance(d.get("blurb"), str)
        and isinstance(d.get("bpm"), (int, float))
        for d in demos
    ),
)
formats = {
    d["file"]: project_format((demo_dir / d["file"]).read_bytes()) for d in demos
}
check(
    f"every demo's first slot is a project of format {PROJ_FORMAT}, the one the card puts on the FM-1 ({[f for f, v in formats.items() if v != PROJ_FORMAT][:3]})",
    demos and all(v == PROJ_FORMAT for v in formats.values()),
)
check(
    "... and that check tells a format 22 project from an older one, a damaged backup and a file that is not one",
    project_format(demo_image(PROJ_FORMAT)) == PROJ_FORMAT
    and project_format(demo_image(15)) == 15
    and project_format(demo_image(PROJ_FORMAT)[:-1]) is None
    and project_format(b"") is None,
)
backup_page = (
    (site / "backup" / "index.html").read_text(encoding="utf-8")
    if (site / "backup" / "index.html").is_file()
    else ""
)
demo_url = re.search(r'const DEMO_DIR = "([^"]+)"', backup_page)
check(
    "backup/ has the demo songs card, the one Restore card it follows, and the emulator's demos/ as its folder",
    backup_page.count('id="rh"') == 1
    and backup_page.count("function demoInstall()") == 1
    and backup_page.count("function addDemoSlots(") == 1
    and backup_page.count("const EXTRAS = (() => {") == 1
    and demo_url
    and (site / "backup" / (demo_url.group(1) + "demos.json")).resolve()
    == listing.resolve(),
)
presets_file = site / "emu" / "presets.json"
presets = (
    json.loads(presets_file.read_text(encoding="utf-8"))
    if presets_file.is_file()
    else {}
)
table = ROOT / "app" / "build" / "gen" / "presets.h"
rows = (
    sum(
        line.startswith('    {"')
        for line in table.read_text(encoding="utf-8").splitlines()
    )
    if table.is_file()
    else -1
)


def is_firmwares(lst):
    """lst is one entry for each row of the firmware's table, in its order, each with its words"""
    listed = lst.get("presets", [])
    return (
        rows > 0
        and len(listed) == rows == lst.get("count")
        and [p["index"] for p in listed] == list(range(rows))
        and all(
            p["name"] and p["engine"] in lst["engines"] and p["desc"] for p in listed
        )
        and {g["engine"] for g in lst["groups"]} == {p["engine"] for p in listed}
    )


short = {**presets, "presets": presets.get("presets", [])[1:]}
over = {**presets, "count": presets.get("count", 0) + 1}
gap = {
    **presets,
    "presets": [
        {**p, "index": p["index"] + (p["index"] > 40)}
        for p in presets.get("presets", [])
    ],
}
check(
    f"emu/presets.json lists the firmware's {rows} presets, each with a name, an engine and a line",
    is_firmwares(presets),
)
check(
    "a list one preset short, a count one over, or an index skipped is not the firmware's",
    is_firmwares(presets)
    and not is_firmwares(short)
    and not is_firmwares(over)
    and not is_firmwares(gap),
)
check(
    "emu/ has the Preset lab, and the demos' folder has not taken its list",
    all(
        f'id="{i}"' in emu_page
        for i in (
            "presets",
            "presets-search",
            "presets-list",
            "presets-count",
            "presets-error",
        )
    )
    and 'import("./presets.js")' in emu_page
    and not (demo_dir / "presets.json").exists(),
)
dead = dead_links(site)
check(
    f"every link between the site's pages lands on a file ({len(dead)} dead: {dead[:4]})",
    not dead,
)
for sec in ("", *(s + "/" for s in SECTIONS)):
    page = (
        (site / sec / "index.html").read_text(encoding="utf-8")
        if (site / sec / "index.html").is_file()
        else ""
    )
    check(
        f"{sec or 'front page'}: the site's header, with a way to every section",
        'class="lm-top"' in page and all(f'{s}/"' in page for s in SECTIONS),
    )

front = (site / "index.html").read_text(encoding="utf-8")
install = (site / "install" / "index.html").read_text(encoding="utf-8")
check("no placeholder is left on the front page", "__" not in front)
packages = (
    sorted((site / "firmware").glob("soundplant-*.fwsc"))
    if (site / "firmware").is_dir()
    else []
)
if packages:
    name = packages[-1].name
    check(
        "with a release: the front page links the package",
        f'href="firmware/{name}"' in front,
    )
    check(
        "with a release: the installer writes that package",
        f"../firmware/{name}" in install,
    )
    check(
        "with a release: the front page does not say it is unreleased",
        "Not released yet" not in front,
    )
else:
    check(
        "no release: the front page says so and links no firmware",
        "Not released yet" in front and "firmware/" not in front,
    )
    check(
        "no release: install/ says so and has no installer in it",
        "no release yet" in install and "fm1ota" not in install,
    )
    refused_dev_package()
print("site:", "all ok" if not bad else f"{bad} FAILED")
sys.exit(1 if bad else 0)
