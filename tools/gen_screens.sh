#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
# The manual's screenshots: tools/manual_screens.xy run in the host simulator (the whole app on the computer),
# each shot saved at twice its size (nearest neighbour, so the pixels stay sharp) as docs/img/screen-NAME.png.
# tools/garden_screens.xy is the README's gallery of the Garden, run on its own freshly started simulator; its shots
# (garden_*) keep only the Garden page's picture, without its header and knobs.
#   tools/gen_screens.sh
set -e
cd "$(dirname "$0")/.."
PY="${PYTHON:-/opt/homebrew/bin/python3.14}"
PYTHON="$PY" sh build.sh --host >/dev/null
rm -rf build/manual && mkdir -p build/manual docs/img
app/build/host/soundplant_host tools/manual_screens.xy build/manual >/dev/null
app/build/host/soundplant_host tools/garden_screens.xy build/manual >/dev/null
"$PY" - build/manual docs/img <<'PY'
import sys
from pathlib import Path
from PIL import Image
src, out = Path(sys.argv[1]), Path(sys.argv[2])
GARDEN_PICTURE = (0, 24, 240, 144)
for f in sorted(src.glob("*.png")):
    im = Image.open(f).convert("RGB")
    if f.stem.startswith("garden_"):
        im = im.crop(GARDEN_PICTURE)
    im.resize((im.width * 2, im.height * 2), Image.NEAREST).save(out / f"screen-{f.stem.replace('_', '-')}.png", optimize=True)
print(f"screens: {len(list(src.glob('*.png')))} in {out}")
PY
