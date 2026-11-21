#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# The emulator page's demo songs (tools/make_demos.py), as the build makes them: every demo's generated script is
# factory sounds alone (no samples line, no user sample u1, u2 ...), and played through the host simulator its song is
# audible from start to end and does not clip. tools/make_demos.py --check refuses a script that names a user sample
# (the nine tools/demos songs made with private banks are such scripts). Needs the host simulator (./build.sh --host).
#   tests/host/demos_test.sh
set -eu
cd "$(dirname "$0")/../.."
PY="${PYTHON:-python3}"
D=build/host/demos
rm -rf "$D" && mkdir -p "$D"
"$PY" tools/make_demos.py --work "$D/work" --render "$D/wav" "$D/out" > "$D/make.log" 2>&1 || { tail -8 "$D/make.log"; exit 1; }
"$PY" - "$D" <<'PYEOF'
import array
import json
import math
import re
import sys
import wave
from pathlib import Path

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
check(f"{len(demos)} demos, the two written for the web among them", len(demos) >= 10 and {"techno", "synthwave"} <= {d["id"] for d in demos})
for d in demos:
    setup = [ln.strip() for ln in (D / "work" / f"{d['id']}.setup.xy").read_text().splitlines()]
    code = [ln for ln in setup if ln and not ln.startswith("#")]
    user = [ln for ln in code if ln.startswith("samples") or re.search(r"\bu\d+\b", ln)]
    bpm = [ln.split()[1] for ln in code if ln.startswith("bpm ")]
    check(f"{d['id']}: the script names no sample bank and no user sample {user[:1]}", code and not user and bpm == [str(d["bpm"])])
    seconds = d["bars"] * 4 * 60 / d["bpm"]
    p = problems(D / "wav" / f"{d['id']}.wav", seconds)
    check(f"{d['id']}: {d['bars']} bars at {d['bpm']} bpm played through: audible, no clipping {p}", not p)

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
