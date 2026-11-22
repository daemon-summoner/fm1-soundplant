#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The demo projects of the emulator page (the picker in app/web/emu/app.js): each a backup image
(app/build/emu/demos/NAME.soundplant, the page's "restore" command) with the demo in all three project slots, and
demos.json, the list the picker shows. A restore replaces the open project and the other two slots, and the firmware
reloads only the open slot, so every slot holds the demo.

The songs are tools/demos/web/*.xy, played in the host simulator: everything before a script's "tap HOME" is the
project (sounds, patterns, scenes, song); what follows is a performance, left out. They use factory sounds alone, so a
"samples" line or a user sample (u1, u2 ...) in one is an error, and the master and samples lines are dropped (the
page's volume knob is the master; the emulator has no user bank to load). A song must be 150 s or longer, use all
eight tracks, stay under the model's load ceiling and fit three copies in the backup's pool (a slot's share under
66 %).

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
SKIP = ("master ", "samples ")
MIN_SECONDS = 150  # a demo is a full song
LOAD_MAX = 96  # the model's load peak a demo may reach, %
TRACKS = 8

# (id: its script is tools/demos/web/ID.xy, the project's name (12 characters at most), the title the picker shows, blurb)
DEMO_LIST = (
    (
        "house",
        "deep_house",
        "Deep house",
        "A full deep house song in A minor: an electric-piano call, gospel organ stabs, a koto arp, a vocal chop, a withheld drop and a bass that takes the hook. 122 bpm.",
    ),
    (
        "soul",
        "soul_ballad",
        "Soul ballad",
        "A late-night ballad in Eb: a reed-lead hook that sighs in three voices, nylon guitar and electric piano, a deceptive turn, a last chorus a semitone up and a false ending. 72 bpm, swung.",
    ),
    (
        "afterglow",
        "afterglow",
        "Afterglow",
        "A slow, warm D-major song that opens on one lone electric-piano riff, adds a layer at a time, lifts a whole step into E and ends where it began. 88 bpm.",
    ),
    (
        "ambient",
        "ambient",
        "Ambient",
        "A slow, still piece in F Lydian: a glass-bell motif turned over and over, a koto arpeggio running like water, a brief detour to Dbmaj7 and Ebadd9, then home. 64 bpm.",
    ),
    (
        "synthwave",
        "synthwave",
        "Synthwave",
        "A synthwave night drive in F# minor: a toy-keys arp motif, a rolling-octave chorus with a gated snare, and a last chorus lifted two semitones. 108 bpm.",
    ),
    (
        "pop",
        "pop",
        "Pop",
        "A radio pop song in E major: a syncopated pluck earworm, a singable vocal chorus, a half-time bridge with a one-beat stop and a last chorus lifted a semitone. 116 bpm.",
    ),
    (
        "hiphop",
        "boom_bap",
        "Hip hop",
        "Boom bap in D Dorian: a swung Rhodes bed, a horn-stab hook, a walking bass and a cracking break, a beat switch with scratches and a beatless strings bridge. 90 bpm.",
    ),
    (
        "house_909",
        "piano_house",
        "Piano house",
        "A piano house song in Bb major: a 909 kit, a rolling bass, sample-piano chords and tune, a soprano chop, a four-bar switch and a final drop lifted a tone. 126 bpm.",
    ),
    (
        "house_acid",
        "acid_house",
        "Acid house",
        "An acid house song in E Phrygian: a 16-bar 303 solo, organ-stab offbeats, a vocal-chop call and answer, a half-time jack section and throws at the section ends. 124 bpm.",
    ),
    (
        "techno",
        "techno",
        "Techno",
        "A techno song in F minor: a ringing 909 kick, a rolling 303 riff with two slides, a Gb organ stab in 3-3-2 and a tubular-bell counter-melody at the peak. 130 bpm.",
    ),
    (
        "garage",
        "uk_garage",
        "UK garage",
        "UK garage in Bb minor: a swung 2-step kit, a gliding sub, a pitched soprano-chop hook, an offbeat organ skank, a rewind and an 8-bar speed-garage switch. 132 bpm, swung.",
    ),
    (
        "hyperpop",
        "hyperpop",
        "Hyperpop",
        "Hyperpop in G# minor: a glitch verse and a four-bar hook that comes back as a music box, in thirds and slowed to a ballad, with a key-lift drop. 160 bpm.",
    ),
    (
        "jungle",
        "jungle",
        "Jungle",
        "Jungle in G minor: a reese bass riff and a ragga \"oh\" chop over a chopped break, a beatless pad break, steppers and a rewind. 170 bpm.",
    ),
)


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


def script_of(did):
    return DEMOS / "web" / f"{did}.xy"


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


def project_script(demo):
    """(setup lines of the demo: its script's project, without the master and samples lines)"""
    lines = [ln for ln in setup_of(script_of(demo)) if not ln.startswith(SKIP)]
    bad = user_samples(lines)
    if bad:
        raise SystemExit(f"make_demos: {demo}: a user sample is left: {bad[0]}")
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
    bad = [ln for ln in log.splitlines() if ln.startswith(("FAIL", "demo: ", "line ")) or " not saved" in ln]
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
        ["master 4096"]
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
        midi = (rd / "midi_out.txt").read_bytes()
        (render / f"{did}.midi.txt").write_bytes(midi)
        for f in rd.iterdir():
            f.unlink()
        rd.rmdir()
        facts["load"] = logged(rs, r"model load peak (\d+) %")
    short = shortfalls(facts, midi.decode() if render else None)
    if short:
        raise SystemExit(f"make_demos: {did}: {'; '.join(short)} ({summary(did, facts).strip()})")
    return facts


def tracks_sounding(midi):
    """the tracks (1 to 8) with a note-on in a host MIDI log (lines like "291 ms: 92 3A 5C -> USB": status, note, velocity)"""
    return {
        int(m[1], 16) % 16 + 1
        for m in re.finditer(r"ms: (9[0-7]) [0-9A-F]{2} ([0-9A-F]{2})", midi)
        if int(m[2], 16)
    }


def shortfalls(f, midi=None):
    """what keeps a demo from being the full song it must be: under MIN_SECONDS long, over LOAD_MAX in the load model
    (f has a "load" after a render), a track that never sounds (midi, the render's log)"""
    out = []
    seconds = f["bars"] * 4 * 60 / f["bpm"]
    if seconds < MIN_SECONDS:
        out.append(f"{seconds:.0f} s long, under {MIN_SECONDS} s")
    if f.get("load", 0) > LOAD_MAX:
        out.append(f"load peak {f['load']} %, over {LOAD_MAX} %")
    if midi is not None:
        silent = sorted(set(range(1, TRACKS + 1)) - tracks_sounding(midi))
        if silent:
            out.append(f"track(s) {silent} never sound")
    return out


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
        did = song.stem
        render = render or work / "render"
        render.mkdir(parents=True, exist_ok=True)
        lines = [ln for ln in setup_of(song) if not ln.startswith(SKIP)]
        print(summary(did, make_one(did, did[:12], lines, work, None, render)))
        return 0
    out = Path(args[0]).resolve() if args else ROOT / "app" / "build" / "emu" / "demos"
    for d in DEMO_LIST:  # (a demo is a script of factory sounds only: the same check as --check)
        check_script(script_of(d[0]))
    out.mkdir(parents=True, exist_ok=True)
    if render:
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
        for (did, name, genre, blurb), f in zip(DEMO_LIST, made)
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
