#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Build and run the Garden state's test (tests/host/garden_test.c). Its glitch schedule is held against an independent
# port of the hash and the pick rules written here (the C and the port must print the same schedule).
set -eu
cd "$(dirname "$0")/../.."
mkdir -p build/host
${CC:-cc} -O2 -ffp-contract=off -std=gnu99 -Wall -Wextra -Wno-unused-function -Werror \
    -Iapp -o build/host/garden_test tests/host/garden_test.c
build/host/garden_test schedule > build/host/garden_schedule_c.txt
"${PYTHON:-python3}" - > build/host/garden_schedule_py.txt <<'PYEND'
M = 0xFFFFFFFF


def gd_hash(a, b):
    h = (a * 0x9E3779B1 + b * 0x85EBCA77 + 0x165667B1) & M
    h ^= h >> 15
    h = h * 0x2C1B3C6D & M
    h ^= h >> 12
    h = h * 0x297A2D39 & M
    h ^= h >> 15
    return h


PCT = {1: 12, 2: 26, 3: 45}
for lvl in (1, 2, 3):
    for beat in range(512):
        h = gd_hash(0xC0FFEE11, beat)
        if h % 100 < PCT[lvl]:
            print(lvl, beat, 1 + (h >> 8) % 4, 360 + (h >> 20) % 360)
PYEND
if cmp -s build/host/garden_schedule_c.txt build/host/garden_schedule_py.txt && [ -s build/host/garden_schedule_c.txt ]; then
    echo "  ok   the glitch schedule is the independent port's ($(wc -l < build/host/garden_schedule_c.txt | tr -d ' ') glitches over 512 beats at three levels)"
else
    echo "  FAIL the glitch schedule differs from the independent port's"
    diff build/host/garden_schedule_c.txt build/host/garden_schedule_py.txt | head
    exit 1
fi
build/host/garden_test
