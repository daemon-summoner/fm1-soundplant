# SPDX-License-Identifier: MPL-2.0
"""The project's name (SoundPlant): no file, path or identifier still carries the name it was forked from, and the
places that must agree on the new one do (fm1.toml, firmware.json, app.h, the release and build docs, the host binary's
name in the scripts). The forked-from name may appear only where credit is due: the first lines of README.md and
LICENSING.md, and the two outside names in docs/superpowers (a branch of fm1-base, a folder in the author's stash).
  tests/host/name_test.py           (tests/run_tests.sh runs it)"""

import json
import re
import subprocess
import sys
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[2]
SELF = "tests/host/name_test.py"  # holds the old name in its detector's own samples
OLD = re.compile(r"(?<![A-Za-z])loom(?![A-Za-z])", re.IGNORECASE)
SKIP_PREFIX = ("base/", "app/build/", "build/", ".git/", ".ruff_cache/")
SKIP_EXT = {".png", ".pyc", ".gif", ".jpg", ".webp", ".wav", ".apng"}
CREDIT_FILES = {"README.md": 12, "LICENSING.md": 8}
OUTSIDE_NAMES = {
    "docs/superpowers/2026-10-18-handoff.md": "loom-hooks",
    "docs/superpowers/2026-10-23-handoff.md": "loom-mdkit",
}

bad = 0


def check(what, ok):
    global bad
    print(f"{what:<88} {'ok' if ok else 'FAIL'}")
    bad += not ok


def offenders(files):
    """the paths and lines carrying the old name, from (relative path, text or None) pairs"""
    out = []
    for rel, text in files:
        if OLD.search(rel):
            out.append(f"{rel}: the file's name")
        for n, line in enumerate((text or "").splitlines(), 1):
            if not OLD.search(line):
                continue
            if n <= CREDIT_FILES.get(rel, 0):
                continue
            if not OLD.search(line.replace(OUTSIDE_NAMES.get(rel, "\0"), "")):
                continue
            out.append(f"{rel}:{n}: {line.strip()[:100]}")
    return out


def repo_files():
    listed = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    for rel in listed:
        if (
            rel == SELF
            or rel.startswith(SKIP_PREFIX)
            or Path(rel).suffix in SKIP_EXT
            or not (ROOT / rel).is_file()
        ):
            continue
        raw = (ROOT / rel).read_bytes()
        try:
            yield rel, raw.decode("utf-8")
        except UnicodeDecodeError:
            yield rel, raw.decode("latin-1")


# the detector first: it must flag the old name in a path and in a line, in every case and as an identifier or a
# word, and leave a word that only contains it ("bloom") and the credited places alone
synthetic = [
    ("app/gfx_loom.c", "int x;"),
    ("a.c", "the LOOM-8 splash"),
    ("b.c", "int loom_text(void);"),
    ("c.c", "a soft bloom, a Loom"),
    ("d.c", "a soft bloom only"),
    ("LICENSING.md", "# x\n" * 7 + "a fork of LOOM-8\n" + "later: Loom\n"),
    ("README.md", "a fork of LOOM-8\n"),
    (
        "docs/superpowers/2026-10-18-handoff.md",
        "the `loom-hooks` branch\nand LOOM-8 itself\n",
    ),
    ("docs/superpowers/2026-10-23-handoff.md", "the `loom-hooks` branch\n"),
]
flagged = offenders(synthetic)
flagged_files = sorted({f.split(":")[0] for f in flagged})
check(
    "the detector flags a file name, an upper-case name, an identifier and a mixed-case word",
    flagged_files
    == [
        "LICENSING.md",
        "a.c",
        "app/gfx_loom.c",
        "b.c",
        "c.c",
        "docs/superpowers/2026-10-18-handoff.md",
        "docs/superpowers/2026-10-23-handoff.md",
    ],
)
check(
    "the detector leaves 'bloom' and the credit lines of README.md and LICENSING.md alone",
    not any(f.startswith(("d.c", "README.md")) for f in flagged)
    and sum(f.startswith("LICENSING.md") for f in flagged) == 1,
)
check(
    "the detector allows an outside name only for its own file and name",
    sum(f.startswith("docs/superpowers/2026-10-18-handoff.md") for f in flagged) == 1
    and sum(f.startswith("docs/superpowers/2026-10-23-handoff.md") for f in flagged)
    == 1,
)

# the repository
found = offenders(repo_files())
check("no file name or line of the repository carries the old name", not found)
for f in found[:40]:
    print("   ", f)

# the places that agree on the name
toml = tomllib.loads((ROOT / "app/fm1.toml").read_text())
hub = json.loads((ROOT / "firmware.json").read_text())
app_h = (ROOT / "app/app.h").read_text()
app_name = re.search(r'#define\s+APP_NAME\s+"([^"]+)"', app_h)
name = toml["name"]
check(
    "app.h's APP_NAME is SoundPlant",
    app_name is not None and app_name.group(1) == "SoundPlant",
)
check(
    "fm1.toml's name is the lower-case APP_NAME",
    app_name is not None and name == app_name.group(1).lower(),
)
check(
    "firmware.json's id and name are fm1.toml's name and APP_NAME",
    hub["id"] == name and app_name is not None and hub["name"] == app_name.group(1),
)
check(
    "the USB names are APP_NAME and 'APP_NAME FM-1', each within the 31 characters the descriptor holds",
    app_name is not None
    and toml["usb_manufacturer"] == app_name.group(1)
    and toml["usb_product"] == app_name.group(1) + " FM-1"
    and len(toml["usb_product"]) <= 31,
)
check("the backup page's file extension is fm1.toml's name", toml["backup_ext"] == name)
check(
    "fm1.toml and firmware.json give the same source, install page and site",
    (toml["repo"], toml["install"], toml["site"])
    == (hub["source"], hub["install"], hub["site"]),
)
check(
    "the screen reader's words URL (app/words.tsv) is under the site",
    f"# url: {toml['site']}words/" in (ROOT / "app/words.tsv").read_text(),
)

# the scripts and docs that name the build's files and the host binary
wrong = []
for rel, text in repo_files():
    if rel.startswith("docs/superpowers/") or rel in ("README.md", SELF):
        continue
    for m in re.finditer(
        r"app/build/([A-Za-z0-9_]+?)(?=[-.][0-9A-Za-z$]*\.?(?:fwsc|bin|elf|rfm1)\b)",
        text,
    ):
        if m.group(1) not in (
            name,
            "rfm1",
            "host",
            "gen",
            "loader",
            "demos",
            "scenarios",
        ):
            wrong.append(f"{rel}: app/build/{m.group(1)}")
    for m in re.finditer(r"app/build/host/([A-Za-z0-9_]+)", text):
        if m.group(1) not in (f"{name}_host", "o2"):
            wrong.append(f"{rel}: app/build/host/{m.group(1)}")
check(
    "the scripts and docs name the package and the host binary after the project",
    not wrong,
)
for w in sorted(set(wrong))[:20]:
    print("   ", w)

sys.exit(1 if bad else 0)
