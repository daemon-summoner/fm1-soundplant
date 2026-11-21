#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# SoundPlant's tests: the units' own (the synth, the Braids engines, the drumline, the FX, the sequencer: tests/host/*_test.sh; the DSP's
# fingerprints when a reference was saved: tests/host/dsp_hash.sh save), the user sample bank's tool, the update path
# against SoundPlant's package (./build.sh first), the whole app in fm1-base's simulator (tests/scenarios/*.xy: UI,
# patterns, persistence, backup and restore; screenshots and audio in app/build/scenarios/, the layout audit), and
# the browser build. Silent: the audio is written to WAV files, never played. fm1-base's own tests (the platform,
# storage, backup and restore, the installer): base/tests/run_tests.sh.
#   tests/run_tests.sh
set -u
cd "$(dirname "$0")/.."
CC="${CC:-cc}"
PY="${PYTHON:-python3}"
export AC79_SDK="${AC79_SDK:-$HOME/fw-AC79_AIoT_SDK}"   # the package's SDK files, as ./build.sh
B=app/build
OUT=$B/tests
FAIL=0
mkdir -p "$OUT" $B/scenarios build/gen
run() {
    name="$1"; shift
    if "$@" > "$OUT/$name.log" 2>&1; then
        echo "  ok   $name"
    else
        echo "  FAIL $name (see $OUT/$name.log)"
        tail -15 "$OUT/$name.log" | sed 's/^/       /'
        FAIL=1
    fi
}
# node 26 can deadlock in process.exit when a Maglev compile job is mid-flight (the main thread joins the worker, the
# worker waits for the main thread to collect garbage): the node tests run without Maglev where node knows the flag
NODE=node; node --no-maglev -e 0 >/dev/null 2>&1 && NODE="node --no-maglev"
# the factory samples as WAVs, and a user bank from two of them (one at 16 kHz), as tools/soundplant_samples.py would
# upload it: its image (tests/scenarios/samples.xy and slice.xy load it) and its SysEx frames (upload.xy plays them
# through samples.c); the bank tool's own tests (layout over the windows, rates, bounds)
"$PY" tools/gen_samples.py build/gen/samples.h build/gen/wav >/dev/null
# the break pack (the four breaks, out of the image since 0.7): the DSP tests' user bank (tests/host/breaks.h)
"$PY" tools/soundplant_samples.py build --no-factory build/gen/breaks.bin breaks >/dev/null
run sample-bank sh -c "'$PY' tools/soundplant_samples.py build build/gen/user_bank.bin 'piano two=build/gen/wav/piano.wav:60%16k' \
    'sweep two=build/gen/wav/sweep.wav:57' && '$PY' tools/soundplant_samples.py syx build/gen/user_bank.syx \
    'piano two=build/gen/wav/piano.wav:60%16k' 'sweep two=build/gen/wav/sweep.wav:57'"
run bank-tool "$PY" tests/host/bank_test.py
run project-name "$PY" tests/host/name_test.py
# the README's art against tools/make_readme_art.py, and its links and credit
run readme "$PY" tests/host/readme_test.py
# the units' own tests, written beside them (their WAVs in build/host/)
for t in synth braids drumline fx seq factory gfx garden; do
    run "$t" sh "tests/host/${t}_test.sh"
done
if command -v node >/dev/null 2>&1; then           # the samples page's bank against soundplant_samples.py's
    run samples-web $NODE tests/host/samples_web.mjs "$PY"
    # the backup page's sample section (app/web/backup/extras.js) against a simulated FM-1 and the command line
    run backup-web $NODE tests/host/backup_web.mjs "$PY"
    # the installer's steps (app/web/install_app.js: SoundPlant's sounds into the bank) against a simulated FM-1
    run install-web $NODE tests/host/install_web.mjs "$PY"
else
    echo "  skip samples-web (no node)"
fi
if [ -f build/host/dsp_hash.ref ]; then
    run dsp-hash sh tests/host/dsp_hash.sh
else
    echo "  skip dsp-hash (no reference: tests/host/dsp_hash.sh save, before a change)"
fi
# the update path, against SoundPlant's package (fm1-base's tests; ./build.sh first)
if [ -f $B/soundplant.fwsc ]; then
    run ota-entry sh -c "$CC -w -o $OUT/ota_test base/tests/ota_test.c && $OUT/ota_test $B/soundplant.fwsc"
    run update-loader sh -c "head -c 200000 $B/soundplant.bin > $OUT/old_app.bin && \
        $PY base/tools/fm1pkg_make.py $OUT/old_app.bin $B/loader/ota.bin $OUT/old.fwsc >/dev/null && \
        $CC -w -o $OUT/ldr_test base/tests/ldr_test.c && $OUT/ldr_test $OUT/old.fwsc $B/soundplant.fwsc"
else
    echo "  skip update path (no $B/soundplant.fwsc: ./build.sh)"
fi
run host-build sh build.sh --host
run lookahead sh tests/host/lookahead_test.sh    # (needs the simulator just built)
# the emulator page's demo songs: factory sounds alone, audible all the way, no clipping; --check refuses a user sample
run demos sh tests/host/demos_test.sh    # (needs the simulator just built)
# a bank image larger than the bank's windows is refused by the simulator's loader (as the tool and the FM-1 refuse it)
run bank-too-big sh -c "mkdir -p $OUT/big && head -c 221185 /dev/zero > $OUT/big.bin && \
    printf 'samples $OUT/big.bin\n' > $OUT/big.xy && ! $B/host/soundplant_host $OUT/big.xy $OUT/big > $OUT/big.out 2>&1 && \
    grep -q 'larger than' $OUT/big.out"
if command -v node >/dev/null 2>&1; then   # the night garden's logic (app/web/emu/garden_core.js), no browser or build needed
    run garden-core $NODE tests/host/garden_core.mjs
else
    echo "  skip garden-core (no node)"
fi
if command -v node >/dev/null 2>&1; then   # the project editor's codec (app/web/project/) against the simulator host-build made
    run project-web $NODE tests/host/project_web.mjs "$PY"
else
    echo "  skip project-web (no node)"
fi
if command -v emcc >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then   # the browser build, when it can be built
    run emu sh -c "sh build.sh --web >/dev/null && $NODE tests/host/emu_test.mjs $B/emu/app.wasm"
    # fm1-base's page with SoundPlant's bits, its worklet with the part resample (in time at 48 kHz)
    run emu-page $NODE tests/host/emu_page_test.mjs $B/emu
    # the site made around it (tools/make_pages.py, before the first release): its sections, its links, its emulator
    run site "$PY" tests/host/site_test.py
else
    echo "  skip emu (no emcc or node)"
fi
for s in tests/scenarios/*.xy; do
    n=$(basename "$s" .xy)
    rm -rf "$B/scenarios/$n" && mkdir -p "$B/scenarios/$n"
    run "scenario-$n" $B/host/soundplant_host "$s" "$B/scenarios/$n"
done
# the USB audio input's ten channels as usbtracks.xy recorded them: the tracks in their own, at their level, before their pan
run usb-channels "$PY" tests/usbtracks_check.py "$B/scenarios/usbtracks"
# struck steps as hop.xy filmed them: a played cell hops and rings back, an empty cell and a still screen do not move
run hop-cells "$PY" tests/hop_check.py "$B/scenarios/hop"
run strip-tabs "$PY" tests/strip_check.py "$B/scenarios/strip"
# the Master page's scope as scope.xy filmed it: it moves while a song plays, and holds when nothing sounds or under still
run scope-plot "$PY" tests/scope_check.py "$B/scenarios/scope"
# every page, engine and type, through the layout audit (tools/layout_sweep.py)
"$PY" tools/layout_sweep.py build/gen/layout_sweep.xy
rm -rf "$B/scenarios/layout_sweep" && mkdir -p "$B/scenarios/layout_sweep"
run layout-sweep $B/host/soundplant_host build/gen/layout_sweep.xy "$B/scenarios/layout_sweep"
# the same in large type (Setup > SEL > LARGE TYPE: its faces from the resource region, built in here)
"$PY" -c "import sys; s = open(sys.argv[1]).read(); open(sys.argv[2], 'w').write(s.replace('wait 300\\n', 'wait 300\\nlarge 1\\n', 1))" \
    build/gen/layout_sweep.xy build/gen/layout_sweep_large.xy
rm -rf "$B/scenarios/layout_sweep_large" && mkdir -p "$B/scenarios/layout_sweep_large"
run layout-sweep-large $B/host/soundplant_host build/gen/layout_sweep_large.xy "$B/scenarios/layout_sweep_large"
# the weave pages with weaves set (the sweep sees them empty), in large type: ARP's Weave, the WEAVE track's own
for sc in weavepage weavetrack garden glide scenemorph homeload euclid strip; do
    "$PY" -c "import sys; s = open(sys.argv[1]).read(); open(sys.argv[2], 'w').write(s.replace('wait 300\\n', 'wait 300\\nlarge 1\\n', 1))" \
        tests/scenarios/$sc.xy build/gen/${sc}_large.xy
    rm -rf "$B/scenarios/${sc}_large" && mkdir -p "$B/scenarios/${sc}_large"
    run $sc-large $B/host/soundplant_host build/gen/${sc}_large.xy "$B/scenarios/${sc}_large"
done
[ $FAIL -eq 0 ] && echo "all tests passed" || echo "TESTS FAILED"
exit $FAIL
