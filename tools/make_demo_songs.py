#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""The songs built into the firmware (LOAD PROJECT's "Demo: NAME" rows): app/builtin_songs.h, made from the demo backup
images tools/make_demos.py writes. A song is a slot's objects as the firmware loads a slot: its settings object, and its
patterns' raw store (the slot's stream objects joined and LZ-unpacked, app/lz.c), each LZMA-packed for the flash
(base/tools/boot_pack.py's FILTERS: base/device/boot_lzma.h unpacks them).

    tools/make_demo_songs.py [--from DIR] [--out PATH]     DIR/<id>.soundplant for each id of BUILTIN and DIR/demos.json
                                                           (default app/build/emu/demos) into PATH (default app/builtin_songs.h)
    tools/make_demo_songs.py --check [--from DIR]          the checked-in header holds those songs (their unpacked content,
                                                           not the LZMA bytes); exit 1, "run tools/make_demo_songs.py", if not

Either way each song must keep the firmware's rule (host command demorule: no sound out of the resource region or the
sample bank), checked through the host simulator (app/build/host/soundplant_host: ./build.sh --host); and the three
slots of its image must hold the same project. A song is refused over 3,584 bytes, the three over 10,752, or a name over
12 characters or too wide for its LOAD PROJECT row (the host's layout audit, in both type sizes)."""

import argparse
import json
import lzma
import re
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "base" / "tools"))
from boot_pack import FILTERS  # noqa: E402  (the decoder's LZMA settings: lc 1, lp 1, pb 1, an end marker)

BUILTIN = ("house", "synthwave", "afterglow")  # the songs, in LOAD PROJECT's order (1 to 3): ids of tools/make_demos.py's DEMO_LIST

SONG_LIMIT = 3584
TOTAL_LIMIT = 10752
NAME_LEN = 12
MAX_SONGS = 3

DEFAULT_FROM = ROOT / "app" / "build" / "emu" / "demos"
DEFAULT_OUT = ROOT / "app" / "builtin_songs.h"
HOST = ROOT / "app" / "build" / "host" / "soundplant_host"

# app/app.h: the backup image (base/device/backup.c), the store's objects, the slot's objects
BACKUP_MAGIC, BACKUP_VERSION = 0x42384D4C, 1
OBJ_PROJ0, PROJ_NOBJ, NPROJ = 2, 7, 3
PROJ_MAGIC = 0x384D4F4C  # "LOM8"
PROJ_STREAM = 2  # the format word of the packed objects (app/project.c)
STREAM_HDR = 16
PLAT_STORE_MAX = 3840
COUNT_AT = 36  # the save count (project.c COUNT_AT: settings rsv[4..7]): each slot of an image has its own, a built-in song none


class Refused(Exception):
    pass


def u32(b, at):
    return struct.unpack_from("<I", b, at)[0]


def read_image(path):
    """a backup image's records: {object id: payload} (an absent object: b'')"""
    d = Path(path).read_bytes()
    if len(d) < 20 or zlib.crc32(d[:-4]) != u32(d, len(d) - 4):
        raise Refused(f"{path}: not a backup image (its CRC)")
    magic, version, count, _flags, head_crc = struct.unpack_from("<IHHII", d, 0)
    if magic != BACKUP_MAGIC or version != BACKUP_VERSION or zlib.crc32(d[:12]) != head_crc:
        raise Refused(f"{path}: not a SoundPlant backup image")
    at, objs = 16, {}
    for _ in range(count):
        if at + 8 > len(d) - 4:
            raise Refused(f"{path}: a record runs past the image")
        oid, n, crc = struct.unpack_from("<HHI", d, at)
        at += 8
        payload = d[at : at + n]
        if len(payload) != n or at + n > len(d) - 4 or zlib.crc32(payload) != crc:
            raise Refused(f"{path}: object {oid} does not check out")
        objs[oid] = payload
        at += n
    return objs


def lz_unpack(src, n):
    """app/lz.c lz_decompress: exactly n bytes from all of src (a control byte c: c < 0x80, c + 1 literals; else a match of
    (c & 0x7F) + 3 bytes, its distance - 1 as a little-endian u16, copied a byte at a time)"""
    out, i = bytearray(), 0
    while len(out) < n:
        if i >= len(src):
            raise Refused("the patterns' stream ends early")
        c = src[i]
        i += 1
        if c < 0x80:
            run = c + 1
            if i + run > len(src) or len(out) + run > n:
                raise Refused("the patterns' stream has a literal run past its end")
            out += src[i : i + run]
            i += run
            continue
        run = (c & 0x7F) + 3
        if i + 2 > len(src):
            raise Refused("the patterns' stream ends early")
        dist = (src[i] | src[i + 1] << 8) + 1
        i += 2
        if dist > len(out) or run > n - len(out):
            raise Refused("the patterns' stream has a match past its end")
        for _ in range(run):
            out.append(out[-dist])
    if i != len(src):
        raise Refused("the patterns' stream has bytes after its end")
    return bytes(out)


def no_count(settings):
    return settings[:COUNT_AT] + bytes(4) + settings[COUNT_AT + 4 :]


def slot_objects(objs, slot):
    return [objs.get(OBJ_PROJ0 + slot * PROJ_NOBJ + k, b"") for k in range(PROJ_NOBJ)]


def slot_patterns(objs):
    """(the raw length, the raw store) of a slot's stream objects: joined, then unpacked, checked by the stream's CRC-32"""
    first = objs[1]
    if len(first) < STREAM_HDR or u32(first, 0) != PROJ_STREAM:
        raise Refused("the slot's patterns are not a packed stream")
    raw_len, crc, packed_len = u32(first, 4), u32(first, 8), u32(first, 12)
    packed = first[STREAM_HDR:]
    for obj in objs[2:]:
        if len(packed) >= packed_len:
            break
        if len(obj) < 4 or u32(obj, 0) != PROJ_STREAM:
            raise Refused("the slot's patterns stream is cut short")
        packed += obj[4:]
    if len(packed) < packed_len:
        raise Refused("the slot's patterns stream is cut short")
    raw = lz_unpack(packed[:packed_len], raw_len)
    if zlib.crc32(raw) != crc:
        raise Refused("the patterns do not match their CRC-32 (the unpacker is wrong, or the image is)")
    return raw_len, raw


def lzma_pack(raw):
    data = lzma.compress(raw, format=lzma.FORMAT_RAW, filters=FILTERS)
    if lzma.decompress(data, format=lzma.FORMAT_RAW, filters=FILTERS) != raw:
        raise Refused("the LZMA round trip failed")
    return data


def lzma_unpack(data, size):
    out = lzma.decompress(data, format=lzma.FORMAT_RAW, filters=FILTERS)
    if len(out) != size:
        raise Refused(f"a stream unpacks to {len(out)} bytes, not {size}")
    return out


def title_of(song_id, names_json):
    """the name LOAD PROJECT shows: the song's genre in demos.json"""
    try:
        entries = json.loads(Path(names_json).read_text())
    except (OSError, ValueError) as e:
        raise Refused(f"{names_json}: {e}")
    names = [e["genre"] for e in entries if e.get("id") == song_id and "genre" in e]
    if len(names) != 1:
        raise Refused(f"{names_json}: no single genre for the song {song_id!r}")
    name = names[0]
    if not name or len(name) > NAME_LEN or not re.fullmatch(r"[!-~]([ -~]*[!-~])?", name) or '"' in name or "\\" in name:
        raise Refused(
            f"the name {name!r} of {song_id!r}: 1 to {NAME_LEN} printable characters, no edge space, no quote or backslash"
        )
    return name


def load_song(src_dir, song_id):
    path = Path(src_dir) / f"{song_id}.soundplant"
    if not path.is_file():
        raise Refused(f"{path}: not there (tools/make_demos.py makes the images)")
    objs = read_image(path)
    slots = [slot_objects(objs, s) for s in range(NPROJ)]
    for s in slots:
        if len(s[0]) < COUNT_AT + 4 or u32(s[0], 0) != PROJ_MAGIC or len(s[0]) > PLAT_STORE_MAX:
            raise Refused(f"{path}: a slot holds no project settings")
    slots = [[no_count(s[0])] + s[1:] for s in slots]
    if slots[1] != slots[0] or slots[2] != slots[0]:
        raise Refused(f"{path}: slots 1, 2 and 3 do not hold the same project")
    settings = slots[0][0]
    pat_raw_len, pats = slot_patterns(slots[0])
    return {
        "id": song_id,
        "image": path,
        "name": title_of(song_id, Path(src_dir) / "demos.json"),
        "settings": settings,
        "pats": pats,
        "pat_raw": pat_raw_len,
    }


def pack_song(song):
    """the stored form: the two streams in one run, with the numbers the firmware checks them by"""
    set_blob, pat_blob = lzma_pack(song["settings"]), lzma_pack(song["pats"])
    data = set_blob + pat_blob
    if len(data) > SONG_LIMIT:
        raise Refused(f"{song['id']}: {len(data)} bytes packed, over {SONG_LIMIT}")
    return {
        **song,
        "data": data,
        "set_n": len(set_blob),
        "pat_n": len(pat_blob),
        "crc": zlib.crc32(data),
        "pat_crc": zlib.crc32(song["pats"]),
    }


def run_host(lines):
    """the host simulator on a script: its exit code, and the lines that name a failure"""
    if not HOST.is_file():
        raise Refused(f"{HOST} is not built: ./build.sh --host")
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "check.xy"
        script.write_text("\n".join(lines) + "\n")
        r = subprocess.run(
            [str(HOST), str(script), tmp],
            capture_output=True,
            text=True,
            env={"SOUNDPLANT_LOAD": "0", "PATH": "/usr/bin:/bin"},
            check=False,
        )
    log = [ln.strip() for ln in (r.stdout + r.stderr).splitlines() if ln.strip().startswith(("demo: ", "FAIL", "line ", "LAYOUT"))]
    return r.returncode, log


def rule_check(images):
    """the firmware's rule on each image, as the host simulator's demorule says it (the image restored, its slot opened)"""
    for image in images:
        code, log = run_host([f"restore {Path(image).resolve()}", "wait 100", "demorule"])
        if code or log:
            raise Refused(f"{image}: breaks the firmware rule (demorule, exit {code}): {' | '.join(log[:3])}")


def name_check(songs):
    """each name on its LOAD PROJECT row in both type sizes: the row's value room is the layout audit's, a name wider than
    it is cut (the 12 characters a name may have are not all as wide)"""
    for large in (False, True):
        lines = ["wait 300"] + (["large 1"] if large else []) + ["demo_pad"]
        lines += [f"demo_name {k} {s['name']}" for k, s in enumerate(songs, 1)]
        lines += ["tap HOME", "tap SEL", "row LOAD PROJECT", "wait 40", f"turn ALGO {NPROJ}"]
        for k in range(1, len(songs) + 1):
            lines += [f"rowdemo {k}", "wait 100", "turn ALGO 1"]
        code, log = run_host(lines)
        if code or log:
            size = "large" if large else "small"
            raise Refused(f"a name does not fit LOAD PROJECT's row in {size} type (exit {code}): {' | '.join(log[:3])}")


def render(songs):
    out = [
        "/* SPDX-License-Identifier: MPL-2.0 */",
        "/* GENERATED by tools/make_demo_songs.py from the demo backup images (tools/make_demos.py): do not edit.",
        " * The firmware's built-in songs (app/project.c project_load_demo): each its title and two LZMA streams in",
        " * one run, the settings object then the patterns' raw store. tests/host/demos_test.sh runs",
        " * tools/make_demo_songs.py --check. */",
        f"#define NDEMO {len(songs)}",
        f"static const char DEMO_NAME[NDEMO][{NAME_LEN + 1}] = {{" + ", ".join(f'"{s["name"]}"' for s in songs) + "};",
    ]
    for k, s in enumerate(songs):
        out.append(f"/* {s['name']} ({s['id']}): settings {s['set_n']} + patterns {s['pat_n']} bytes */")
        out.append(f"static const uint8_t DEMO{k}[] = {{")
        for i in range(0, len(s["data"]), 16):
            out.append("    " + ", ".join(f"0x{b:02x}" for b in s["data"][i : i + 16]) + ",")
        out.append("};")
        out.append(
            f"_Static_assert(sizeof DEMO{k} == {s['set_n']}u + {s['pat_n']}u, \"DEMO{k}: its two streams' lengths\");"
        )
    out.append("/* name, data, settings stream bytes, patterns stream bytes, settings object bytes, patterns raw bytes,")
    out.append(" * CRC-32 of the data, CRC-32 of the unpacked patterns */")
    out.append("#define DEMO_ROWS { \\")
    for k, s in enumerate(songs):
        out.append(
            f"    {{DEMO_NAME[{k}], DEMO{k}, {s['set_n']}u, {s['pat_n']}u, {len(s['settings'])}u, {s['pat_raw']}u, "
            f"0x{s['crc']:08X}u, 0x{s['pat_crc']:08X}u}}, \\"
        )
    out[-1] = out[-1][:-3] + " \\"
    out.append("}")
    out.append("#define DEMO_DATA_BYTES (" + " + ".join(f"sizeof DEMO{k}" for k in range(len(songs))) + ")")
    out.append(f'_Static_assert(DEMO_DATA_BYTES <= {TOTAL_LIMIT}u, "the built-in songs: {TOTAL_LIMIT} bytes at most");')
    return "\n".join(out) + "\n"


def parse(text):
    """a header's songs, as render wrote them: [{name, data, set_n, pat_n, set_raw, pat_raw, crc, pat_crc}]"""
    names = re.search(r"DEMO_NAME\[NDEMO\]\[\d+\] = \{(.*?)\};", text)
    arrays = dict(re.findall(r"static const uint8_t DEMO(\d+)\[\] = \{(.*?)\};", text, re.DOTALL))
    rows = re.findall(
        r"\{DEMO_NAME\[(\d+)\], DEMO(\d+), (\d+)u, (\d+)u, (\d+)u, (\d+)u, 0x([0-9A-F]{8})u, 0x([0-9A-F]{8})u\}", text
    )
    if not names or not rows or len(arrays) != len(rows):
        raise Refused("the header is not one this tool wrote")
    titles = re.findall(r'"([^"]*)"', names[1])
    if len(titles) != len(rows):
        raise Refused("the header's names and rows differ in number")
    songs = []
    for name, (k, a, set_n, pat_n, set_raw, pat_raw, crc, pat_crc) in zip(titles, rows):
        if k != a or a not in arrays:
            raise Refused("the header's rows do not name their songs in order")
        data = bytes(int(h, 16) for h in re.findall(r"0x([0-9a-f]{2})", arrays[a]))
        songs.append(
            {
                "name": name,
                "data": data,
                "set_n": int(set_n),
                "pat_n": int(pat_n),
                "set_raw": int(set_raw),
                "pat_raw": int(pat_raw),
                "crc": int(crc, 16),
                "pat_crc": int(pat_crc, 16),
            }
        )
    return songs


def check_header(path, songs):
    """what is wrong with the header at path against the songs made from the images (their unpacked content): [str]"""
    try:
        have = parse(Path(path).read_text())
    except OSError as e:
        return [f"{path}: {e}"]
    except Refused as e:
        return [f"{path}: {e}"]
    if len(have) != len(songs):
        return [f"{path} holds {len(have)} songs, the images {len(songs)}"]
    bad = []
    for h, s in zip(have, songs):
        who = s["id"]
        if h["name"] != s["name"]:
            bad.append(f"{who}: the header names it {h['name']!r}, the images {s['name']!r}")
        if h["set_n"] + h["pat_n"] != len(h["data"]) or zlib.crc32(h["data"]) != h["crc"]:
            bad.append(f"{who}: the header's data does not match its lengths and CRC")
            continue
        try:
            set_obj = lzma_unpack(h["data"][: h["set_n"]], h["set_raw"])
            pats = lzma_unpack(h["data"][h["set_n"] :], h["pat_raw"])
        except (Refused, lzma.LZMAError) as e:
            bad.append(f"{who}: the header's data does not unpack: {e}")
            continue
        if set_obj != s["settings"]:
            bad.append(f"{who}: the header's settings are not the image's")
        if pats != s["pats"] or h["pat_crc"] != zlib.crc32(pats):
            bad.append(f"{who}: the header's patterns are not the image's")
    return bad


def main(argv):
    ap = argparse.ArgumentParser(description="app/builtin_songs.h from the demo images", add_help=True)
    ap.add_argument("--from", dest="src", default=str(DEFAULT_FROM), help="the images' directory (with demos.json)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="the header to write, or with --check to compare")
    ap.add_argument("--check", action="store_true", help="the header holds the images' songs; nothing is written")
    args = ap.parse_args(argv)
    try:
        if not 1 <= len(BUILTIN) <= MAX_SONGS or len(set(BUILTIN)) != len(BUILTIN):
            raise Refused(f"BUILTIN: 1 to {MAX_SONGS} different songs")
        songs = [pack_song(load_song(args.src, i)) for i in BUILTIN]
        total = sum(len(s["data"]) for s in songs)
        if total > TOTAL_LIMIT:
            raise Refused(f"{total} bytes packed, over {TOTAL_LIMIT}")
        rule_check(s["image"] for s in songs)
        name_check(songs)
        if args.check:
            bad = check_header(args.out, songs)
            if bad:
                print("\n".join(f"make_demo_songs: {b}" for b in bad), file=sys.stderr)
                print("make_demo_songs: run tools/make_demo_songs.py", file=sys.stderr)
                return 1
            print(f"make_demo_songs: {args.out} holds {len(songs)} songs, {total} bytes: as the images")
            return 0
        Path(args.out).write_text(render(songs))
        print(f"make_demo_songs: {args.out}: {len(songs)} songs, {total} of {TOTAL_LIMIT} bytes")
        for s in songs:
            print(f"  {s['id']}: {s['name']!r}, settings {s['set_n']} + patterns {s['pat_n']} bytes")
        return 0
    except Refused as e:
        print(f"make_demo_songs: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
