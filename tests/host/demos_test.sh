#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# The emulator page's demo songs (tools/make_demos.py), as the build makes them: one demo for each song of
# tools/demos/web, its script factory sounds alone (no samples line, no user sample u1, u2 ...), and played through the
# host simulator a full song (150 s or more) in which all eight tracks sound, audible from start to end, not clipped,
# under the load model's ceiling and in a slot's share. The checks are shown to refuse what they are there for: a
# short song, a silent track, a load over the ceiling (tools/demos/stress.xy), a project too big for the pool, a
# sound the firmware's rule keeps out of the built-in songs. tools/make_demos.py --check refuses a script that names a
# user sample (the private-bank songs of tools/demos are such scripts). The songs the firmware carries
# (tools/make_demo_songs.py) are checked against app/builtin_songs.h. Needs the host simulator (./build.sh --host).
#   tests/host/demos_test.sh
set -eu
cd "$(dirname "$0")/../.."
PY="${PYTHON:-python3}"
D=build/host/demos
rm -rf "$D" && mkdir -p "$D"
"$PY" tools/make_demos.py --jobs 4 --work "$D/work" --render "$D/wav" "$D/out" > "$D/make.log" 2>&1 || { tail -8 "$D/make.log"; exit 1; }
"$PY" - "$D" <<'PYEOF'
import array
import json
import math
import re
import sys
import wave
from pathlib import Path

sys.path.insert(0, "tools")
import make_demos  # noqa: E402

D = Path(sys.argv[1])
bad = 0


def check(what, ok):
    global bad
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    bad += not ok


def problems(path, seconds):
    """what is wrong with a render of a song that lasts `seconds`: too short, clipped, quiet, or a silent stretch"""
    w = wave.open(str(path))
    ch, rate = w.getnchannels(), w.getframerate()
    if w.getsampwidth() != 2:
        return ["not 16-bit"]
    pcm = array.array("h")
    pcm.frombytes(w.readframes(w.getnframes()))
    out = []
    if len(pcm) / ch / rate < seconds:
        out.append(f"{len(pcm) / ch / rate:.1f} s of the song's {seconds:.1f}")
    if any(x >= 32767 or x <= -32768 for x in pcm):
        out.append("a sample at full scale")
    if max(max(pcm), -min(pcm)) < 3000:
        out.append(f"quiet: peak {max(max(pcm), -min(pcm))}")
    win = rate * ch

    def rms(i):
        part = pcm[i : i + win : 4]
        return math.sqrt(sum(x * x for x in part) / len(part)) if part else 0

    quiet = [i // win for i in range(0, int(seconds) * win, win) if rms(i) < 150]
    if quiet:
        out.append(f"silent in second(s) {quiet[:5]}")
    return out


demos = json.loads((D / "out" / "demos.json").read_text())
web = {p.stem for p in Path("tools/demos/web").glob("*.xy")}
check(f"{len(demos)} demos, one for each of the {len(web)} songs of tools/demos/web", len(demos) == len(web) and {d["id"] for d in demos} == web)
facts = {
    m[1]: (int(m[2]), int(m[3]))
    for m in re.finditer(r"^  (\w+): \d+ bars at \d+ bpm, load peak (\d+) %, (\d+) % of a slot$", (D / "make.log").read_text(), re.M)
}
for d in demos:
    setup = [ln.strip() for ln in (D / "work" / f"{d['id']}.setup.xy").read_text().splitlines()]
    code = [ln for ln in setup if ln and not ln.startswith("#")]
    user = [ln for ln in code if ln.startswith("samples") or re.search(r"\bu\d+\b", ln)]
    bpm = [ln.split()[1] for ln in code if ln.startswith("bpm ")]
    check(f"{d['id']}: the script names no sample bank and no user sample {user[:1]}", code and not user and bpm == [str(d["bpm"])])
    seconds = d["bars"] * 4 * 60 / d["bpm"]
    p = problems(D / "wav" / f"{d['id']}.wav", seconds)
    check(f"{d['id']}: {d['bars']} bars at {d['bpm']} bpm played through: audible, no clipping {p}", not p)
    silent = sorted(set(range(1, make_demos.TRACKS + 1)) - make_demos.tracks_sounding((D / "wav" / f"{d['id']}.midi.txt").read_text()))
    load, mem = facts.get(d["id"], (999, 999))
    check(
        f"{d['id']}: {seconds:.0f} s, all eight tracks sound {silent}, load peak {load} %, {mem} % of a slot",
        seconds >= make_demos.MIN_SECONDS and not silent and load <= make_demos.LOAD_MAX and mem < make_demos.MEM_MAX,
    )

# the song checks must fail on what they are there for
eight = "".join(f"{100 * k} ms: 9{k - 1} 3C 64 -> USB\n" for k in range(1, 9))
check("a log with a note on each of the eight tracks has none silent", make_demos.tracks_sounding(eight) == set(range(1, 9)))
check("a track with only a note-off (velocity 0) or a note on another channel is silent", make_demos.tracks_sounding("5 ms: 92 3C 00 -> USB\n6 ms: 9A 3C 64 -> USB\n") == set())
check("a song of 32 bars at 130 bpm is refused as too short", any("under" in x for x in make_demos.shortfalls({"bars": 32, "bpm": 130})))
check("a song whose load peaks over the ceiling is refused", any("load" in x for x in make_demos.shortfalls({"bars": 104, "bpm": 126, "load": make_demos.LOAD_MAX + 1}, eight)))
no7 = "".join(ln for ln in eight.splitlines(True) if ": 96 " not in ln)
check("a log without track 7 is refused", any("[7]" in x for x in make_demos.shortfalls({"bars": 104, "bpm": 126, "load": 80}, no7)))
check("a full song at the ceiling is accepted", not make_demos.shortfalls({"bars": 104, "bpm": 126, "load": make_demos.LOAD_MAX}, eight))

# the audio check itself must fail on what it is there for
for name, frames in (
    ("silence", [0] * 2 * 44100 * 4),
    ("a clipped square wave", [32767, -32768] * 44100 * 2),
    ("a song that stops early", [8000, -8000] * 44100),
):
    f = D / "synthetic.wav"
    with wave.open(str(f), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(array.array("h", frames).tobytes())
    check(f"the audio check refuses {name}", bool(problems(f, 4.0)))
f = D / "synthetic.wav"
with wave.open(str(f), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(44100)
    w.writeframes(array.array("h", [int(9000 * math.sin(i / 20)) for i in range(2 * 44100 * 4)]).tobytes())
check("... and accepts a steady tone that lasts the song", not problems(f, 4.0))
sys.exit(1 if bad else 0)
PYEOF
# --check: the factory-sound scripts pass; a samples line, a user sample in a knob or in a lock, and the private-bank songs are refused
"$PY" tools/make_demos.py --check tools/demos/web/*.xy > "$D/check_ok.log" 2>&1 || { cat "$D/check_ok.log"; echo "  FAIL --check refused a script of factory sounds"; exit 1; }
echo "  ok   --check passes the songs written for the web"
printf 'bpm 120\nsamples bank.bin\n' > "$D/bank.xy"
printf 'bpm 120\nknob 3 e1 u2\n' > "$D/knob.xy"
printf 'bpm 120\nlock 1 1 1 e1 u1\n' > "$D/lock.xy"
for f in "$D/bank.xy" "$D/knob.xy" "$D/lock.xy" tools/demos/hiphop.xy; do
    if "$PY" tools/make_demos.py --check "$f" > "$D/check.log" 2>&1; then echo "  FAIL --check passed $f"; exit 1; fi
    grep -q "uses a user sample" "$D/check.log" || { cat "$D/check.log"; echo "  FAIL --check refused $f for another reason"; exit 1; }
    echo "  ok   --check refuses $f"
done
# the load ceiling and the size cap, on real projects: the worst case a song can ask for, and a project of four tracks of
# random notes (a share of a slot over the cap: random notes do not pack)
if "$PY" tools/make_demos.py --song tools/demos/stress.xy --work "$D/stress" > "$D/stress.log" 2>&1; then echo "  FAIL the load ceiling passed tools/demos/stress.xy"; exit 1; fi
grep -q "load peak [0-9]* %, over" "$D/stress.log" || { cat "$D/stress.log"; echo "  FAIL tools/demos/stress.xy was refused for another reason"; exit 1; }
echo "  ok   the load ceiling refuses tools/demos/stress.xy"
"$PY" - "$D/big.xy" <<'PYEOF'
import random
import sys

r = random.Random(7)
lines = ["bpm 120"]
for t in range(2, 6):
    for p in range(1, 9):
        lines.append(f"pat {t} {p} 64 1 100 0")
        lines += [f"notes {t} {p} {s} 1 {r.randint(1, 127)} " + " ".join(str(r.randint(24, 96)) for _ in range(4)) for s in range(1, 65)]
open(sys.argv[1], "w").write("\n".join(lines + ["song 1:8", "tap HOME"]) + "\n")
PYEOF
if "$PY" tools/make_demos.py --song "$D/big.xy" --work "$D/bigwork" > "$D/big.log" 2>&1; then echo "  FAIL a project over the slot cap was accepted"; exit 1; fi
grep -q "expect mem" "$D/big.log" || { cat "$D/big.log"; echo "  FAIL the big project was refused for another reason"; exit 1; }
echo "  ok   a project over the slot cap is refused (expect mem)"
# the firmware's rule for its built-in songs, as the simulator's demorule says it: house keeps it; hyperpop (a jacquard
# wavetable lead), a kit key on the sample model (10) and one on a 909 cymbal (26 to 29) do not
HOST=app/build/host/soundplant_host
rule() { printf '%s\n' "$@" > "$D/rule.xy"; "$HOST" "$D/rule.xy" "$D" > "$D/rule.log" 2>&1; }
rule "restore $PWD/$D/out/house.soundplant" "wait 100" "demorule" || { cat "$D/rule.log"; echo "  FAIL demorule refused house"; exit 1; }
echo "  ok   house keeps the firmware's rule"
rule "restore $PWD/$D/out/hyperpop.soundplant" "wait 100" "demorule" && { echo "  FAIL demorule passed hyperpop (jacquard)"; exit 1; }
grep -q "demorule: " "$D/rule.log" || { cat "$D/rule.log"; echo "  FAIL hyperpop was refused for another reason"; exit 1; }
echo "  ok   hyperpop breaks it: $(grep 'demorule: ' "$D/rule.log" | head -1)"
for m in 10 26 29; do
    rule "restore $PWD/$D/out/house.soundplant" "wait 100" "param 1 d1.model $m" "demorule" && { echo "  FAIL demorule passed a kit key on model $m"; exit 1; }
    grep -q "demorule: track 1 key 1 uses the model" "$D/rule.log" || { cat "$D/rule.log"; echo "  FAIL model $m was refused for another reason"; exit 1; }
done
echo "  ok   a kit key on the sample model or a 909 cymbal breaks it: $(grep 'demorule: ' "$D/rule.log" | head -1)"
"$PY" tools/make_demo_songs.py --from "$D/out" --check || { echo "  FAIL app/builtin_songs.h is not what tools/make_demo_songs.py makes"; exit 1; }
echo "  ok   app/builtin_songs.h holds the built-in songs"
