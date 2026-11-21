#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The preset list of the emulator page's Preset lab (app/web/emu/presets.js): presets.json, every factory preset in the
firmware's own order (tools/gen_presets.py's recipes: the PRESETS table), so a preset's index is what the firmware's
web_preset takes. The list is checked against the table the build compiled (app/build/gen/presets.h): a list that is not
the firmware's would put another sound under a name.

    tools/make_presets.py [OUT.json]    (default app/build/emu/presets.json; tools/emu_page.py runs it)
"""

import json
import re
import sys
from pathlib import Path

import gen_presets

ROOT = Path(__file__).resolve().parents[1]
TABLE = ROOT / "app" / "build" / "gen" / "presets.h"
# one line for each engine that has presets (docs/MANUAL.md has the engines' sections)
BLURB = {
    "knit": "Subtractive voice with a unison stack: basses, brass, strings, stabs and pads.",
    "rayon": "Two-operator FM in the DX style: e-pianos, bells, mallets and basses.",
    "jacquard": "Wavetables: nine tables, scanned, bent and wobbled.",
    "bellows": "A drawbar organ with a rotating speaker.",
    "cane": "Physical models: plucked and bowed strings, reeds, flutes, bells and drums.",
    "voile": "Voices: vosim, vowels, a choir and a whisper.",
    "sample": "Plays a sample from the bank at the pitch of the note: piano, bass, strings, brass, flute, hits.",
    "slice": "Cuts a loop into slices and plays one slice per note: the four breaks.",
    "acid": "A bass line machine after the TB-303.",
}
MODE_NOTE = {"poly": "", "mono": " (mono)", "legato": " (legato)"}


def compiled_table():
    """(name, engine) of every row of the table the build compiled, in its order"""
    if not TABLE.is_file():
        raise SystemExit(
            f"make_presets: {TABLE.relative_to(ROOT)} is missing (build the firmware first: ./build.sh --web)"
        )
    return re.findall(
        r'^    \{"([^"]*)", \{\[TP_ENGINE\] = EG_(\w+),',
        TABLE.read_text(),
        re.MULTILINE,
    )


def listing():
    ps = gen_presets.load()
    table = compiled_table()
    mine = [(p["name"], p["engine"].upper()) for p in ps]
    if table != mine:
        at = next(
            (i for i, (a, b) in enumerate(zip(table, mine)) if a != b),
            min(len(table), len(mine)),
        )
        raise SystemExit(
            f"make_presets: the recipes (tools/presets/) have {len(mine)} presets and the compiled table "
            f"({TABLE.relative_to(ROOT)}) {len(table)}; they first differ at {at}: build again (./build.sh --web)"
        )
    used = [e for e in gen_presets.lib.ENGINES if any(p["engine"] == e for p in ps)]
    missing = [e for e in used if e not in BLURB]
    stale = [e for e in BLURB if e not in used]
    if missing or stale:
        raise SystemExit(
            f"make_presets: BLURB lacks {missing} and describes engines with no presets: {stale}"
        )
    return {
        "count": len(ps),
        "engines": gen_presets.lib.ENGINES,
        "groups": [
            {"engine": e, "blurb": BLURB[e], "knobs": gen_presets.lib.KNOBS[e]}
            for e in used
        ],
        "presets": [
            {
                "index": i,
                "name": p["name"],
                "engine": p["engine"],
                "role": p["role"],
                "genres": list(p["genres"]),
                "desc": p["role"]
                + MODE_NOTE[p["mode"]]
                + (", for " + ", ".join(p["genres"]) if p["genres"] else ""),
            }
            for i, p in enumerate(ps)
        ],
    }


def main(argv):
    out = (
        Path(argv[0]).resolve()
        if argv
        else ROOT / "app" / "build" / "emu" / "presets.json"
    )
    data = listing()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1) + "\n")
    print(
        f"presets  {data['count']} factory presets in {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: "
        + ", ".join(
            f"{g['engine']} {sum(p['engine'] == g['engine'] for p in data['presets'])}"
            for g in data["groups"]
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
