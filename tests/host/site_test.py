# SPDX-License-Identifier: MPL-2.0
"""The site tools/make_pages.py makes for GitHub Pages: every section is there, every link between its pages lands on a
file, the emulator has what it loads, and before the first release nothing offers a download or an installer that is
not there. With a directory it checks that site (CI checks what it deploys); without one it makes the no-release site
first, from the emulator ./build.sh --web built.
  tests/host/site_test.py [SITE_DIR]      (tests/run_tests.sh runs it)"""

import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SECTIONS = ("emu", "manual", "install", "backup", "mirror", "samples")
EMU_FILES = (
    "index.html",
    "app.wasm",
    "worklet.js",
    "app_worklet.js",
    "app.js",
    "app_own.js",
)
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
