// SPDX-License-Identifier: MPL-2.0
// app/web/samples/soundplant_samples.js against tools/soundplant_samples.py (and sampleio.py): the samples page builds the bank
// the command line builds.
//   1. the same int16 samples -> the same bank image, byte for byte (layout, the update record's marks, header, CRC)
//   2. WAV files -> the same samples at a rate (numpy's path: within a rounding), the same loop points
//   3. soundplant_samples.py build (auto rate) -> the same rate chosen and the same layout (the header but its CRC)
//   4. a bank read back (keptOf) and built again -> the same image; with a sample removed, the rest kept as stored
//   5. soundplant_prep.js, the samples page's editor: trim, zero-crossing snap, normalise, fades, reverse, mono, loop
//      mapping, the prepared sample as a bank entry (byte for byte the command line's image for the same samples) and as a WAV
//   6. the page's script with both libraries inlined as make_pages.py does: one valid module scope, every id it asks for in the markup
//   node tests/host/samples_web.mjs [PYTHON]     (PYTHON: one with numpy for 2, 3 and 5's resampling; without, they are skipped)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as L from "../../app/web/samples/soundplant_samples.js";
import * as P from "../../app/web/samples/soundplant_prep.js";

const PY = process.argv[2] || process.env.PYTHON || "python3";
const dir = mkdtempSync(join(tmpdir(), "soundplant-samples-"));
let bad = 0;
const check = (what, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad++; };
const py = (code) => execFileSync(PY, ["-c", `import sys; sys.path.insert(0, "tools")\n${code}`],
  { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
const hasNumpy = (() => { try { py("import numpy"); return true; } catch (_) { return false; } })();

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) / 16777216 - 0.5; };

// 1. the same int16 samples -> the same image
{
  const specs = [];
  const lens = [30000, 5, 64, 65, 120000, 47000, 90000, 333, 22050, 41000, 70000];   // over the windows' seams
  lens.forEach((n, k) => {
    const s = new Int16Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.round(20000 * Math.sin(i * (0.01 + k * 0.003)) + 4000 * rnd());
    specs.push({ name: `Test_${k}!`, s, root: 40 + k, loop: k % 3 ? [k * 10, Math.max(1, n - k)] : null, bars: k % 5,
      rate: [11025, 16000, 22050, 32000][k % 4] });
  });
  const f = join(dir, "spec.json");
  writeFileSync(f, JSON.stringify(specs.map((p) => ({ ...p, s: Array.from(p.s) }))));
  let pyImg = null, jsImg = null, pyErr = "", jsErr = "";
  try {
    pyImg = Buffer.from(py(`import json, sampleio as sio
sp = json.load(open("${f}"))
img = sio.user_bank([(p["name"], p["s"], p["root"], tuple(p["loop"]) if p["loop"] else None, p["bars"], p["rate"]) for p in sp])
sys.stdout.write(img.hex())`), "hex");
  } catch (e) { pyErr = String(e.stderr || e).split("\n").filter(Boolean).pop(); }
  try { jsImg = Buffer.from(L.userBank(specs)); } catch (e) { jsErr = e.message; }
  if (pyErr || jsErr)
    check(`too long in both, the same way (${pyErr} / ${jsErr})`, pyErr.includes("too long") && jsErr.includes("too long"));
  else check(`the same samples: the same image (${specs.length} samples, ${jsImg.length} B)`, Buffer.compare(pyImg, jsImg) === 0);
  // a smaller set that fits (into the second window): byte for byte
  const fit = specs.filter((_, k) => [0, 1, 2, 3, 5, 6, 7, 8, 9].includes(k));
  writeFileSync(f, JSON.stringify(fit.map((p) => ({ ...p, s: Array.from(p.s) }))));
  const a = Buffer.from(py(`import json, sampleio as sio
sp = json.load(open("${f}"))
img = sio.user_bank([(p["name"], p["s"], p["root"], tuple(p["loop"]) if p["loop"] else None, p["bars"], p["rate"]) for p in sp])
sys.stdout.write(img.hex())`), "hex");
  const b = Buffer.from(L.userBank(fit));
  check(`the same samples (fitting): the same image (${fit.length} samples, ${b.length} B)`, Buffer.compare(a, b) === 0);
  for (const nm of ["Kick_C2.wav", "pad F#3", "x", "!!", "a_very_long_name_indeed"])
    check(`names: ${nm}`, L.cleanName(nm) === py(`import sampleio as sio; print(sio.clean_name(${JSON.stringify(nm)}), end="")`) &&
      L.noteFromName(nm) === Number(py(`import sampleio as sio; print(sio.note_from_name(${JSON.stringify(nm)}), end="")`)));
}

function wav(path, rate, nch, bits, seconds, loop) {
  const n = Math.round(rate * seconds), bps = bits >> 3, data = Buffer.alloc(n * nch * bps);
  for (let i = 0; i < n; i++) {
    const v = 0.6 * Math.sin(i * 2 * Math.PI * 220 / rate) * Math.exp(-i / rate) + 0.05 * rnd() + 0.2 * Math.sin(i * 2 * Math.PI * 7000 / rate);
    for (let c = 0; c < nch; c++) {
      const s = Math.max(-1, Math.min(1, c ? v * 0.7 : v)), o = (i * nch + c) * bps;
      if (bits === 16) data.writeInt16LE(Math.round(s * 32767), o);
      else data.writeIntLE(Math.round(s * 8388607), o, 3);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(nch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * nch * bps, 28); h.writeUInt16LE(nch * bps, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  let smpl = Buffer.alloc(0);
  if (loop) {
    smpl = Buffer.alloc(8 + 60);
    smpl.write("smpl", 0); smpl.writeUInt32LE(60, 4); smpl.writeUInt32LE(1, 8 + 28);
    smpl.writeUInt32LE(loop[0], 8 + 44); smpl.writeUInt32LE(loop[1], 8 + 48);
  }
  const all = Buffer.concat([h, data, smpl]);
  all.writeUInt32LE(all.length - 8, 4);
  writeFileSync(path, all);
}

const files = [
  [join(dir, "pad_C3.wav"), 44100, 2, 16, 1.5, [4410, 40000]],
  [join(dir, "brk.wav"), 48000, 1, 24, 2.0, null],
  [join(dir, "hit.wav"), 22050, 1, 16, 0.4, null],
];
for (const f of files) wav(...f);

// 2. WAV -> samples at a rate
if (hasNumpy) {
  for (const [path, , , , , loop] of files)
    for (const rate of [32000, 22050, 11025]) {
      const { rate: sr, x, loop: lp } = L.readWav(readFileSync(path));
      const js = L.atRate(x, sr, lp, rate);
      const out = JSON.parse(py(`import json, soundplant_samples as ls
p = ls.parse("${path}")
t = ls.at_rate(p, ${rate})
print(json.dumps({"s": t[1], "loop": t[3]}))`));
      let diff = 0, worst = 0;
      for (let i = 0; i < Math.max(js.s.length, out.s.length); i++) {
        const d = Math.abs((js.s[i] ?? 99999) - (out.s[i] ?? -99999));
        if (d) diff++;
        if (d > worst) worst = d;
      }
      const sameLoop = JSON.stringify(js.loop) === JSON.stringify(out.loop) && (loop ? !!js.loop : !js.loop);
      check(`${path.split("/").pop()} at ${rate}: ${js.s.length} samples, ${diff} differ (at most ${worst}), loop ${JSON.stringify(js.loop)}`,
        js.s.length === out.s.length && worst <= 1 && diff <= js.s.length / 1000 && sameLoop);
    }
} else console.log(`  skip WAV comparisons (${PY} has no numpy: sampleio's other path)`);

// 3. the command line's bank: the same rate, the same layout
if (hasNumpy) {
  const specs = [`${files[0][0]}`, `beat=${files[1][0]}@1`, `${files[2][0]}:62%32k`];
  const out = join(dir, "py.bin");
  const log = py(`import soundplant_samples as ls
from pathlib import Path
Path("${out}").write_bytes(ls.build(${JSON.stringify(specs)}, None, factory=False))`);
  const pyImg = readFileSync(out);
  const items = specs.map((sp) => {
    let name = null, s = sp, rate = null, bars = 0, root = null;
    if (s.includes("=")) [name, s] = s.split("=");
    if (s.includes("%")) { const r = s.split("%"); s = r[0]; rate = { "32k": 32000 }[r[1]]; }
    if (/@\d+$/.test(s)) { bars = Number(s.split("@").pop()); s = s.replace(/@\d+$/, ""); }
    if (/:\d+$/.test(s)) { root = Number(s.split(":").pop()); s = s.replace(/:\d+$/, ""); }
    const { rate: sr, x, loop } = L.readWav(readFileSync(s));
    const stem = s.split("/").pop().replace(/\.wav$/, "");
    return { name: name || stem, x, sr, loop, root: root ?? (bars ? L.LOOP_ROOT : L.noteFromName(stem)), bars, rate };
  });
  const { img, chose } = L.build(items);
  const ph = Buffer.from(pyImg.subarray(0, L.BANK_HDR)), jh = Buffer.from(img.subarray(0, L.BANK_HDR));
  ph.fill(0, 12, 16); jh.fill(0, 12, 16);
  check(`soundplant_samples.py build: auto chose ${chose} Hz; the same header but the CRC (${img.length} B, ${log.trim().split("\n").pop()})`,
    img.length === pyImg.length && Buffer.compare(ph, jh) === 0);
}

// 3b. with the factory set (0.8): the page's (factory.bin's entries, kept as stored, after the samples) is the command
// line's (its default), byte for byte; and the factory set's entries are the image's own until 0.8 (gen_samples.py)
if (hasNumpy) {
  const fb = join(dir, "factory.bin"), out2 = join(dir, "py_f.bin");
  py(`import gen_samples, sampleio as sio
from pathlib import Path
Path("${fb}").write_bytes(sio.user_bank(gen_samples.factory_set()))`);
  const factory = L.factoryOf(new Uint8Array(readFileSync(fb)));
  check(`the factory set: ${factory.length} entries, all marked`, factory.length === L.NFENT && factory.every(L.isFactory));
  const specs = [`${files[0][0]}`, `beat=${files[1][0]}@1`];
  py(`import soundplant_samples as ls
from pathlib import Path
Path("${out2}").write_bytes(ls.build(${JSON.stringify(specs)}, None, quiet=True))`);
  const items = specs.map((sp) => {
    let name = null, s = sp, bars = 0;
    if (s.includes("=")) [name, s] = s.split("=");
    if (/@\d+$/.test(s)) { bars = Number(s.split("@").pop()); s = s.replace(/@\d+$/, ""); }
    const { rate: sr, x, loop } = L.readWav(readFileSync(s));
    const stem = s.split("/").pop().replace(/\.wav$/, "");
    return { name: name || stem, x, sr, loop, root: bars ? L.LOOP_ROOT : L.noteFromName(stem), bars, rate: null };
  });
  const missing = L.factoryMissing(items, factory);
  const { img } = L.build([...items, ...missing]);
  const pyImg = readFileSync(out2);
  const ph = Buffer.from(pyImg.subarray(0, L.BANK_HDR)), jh = Buffer.from(img.subarray(0, L.BANK_HDR));
  ph.fill(0, 12, 16); jh.fill(0, 12, 16);
  check(`with the factory set: the page's bank is the command line's (${img.length} B)`,
    missing.length === L.NFENT && img.length === pyImg.length && Buffer.compare(ph, jh) === 0);
  const h = L.parseHeader(img.subarray(0, L.BANK_HDR));
  check("the samples first (user 1, user 2), the factory set after them",
    h.count === 2 + L.NFENT && !(h.entries[0].flags & L.E_FACTORY) && !(h.entries[1].flags & L.E_FACTORY) &&
    h.entries.slice(2).every((e) => e.flags & L.E_FACTORY));
  check("a bank with the factory set needs none of it again", L.factoryMissing(L.keptOf(img), factory).length === 0);
}

// 4. read back and built again
{
  const items = files.map(([path]) => {
    const { rate: sr, x, loop } = L.readWav(readFileSync(path));
    return { name: path.split("/").pop(), x, sr, loop, root: 60, bars: 0, rate: null };
  });
  const { img } = L.build(items);
  const kept = L.keptOf(img);
  const again = L.build(kept).img;
  check(`a bank read back and built again: the same image (${kept.length} samples)`, Buffer.compare(Buffer.from(img), Buffer.from(again)) === 0);
  const fewer = L.build([kept[0], kept[2]]).img, h = L.parseHeader(fewer.subarray(0, L.BANK_HDR));
  const e = h.entries[1], k2 = kept[2];
  const same = Buffer.compare(Buffer.from(fewer.subarray(e.adpOff, e.adpOff + k2.adpcm.length)), Buffer.from(k2.adpcm)) === 0;
  check("one removed: the others kept as stored", h.count === 2 && e.n === k2.n && same && L.crc32(fewer.subarray(L.BANK_HDR)) === h.crc);
  // the frames: as soundplant_samples.frames sends them
  const fr = [...L.frames(img)].map(([c, a]) => [c, a]);
  writeFileSync(join(dir, "web.bin"), img);
  const pyFr = JSON.parse(py(`import json, soundplant_samples as ls
from pathlib import Path
img = Path("${join(dir, "web.bin")}").read_bytes()
print(json.dumps([[c, a] for c, a, _, _ in ls.frames(img)]))`));
  check(`the upload's frames: as soundplant_samples.py sends them (${fr.length})`, JSON.stringify(fr) === JSON.stringify(pyFr));
}
// findLink: the FM-1's ports as each system names them (a fake FM-1 answers PING; other gear never probed)
{
  const fm1 = (names, opts = {}) => {
    const probed = [];
    const ins = [], outs = [];
    for (const [inName, outName, isFm1] of names) {
      const input = { name: inName, state: "connected", onmidimessage: null, open: async () => { if (opts.busy) throw new Error("busy"); } };
      const output = { name: outName, state: "connected", open: async () => {},
        send: (d) => { probed.push(outName); if (isFm1 && d[4] === 25) setTimeout(() => input.onmidimessage({ data: [0xF0, 0x7D, 0x46, 0x4C, 25, 0, 0xF7] }), 1); } };
      ins.push(input); outs.push(output);
    }
    return { midi: { inputs: new Map(ins.map((p, i) => [i, p])), outputs: new Map(outs.map((p, i) => [i, p])) }, probed };
  };
  const cases = [
    ["macOS: an earlier firmware's name", [["IAC Driver Bus 1", "IAC Driver Bus 1"], ["X0X FM-1", "X0X FM-1", 1]], true],
    ["Windows: the ends named apart", [["SoundPlant FM-1", "MIDIOUT2 (SoundPlant FM-1)", 1], ["loopMIDI", "loopMIDI"]], true],
    ["Windows: numbered", [["SoundPlant FM-1 0", "SoundPlant FM-1 1", 1], ["Digital Piano", "Digital Piano"]], true],
    ["Windows: USB-MIDI", [["USB-MIDI", "USB-MIDI", 1]], true],
    ["other gear only", [["Digital Piano", "Digital Piano"]], false],
  ];
  for (const [what, names, found] of cases) {
    const { midi, probed } = fm1(names);
    const l = await L.findLink(midi, 50);
    check(`findLink: ${what}`, !!l === found && !probed.some((n) => /IAC|Piano|loopMIDI/.test(n)));
    if (l) l.close();
  }
  const { midi } = fm1([["SoundPlant FM-1", "SoundPlant FM-1", 1]], { busy: true });
  check("findLink: a port another app holds is passed over", (await L.findLink(midi, 50)) === null);
}

// 5. preparing a sample (soundplant_prep.js): each step on samples whose result is known, each with what it must refuse
const throws = (fn, re) => { try { fn(); } catch (e) { return re.test(String(e.message)); } return false; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const near = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;
const peakI = (s) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const ramp = (n) => Float64Array.from({ length: n }, (_, i) => (i + 1) / n);
const sine = (n, period, phase = 0) => Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * (i + phase) / period));
const pcm16 = (rate, chs) => {
  const nch = chs.length, n = chs[0].length, b = Buffer.alloc(44 + n * nch * 2);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(nch, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * nch * 2, 28);
  b.writeUInt16LE(nch * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * nch * 2, 40);
  for (let i = 0; i < n; i++) chs.forEach((c, k) => b.writeInt16LE(c[i], 44 + (i * nch + k) * 2));
  return b;
};

// trim
{
  const x = ramp(1000), copy = Float64Array.from(x), y = P.trim(x, 100, 600);
  check("trim [100, 600): 500 samples, the first and the last as the sound's", y.length === 500 && y[0] === x[100] && y[499] === x[599]);
  check("trim: the sound itself is left as it was", same(x, copy) && y.buffer !== x.buffer);
  check("trim: the whole sound is allowed", same(P.trim(x, 0, 1000), x));
  check("trim: start == end refused", throws(() => P.trim(x, 500, 500), /before the end/));
  check("trim: start after end refused", throws(() => P.trim(x, 600, 500), /before the end/));
  check("trim: past either end of the sound refused", throws(() => P.trim(x, 0, 1001), /1000 samples/) && throws(() => P.trim(x, -1, 100), /1000 samples/));
  check("trim: a part of a sample refused", throws(() => P.trim(x, 0.5, 100), /whole samples/) && throws(() => P.trim(x, 0, NaN), /whole samples/));
  check(`trim: ${P.MIN_TRIM - 1} samples refused, ${P.MIN_TRIM} allowed`,
    throws(() => P.trim(x, 0, P.MIN_TRIM - 1), /32 samples/) && P.trim(x, 10, 10 + P.MIN_TRIM).length === P.MIN_TRIM);
  const tiny = ramp(10);
  check("trim: a sound shorter than the least can be kept whole, not cut", P.trim(tiny, 0, 10).length === 10 && throws(() => P.trim(tiny, 0, 9), /32 samples/));
}

// zero-crossing snap: sin with a period of 100 samples, a quarter-sample off, so crossings lie between 49|50, 99|100, ...
{
  const x = sine(300, 100, 0.3), dc = new Float64Array(64).fill(0.5);
  check("snap: from 30 to the crossing at 50 (the sample nearer to zero), where the sign changes",
    P.snapZero(x, 30) === 50 && x[49] > 0 && x[50] < 0 && Math.abs(x[50]) < Math.abs(x[49]));
  check("snap: the snapped cut is quiet where the unsnapped one was loud", Math.abs(x[P.snapZero(x, 30)]) < 0.05 && Math.abs(x[30]) > 0.9);
  check("snap: the crossing nearer wins (70 -> 50, 80 -> 100)", P.snapZero(x, 70) === 50 && P.snapZero(x, 80) === 100);
  check("snap: none within the radius: the cut stays", P.snapZero(x, 30, 5) === 30);
  check("snap: a sound with no crossing: the cut stays", P.snapZero(dc, 10) === 10);
  const z = new Float64Array(40).fill(0.1); z[7] = 0;
  check("snap: a sample of exactly 0 is a crossing", P.snapZero(z, 9) === 7 && P.snapZero(z, 7) === 7);
  check("snap: the next crossing after / before a cut (nextZero)",
    P.nextZero(x, 30, 1) === 50 && P.nextZero(x, 50, 1) === 100 && P.nextZero(x, 60, -1) === 50 && P.nextZero(dc, 10, 1) === 10 && P.nextZero(dc, 10, -1) === 10);
  const a = P.snapZero(x, 20), b = P.snapZero(x, 220), cut = P.trim(x, a, b);
  check("snap: a trim between snapped cuts starts and ends at silence", cut.length === b - a && Math.abs(cut[0]) < 0.05 && Math.abs(cut[cut.length - 1]) < 0.05);
}

// normalise, gain, the peak
{
  const x = Float64Array.from([0.1, -0.25, 0.5, -0.5, 0.05]), copy = Float64Array.from(x);
  const r = P.normalise(x, -6);
  check("normalise to -6 dBFS: the peak lands on 0.5012", near(P.peakOf(r.x).peak, P.fromDb(-6)) && near(r.peak, 0.5) && !r.silent);
  check("normalise: the shape is kept (every sample times one gain), the sound itself is not changed",
    r.x.every((v, i) => near(v, x[i] * r.gain)) && same(x, copy));
  check("normalise to 0 dBFS: the peak is 1", near(P.peakOf(P.normalise(x, 0).x).peak, 1));
  const bank = P.normalise(x).x;
  check("normalise by default: the bank's level (the int16 of it peaks at 30000)", peakI(L.toInt16(bank)) === 30000 && near(P.peakOf(bank).peak * 32768, 30000));
  const q = P.normalise(new Float64Array(100));
  check("normalise: silence stays silence, no division by zero", q.silent && q.gain === 1 && q.peak === 0 && q.x.every((v) => v === 0));
  check("normalise: a target above 0 dBFS or under -96 refused", throws(() => P.normalise(x, 1), /between -96 and 0/) && throws(() => P.normalise(x, -97), /between -96 and 0/) && throws(() => P.normalise(x, NaN), /between -96 and 0/));
  check("normalise: a sample that is not a number refused", throws(() => P.normalise(Float64Array.from([0.1, NaN, 0.2]), -6), /not a number/) && throws(() => P.normalise(Float64Array.from([0.1, Infinity]), -6), /not a number/));
  const flat = Float64Array.from([0.2, 1, 1, 1, 1, -0.3, 0.9, 0.9]), round = Float64Array.from([0.2, 1, 1, -0.3]);
  check("clipped input: the samples in flat tops counted (4 of 4 at the peak), 2 in a row are not a flat top",
    P.peakOf(flat).clipped === 4 && P.normalise(flat, -6).clipped === 4 && P.peakOf(round).clipped === 0 && P.normalise(round, -6).clipped === 0);
  check("peak: the largest absolute sample and where", P.peakOf(x).peak === 0.5 && P.peakOf(x).at === 2 && P.peakOf(new Float64Array(0)).peak === 0);
  check("peak: a sample that is not a number or not finite is found, not looped on",
    Number.isNaN(P.peakOf(Float64Array.from([0.1, NaN, 0.2])).peak) && P.peakOf(Float64Array.from([0.1, NaN, 0.2])).at === 1 && Number.isNaN(P.peakOf(Float64Array.from([-Infinity, 0.2])).peak));
  const g = P.applyGain(x, 20 * Math.log10(2));
  check("gain +6.02 dB doubles every sample, not the original", g.every((v, i) => near(v, x[i] * 2)) && same(x, copy));
  check("gain: not a number, infinite or past 96 dB refused", throws(() => P.applyGain(x, NaN), /gain/) && throws(() => P.applyGain(x, Infinity), /gain/) && throws(() => P.applyGain(x, 97), /between -96 and 96/) && P.applyGain(x, 96).length === 5);
  check("fade in ms: 20 ms at 22050 Hz is 441 samples; negative, NaN refused", P.fadeSamples(20, 22050) === 441 && P.fadeSamples(0, 22050) === 0 && throws(() => P.fadeSamples(-1, 22050), /0 or more/) && throws(() => P.fadeSamples(NaN, 22050), /0 or more/));
  check("the bank's level as the level field shows it (-0.77) is the bank's exact one", P.levelDb(-0.77) === P.BANK_DB && P.levelDb(-3) === -3);
}

// fade, reverse, mono
{
  const x = new Float64Array(1000).fill(1), copy = Float64Array.from(x), y = P.fade(x, 100, 200);
  check("fade: the first and the last sample reach 0", y[0] === 0 && y[999] === 0);
  check("fade in: linear over 100 samples (50 is half), full from there", y[50] === 0.5 && y[99] === 0.99 && y[100] === 1);
  check("fade out: linear over 200 samples (the 100th from the end is half)", y[899] === 0.5 && y[800] === 0.995 && y[799] === 1);
  let mid = true;
  for (let i = 100; i < 800; i++) if (y[i] !== 1) mid = false;
  check("fade: the middle [100, 800) is untouched, the sound itself too", mid && same(x, copy));
  check("fade of 0 and 0 leaves every sample", same(P.fade(x, 0, 0), x) && P.fade(x, 0, 0) !== x);
  const lap = P.fade(x, 600, 600);
  check("fade: two fades that meet never raise a sample, no NaN", lap.every((v) => v >= 0 && v <= 1) && lap[0] === 0 && lap[999] === 0 && lap[500] < 1);
  const over = P.fade(new Float64Array(100).fill(1), 5000, 0);
  check("fade: longer than the sound: a slow ramp, no crash", over[0] === 0 && over[99] === 99 / 5000);
  check("fade: negative or partial samples refused", throws(() => P.fade(x, -1, 0), /whole samples/) && throws(() => P.fade(x, 0, 1.5), /whole samples/));

  const r = Float64Array.from({ length: 777 }, () => rnd()), rev = P.reverse(r);
  check("reverse: the first sample is the last, and the sound is left as it was", rev[0] === r[776] && rev[776] === r[0] && !same(rev, r));
  check("reverse twice is the sound itself", same(P.reverse(rev), r));
  check("reverse of nothing is nothing", P.reverse(new Float64Array(0)).length === 0);

  const st = pcm16(44100, [[16384, -32768, 0, 8192], [-8192, 0, 0, 24576]]), w = L.readWav(st, true);
  const mono = P.mixDown(w.chs);
  check("mono: the mean of a known pair (L 0.5 / R -0.25 gives 0.125; -1 / 0 gives -0.5), as readWav takes it",
    same(mono, [0.125, -0.5, 0, 0.5]) && same(mono, w.x));
  check("mono: one channel alone", same(P.mixDown(w.chs, 1), [-0.25, 0, 0, 0.75]) && P.mixDown(w.chs, 0) === w.chs[0]);
  check("mono: a channel the sound does not have refused", throws(() => P.mixDown(w.chs, 2), /the sound has 2/) && throws(() => P.mixDown(w.chs, -2), /channel -2/) &&
    throws(() => P.mixDown(w.chs, 0.5), /channel/) && throws(() => P.mixDown([]), /no channels/));
  check("readWav without keep: no channels kept (the old shape)", L.readWav(st).chs === null && L.readWav(st, true).chs.length === 2);
}

// loops
{
  check("loop: kept inside a trim that cuts into it", JSON.stringify(P.fitLoop([100, 300], 200, 1000)) === "[200,300]" && JSON.stringify(P.fitLoop([100, 300], 0, 250)) === "[100,250]");
  check("loop: lost when under 32 samples are left of it, or none was set", P.fitLoop([100, 300], 280, 1000) === null && P.fitLoop(null, 0, 10) === null);
  check("loop in a trim [50, 500): moved to the trim's start; reversed: mirrored",
    JSON.stringify(P.mapLoop([100, 300], 50, 500)) === "[50,250]" && JSON.stringify(P.mapLoop([100, 300], 50, 500, true)) === "[200,400]");
  check("loop by hand: inside the trim, 32 samples or more, start before end",
    P.checkLoop([100, 200], 0, 500)[1] === 200 && throws(() => P.checkLoop([200, 200], 0, 500), /before the end/) && throws(() => P.checkLoop([100, 120], 0, 500), /32 samples/) &&
    throws(() => P.checkLoop([100, 600], 0, 500), /inside the trim/) && throws(() => P.checkLoop([10, 200], 50, 500), /inside the trim/) && throws(() => P.checkLoop([1.5, 200], 0, 500), /whole samples/));
}

// moving the cuts and the loop's ends the way the editor's handles and fields do
{
  const x = sine(1000, 100, 0.3), p = { start: 0, end: 1000, loop: null };
  check("move a cut: typed values land as given, or on the crossing nearby with snap (30 -> 50)", P.moveCut(x, p, "start", 30, false) === 30 && P.moveCut(x, p, "start", 30, true) === 50);
  check("move a cut: a typed start at or past the end, or past the sound, is refused", throws(() => P.moveCut(x, { ...p, end: 500 }, "start", 500, false), /before the end/) &&
    throws(() => P.moveCut(x, p, "end", 1001, false), /1000 samples/) && throws(() => P.moveCut(x, p, "start", 2.5, true), /whole samples/) && throws(() => P.moveCut(x, p, "start", NaN, true), /whole samples/));
  check("move a cut: a dragged one stops at the nearest legal place (the other cut less 32; the ends)",
    P.moveCut(x, { ...p, end: 500 }, "start", 900, false, true) === 468 && P.moveCut(x, { ...p, start: 200 }, "end", 10, false, true) === 232 &&
    P.moveCut(x, p, "start", -50, false, true) === 0 && P.moveCut(x, p, "end", 5000, false, true) === 1000 && P.moveCut(x, p, "start", 30.4, false, true) === 30);
  check("move a cut: snapping never makes an illegal cut (a crossing that would leave 20 or 30 samples is passed over, the typed place kept)",
    P.moveCut(x, { ...p, end: 120 }, "start", 85, true) === 85 && P.moveCut(x, { ...p, end: 300 }, "start", 85, true) === 100 &&
    P.moveCut(x, { ...p, start: 520 }, "end", 560, true) === 560 && P.moveCut(x, p, "end", 530, true) === 550);
  check("move a cut: neither end named start or end refused", throws(() => P.moveCut(x, p, "middle", 5, false), /no trim end/));
  const q = { start: 100, end: 600, loop: [200, 400] };
  check("move the loop: an end typed lands inside the trim; with snap on the crossing (a loop start 320 -> 300)",
    JSON.stringify(P.moveLoop(x, q, "start", 250, false)) === "[250,400]" && P.moveLoop(x, q, "start", 320, true)[0] === 300 && P.moveLoop(x, { ...q, loop: null }, "end", 300, false)[0] === 100);
  check("move the loop: outside the trim, under 32 samples, backwards or in parts of a sample refused",
    throws(() => P.moveLoop(x, q, "end", 700, false), /inside the trim/) && throws(() => P.moveLoop(x, q, "start", 380, false), /32 samples/) &&
    throws(() => P.moveLoop(x, q, "start", 450, false), /before the end/) && throws(() => P.moveLoop(x, q, "end", 300.5, false), /whole samples/) && throws(() => P.moveLoop(x, q, "left", 300, false), /no loop end/));
}

// the pipeline: prepare
const base =() => ({ rate: 22050, chs: [Float64Array.from({ length: 2000 }, (_, i) => 0.5 * Math.sin(i * 0.05))], loop: [100, 900] });
{
  const src = base(), p0 = P.defaults(src, false), o0 = P.prepare(src, p0);
  check("prepare: the defaults of a sound change nothing (the sound, its loop, its rate)", same(o0.x, src.chs[0]) && JSON.stringify(o0.loop) === "[100,900]" && o0.rate === 22050 && !o0.over && !o0.silent);
  check("prepare: a new sound is levelled to the bank's by default, a stored one is not", P.defaults(src, true).normTo === P.BANK_DB && P.defaults(src, false).normTo === null);
  const o1 = P.prepare(src, { ...p0, start: 200, end: 1000 });
  check("prepare: trim [200, 1000) keeps 800 samples; the loop is clipped to it and moved", o1.x.length === 800 && o1.x[0] === src.chs[0][200] && JSON.stringify(o1.loop) === "[0,700]");
  check("prepare: a trim that leaves the loop under 32 samples drops it", P.prepare(src, { ...p0, start: 880 }).loop === null);
  const o2 = P.prepare(src, { ...p0, start: 200, end: 1000, reverse: true });
  check("prepare: reversed, the loop's first sample is the source's last one in it, and its last the source's first",
    o2.x[o2.loop[0]] === src.chs[0][899] && o2.x[o2.loop[1] - 1] === src.chs[0][200] && JSON.stringify(o2.loop) === "[100,800]");
  const o3 = P.prepare(src, { ...p0, fadeIn: 20, fadeOut: 40 });
  const n3 = o3.x.length;
  check("prepare: fades in ms (20 ms = 441 samples in, 40 ms = 882 out): the ends 0, the middle untouched",
    o3.x[0] === 0 && o3.x[n3 - 1] === 0 && o3.x[441] === src.chs[0][441] && o3.x[n3 - 1 - 882] === src.chs[0][n3 - 1 - 882] && o3.x[220] !== src.chs[0][220]);
  const pk = Float64Array.from({ length: 400 }, (_, i) => (i === 10 ? 1 : 0.2 * Math.sin(i * 0.3)));
  const o4 = P.prepare({ rate: 22050, chs: [pk], loop: null }, { ...P.defaults({ chs: [pk], loop: null }, true), fadeIn: 10, normTo: -6 });
  check("prepare: the level is set after the fades (the peak sat in the fade-in: still -6 dBFS)", near(o4.peak, P.fromDb(-6), 1e-9) && o4.x[10] !== o4.peak);
  const o5 = P.prepare(src, { ...p0, normTo: -6, gain: 3 });
  check("prepare: normalise to -6 dBFS then +3 dB gain: the peak is -3 dBFS", near(o5.peak, P.fromDb(-3), 1e-9) && !o5.over);
  const o6 = P.prepare(src, { ...p0, normTo: 0, gain: 1 });
  check("prepare: a gain past full scale is marked over", o6.over && near(o6.peak, P.fromDb(1), 1e-9));
  check("prepare: over full scale: the bank entry, the stored entry and the WAV all refuse it",
    throws(() => P.peakInt(o6), /over full scale/) && throws(() => P.newItem(o6, {}), /over full scale/) && throws(() => P.storedItem(o6, {}), /over full scale/) && throws(() => P.encodeWav(o6), /over full scale/));
  check("prepare: at exactly 0 dBFS is not over", !P.prepare(src, { ...p0, normTo: 0 }).over && P.peakInt(P.prepare(src, { ...p0, normTo: 0 })) === 32767);
  const sil = { rate: 22050, chs: [new Float64Array(500)], loop: null }, os = P.prepare(sil, P.defaults(sil, true));
  check("prepare: silence is silence (not over, peak 0, every sample 0), stored at the bank's level", os.silent && !os.over && os.peak === 0 && os.x.every((v) => v === 0) && P.peakInt(os) === 30000);
  const clip = { rate: 22050, chs: [Float64Array.from([0, 0.5, 1, 1, 1, 1, 0.5, 0, ...new Float64Array(40)])], loop: null };
  check("prepare: a clipped input reports its flat-top samples, a clean one 0", P.prepare(clip, P.defaults(clip, true)).clipped === 4 && o0.clipped === 0);
  const two = { rate: 22050, chs: [new Float64Array(64).fill(0.25), new Float64Array(64).fill(-0.5)], loop: null }, p2 = P.defaults(two, false);
  check("prepare: mono mix-down of two channels, or one of them", P.prepare(two, p2).x.every((v) => v === -0.125) && P.prepare(two, { ...p2, channel: 1 }).x.every((v) => v === -0.5));
  check("prepare: a setting it cannot use is refused, not guessed",
    throws(() => P.prepare(src, { ...p0, fadeIn: -5 }), /fade/) && throws(() => P.prepare(src, { ...p0, fadeOut: NaN }), /fade/) &&
    throws(() => P.prepare(src, { ...p0, start: 500, end: 500 }), /before the end/) && throws(() => P.prepare(src, { ...p0, channel: 3 }), /channel/));
  check("prepare: the source is left as it was", same(src.chs[0], base().chs[0]) && JSON.stringify(src.loop) === "[100,900]");
}

// a prepared sample in the bank: as a new item (the bank resamples and encodes) and as a stored one (kept at its rate)
const entryOf = (img) => L.parseHeader(img.subarray(0, L.BANK_HDR)).entries;
{
  const src = base(), p = { ...P.defaults(src, true), start: 300, end: 1700, fadeOut: 20, normTo: -12 };
  const out = P.prepare(src, p), item = P.newItem(out, { name: "edit", root: 61, bars: 0, rate: 22050 });
  const want = Math.round(P.fromDb(-12) * 32768);
  check(`new item: its level is the one asked for (-12 dBFS = ${want} of 32768), its loop a file's way ([start, last])`,
    item.peak === want && JSON.stringify(item.loop) === "[0,599]" && item.sr === 22050 && item.x === out.x);
  const { img } = L.build([item]), e = entryOf(img)[0];
  const back = L.imaDecode(img.subarray(e.adpOff, e.adpOff + ((e.n + 1) >> 1)), e.n);
  check("new item: the bank entry holds 1400 samples at 22050 Hz, root 61, the loop [0, 600) the bank's way",
    e.n === 1400 && e.rate === 22050 && e.root === 61 && e.bars === 0 && e.ls === 0 && e.le === 600);
  check(`new item: the stored peak is -12 dBFS (${peakI(back)} of ${want}, within the ADPCM's error)`, Math.abs(peakI(back) - want) < want * 0.05);
  const atBank = P.prepare(src, { ...p, normTo: P.BANK_DB }), viaEditor = P.newItem(atBank, { name: "edit", root: 61, bars: 0, rate: 22050 });
  const asFile = { name: "edit", x: atBank.x, sr: 22050, loop: viaEditor.loop, root: 61, bars: 0, rate: 22050 };
  check("new item: at the bank's level (peak 30000) its image is the one a file of the same sound gives, byte for byte",
    viaEditor.peak === 30000 && Buffer.compare(Buffer.from(L.build([viaEditor]).img), Buffer.from(L.build([asFile]).img)) === 0);
  check("new item: the peak the bank's default gives (no peak) stays 30000",
    peakI(L.atRate(out.x, 22050, null, 22050).s) === 30000 && peakI(L.atRate(out.x, 22050, null, 22050, 12345).s) === 12345);

  // too big: refused with the bank's own message; a trim that fits is built
  const nBig = 48000 * 40, big = { rate: 48000, chs: [sine(nBig, 480)], loop: null };
  const outBig = P.prepare(big, P.defaults(big, true));
  let tooLong = null;
  try { L.build([P.newItem(outBig, { name: "long", root: 60, bars: 0, rate: null })]); } catch (err) { tooLong = err; }
  check(`too big: 40 s of 48 kHz audio does not fit and says so (${tooLong && tooLong.message})`, tooLong instanceof L.TooLong && /too long/.test(tooLong.message));
  const outFit = P.prepare(big, { ...P.defaults(big, true), start: 0, end: 48000 * 8 });
  check("too big: trimmed to 8 s it builds", L.build([P.newItem(outFit, { name: "long", root: 60, bars: 0, rate: null })]).img.length > L.BANK_HDR);

  // stored: a sample read back from the bank, edited, kept at its rate and its level
  const orig = L.readWav(pcm16(22050, [Array.from(sine(6000, 50), (v) => Math.round(v * 20000))]));
  const kept = L.keptOf(L.build([{ name: "orig", x: orig.x, sr: orig.rate, loop: [500, 5000], root: 57, bars: 2, rate: 22050 }]).img)[0];
  const ss = P.sourceOfStored(kept);
  const dec = L.imaDecode(kept.adpcm, kept.n);
  check("stored: the source is the samples as the bank stores them, at their rate, with the bank's loop [ls, le)",
    ss.rate === 22050 && ss.chs[0].length === kept.n && ss.chs[0].every((v, i) => v * 32768 === dec[i]) && JSON.stringify(ss.loop) === JSON.stringify(kept.loop));
  const meta = { name: kept.name, root: kept.root, bars: kept.bars, flags: kept.flags };
  const ps = { ...P.defaults(ss, false), start: 1000, end: 5000 }, os = P.prepare(ss, ps), si = P.storedItem(os, meta);
  check("stored: a trim alone keeps every sample exactly (no resample, no emphasis again, no level change), at the same rate; the loop is the bank's [ls, le)",
    si.s instanceof Int16Array && same(si.s, dec.slice(1000, 5000)) && si.rate === 22050 && JSON.stringify(si.loop) === "[0,4000]");
  const e2 = entryOf(L.build([si]).img)[0];
  check("stored: the bank entry keeps its root and bars and its rate; its length is the trim's; its loop the one inside the trim",
    e2.n === 4000 && e2.rate === 22050 && e2.root === 57 && e2.bars === 2 && e2.ls === 0 && e2.le === 4000);
  const quiet = P.storedItem(P.prepare(ss, { ...ps, normTo: -6 }), meta), faded = P.storedItem(P.prepare(ss, { ...ps, fadeOut: 5 }), meta);
  check("stored: a new level is the peak asked for (-6 dBFS = 16423); a fade ends at 0 and leaves the rest as it was",
    peakI(quiet.s) === Math.round(P.fromDb(-6) * 32768) && faded.s[3999] === 0 && same(faded.s.slice(0, 3800), dec.slice(1000, 4800)));
  const stale = { ...ss, loop: [100, 400] }, gone = P.prepare(stale, { ...P.defaults(stale, false), start: 1000, end: 5000 });
  check("stored: a loop cut away by the trim is not stored", gone.loop === null && P.storedItem(gone, meta).loop === null && entryOf(L.build([P.storedItem(gone, meta)]).img)[0].le === 0);

  // the editor's hand-over: what it opens for a list item, and the item an edit puts back in the list
  const reopened = P.editOf(kept);
  check("editOf: a sample read back opens as stored (its decoded samples at its rate), the level left as it is",
    reopened.stored && reopened.src.rate === 22050 && reopened.src.chs[0].length === kept.n && reopened.p.normTo === null && reopened.p.start === 0 && reopened.p.end === kept.n);
  const fresh = { name: "n", x: orig.x, sr: 22050, loop: [500, 5000], root: 60, bars: 0, rate: null, isNew: true };
  const opened = P.editOf(fresh);
  check("editOf: a new sample opens as new, levelled to the bank's by default, its loop [start, last] as [ls, le)",
    !opened.stored && opened.p.normTo === P.BANK_DB && JSON.stringify(opened.p.loop) === "[500,5001]" && opened.src.chs[0] === orig.x);
  const eItem = P.editedItem(os, { ...kept, pic: new Int16Array(3) }, true, { src: ss, p: ps });
  const eEnt = entryOf(L.build([eItem]).img)[0];
  check("editedItem: the old sound's adpcm, checkpoints, length and picture are not kept; the bank holds the new sound under the old name, root and bars",
    !("adpcm" in eItem) && !("ckb" in eItem) && !("pic" in eItem) && !("n" in eItem) && eItem.edited === true && eEnt.n === 4000 && eEnt.root === 57 && eEnt.bars === 2 && eEnt.name === kept.name);
  const again = P.editOf(eItem);
  check("editOf: an edited item opens with the source and settings of its edit (a copy: changing them leaves the item's)",
    again.src === ss && again.p.start === 1000 && again.p !== ps && again.stored);
  const nItem = P.editedItem(out, { ...fresh, pic: new Int16Array(2) }, false, { src, p });
  check("editedItem: a new sample's edit carries the sound, its level and its loop, and keeps its name",
    nItem.x === out.x && nItem.peak === want && nItem.sr === 22050 && nItem.isNew && nItem.name === "n" && !("pic" in nItem) && JSON.stringify(nItem.loop) === "[0,599]" && !("s" in nItem));
}

// the WAV a prepared sample downloads as
{
  const src = base(), out = P.prepare(src, { ...P.defaults(src, true), start: 100, end: 1100 }), wavb = P.encodeWav(out);
  const dv = new DataView(wavb.buffer), back = L.readWav(wavb);
  const s = L.toInt16(out.x, P.peakInt(out));
  check("WAV: 1000 samples, mono 16-bit, the loop's 'smpl' chunk after the data (44 + 2000 + 68 bytes, the sizes as RIFF says)",
    wavb.length === 44 + 2000 + 68 && dv.getUint32(4, true) === wavb.length - 8 && dv.getUint32(40, true) === 2000 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16);
  check("WAV: read back as it was written: the rate, the samples (as the bank would store them), the loop [start, last sample]",
    back.rate === 22050 && back.x.length === 1000 && back.x.every((v, i) => v * 32768 === s[i]) && JSON.stringify(back.loop) === "[0,799]" && JSON.stringify(out.loop) === "[0,800]");
  const noLoop = P.encodeWav(P.prepare(src, { ...P.defaults(src, true), loop: null, start: 0, end: 500 }));
  check("WAV: without a loop no 'smpl' chunk (44 + 1000 bytes)", noLoop.length === 1044 && L.readWav(noLoop).loop === null);
  check("WAV: written to disk and read by the command line's reader: the same rate, samples and loop", (() => {
    const f = join(dir, "edited.wav");
    writeFileSync(f, wavb);
    const o = JSON.parse(py(`import json, pathlib, sampleio as sio
rate, v, loop = sio.read_any_wav(pathlib.Path("${f}"))
print(json.dumps({"rate": rate, "loop": list(loop) if loop else None, "s": [round(a * 32768) for a in v]}))`));
    return o.rate === 22050 && JSON.stringify(o.loop) === "[0,799]" && o.s.length === 1000 && o.s.every((v, i) => v === s[i]);
  })());
}

// the prepared sample's bank image is the command line's for the same samples, byte for byte
{
  const src = L.readWav(readFileSync(files[0][0]), true);
  const ws = { rate: src.rate, chs: src.chs, loop: src.loop ? [src.loop[0], src.loop[1] + 1] : null };
  const out = P.prepare(ws, { ...P.defaults(ws, true), start: 1000, end: 30000, fadeIn: 5, fadeOut: 20, normTo: -3 });
  const item = P.newItem(out, { name: "edit", root: 60, bars: 1, rate: 22050 });
  const j = join(dir, "prep.json");
  const asSamples = (s, loop) => JSON.stringify([{ name: "edit", s: Array.from(s), root: 60, loop, bars: 1, rate: 22050 }]);
  const pyImage = (spec) => { writeFileSync(j, spec); return Buffer.from(py(`import json, sampleio as sio
sp = json.load(open("${j}"))
sys.stdout.write(sio.user_bank([(p["name"], p["s"], p["root"], tuple(p["loop"]) if p["loop"] else None, p["bars"], p["rate"]) for p in sp]).hex())`), "hex"); };
  const { s, loop } = L.atRate(item.x, item.sr, item.loop, 22050, item.peak);
  check(`edited new sample (${s.length} samples at 22050 Hz, loop ${JSON.stringify(loop)}, peak ${item.peak}): the bank image is sampleio.user_bank's`,
    Buffer.compare(Buffer.from(L.build([item], 22050).img), pyImage(asSamples(s, loop))) === 0 && !!loop);
  if (hasNumpy) {
    writeFileSync(j, JSON.stringify({ x: Array.from(item.x), sr: item.sr, rate: 22050, peak: item.peak, loop: item.loop }));
    const ref = JSON.parse(py(`import json, sampleio as sio
d = json.load(open("${j}"))
lp = d["loop"]
print(json.dumps({"s": sio.to_int16(sio.emphasis(sio.resample(d["x"], d["sr"], d["rate"])), d["peak"]),
  "loop": [int(lp[0] * d["rate"] / d["sr"]), int((lp[1] + 1) * d["rate"] / d["sr"])]}))`));
    let diff = 0, worst = 0;
    for (let i = 0; i < Math.max(s.length, ref.s.length); i++) { const d = Math.abs((s[i] ?? 99999) - (ref.s[i] ?? -99999)); if (d) diff++; worst = Math.max(worst, d); }
    check(`edited new sample at a level of ${item.peak}: the samples and the loop as sampleio makes them (${diff} differ, at most ${worst})`,
      s.length === ref.s.length && worst <= 1 && diff <= s.length / 1000 && JSON.stringify(loop) === JSON.stringify(ref.loop) && peakI(s) === item.peak);
  } else console.log(`  skip the resampling comparison (${PY} has no numpy)`);

  const sp = P.sourceOfStored(L.keptOf(L.build([{ name: "edit", x: src.x, sr: src.rate, loop: src.loop, root: 60, bars: 1, rate: 22050 }]).img)[0]);
  const so = P.prepare(sp, { ...P.defaults(sp, false), start: 500, end: 9000, fadeIn: 3, normTo: -6 });
  const si = P.storedItem(so, { name: "edit", root: 60, bars: 1 });
  check(`edited stored sample (${si.s.length} samples, loop ${JSON.stringify(si.loop)}): the bank image is sampleio.user_bank's`,
    Buffer.compare(Buffer.from(L.build([si]).img), pyImage(asSamples(si.s, si.loop))) === 0 && !!si.loop && peakI(si.s) === P.peakInt(so));
}

// 6. the page itself: tools/make_pages.py inlines both libraries into the page's one module script (strip_module: no export,
// no import), so a name two of them define, or a slip in the page's own script, would stop the whole page; and every id the
// script asks for must be in the markup
{
  const strip = (t) => t.replace(/^export\s+/gm, "").replace(/^import .*?;\n/gm, "");
  const here = (f) => new URL(f, import.meta.url);
  const html = readFileSync(here("../../app/web/samples/index.html"), "utf8");
  const script = html.match(/<script type="module">\n([\s\S]*?)<\/script>/)[1];
  const libs = strip(readFileSync(here("../../app/web/samples/soundplant_samples.js"), "utf8")) +
    strip(readFileSync(here("../../app/web/samples/soundplant_prep.js"), "utf8"));
  const page = script.replace("/*LIB*/", libs);
  const parses = (code) => {
    const f = join(dir, "page.mjs");
    writeFileSync(f, code);
    try { execFileSync(process.execPath, ["--check", f], { stdio: ["ignore", "pipe", "pipe"] }); return ""; }
    catch (e) { return String(e.stderr).split("\n").find((l) => /Error/.test(l)) || "failed"; }
  };
  check("the page's script, with both libraries inlined, is one valid module scope", parses(page) === "");
  const clash = parses(page + "\nfunction trim() {}\n");
  check(`a name defined twice in that scope is caught by the same check (${clash})`, /already been declared/.test(clash));
  check("the libraries are really inlined (the page's script has no LIB marker left)", !page.includes("/*LIB*/") && page.includes("function prepare("));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const asked = [...new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
  const missing = asked.filter((id) => !ids.has(id));
  check(`every id the script asks for is in the page (${asked.length} ids)`, asked.length > 40 && missing.length === 0);
  check("an id the page does not have is found missing", ["pstart", "nonesuch"].filter((id) => !ids.has(id)).join() === "nonesuch");
}

rmSync(dir, { recursive: true, force: true });
console.log(bad ? "SAMPLES WEB FAILED" : "samples web: as soundplant_samples.py");
process.exit(bad ? 1 : 0);
