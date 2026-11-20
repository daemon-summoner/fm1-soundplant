#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# Build and run the sub-pixel drawing's and the springs' test (tests/host/gfx_test.c); the fonts are generated first.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p build/host app/build/gen
"${PYTHON:-python3}" tools/gen_font.py app/build/gen/soundplant_font.h >/dev/null
[ -f app/build/gen/felucca_font.h ] || "${PYTHON:-python3}" base/tools/gen_font.py app/build/gen/felucca_font.h >/dev/null
${CC:-cc} -O2 -ffp-contract=off -std=gnu99 -Wall -Wextra -Wno-unused-function -Wno-unused-variable -Wno-unused-parameter -Werror \
    -DPLAT_HOST -Iapp -Ibase/device -Ibase/include -Iapp/build/gen -o build/host/gfx_test tests/host/gfx_test.c -lm
build/host/gfx_test
