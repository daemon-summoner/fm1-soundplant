#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The demo projects of the emulator page (the picker in app/web/emu/app.js): each a backup image
(app/build/emu/demos/NAME.soundplant, the page's "restore" command) with the demo in all three project slots, and
demos.json, the list the picker shows. A restore replaces the open project and the other two slots, and the firmware
reloads only the open slot, so every slot holds the demo.

The songs are tools/demos/*.xy, played in the host simulator: everything before a script's "tap HOME" is the project
(sounds, patterns, scenes, song); what follows is a performance, left out. Those eight were made with private sample
banks (a sung bar, a break, a 808, a vocal "hey"), which must never be published, so they are built here with
factory sounds in their place: SWAPS names, per demo and track, the sample (the breaks come with the emulator) and how
far the track's notes move so that it still plays the right slice or pitch. The master and samples lines are dropped (the
page's volume knob is the master; the emulator has no user bank to load). The songs written for the web, tools/demos/web/,
use factory sounds alone and are checked as strictly: a "samples" line or a user sample (u1, u2 ...) in one is an error.

    tools/make_demos.py [OUT_DIR]       images and demos.json into OUT_DIR (default app/build/emu/demos); the host
                                        simulator is built first (./build.sh --host) when it is missing or older
                                        than the app
    tools/make_demos.py --render DIR    also each demo's song played through the host into DIR/NAME.wav (a break pack
                                        in the bank for the breaks, as the emulator has them built in), the MIDI it sent
                                        in DIR/NAME.midi.txt, and the model's load peak and the project's share of a
                                        slot printed
    tools/make_demos.py --song FILE     one script on its own, as a song being written: its render, MIDI log, load and
                                        size (into --render, default WORK/render); no images, no demos.json
    tools/make_demos.py --check FILE..  the scripts must have no user sample: the error otherwise (exit 1)
    --work DIR                          where the setup scripts, logs and renders go (default app/build/demos)
    --jobs N                            N demos at a time (default 1)
"""

import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMOS = ROOT / "tools" / "demos"
HOST = ROOT / "app" / "build" / "host" / "soundplant_host"
BREAKS = ROOT / "build" / "gen" / "breaks.bin"
SKIP = ("master ", "samples ")
BREAK_NAMES = ("classic", "heat", "choke", "ecstasy")
SLICE_ROOT = (
    53  # the note of a break's first slice (the scripts' notes 53..68 are its sixteen)
)
NOTES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# (id, the project's name (12 characters at most), genre, blurb, script, SWAPS)
# SWAPS: {track: (factory sample, notes moved)}. The slice tracks move by the sample's root over the break's 53 (the
# slice a note picks is (note - root) mod 16); the pitched tracks by what makes the factory sample sound the song's pitch.
# The kick's tone is about G1 under its declared root C4, so a kick played as a bass sits 29 semitones up.
DEMO_LIST = (
    (
        "ambient",
        "ambient",
        "Ambient",
        "Slow pads and bells, a long hall, no drums. 64 bpm.",
        "ambient.xy",
        {},
    ),
    (
        "soul",
        "soul_ballad",
        "Soul ballad",
        "A late-night ballad in Eb: a reed-lead hook that sighs in three voices, nylon guitar and electric piano, a deceptive turn, a last chorus a semitone up and a false ending. 72 bpm, swung.",
        "web/soul.xy",
        {},
    ),
    (
        "hiphop",
        "boom_bap",
        "Hip hop",
        "Boom bap: a crushed break, a horn stab on each chord, a scratched voice. 90 bpm, swung.",
        "hiphop.xy",
        {1: ("heat", 0), 5: ("brass", 0)},
    ),
    (
        "pop",
        "pop",
        "Pop",
        "A bright pop song in C: a flute hook over a clean kit, piano and a wide pad. 110 bpm.",
        "pop.xy",
        {4: ("strings", 7), 5: ("flute", 0)},
    ),
    (
        "house",
        "deep_house",
        "Deep house",
        "A full deep house song in A minor: an electric-piano call, gospel organ stabs, a koto arp, a vocal chop, a withheld drop and a bass that takes the hook. 122 bpm.",
        "web/house.xy",
        {},
    ),
    (
        "house_acid",
        "acid_house",
        "Acid house",
        "The deep house with a 303 line, slides and accents, and a 909 kick and clap. 122 bpm.",
        "house_acid.xy",
        {5: ("classic", 0), 6: ("brass", 0)},
    ),
    (
        "house_909",
        "house_909",
        "House",
        "The acid house with the 909's hats and cymbals too. 122 bpm.",
        "house_909.xy",
        {5: ("classic", 0), 6: ("brass", 0)},
    ),
    (
        "garage",
        "uk_garage",
        "UK garage",
        "The 2-step: a shuffled kit, a bouncing bass that glides, organ stabs, chopped flute. 132 bpm, swung.",
        "garage.xy",
        {4: ("flute", 19), 5: ("ecstasy", 0)},
    ),
    (
        "hyperpop",
        "hyperpop",
        "Hyperpop",
        "Fast, bright and loud: a kick bass that slides, a crushed flute chop, a toy lead through an arp. 160 bpm.",
        "hyperpop.xy",
        {2: ("kick", 29), 4: ("strings", 7)},
    ),
    (
        "jungle",
        "jungle",
        "Jungle",
        "Two chopped breaks over a rolling sub bass and pads, 90s style. 170 bpm.",
        "jungle.xy",
        {1: ("classic", 0), 6: ("heat", 0)},
    ),
    (
        "techno",
        "techno",
        "Techno",
        "A hard 909 kick, a rolling acid line with slides, minor stabs and a dark pad, a riser into the drop. 130 bpm.",
        "web/techno.xy",
        {},
    ),
    (
        "synthwave",
        "synthwave",
        "Synthwave",
        "A retro night drive: an FM bass in eighths, a big snare in the hall, a lead over a plucked arpeggio and a wide pad. 108 bpm.",
        "web/synthwave.xy",
        {},
    ),
)
# {demo id: {track: level}}: a track's level where the substitute sounds too loud or too soft
LEVELS = {"hiphop": {5: 124}, "jungle": {1: 122}}


def note_number(tok):
    """a note as the host reads it (C4 = 60, F#3, Bb2) or a number, as a number"""
    if tok.lstrip("-").isdigit():
        return int(tok)
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)", tok)
    if not m:
        raise SystemExit(f"make_demos: not a note: {tok}")
    n = NOTES[m[1].upper()] + {"#": 1, "b": -1, "": 0}[m[2]] + 12 * (int(m[3]) + 1)
    return n


def user_samples(lines):
    """the lines that name a user sample: a samples line, or a u1 ... in a knob or a lock"""
    return [
        ln
        for ln in lines
        if ln.startswith("samples ")
        or (ln.startswith(("knob ", "lock ")) and re.search(r"\bu\d+\b", ln))
    ]


def check_script(path):
    bad = user_samples([ln.strip() for ln in Path(path).read_text().splitlines()])
    if bad:
        raise SystemExit(
            f"make_demos: {path} uses a user sample (the web demos use the factory sounds only): {bad[0]}"
        )


def setup_of(script):
    """a script's lines before its "tap HOME": the project, without comments"""
    lines = script.read_text().splitlines()
    k = next((i for i, ln in enumerate(lines) if ln.strip() == "tap HOME"), None)
    if k is None:
        raise SystemExit(
            f'make_demos: {script} has no "tap HOME" (where its setup ends)'
        )
    return [
        ln.strip() for ln in lines[:k] if ln.strip() and not ln.lstrip().startswith("#")
    ]


def replace_sample(lines, demo, track, sample, shift):
    want = re.compile(rf"knob {track} e1 u\d+")
    at = [i for i, ln in enumerate(lines) if want.fullmatch(ln)]
    if len(at) != 1:
        raise SystemExit(
            f"make_demos: {demo}: track {track} has {len(at)} user sample lines, not one"
        )
    lines[at[0]] = f"knob {track} e1 {sample}"
    if shift:
        for i, ln in enumerate(lines):
            w = ln.split()
            if w[0] == "notes" and w[1] == str(track):
                lines[i] = " ".join(
                    w[:6] + [str(note_number(t) + shift) for t in w[6:]]
                )
                if any(note_number(t) > 127 for t in lines[i].split()[6:]):
                    raise SystemExit(
                        f"make_demos: {demo}: {ln}: moved by {shift} beyond the top note"
                    )


def set_level(lines, demo, track, level):
    at = [i for i, ln in enumerate(lines) if ln.startswith(f"knob {track} level ")]
    if len(at) != 1:
        raise SystemExit(
            f"make_demos: {demo}: track {track} has {len(at)} level lines, not one"
        )
    lines[at[0]] = f"knob {track} level {level}"


def project_script(demo):
    """(setup lines of the demo, with factory sounds only)"""
    did, _, _, _, script, swaps = next(d for d in DEMO_LIST if d[0] == demo)
    path = DEMOS / script
    lines = [ln for ln in setup_of(path) if not ln.startswith(SKIP)]
    for track, (sample, shift) in swaps.items():
        replace_sample(lines, did, track, sample, shift)
    for track, level in LEVELS.get(did, {}).items():
        set_level(lines, did, track, level)
    bad = user_samples(lines)
    if bad:
        raise SystemExit(f"make_demos: {did}: a user sample is left: {bad[0]}")
    return lines


def bpm_of(lines):
    b = [ln.split()[1] for ln in lines if ln.startswith("bpm ")]
    if len(b) != 1 or not b[0].isdigit():
        raise SystemExit("make_demos: a demo needs one 'bpm N' line")
    return int(b[0])


def song_bars(lines):
    s = [ln for ln in lines if ln.startswith("song ")]
    if len(s) != 1:
        raise SystemExit("make_demos: a demo needs one 'song' line")
    return sum(int(p.split(":")[1]) for p in s[0].split()[1:])


def host_stale():
    if not HOST.exists():
        return True
    built = HOST.stat().st_mtime
    skip = {"build", "web", "samples"}
    for top in (
        ROOT / "app",
        ROOT / "base" / "host",
        ROOT / "base" / "include",
        ROOT / "base" / "lib",
        ROOT / "base" / "device",
    ):
        for p in top.rglob("*"):
            if (
                p.is_file()
                and not (skip & set(p.relative_to(ROOT).parts))
                and p.stat().st_mtime > built
            ):
                return True
    return False


def ensure_host():
    """the host simulator, built from the app as it is: its backup image is what the emulator's firmware reads back"""
    if not host_stale():
        return
    print("make_demos: building the host simulator (build.sh --host)")
    r = subprocess.run(["sh", str(ROOT / "build.sh"), "--host"], cwd=ROOT, check=False)
    if r.returncode or not HOST.exists():
        raise SystemExit(
            "make_demos: the host simulator did not build (./build.sh --host)"
        )


def ensure_breaks():
    if not BREAKS.exists():
        BREAKS.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "soundplant_samples.py"),
                "build",
                "--no-factory",
                str(BREAKS),
                "breaks",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if r.returncode:
            raise SystemExit(
                f"make_demos: the break pack did not build: {r.stdout}{r.stderr}"
            )


def run_host(script, out, what):
    out.mkdir(parents=True, exist_ok=True)  # (the host does not make its directory)
    r = subprocess.run(
        [str(HOST), str(script), str(out)],
        capture_output=True,
        text=True,
        env={"SOUNDPLANT_LOAD": "0", "PATH": "/usr/bin:/bin"},
        check=False,
    )  # (0 % load: the same render every time)
    log = r.stdout + r.stderr
    script.with_suffix(".log").write_text(log)
    bad = [ln for ln in log.splitlines() if ln.startswith(("FAIL", "demo: ", "line "))]
    if r.returncode or bad:
        raise SystemExit(
            f"make_demos: {what}: the host simulator failed (rc {r.returncode}): {bad[:3]} (see {script.with_suffix('.log')})"
        )


MEM_MAX = 66  # a slot's share, %: three copies must fit the 20-sector pool (the store's 3 x 7 objects)


def backup_script(name, lines):
    out = list(lines)
    for slot in (1, 2, 3):
        out += [f"projsave {slot} {name}", "wait 200"]
    return out + [f"expect mem <{MEM_MAX}", f"backup out:{name}.soundplant"]


def render_script(lines, bars):
    """the demo played from the Song page, as a player starts it (HOME, SELECT, PLAY), to a WAV; the volume knob full"""
    return (
        ["master 4096", f"samples {BREAKS}"]
        + lines
        + [
            "tap HOME",
            "turn SELECT 1",
            "stats reset",
            "wav demo.wav",
            "tap PLAY",
            f"bars {bars}",
            "wait 2500",
            "wavstop",
            "stats",
        ]
    )


def logged(script, pattern):
    """the first number a host log line of the script's run has, by pattern (one group)"""
    m = re.search(pattern, script.with_suffix(".log").read_text())
    if not m:
        raise SystemExit(f"make_demos: {script.with_suffix('.log')} has no line like {pattern}")
    return int(m[1])


def make_one(did, name, lines, work, out, render):
    """one demo: its project's backup image (into out, unless None), and with render its WAV, MIDI log and load;
    the facts a song's author watches (bpm, bars, the load peak, the share of a slot)"""
    bpm, bars = bpm_of(lines), song_bars(lines)
    (work / f"{did}.setup.xy").write_text("\n".join(lines) + "\n")
    bs = work / f"{did}.backup.xy"
    bs.write_text("\n".join(backup_script(name, lines)) + "\n")
    wd = work / did
    run_host(bs, wd, f"{did}'s image")
    image = wd / f"{name}.soundplant"
    if not image.exists():
        raise SystemExit(f"make_demos: {did}: the host wrote no image")
    if out:
        (out / f"{did}.soundplant").write_bytes(image.read_bytes())
    facts = {"bpm": bpm, "bars": bars, "mem": logged(bs, r"ok mem == (\d+)")}
    if render:
        rs = work / f"{did}.render.xy"
        rs.write_text("\n".join(render_script(lines, bars)) + "\n")
        rd = render / did
        run_host(rs, rd, f"{did}'s render")
        (render / f"{did}.wav").write_bytes((rd / "demo.wav").read_bytes())
        (render / f"{did}.midi.txt").write_bytes((rd / "midi_out.txt").read_bytes())
        for f in rd.iterdir():
            f.unlink()
        rd.rmdir()
        facts["load"] = logged(rs, r"model load peak (\d+) %")
    return facts


def summary(did, f):
    load = f" load peak {f['load']} %," if "load" in f else ""
    return f"  {did}: {f['bars']} bars at {f['bpm']} bpm,{load} {f['mem']} % of a slot"


def flag_path(args, flag):
    """--FLAG VALUE taken out of args as a path, or None when the flag is not there"""
    if flag not in args:
        return None
    i = args.index(flag)
    if i + 1 >= len(args):
        raise SystemExit(f"make_demos: {flag} needs a path")
    val = Path(args[i + 1]).resolve()
    del args[i : i + 2]
    return val


def main(argv):
    args = list(argv)
    work = flag_path(args, "--work") or ROOT / "app" / "build" / "demos"
    render = flag_path(args, "--render")
    song = flag_path(args, "--song")
    jobs = 1
    if "--jobs" in args:
        i = args.index("--jobs")
        if i + 1 >= len(args) or not args[i + 1].isdigit() or int(args[i + 1]) < 1:
            raise SystemExit("make_demos: --jobs needs a number of 1 or more")
        jobs = int(args[i + 1])
        del args[i : i + 2]
    if args[:1] == ["--check"]:
        if len(args) < 2:
            raise SystemExit("make_demos: --check needs scripts")
        for f in args[1:]:
            check_script(f)
        print(f"make_demos: {len(args) - 1} scripts, no user sample")
        return 0
    ensure_host()
    work.mkdir(parents=True, exist_ok=True)
    if song:
        check_script(song)
        ensure_breaks()
        did = song.stem
        render = render or work / "render"
        render.mkdir(parents=True, exist_ok=True)
        lines = [ln for ln in setup_of(song) if not ln.startswith(SKIP)]
        print(summary(did, make_one(did, did[:12], lines, work, None, render)))
        return 0
    out = Path(args[0]).resolve() if args else ROOT / "app" / "build" / "emu" / "demos"
    for d in (
        DEMO_LIST
    ):  # (a web demo is a script of factory sounds only: the same check as --check)
        if d[4].startswith("web/"):
            check_script(DEMOS / d[4])
    out.mkdir(parents=True, exist_ok=True)
    if render:
        ensure_breaks()
        render.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(jobs) as pool:
        made = list(
            pool.map(
                lambda d: make_one(d[0], d[1], project_script(d[0]), work, out, render),
                DEMO_LIST,
            )
        )
    listing = [
        {
            "id": did,
            "genre": genre,
            "project": name,
            "bpm": f["bpm"],
            "bars": f["bars"],
            "blurb": blurb,
            "file": f"{did}.soundplant",
        }
        for (did, name, genre, blurb, _, _), f in zip(DEMO_LIST, made)
    ]
    (out / "demos.json").write_text(json.dumps(listing, indent=1) + "\n")
    if render:
        for d, f in zip(DEMO_LIST, made):
            print(summary(d[0], f))
    print(
        f"demos    {len(listing)} projects in {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}: {', '.join(d['id'] for d in listing)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
