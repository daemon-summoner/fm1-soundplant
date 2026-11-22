// SPDX-License-Identifier: MPL-2.0
// The project editor's codec (app/web/project/soundplant_project.js) against real backups and the firmware itself. The images are
// the demo songs' setups saved into the three project slots by the host simulator (tools/demos/*.xy, as
// tools/demos/device_projects.py runs them); the simulator also restores what the codec writes:
//   1. decode then encode gives every real image back byte for byte; what it writes is a backup base/tools/fm1_backup.py accepts
//   2. what the model holds is what the firmware reads: each slot restored and loaded in the simulator, its tempo, names, levels,
//      scenes, song and every pattern listing (the simulator's `steps`) equal the model's
//   3. lzCompress is the firmware's compressor (app/lz.c): the packed tracks and patterns the simulator stored come out identical,
//      and so do its outputs on inputs the demos do not reach (past 64 KB back, runs, noise)
//   4. an edited image restores and plays as edited (tempo, a name, level and pan, melodic steps, a kit sound, a cleared step,
//      step and pattern settings, a scene's patterns, a song part): only the edited bytes differ, the other slots' records and the
//      sample section stay as they were; a slot of seven flash sectors (the most) restores and plays
//   5. a bad image throws a ProjectError, never partial data: wrong magic, a flipped byte anywhere, a cut anywhere, an unknown
//      container version or project format, a damaged pattern stream
//   6. encode refuses what the FM-1 would clamp or not hold: a tempo, a name, a level, a slot or the pool over the flash
//   7. the pattern helpers: notes, kit sounds, step lengths, conditions
//   8. the page (app/web/project/index.html) with the codec inlined as make_pages.py does: one valid module, every id it asks for
//  14. addDemoSlots (the Backup page's demo songs): whole songs from other backups go into the empty slots and nothing else changes,
//      the simulator restores and plays them; no empty slot, too many songs, a pool over 20 sectors, a damaged or old demo are refused
//   node tests/host/project_web.mjs [PYTHON]       (the simulator: $SOUNDPLANT_HOST, default app/build/host/soundplant_host)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../../app/web/project/soundplant_project.js";
import * as M from "../../app/web/project/soundplant_midi.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PY = process.argv[2] || process.env.PYTHON || "python3";
const HOST = process.env.SOUNDPLANT_HOST || join(ROOT, "app/build/host/soundplant_host");
if (!existsSync(HOST)) throw new Error(`no simulator at ${HOST}: ./build.sh --host, or SOUNDPLANT_HOST`);

let bad = 0;
const check = (what, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad++; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const u16 = (b, o) => b[o] | b[o + 1] << 8;
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const put32 = (b, o, v) => { b[o] = v; b[o + 1] = v >>> 8; b[o + 2] = v >>> 16; b[o + 3] = v >>> 24; };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const refuses = (what, fn, re) => { const e = thrown(fn); check(what, e instanceof P.ProjectError && re.test(e.message)); };
const refusesMidi = (what, fn, re) => { const e = thrown(fn); check(what, e instanceof M.MidiError && e.name === "MidiError" && re.test(e.message)); };
const plain = (v) => JSON.stringify(v, (k, x) => k === "_src" || k === "_raw" ? undefined : ArrayBuffer.isView(x) ? Array.from(x) : x);

// the container, read and written apart from the codec's own: head 16 bytes, records (id, len, CRC-32, payload), the file's CRC-32
function records(img) {
  const recs = [];
  let at = 16;
  for (let k = 0; k < u16(img, 6); k++) {
    const len = u16(img, at + 2);
    recs.push({ id: u16(img, at), payload: img.slice(at + 8, at + 8 + len) });
    at += 8 + len;
  }
  return { recs, end: at + 4 };
}
function build(payloads, { magic = 0x42384D4C, version = 1, flags = 0 } = {}) {
  const out = new Uint8Array(16 + payloads.reduce((a, p) => a + 8 + p.length, 4));
  put32(out, 0, magic); out[4] = version; out[6] = payloads.length; put32(out, 8, flags); put32(out, 12, P.crc32(out, 0, 12));
  let at = 16;
  payloads.forEach((p, k) => {
    out[at] = k + 1; out[at + 2] = p.length; out[at + 3] = p.length >> 8; put32(out, at + 4, P.crc32(p));
    out.set(p, at + 8);
    at += 8 + p.length;
  });
  put32(out, at, P.crc32(out, 0, at));
  return out;
}
// the image with some payloads changed and every CRC-32 made again: damage the checks do not see
const rebuilt = (img, edit) => { const { recs } = records(img); const p = recs.map((r) => r.payload); edit(p); return build(p, { flags: u32(img, 8) }); };
const withSections = (img, ...secs) => {
  const parts = [img];
  for (const [tag, data] of secs) {
    const s = new Uint8Array(12 + data.length);
    for (let i = 0; i < 4; i++) s[i] = tag.charCodeAt(i);
    put32(s, 4, data.length); s.set(data, 8); put32(s, 8 + data.length, P.crc32(data));
    parts.push(s);
  }
  return Uint8Array.from(parts.flatMap((a) => Array.from(a)));
};

// a slot's stored bytes: settings (a 58 byte head, the packed tracks' length, the packed tracks), then the patterns' stream:
// objects 2..7 hold its packed bytes (16 bytes of header in the first, 4 in each next)
const SET_HEAD = 58, TRK_RAW = P.NALLTRK * (P.TP.N + P.NAME_LEN + 4), PATS_RAW = 71572;
function slotRaw(img, n) {
  const objs = records(img).recs.slice(1 + n * 7, 8 + n * 7).map((r) => r.payload);
  if (!objs[0].length) return null;
  const tlen = u32(objs[0], SET_HEAD), plen = u32(objs[1], 12), packed = new Uint8Array(plen);
  let got = Math.min(plen, objs[1].length - 16);
  packed.set(objs[1].subarray(16, 16 + got));
  for (let k = 2; got < plen; k++) {
    const take = Math.min(plen - got, objs[k].length - 4);
    packed.set(objs[k].subarray(4, 4 + take), got);
    got += take;
  }
  return {
    objs, head: objs[0].subarray(0, SET_HEAD), trkPacked: objs[0].subarray(SET_HEAD + 4, SET_HEAD + 4 + tlen), packed,
    trk: P.lzDecompress(objs[0], SET_HEAD + 4, tlen, TRK_RAW), pats: P.lzDecompress(packed, 0, plen, PATS_RAW),
  };
}
const diffs = (a, b) => { const d = []; a.forEach((v, i) => { if (v !== b[i]) d.push(i); }); return d; };
const only = (offs, spans) => offs.length > 0 && offs.every((o) => spans.some(([s, e]) => o >= s && o < e));
// patterns_t: pat[10][8] of 776 bytes (64 steps of 12, then 8 of settings), scene[32] of 26 at 70368, the song at 71200
const stepAt = (t, p, s) => (t * 8 + p) * 776 + s * 12;
const stepSpan = (t, p, s) => [stepAt(t, p, s), stepAt(t, p, s) + 12];
const tailSpan = (t, p) => [stepAt(t, p, 64), stepAt(t, p, 64) + 8];
const SCENE0 = 70368, SONG0 = 71200;

// ---- the simulator
const work = mkdtempSync(join(tmpdir(), "soundplant-project-"));
function hostRun(lines, tag = "run") {
  const xy = join(work, `${tag}.xy`);
  writeFileSync(xy, lines.join("\n") + "\n");
  const r = spawnSync(HOST, [xy, work], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  const out = r.stdout + r.stderr;
  return { rc: r.status, out, fails: out.split("\n").filter((l) => /^\s*FAIL/.test(l)), oks: out.split("\n").filter((l) => /^ {2}ok /.test(l)).length };
}
const demoSetup = (song) => {
  const lines = readFileSync(join(ROOT, "tools/demos", `${song}.xy`), "utf8").split("\n");
  const end = lines.findIndex((l) => l.trim() === "tap HOME");
  if (end < 0) throw new Error(`tools/demos/${song}.xy has no "tap HOME" line (where its performance starts)`);
  return lines.slice(0, end).filter((l) => l.trim() && !l.trimStart().startsWith("#") && !/^(master|samples) /.test(l));
};
function makeImage(name, script) {
  const r = hostRun([...script, `backup out:${name}.soundplant`], name);
  if (r.rc !== 0 || r.fails.length) throw new Error(`the simulator could not make ${name}: rc ${r.rc}\n${r.out.slice(-800)}`);
  return new Uint8Array(readFileSync(join(work, `${name}.soundplant`)));
}
const songsImage = (name, songs) => makeImage(name, ["master 4096", ...songs.flatMap((song, k) =>
  [...(k ? ["projnew"] : []), ...demoSetup(song), `projsave ${k + 1} ${song.slice(0, 11)}`, "wait 200"])]);

// the slot n (0-based) loaded from HOME's list after the image's restore; then the simulator's own reading of the slot
const loadSlot = (n) => ["tap HOME", "wait 300", "tap SEL", "wait 300", "turn SELECT 8", "wait 200", "said LOAD PROJECT",
  ...(n ? [`turn ALGO ${n}`, "wait 200"] : []), "tap SEL", "wait 500", `said LOADED slot ${n + 1}`];
const STEPS_LINE = /^ {2}track \d+ pattern \d+:|^ {4}[ \d]\d:/;
const stepsText = (out) => out.split("\n").filter((l) => STEPS_LINE.test(l)).join("\n");
// the simulator's `steps T P` for the model's pattern, as host.c prints it
function modelSteps(s, t, p) {
  const pat = s.patterns[t][p], kit = P.isKitTrack(s, t);
  const rows = [`  track ${t + 1} pattern ${p + 1}: ${pat.len} steps, scale ${pat.scale}, nlen ${pat.nlen}`];
  for (let i = 0; i < pat.len; i++) {
    const st = pat.steps[i];
    if (P.stepIsEmpty(st) && !st.comp && !st.comp2 && !st.cond) continue;
    const notes = kit ? Array.from({ length: P.NDRUM }, (_, k) => k + 1).filter((k) => P.kitHas(st, k)) : st.notes.filter((n) => n);
    rows.push(`    ${String(i + 1).padStart(2)}:${notes.map((n) => ` ${n}`).join("")}  vel ${st.vel} len ${st.len} nudge ${st.nudge} ` +
              `comp ${st.comp}/${st.cval} comp2 ${st.comp2}/${st.cval2} cond ${st.cond}`);
  }
  return rows.join("\n");
}
const allSteps = (s) => Array.from({ length: P.NTRK }, (_, t) => Array.from({ length: P.NPATT }, (_, p) => modelSteps(s, t, p)).join("\n")).join("\n");
// the values the simulator can be asked for
function modelExpects(s) {
  const e = [`tempo ${Math.round(s.tempoX10 / 10)}`, `trk ${s.trkSel + 1}`, `songlen ${s.song.len}`, `scene ${s.scene + 1}`,
    `used ${s.scenes.reduce((m, sc, k) => m | sc.used << k, 0)}`];
  s.tracks.forEach((t, k) => {
    if (k < P.NTRK) e.push(`name${k + 1} ${t.name.charCodeAt(0) || 0}`, `par${k + 1}.engine ${t.par[P.TP.ENGINE]}`);
    e.push(`par${k + 1}.level ${t.par[P.TP.LEVEL]}`, `par${k + 1}.pan ${t.par[P.TP.PAN]}`);
  });
  s.scenes.forEach((sc, k) => sc.pat.forEach((v, t) => e.push(`spat${k + 1}.${t + 1} ${v + 1}`)));
  s.song.slots.slice(0, s.song.len).forEach((p, k) => e.push(`slotsc${k + 1} ${p.scene + 1}`));
  return e;
}
// restore the image, load its slot n, ask the simulator about the model's slot: no failure, and the pattern listings equal the model's
function agrees(img, n, slot, tag) {
  const file = `${tag}.soundplant`;
  writeFileSync(join(work, file), img);
  const ask = modelExpects(slot);
  const steps = [];
  for (let t = 1; t <= P.NTRK; t++) for (let p = 1; p <= P.NPATT; p++) steps.push(`steps ${t} ${p}`);
  const r = hostRun(["master 4096", `restore out:${file}`, "expect restore_rc 0", "wait 300", "listen", ...loadSlot(n),
    ...ask.map((x) => `expect ${x}`), ...steps], tag);
  return { ...r, asked: ask.length, listing: stepsText(r.out) === allSteps(slot) };
}
// the firmware tool's own reading of a file: [parts, parts with data, sections]
const py = (code) => execFileSync(PY, ["-c", `import sys; sys.path.insert(0, "base/tools")\n${code}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
function firmwareToolReads(img, tag) {
  const f = join(work, `${tag}.soundplant`);
  writeFileSync(f, img);
  return py(`import fm1_backup as B\nimage, secs = B.split(open("${f}","rb").read())\nflags, objs = B.parse(image)\n` +
            `print(len(objs), sum(1 for _, p in objs if p), len(secs))`).trim();
}

// noise in valid ranges, to fill a slot's patterns: packed it does not shrink, so a slot of it takes the flash it can
let noiseSeed = 2463534242;   // xorshift32 (an LCG's low bits repeat within 2^15 draws, and the packer would find it)
const noise = (n) => {
  noiseSeed ^= noiseSeed << 13; noiseSeed >>>= 0;
  noiseSeed ^= noiseSeed >>> 17;
  noiseSeed ^= noiseSeed << 5; noiseSeed >>>= 0;
  return noiseSeed % n;
};
const noiseStep = (kit) => ({
  notes: kit ? [noise(256), noise(8), 0, 0] : [noise(128), noise(128), noise(128), noise(128)], vel: noise(128), len: noise(113), nudge: noise(25) - 12,
  comp: noise(16), cval: noise(256), cond: noise(135), comp2: noise(16), cval2: noise(256),
});
// patterns of noise in slot n, one by one while its packed size is not past target; how many it took (all 64 for Infinity)
function fill(model, n, target) {
  const s = model.slots[n];
  let count = 0;
  for (let t = 0; t < P.NTRK; t++) for (let p = 0; p < P.NPATT; p++) {
    if (target < Infinity && P.measure(model).slots[n].packed > target) return count;
    s.patterns[t][p].len = 64;
    s.patterns[t][p].steps = s.patterns[t][p].steps.map(() => noiseStep(P.isKitTrack(s, t)));
    count++;
  }
  return count;
}
const SEVEN = 19200;   // packed bytes that need all seven of a slot's objects (the stream's first holds 3824, each next 3836: five hold 19168)

// ---- MIDI: a writer and a reader of the test's own, apart from the library's
const be = (v, n) => Array.from({ length: n }, (_, k) => v >>> 8 * (n - 1 - k) & 255);
const vl = (v) => { const o = [v & 127]; while ((v = Math.floor(v / 128)) > 0) o.unshift(v & 127 | 128); return o; };
const ev = (delta, ...bytes) => [...vl(delta), ...bytes];
const eot = (delta = 0) => ev(delta, 0xFF, 0x2F, 0);
const txt = (s) => Array.from(s, (c) => c.charCodeAt(0));
const tempoEv = (delta, uspq) => ev(delta, 0xFF, 0x51, 3, ...be(uspq, 3));
const nameEv = (s) => ev(0, 0xFF, 0x03, s.length, ...txt(s));
// a file from tracks (arrays of event bytes, each already ending in its end-of-track); header fields can be set wrong
const smf = (tracks, { format = 1, ppq = 96, ntrks = tracks.length, hlen = 6 } = {}) => Uint8Array.from([
  ...txt("MThd"), ...be(hlen, 4), ...be(format, 2), ...be(ntrks, 2), ...be(ppq, 2), ...Array(Math.max(0, hlen - 6)).fill(0),
  ...tracks.flatMap((t) => [...txt("MTrk"), ...be(t.length, 4), ...t])]);
// notes [{tick, end, key, vel = 100, ch = 0}] as one track's events, in time order, offs before ons at a tick
function trackOf(notes, { tail = 0, head = [] } = {}) {
  const list = notes.flatMap((n) => [{ at: n.tick, rank: 1, b: [0x90 | (n.ch || 0), n.key, n.vel ?? 100] }, { at: n.end, rank: 0, b: [0x80 | (n.ch || 0), n.key, 64] }]);
  list.sort((x, y) => x.at - y.at || x.rank - y.rank);
  const out = [...head];
  let at = 0;
  for (const e of list) { out.push(...ev(e.at - at, ...e.b)); at = e.at; }
  return [...out, ...eot(Math.max(0, tail - at))];
}

// a second reader, for the files toMidi writes: every status byte explicit, and nothing but notes and meta events
function refRead(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const four = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (four(0) !== "MThd" || dv.getUint32(4) !== 6) throw new Error("ref: not a six byte MThd");
  const file = { format: dv.getUint16(8), ntrks: dv.getUint16(10), division: dv.getUint16(12), tracks: [] };
  let o = 14;
  while (o < bytes.length) {
    if (four(o) !== "MTrk") throw new Error(`ref: chunk ${four(o)}`);
    const end = o + 8 + dv.getUint32(o + 4), list = [];
    let p = o + 8, tick = 0;
    const num = () => { let v = 0, b; do { b = bytes[p++]; v = v * 128 + (b & 127); } while (b & 128); return v; };
    while (p < end) {
      tick += num();
      const st = bytes[p++];
      if (st === 0xFF) {
        const type = bytes[p++], n = num();
        list.push({ tick, meta: type, data: Array.from(bytes.subarray(p, p + n)) });
        p += n;
      } else if ((st & 0xF0) === 0x80 || (st & 0xF0) === 0x90) {
        list.push({ tick, on: (st & 0xF0) === 0x90, ch: st & 15, key: bytes[p], vel: bytes[p + 1] });
        p += 2;
      } else {
        throw new Error(`ref: status byte ${st.toString(16)}`);
      }
    }
    if (p !== end) throw new Error("ref: event past the chunk");
    file.tracks.push(list);
    o = end;
  }
  if (file.tracks.length !== file.ntrks) throw new Error("ref: track count");
  return file;
}
const noteLines = (list) => list.filter((e) => e.on !== undefined).map((e) => `${e.tick} ${e.on ? "on" : "off"} ${e.key} v${e.vel} ch${e.ch + 1}`);
const metaOf = (list, type) => list.filter((e) => e.meta === type);
const ascii = (d) => String.fromCharCode(...d);

// a slot with just what toMidi and fromMidi read; kits are the tracks on the kit engine
const par = (eng) => { const a = new Uint8Array(P.TP.N); a[P.TP.ENGINE] = eng; return a; };
const synth = (kits = [], names = {}) => ({
  tempoX10: 1200,
  tracks: Array.from({ length: P.NALLTRK }, (_, t) => ({ name: names[t] || "", par: par(kits.includes(t) ? P.EG_DRUMLINE : 0), rsv: new Uint8Array(4) })),
  patterns: Array.from({ length: P.NTRK }, () => Array.from({ length: P.NPATT }, P.newPattern)),
  scenes: Array.from({ length: P.NSCENE }, () => ({ pat: Array(P.NSEQT).fill(0), mute: 0 })),
});
const stp = (notes, o = {}) => ({ ...P.newStep(), notes: [...notes, 0, 0, 0, 0].slice(0, 4), ...o });
const kstp = (sounds, o = {}) => { const s = { ...P.newStep(), ...o }; P.kitSet(s, sounds.reduce((m, k) => m | 1 << k - 1, 0)); return s; };
const putPattern = (slot, t, p, o, steps) => {
  const pat = slot.patterns[t][p];
  Object.assign(pat, o);
  Object.entries(steps).forEach(([i, st]) => { pat.steps[i] = st; });
  return pat;
};
const modelOf = (slot) => ({ slots: [slot, null, null] });
const asExport = (slot, o) => M.toMidi(modelOf(slot), { slot: 0, ...o });
const importOf = (slot, bytes, o) => M.fromMidi(bytes, { slot, track: 0, pattern: 0, midiTrack: 1, ...o });
const counts = (r) => Object.fromEntries(r.report.map((x) => [x.key, x.count]));
// a step as the file can say it: its notes sorted, velocity 100 for 0, and the length and nudge
const norm = (st, kit) => JSON.stringify({
  n: kit ? Array.from({ length: P.NDRUM }, (_, k) => k + 1).filter((k) => P.kitHas(st, k)) : st.notes.filter((v) => v).sort((a, b) => a - b),
  v: st.vel || 100, l: st.len, d: st.nudge,
});
const countNotes = (pat, kit) => pat.steps.reduce((a, st) => a + (kit ? Array.from({ length: P.NDRUM }, (_, k) => k + 1).filter((k) => P.kitHas(st, k)).length : st.notes.filter((v) => v).length), 0);

const ctr = (r) => Object.entries(counts(r)).map(([k, v]) => `${k} ${v}`).join(", ");
const where = (r) => r.pattern.steps.map((st, i) => (st.notes[0] ? i : -1)).filter((i) => i >= 0).join(",");
// a melodic pattern with every field the export reads
function richSlot() {
  const o = synth([], { 0: "Lead" });
  putPattern(o, 0, 0, { len: 4 }, {
    0: stp([60], { vel: 90 }), 1: stp([67, 64], { len: 8, nudge: 6 }), 2: stp([72], { vel: 127, len: 4, nudge: -3 }), 3: stp([48], { vel: 1, len: 65 }),
  });
  return o;
}
let midiSeed = 0x9E3779B9;   // xorshift32, its own stream: noise() is the packer tests'
const rng = (n) => { midiSeed ^= midiSeed << 13; midiSeed >>>= 0; midiSeed ^= midiSeed >>> 17; midiSeed ^= midiSeed << 5; midiSeed >>>= 0; return midiSeed % n; };
const SIX = [0.5, 1, 2, 3, 4, 5, 6, 8, 16];
const ticksOf = (code, S, def) => (code === 0 ? def : code <= 64 ? code * S / 4 : (code - 48) * S);
// a pattern of random notes that the file can say exactly (no same pitch overlapping, nothing past the end, no nudge before the
// start), and the step list the import should give: the notes sorted, velocity 0 as 100, a length equal to the pattern's as 0
function randomPattern(kit, scale, nlen) {
  const S = 96 * SIX[scale], unit = S / (scale === 0 ? 48 : 24), len = 1 + rng(64), cycle = len * S, def = Math.max(1, Math.round(nlen * S / 100));
  const pat = { ...P.newPattern(), len, scale, nlen }, want = Array.from({ length: P.NSTEP }, () => norm(P.newStep(), kit));
  const busy = new Map();
  for (let i = 0; i < len; i++) {
    if (rng(100) < 45) continue;
    const nudge = i === 0 ? rng(13) : scale === 0 ? rng(25) - 12 : rng(24) - 11, on = i * S + nudge * unit;
    let code = rng(100) < 15 ? 0 : rng(100) < 12 ? 65 + rng(48) : 1 + rng(64);
    while (code && on + ticksOf(code, S, def) > cycle) code = code > 64 ? 1 + rng(64) : code >> 1;
    if (!code && on + def > cycle) code = 1;
    const ids = [];
    for (let tries = 0, n = 1 + rng(kit ? 6 : 4); tries < 40 && ids.length < n; tries++) {
      const id = kit ? 1 + rng(P.NDRUM) : 1 + rng(127);
      if (!ids.includes(id) && (busy.get(id) ?? -1) <= on) ids.push(id);
    }
    if (!ids.length) continue;
    ids.forEach((id) => busy.set(id, on + ticksOf(code, S, def)));
    const o = { vel: rng(100) < 10 ? 0 : 1 + rng(127), len: code, nudge };
    pat.steps[i] = kit ? kstp(ids, o) : stp(ids, o);
    want[i] = JSON.stringify({ n: [...ids].sort((a, b) => a - b), v: o.vel || 100, l: ticksOf(code, S, def) === def ? 0 : code, d: nudge });
  }
  if (pat.steps.every((st) => P.stepIsEmpty(st))) {
    pat.steps[0] = kit ? kstp([1]) : stp([60]);
    want[0] = JSON.stringify({ n: [kit ? 1 : 60], v: 100, l: 0, d: 0 });
  }
  return { pat, want };
}

// ---- real images: three songs in the three slots, four groups; one slot of user presets
const GROUPS = { A: ["jungle", "garage", "hyperpop"], B: ["house", "pop", "hiphop"], C: ["stress", "ambient", "house_acid"], D: ["weave_demo", "house_909", "pop"] };

try {
  const images = Object.fromEntries(Object.entries(GROUPS).map(([g, songs]) => [g, songsImage(`group_${g}`, songs)]));
  const presetsImg = makeImage("presets", ["master 4096", "wait 300", "preset 2 reese", "knob 2 x1 70", "usersave 2 3", "preset 3 reese", "usersave 3 5",
    "bpm 99", "projsave 1 presets", "wait 200"]);
  console.log("project codec: real backups from the simulator");
  {
    const slots = [];
    for (const [g, img] of Object.entries(images)) {
      const m = P.decode(img);
      const n = m.slots.filter(Boolean).length;
      check(`1. group ${g} (${img.length} bytes, ${n} slots): decode then encode is the image, byte for byte`, n === 3 && same(P.encode(m), img));
      check(`   ... and the firmware tool's reading: 22 parts, ${records(img).recs.filter((r) => r.payload.length).length} with data, no sections`,
            firmwareToolReads(img, `grp${g}`) === `22 ${records(img).recs.filter((r) => r.payload.length).length} 0`);
      slots.push(...m.slots.map((s, k) => [g, k, s]));
    }
    const m = P.decode(presetsImg);
    check("   slots never saved are absent from the model, and come back absent", m.slots[0] && !m.slots[1] && !m.slots[2] && same(P.encode(m), presetsImg));
    const m2 = P.decode(images.B);
    m2.slots[1].tempoX10 += 10;
    check("   an edit changes the image (the comparison above can tell)", !same(P.encode(m2), images.B));
    check("   crc32 is zlib's: the standard check value", P.crc32(new TextEncoder().encode("123456789")) === 0xCBF43926);
    const me = P.measure(P.decode(images.C));
    check(`   measure: the sectors the slots take (${me.sectors} of ${me.pool}) are the records with data`,
          me.sectors === records(images.C).recs.slice(1).filter((r) => r.payload.length).length && me.slots.every((s) => s.cap === 23004 && s.objects >= 2));

    // 2. the model against the firmware's own reading
    for (const g of Object.keys(images)) {
      const m = P.decode(images[g]);
      let asked = 0, listed = 0;
      m.slots.forEach((s, n) => {
        const r = agrees(images[g], n, s, `read_${g}${n}`);
        asked += r.asked;
        listed += r.listing;
        if (r.rc !== 0 || r.fails.length || !r.listing || r.oks < r.asked) {
          console.log(r.fails.slice(0, 5).join("\n"));
          check(`2. group ${g} slot ${n + 1}: the simulator reads what the model holds`, false);
        }
      });
      check(`2. group ${g}: all 3 slots restored, loaded and read by the simulator as the model says (${asked} values, ${listed * 64} pattern listings)`, listed === 3);
    }
    const wrongTempo = P.decode(images.B).slots[1];
    wrongTempo.tempoX10 += 10;
    check("   a model that differs is told apart: a tempo a beat off fails", agrees(images.B, 1, wrongTempo, "read_wrong_tempo").fails.length > 0);
    const wrongStep = P.decode(images.B).slots[1];
    const listed = wrongStep.patterns[0][0].steps.findIndex((st, i) => i < wrongStep.patterns[0][0].len && !P.stepIsEmpty(st));
    wrongStep.patterns[0][0].steps[listed].vel ^= 1;
    check("   ... and a velocity one off changes the pattern listing", listed >= 0 && !agrees(images.B, 1, wrongStep, "read_wrong_step").listing);

    // 3. the compressor
    let packedTrk = 0, packedPats = 0;
    for (const [g, k, s] of slots) {
      const raw = slotRaw(images[g], k);
      packedTrk += same(P.lzCompress(raw.trk), raw.trkPacked);
      packedPats += same(P.lzCompress(raw.pats), raw.packed);
    }
    check(`3. lzCompress gives the packed tracks of all ${slots.length} slots the firmware stored, byte for byte`, packedTrk === slots.length);
    check(`   ... and their packed patterns (${slotRaw(images.C, 0).packed.length} bytes for the stress song's first slot)`, packedPats === slots.length);
    const vec = (a) => Uint8Array.from(a);
    check("   a run: 5 5 5 5 5 is a literal and a match one back (app/lz.c's own output)", same(P.lzCompress(vec([5, 5, 5, 5, 5])), vec([0x00, 0x05, 0x81, 0x00, 0x00])));
    check("   a repeat of 3 letters: the literals, then matches (the firmware's bytes)", same(P.lzCompress(new TextEncoder().encode("abcabcabcabcabcXabcabcabc")),
          vec([0x02, 0x61, 0x62, 0x63, 0x89, 0x02, 0x00, 0x00, 0x58, 0x80, 0x03, 0x00, 0x83, 0x02, 0x00])));
    check("   too short to match: a literal run", same(P.lzCompress(vec([1, 2])), vec([0x01, 0x01, 0x02])));
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 8;
    const far = new Uint8Array(200000);
    const inputs = {   // [length, CRC-32] of what app/lz.c packs each one to (200 KB: matches past the 16 bit distance are passed over)
      noise: [Uint8Array.from({ length: 5000 }, () => rnd() & 255), 2939, 0x2c60fdce],
      "2 bits": [Uint8Array.from({ length: 30000 }, () => rnd() & 3), 4935, 0xd1944e4d],
      far: [(() => { for (let i = 0; i < far.length; i++) far[i] = i % 70001 < 400 ? i % 251 : rnd() & 255; return far; })(), 11084, 0xf823d1d6],
      periodic: [Uint8Array.from({ length: 150000 }, (_, i) => i * 7 + (i >> 9) & 255), 4644, 0x21221387],
      sparse: [Uint8Array.from({ length: PATS_RAW }, (_, i) => i % 97 < 60 ? 0 : rnd() & 15), 14576, 0x9efe0f85],
    };
    for (const [what, [data, len, crc]] of Object.entries(inputs)) {
      const packed = P.lzCompress(data);
      check(`   ${what} (${data.length} bytes): ${len} bytes packed with the firmware's CRC-32, and unpacked it is the input`,
            packed.length === len && P.crc32(packed) === crc && same(P.lzDecompress(packed, 0, packed.length, data.length), data));
    }
    refuses("   packed data cut in the middle of a match: refused", () => P.lzDecompress(vec([0x00, 0x05, 0x81, 0x00]), 0, 4, 5), /ends early/);
    refuses("   packed data that gives fewer bytes than asked for: refused", () => P.lzDecompress(vec([0x00, 0x05, 0x81, 0x00, 0x00]), 0, 5, 6), /ends early/);
    refuses("   a literal run longer than the bytes asked for: refused", () => P.lzDecompress(vec([0x04, 1, 2, 3, 4, 5]), 0, 6, 3), /longer than it says/);
    refuses("   a match that overruns the bytes asked for: refused", () => P.lzDecompress(vec([0x00, 0x05, 0x81, 0x00, 0x00]), 0, 5, 4), /outside/);
    refuses("   a match that reaches back before the first byte: refused", () => P.lzDecompress(vec([0x80, 0x05, 0x00]), 0, 3, 3), /outside/);
  }

  console.log("project codec: edits through the firmware");
  {
    const orig = images.B;
    const sections = [["LSMP", Uint8Array.from({ length: 97 }, (_, i) => i * 3)]];
    const file = withSections(orig, ...sections);
    const m = P.decode(file);
    check("4. a sample section after the backup is kept: read, and written back with the image", m.sections.length === 1 && m.sections[0].tag === "LSMP" &&
          same(m.sections[0].data, sections[0][1]) && same(P.encode(m), file));
    const s = m.slots[1];
    const mel = s.tracks.findIndex((t, k) => k < P.NTRK && !P.isKitTrack(s, k));
    const kit = s.tracks.findIndex((t, k) => k < P.NTRK && P.isKitTrack(s, k));
    const iNote = s.patterns[mel][0].steps.findIndex((st) => P.stepIsEmpty(st));
    const iKitStep = s.patterns[kit][0].steps.findIndex((st) => !P.kitHas(st, 5));
    const clear = { t: -1, p: -1, i: -1 };
    for (let t = 0; t < P.NTRK && clear.t < 0; t++) for (let p = 1; p < P.NPATT && clear.t < 0; p++) {
      const i = s.patterns[t][p].steps.findIndex((st) => !P.stepIsEmpty(st));
      if (i >= 0) Object.assign(clear, { t, p, i });
    }
    check("   (the song has a melodic track, a kit track and a step to clear to edit)", mel >= 0 && kit >= 0 && iNote >= 0 && iKitStep >= 0 && clear.t >= 0);
    const scene = s.scenes.findIndex((sc, k) => sc.used && k !== s.song.slots[0].scene);

    s.tempoX10 = s.tempoX10 === 1330 ? 1250 : 1330;
    s.tracks[1].name = "Zed bass";
    s.tracks[1].par[P.TP.LEVEL] = s.tracks[1].par[P.TP.LEVEL] === 90 ? 91 : 90;
    s.tracks[1].par[P.TP.PAN] = s.tracks[1].par[P.TP.PAN] === 30 ? 31 : 30;
    const pm = s.patterns[mel][0];
    P.toggleNote(pm, iNote, 64);
    Object.assign(pm.steps[iNote], { len: 5, nudge: -3, cond: 101, comp: 2, cval: 9, comp2: 1, cval2: 4 });
    P.toggleKitSound(s.patterns[kit][0], iKitStep, 5);
    P.clearStep(s.patterns[clear.t][clear.p], clear.i);
    Object.assign(s.patterns[mel][2], { len: 20, scale: 3, nlen: 33 });
    const oldPat = s.scenes[scene].pat[0];
    s.scenes[scene].pat[0] = (oldPat + 1) % 8;
    const oldSong = s.song.slots[0].scene;
    Object.assign(s.song.slots[0], { scene, rep: 7 });
    check("   (the edits are real: the step, the clear and the song part differ from the image's)", pm.steps[iNote].notes[0] === 64 && s.song.slots[0].scene !== oldSong &&
          P.stepIsEmpty(s.patterns[clear.t][clear.p].steps[clear.i]) && P.validate(m).length === 0);

    const edited = P.encode(m);
    const back = P.decode(edited);
    check("   the edited image decodes to the edited model (every field written is read)", plain(back.slots[1]) === plain(m.slots[1]));
    check("   ... a valid backup to the firmware tool, the sample section after it", firmwareToolReads(edited, "edited") === "22 " + records(edited).recs.filter((r) => r.payload.length).length + " 1");
    const r = agrees(edited.subarray(0, records(edited).end), 1, m.slots[1], "edited");
    check(`   restored in the simulator and loaded: it reads the edited slot (${r.asked} values and 64 pattern listings), no failure`,
          r.rc === 0 && r.fails.length === 0 && r.listing && r.oks >= r.asked);
    const unedited = agrees(edited.subarray(0, records(edited).end), 1, P.decode(orig).slots[1], "edited_vs_orig");
    check("   ... and not the original: the original model fails the same questions", unedited.fails.length > 0 && !unedited.listing);

    const a = slotRaw(orig, 1), b = slotRaw(edited, 1);
    check("   only the edited head bytes changed: the tempo", only(diffs(a.head, b.head), [[20, 22]]));
    const t1 = 334;
    check("   only the edited track bytes changed: the second track's level, pan and name", only(diffs(a.trk, b.trk), [[t1 + P.TP.LEVEL, t1 + P.TP.PAN + 1], [t1 + P.TP.N, t1 + P.TP.N + P.NAME_LEN]]));
    const spans = [stepSpan(mel, 0, iNote), stepSpan(kit, 0, iKitStep), stepSpan(clear.t, clear.p, clear.i), tailSpan(mel, 0), tailSpan(kit, 0),
      tailSpan(mel, 2), [SCENE0 + scene * 26, SCENE0 + scene * 26 + 1], [SONG0 + 4, SONG0 + 6]];
    check("   only the edited pattern bytes changed: those steps, that pattern's length, that scene's pattern, that song part (the lanes, the weave and the hits are as they were)",
          only(diffs(a.pats, b.pats), spans));
    const ra = records(orig).recs, rb = records(edited).recs;
    check("   the presets and the other two slots are the image's own records, byte for byte", rb.every((rec, k) => (k >= 8 && k <= 14) || same(rec.payload, ra[k].payload)));
    check("   the sample section is as it was", same(edited.subarray(records(edited).end), file.subarray(records(file).end)));
    check("   the edited slot's records changed, and no other", rb.some((rec, k) => k >= 8 && k <= 14 && !same(rec.payload, ra[k].payload)));
  }

  {
    const m = P.decode(images.A);
    const s = m.slots[0];
    const mel = s.tracks.findIndex((t, k) => k < P.NTRK && !P.isKitTrack(s, k));
    {
      Object.assign(s, { tempoX10: 1337, swing: 3, groove: 5, metronome: 1, lights: 2, clock: 1, sendNotes: 1, oneCore: 1, usbFull: 1, scene: 5, trkSel: 3 });
      s.rsv[0] = 9; s.master[3] = 7;
      Object.assign(s.tracks[0], { name: "abc~ 12" });
      s.tracks[0].par[P.TP.LEVEL] = 77; s.tracks[0].par[P.TP.PAN] = 12; s.tracks[0].par[P.TP.VOLUME] = 99; s.tracks[0].rsv[2] = 5;
      Object.assign(s.patterns[mel][0], { len: 33, scale: 4, groove: -7, quant: 40, nlen: 30, shape: 2, lstart: 3, lend: 9 });
      Object.assign(s.patterns[mel][0].steps[5], { notes: [60, 64, 67, 72], vel: 99, len: 7, nudge: -5, comp: 3, cval: 20, cond: 134, comp2: 4, cval2: 50 });
      Object.assign(s.scenes[3], { pat: [1, 2, 3, 4, 5, 6, 7, 0, 1, 2], used: 1, mute: 0x155, brainKey: 5, brainScale: 3, brainDeg: -3, weave: 2, kmute: [1, 2, 3, 2047] });
      Object.assign(s.song, { len: 5, loop: 1 });
      Object.assign(s.song.slots[0], { scene: 3, rep: 9 });
    }
    const e = P.encode(m);
    check("   every field of a slot, edited at once, is written and read back (all its settings, a track, a pattern, a step, a scene, the song)",
          P.validate(m).length === 0 && plain(P.decode(e)) === plain(m) && !same(e, images.A));
    const m3 = P.decode(e);
    m3.slots[0].tracks[0].name = "";
    check("   a track with no name is allowed", P.validate(m3).length === 0 && P.decode(P.encode(m3)).slots[0].tracks[0].name === "");
    const f = P.decode(P.encode(P.decode(images.A)));
    check("   decode and encode do not change what they are given: encoding twice is the same", same(P.encode(f), P.encode(f)) && same(P.encode(f), images.A));
    check("   a backup given as an ArrayBuffer decodes as one given as bytes", same(P.encode(P.decode(images.A.buffer.slice(images.A.byteOffset, images.A.byteOffset + images.A.length))), images.A));
  }

  {
    // the user presets: names only; a rename is those bytes
    const m = P.decode(presetsImg);
    const named = m.presets.presets.map((p, k) => p && `${k + 1}:${p.name}`).filter(Boolean);
    check("   user presets: the two saved (3 and 5, named reese) are the only ones, and no user kit", named.join(" ") === "3:reese 5:reese" && m.presets.kits.every((k) => k === null));
    m.presets.presets[2].name = "Renamed 1";
    const e = P.encode(m);
    const [pa, pb] = [records(presetsImg).recs[0].payload, records(e).recs[0].payload];
    check("   a preset renamed: that name's bytes alone differ, the image restores in the simulator", P.decode(e).presets.presets[2].name === "Renamed 1" &&
          only(diffs(pa, pb), [[4 + 2 * 53, 4 + 2 * 53 + 12]]) && records(e).recs.slice(1).every((r, k) => same(r.payload, records(presetsImg).recs[k + 1].payload)));
    writeFileSync(join(work, "renamed.soundplant"), e);
    const r = hostRun(["master 4096", "restore out:renamed.soundplant", "expect restore_rc 0"], "renamed");
    check("   ... the simulator takes it (restore rc 0)", r.rc === 0 && r.fails.length === 0 && r.oks >= 1);
    const other = rebuilt(presetsImg, (p) => { p[0] = p[0].slice(); put32(p[0], 0, 12); });
    const mo = P.decode(other);
    check("   presets of another format are kept as they are, not read", mo.presets.format === 12 && mo.presets.presets === null && same(P.encode(mo), other));
    refuses("   a preset named with a letter too many is refused", () => { const x = P.decode(presetsImg); x.presets.presets[2].name = "abcdefghijkl"; P.encode(x); }, /name/);
    refuses("   a preset named with nothing is refused", () => { const x = P.decode(presetsImg); x.presets.presets[2].name = ""; P.encode(x); }, /name/);
  }

  console.log("project codec: slots that fill the flash");
  {
    const m = P.decode(images.B);
    fill(m, 1, SEVEN);
    const me = P.measure(m);
    check(`   a slot of noise to 7 flash sectors (the most one holds): ${me.slots[1].packed} bytes packed of ${me.slots[1].cap}`, me.slots[1].objects === 7 && me.slots[1].packed > SEVEN && me.slots[1].packed <= me.slots[1].cap);
    const big = P.encode(m);
    check("   ... a valid backup to the firmware tool", firmwareToolReads(big, "big") === `22 ${records(big).recs.filter((r) => r.payload.length).length} 0`);
    const r = agrees(big, 1, m.slots[1], "big");
    check(`   ... the simulator restores it, loads it, and lists its patterns as the model does (${r.asked} values, 64 listings of noise)`, r.rc === 0 && r.fails.length === 0 && r.listing && r.oks >= r.asked);
    check("   ... the image decodes to the same model", plain(P.decode(big).slots[1]) === plain(m.slots[1]));

    const three = P.decode(images.B);
    [0, 1, 2].forEach((n) => fill(three, n, SEVEN));
    const sectors = P.measure(three);
    check(`   three of them: ${sectors.sectors} sectors, the pool has ${sectors.pool}`, sectors.slots.every((s) => s.objects === 7) && sectors.sectors === 21);
    refuses("   ... refused: MEMORY FULL, the pool (every slot would be fine alone)", () => P.encode(three), /MEMORY FULL.*21.*20/);
    const everything = P.decode(images.B);
    fill(everything, 0, Infinity);
    refuses("   a slot of noise in every pattern: refused, MEMORY FULL, over what a slot holds", () => P.encode(everything), /MEMORY FULL.*patterns pack to \d+ bytes.*23004/);
  }

  console.log("project codec: images that are not backups");
  {
    const img = images.B;
    const { recs, end } = records(img);
    const flip = (at, bit = 1) => { const x = Uint8Array.from(img); x[at] ^= bit; return x; };
    refuses("5. a few bytes: too short", () => P.decode(img.subarray(0, 7)), /too short/);
    refuses("   nothing", () => P.decode(new Uint8Array(0)), /too short/);
    refuses("   another file's bytes: not a backup (its first four are not LM8B)", () => P.decode(new TextEncoder().encode("RIFF....WAVEfmt this is not a backup at all, only a text of some length")), /not a SoundPlant backup/);
    refuses("   the magic changed (head, records and CRC-32s made again): not a backup", () => P.decode(build(recs.map((r) => r.payload), { magic: 0x4D384D4C })), /not a SoundPlant backup/);
    refuses("   a container version it does not know (CRC-32s made again): refused, naming it", () => P.decode(build(recs.map((r) => r.payload), { version: 2 })), /version 2/);
    refuses("   21 parts: refused", () => P.decode(build(recs.map((r) => r.payload).slice(0, 21))), /21 parts/);
    refuses("   the head's CRC-32 flipped", () => P.decode(flip(12)), /damaged/);
    refuses("   a record's payload byte flipped", () => P.decode(flip(16 + 8 + recs[0].payload.length + 8 + 10)), /damaged/);
    refuses("   the file's CRC-32 flipped", () => P.decode(flip(end - 1)), /whole file/);
    const wrongId = Uint8Array.from(img); wrongId[16] = 2; put32(wrongId, end - 4, P.crc32(wrongId, 0, end - 4));
    refuses("   a record numbered out of order (the file's CRC-32 made again): refused, naming it", () => P.decode(wrongId), /part 1 is numbered 2/);
    let miss = 0, notProjectError = 0;
    for (let at = 0; at < img.length; at += at < 80 ? 1 : 7) {
      const e = thrown(() => P.decode(flip(at, 1 << at % 8)));
      miss += e === null;
      notProjectError += e !== null && !(e instanceof P.ProjectError);
    }
    check("   a bit flipped anywhere (every byte of the head and records' headers, then every 7th): always refused", miss === 0);
    check("   ... always a ProjectError, not a stray TypeError or RangeError", notProjectError === 0);
    let cuts = 0, strays = 0, cutTo = [];
    for (let n = 0; n < img.length; n += n < 100 ? 1 : 211) cutTo.push(n);
    cutTo.push(img.length - 1, img.length - 4, img.length - 5);
    for (const n of cutTo) {
      const e = thrown(() => P.decode(img.subarray(0, n)));
      cuts += e === null;
      strays += e !== null && !(e instanceof P.ProjectError);
    }
    check(`   cut short at ${cutTo.length} places, from nothing to a byte short of whole: always refused with a ProjectError`, cuts === 0 && strays === 0);
    check("   the whole image still decodes (the cuts and flips were of copies)", P.decode(img).slots.every(Boolean));
    refuses("   a section after the backup with a flipped byte", () => P.decode(withSections(img, ["LSMP", Uint8Array.from([1, 2, 3, 4, 5])]).map((v, i, a) => i === a.length - 6 ? v ^ 1 : v)), /LSMP/);
    refuses("   a section cut short", () => P.decode(withSections(img, ["LSMP", Uint8Array.from([1, 2, 3, 4, 5])]).subarray(0, end + 10)), /section/);
    refuses("   a few stray bytes after the backup: not a section", () => P.decode(Uint8Array.from([...img, 1, 2, 3])), /section/);

    // damage the checks cannot see: the records are made again with their CRC-32s, the contents are wrong
    const slot = (n) => 1 + 7 * n;
    const wrongSettings = (what, edit, re) => refuses(`   ${what}`, () => P.decode(rebuilt(img, (p) => { p[slot(1)] = p[slot(1)].slice(); edit(p[slot(1)], p); })), re);
    wrongSettings("project format 21 (the one before): refused with the way out, load it on the FM-1 and make the backup again", (s) => put32(s, 4, 21), /format 21.*load that slot.*backup again/i);
    wrongSettings("project format 23 (a newer SoundPlant's): refused, naming it", (s) => put32(s, 4, 23), /format 23/);
    wrongSettings("a slot whose settings are not a project's (its magic)", (s) => { s[0] ^= 0xFF; }, /not a SoundPlant project/);
    wrongSettings("a tempo of 10 BPM (the FM-1 plays 40 to 300): refused", (s) => { s[20] = 100; s[21] = 0; }, /tempo/);
    wrongSettings("a start scene past the 32", (s) => { s[30] = 32; }, /start scene/);
    wrongSettings("a packed length that runs past its object", (s) => put32(s, SET_HEAD, 5000), /run past/);
    wrongSettings("packed tracks cut to nothing (the stream ends early)", (s, p) => { p[slot(1)] = s.subarray(0, SET_HEAD + 4 + 3); put32(p[slot(1)], SET_HEAD, 3); }, /tracks/);
    const wrongStream = (what, edit, re) => refuses(`   ${what}`, () => P.decode(rebuilt(img, (p) => { p[slot(1) + 1] = p[slot(1) + 1].slice(); edit(p[slot(1) + 1], p); })), re);
    wrongStream("the patterns' check sum changed: refused", (s) => put32(s, 8, u32(s, 8) ^ 1), /check sum/);
    wrongStream("patterns in an older layout (a raw size of 65000): refused with the way out", (s) => put32(s, 4, 65000), /older layout.*backup again/);
    wrongStream("a packed size over what a slot holds", (s) => put32(s, 12, 30000), /at most 23004/);
    wrongStream("a packed byte changed: the check sum, or the stream, catches it", (s) => { s[40] ^= 0x55; }, /patterns/);
    wrongStream("a stream object not marked as one", (s) => put32(s, 0, 3), /patterns are missing/);
    refuses("   patterns with no settings: refused", () => P.decode(rebuilt(img, (p) => { p[slot(1)] = new Uint8Array(0); })), /no settings/);
    const wide = P.decode(img);
    fill(wide, 1, SEVEN);
    const multi = P.encode(wide);
    check("   (a slot whose patterns are in all six stream objects, to cut)", slotRaw(multi, 1).objs.filter((o) => o.length).length === 7);
    refuses("   patterns cut short (the stream's later objects gone)", () => P.decode(rebuilt(multi, (p) => { for (let k = 2; k < 7; k++) p[slot(1) + k] = new Uint8Array(0); })), /cut short/);
    refuses("   patterns cut short (the last of them gone)", () => P.decode(rebuilt(multi, (p) => { p[slot(1) + 6] = new Uint8Array(0); })), /cut short/);
    check("   all of those are the one image made again: it itself decodes, as the same image", same(P.encode(P.decode(rebuilt(img, () => {}))), img));
  }

  console.log("project codec: refusals when writing");
  {
    const edit = (fn) => () => { const m = P.decode(images.B); fn(m.slots[1], m); P.encode(m); };
    check("6. an edit that is in range is accepted (so the refusals below are about the value)", thrown(edit((s) => { s.tempoX10 = 1234; s.tracks[0].name = "Kick 808"; })) === null);
    refuses("   a tempo over 300 BPM", edit((s) => { s.tempoX10 = 3001; }), /tempo.*300/);
    refuses("   a tempo under 40 BPM", edit((s) => { s.tempoX10 = 399; }), /tempo.*40/);
    refuses("   a tempo that is not a whole number of tenths", edit((s) => { s.tempoX10 = 1234.5; }), /tempo/);
    refuses("   a tempo that is not a number", edit((s) => { s.tempoX10 = "fast"; }), /tempo/);
    refuses("   a track name of twelve letters (eleven is the most)", edit((s) => { s.tracks[0].name = "abcdefghijkl"; }), /name/);
    refuses("   a track name with a letter outside ASCII", edit((s) => { s.tracks[0].name = "caf\u00e9"; }), /name/);
    refuses("   a level of 128", edit((s) => { s.tracks[0].par[P.TP.LEVEL] = 128; }), /level/);
    refuses("   a pan of 200", edit((s) => { s.tracks[0].par[P.TP.PAN] = 200; }), /pan/);
    refuses("   an engine that does not exist", edit((s) => { s.tracks[0].par[P.TP.ENGINE] = 11; }), /engine 11/);
    refuses("   a velocity of 128", edit((s) => { s.patterns[0][0].steps[0].vel = 128; }), /velocity/);
    refuses("   a note of 128 on a melodic track", edit((s) => { const t = s.tracks.findIndex((x, k) => k < 8 && !P.isKitTrack(s, k)); s.patterns[t][0].steps[0].notes[0] = 128; }), /notes/);
    refuses("   a kit step with a sound past the eleven", edit((s) => { const t = s.tracks.findIndex((x, k) => k < 8 && P.isKitTrack(s, k)); s.patterns[t][0].steps[0].notes[1] = 8; }), /kit step/);
    refuses("   a pattern of 0 steps", edit((s) => { s.patterns[0][0].len = 0; }), /length/);
    refuses("   a pattern of 65 steps", edit((s) => { s.patterns[0][0].len = 65; }), /length/);
    refuses("   a step length of 113", edit((s) => { s.patterns[0][0].steps[0].len = 113; }), /length/);
    refuses("   a nudge of 13", edit((s) => { s.patterns[0][0].steps[0].nudge = 13; }), /nudge/);
    refuses("   a condition of 135", edit((s) => { s.patterns[0][0].steps[0].cond = 135; }), /condition/);
    refuses("   a scene's pattern 9 (there are eight)", edit((s) => { s.scenes[0].pat[0] = 8; }), /pattern/);
    refuses("   a song of 65 parts", edit((s) => { s.song.len = 65; }), /song/);
    refuses("   a song part of 0 bars in the song", edit((s) => { s.song.slots[0].rep = 0; }), /bars/);
    refuses("   a song part of 65 bars", edit((s) => { s.song.slots[0].rep = 65; }), /bars/);
    refuses("   a song part on scene 33", edit((s) => { s.song.slots[0].scene = 32; }), /scene/);
    refuses("   a start scene of 33", edit((s) => { s.scene = 32; }), /start scene/);
    refuses("   a conductor key of 12", edit((s) => { s.scenes[0].brainKey = 12; }), /key/);
    refuses("   a slot with 12 tracks (its shape is wrong)", edit((s) => { s.tracks.pop(); }), /13 tracks/);
    refuses("   a model of two slots", edit((s, m) => { m.slots.pop(); }), /3 slots/);
    refuses("   ... and the problems come together: the first, and how many more", edit((s) => { s.tempoX10 = 5000; s.tracks[0].par[P.TP.LEVEL] = 200; }), /\(and 1 more\)/);
    const bad = P.decode(images.B);
    bad.slots[1].tempoX10 = 5000;
    check("   validate lists them without throwing", P.validate(bad).length === 1 && /tempo/.test(P.validate(bad)[0]) && P.validate(P.decode(images.B)).length === 0);
    const song = P.decode(images.B).slots[1].song;
    check("   the parts past a song's end are stored by the firmware as 0 bars, and are not a problem", song.len < 64 && song.slots.slice(song.len).some((p) => p.rep === 0) &&
          P.validate(P.decode(images.B)).length === 0);
  }

  console.log("project codec: pattern helpers");
  {
    const pat = P.newPattern();
    check("7. a new pattern: 16 steps of 64, scale 1, quantise 100, note length 50, every step empty", pat.len === 16 && pat.scale === 1 && pat.quant === 100 && pat.nlen === 50 &&
          pat.steps.length === 64 && pat.steps.every(P.stepIsEmpty));
    check("   a note on an empty step: the note, velocity 100, the length unchanged", P.toggleNote(pat, 3, 60) && same(pat.steps[3].notes, [60, 0, 0, 0]) && pat.steps[3].vel === 100 && pat.len === 16);
    check("   a note on a step past the pattern's end lengthens the pattern to it", P.toggleNote(pat, 20, 62) && pat.len === 21);
    P.toggleNote(pat, 3, 64); P.toggleNote(pat, 3, 67); P.toggleNote(pat, 3, 72);
    check("   up to four notes on a step", same(pat.steps[3].notes, [60, 64, 67, 72]));
    check("   a fifth is refused (false) and changes nothing", P.toggleNote(pat, 3, 75) === false && same(pat.steps[3].notes, [60, 64, 67, 72]));
    P.toggleNote(pat, 3, 64);
    check("   a note toggled off leaves the others in order, the rest free", same(pat.steps[3].notes, [60, 67, 72, 0]));
    Object.assign(pat.steps[3], { len: 9, nudge: 4, cond: 50, comp: 2, cval: 3, comp2: 1, cval2: 8 });
    P.toggleNote(pat, 3, 60); P.toggleNote(pat, 3, 67); P.toggleNote(pat, 3, 72);
    check("   the last note off: the step is the firmware's cleared one (no length, nudge or tricks, velocity 100)", P.stepIsEmpty(pat.steps[3]) &&
          plain(pat.steps[3]) === plain({ ...P.newStep(), vel: 100 }));
    Object.assign(pat.steps[20], { len: 9, nudge: 4, cond: 50, comp: 2, vel: 40 });
    P.clearStep(pat, 20);
    check("   clearStep: the same cleared step", plain(pat.steps[20]) === plain({ ...P.newStep(), vel: 100 }));

    const kit = P.newPattern();
    P.toggleKitSound(kit, 0, 1); P.toggleKitSound(kit, 0, 9); P.toggleKitSound(kit, 0, 11);
    check("   kit sounds are bits: 1 is bit 0 of the first byte, 9 and 11 are bits 0 and 2 of the second", same(kit.steps[0].notes, [1, 5, 0, 0]) && P.kitMask(kit.steps[0]) === 0x501);
    check("   ... kitHas says which", [1, 9, 11].every((k) => P.kitHas(kit.steps[0], k)) && [2, 8, 10, 12, 0].every((k) => !P.kitHas(kit.steps[0], k)));
    P.toggleKitSound(kit, 0, 9);
    check("   a sound toggled off leaves the others", P.kitMask(kit.steps[0]) === 0x401 && same(kit.steps[0].notes, [1, 4, 0, 0]));
    P.toggleKitSound(kit, 0, 1); P.toggleKitSound(kit, 0, 11);
    check("   the last sound off: the cleared step", P.stepIsEmpty(kit.steps[0]) && kit.steps[0].vel === 100);
    P.toggleKitSound(kit, 30, 2);
    check("   a kit sound past the pattern's end lengthens it", kit.len === 31);
    refuses("   a kit sound 12 or 0 is refused", () => P.toggleKitSound(kit, 0, 12), /sounds 1 to 11/);
    refuses("   ... 0 too", () => P.toggleKitSound(kit, 0, 0), /sounds 1 to 11/);

    check("   step lengths: 0 is the pattern's, 1 to 64 quarter steps, 65 to 112 whole steps from 17: 65 is 17 steps, 112 is 64",
          P.stepLenQuarters(0) === 0 && P.stepLenQuarters(1) === 1 && P.stepLenQuarters(64) === 64 && P.stepLenQuarters(65) === 68 && P.stepLenQuarters(112) === 256);
    check("   ... a code survives quarters and back, the whole range", Array.from({ length: 112 }, (_, k) => k + 1).every((c) => P.stepLenCode(P.stepLenQuarters(c)) === c));
    check("   ... quarters between whole steps round up, and past 64 steps stop at the longest", P.stepLenCode(69) === 66 && P.stepLenCode(1000) === 112 && P.stepLenCode(0) === 1);
    check("   conditions: always, a chance in %, and the A:B cycles from 100 (1:2 2:2 1:3 ... 8:8)",
          P.condText(0) === "always" && P.condText(1) === "1 %" && P.condText(99) === "99 %" && P.condText(100) === "1:2" && P.condText(101) === "2:2" &&
          P.condText(102) === "1:3" && P.condText(134) === "8:8");
    check("   there are 35 cycles: a count of 8 beats makes 36", P.COND_NAB === 35 && P.condAB(34).join(":") === "8:8" && P.condAB(35).join(":") === "8:8");
    check("   notes are named from C4 = 60 (the FM-1's own, middle C)", P.noteName(60) === "C4" && P.noteName(61) === "C#4" && P.noteName(0) === "C-1" && P.noteName(127) === "G9");
  }

  console.log("project page: app/web/project/index.html");
  {
    // tools/make_pages.py inlines the codec and the MIDI module at the page's one placeholder as plain script (strip_module): the
    // page must hold together as that one module, and every id its script asks for must be in its markup, once
    const strip = (t) => t.replace(/^export\s+/gm, "").replace(/^import .*?;\n/gm, "");
    const html = readFileSync(join(ROOT, "app/web/project/index.html"), "utf8");
    const script = html.match(/<script type="module">\n([\s\S]*?)<\/script>/)[1];
    const libs = ["soundplant_project.js", "soundplant_midi.js"].map((f) => readFileSync(join(ROOT, "app/web/project", f), "utf8"));
    const page = script.replace("/*LIB*/", libs.map(strip).join("\n"));
    const parses = (code) => {
      const f = join(work, "page.mjs");
      writeFileSync(f, code);
      try { execFileSync(process.execPath, ["--check", f], { stdio: ["ignore", "pipe", "pipe"] }); return ""; }
      catch (e) { return String(e.stderr).split("\n").find((l) => /Error/.test(l)) || "failed"; }
    };
    check("8. the placeholder is in the page once, and the codec and the MIDI module inlined make one valid module", html.split("/*LIB*/").length === 2 && parses(page) === "" &&
          !page.includes("/*LIB*/") && page.includes("function decode(") && page.includes("function toMidi(") && page.includes("function fromMidi("));
    const called = ["toMidi", "fromMidi", "readMidi", "applyImport", "revertImport", "MidiError", "KIT_GM_NOTES", "GM_DRUM_ALIASES", "DRUM_SOUND_NAMES"];
    check(`   every library name the page's MIDI code uses is defined by the two libraries (${called.length} names)`,
          called.every((n) => script.includes(n) && new RegExp(`\\b(function|class|const) ${n}\\b`).test(libs.join("\n"))));
    check("   the same check refuses a slip in the page's script", parses(page + "\n)(\n") !== "");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const asked = [...new Set([...script.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
    const missing = asked.filter((id) => !ids.includes(id));
    check(`   every id the script asks for is in the markup (${asked.length} ids; missing: ${missing.join(", ") || "none"})`, asked.length > 30 && missing.length === 0);
    check("   ... and no id is in it twice", new Set(ids).size === ids.length);
    check("   the page points to the Backup page for the restore, and its script makes no network request", html.includes('href="../backup/"') && !/\b(fetch|XMLHttpRequest|WebSocket)\b/.test(script));
  }
  console.log("MIDI export: the file toMidi writes, read by a reader of the test's own");
  {
    // 9. the exact bytes of a small file: MThd (format 1, 2 tracks, 384 a quarter), the tempo track (name, 120 BPM, 4/4, end at 192),
    // the note track (name, C4 on at 0 with velocity 100, off 48 ticks later, end at 192)
    const KNOWN = ["4d546864", "00000006", "0001", "0002", "0180",
      "4d54726b", "00000029", "00ff0311", "536f756e64506c616e7420736c6f742031", "00ff510307a120", "00ff580404021808", "8140ff2f00",
      "4d54726b", "00000018", "00ff0307", "547261636b2031", "00903c64", "30803c40", "8110ff2f00"].join("");
    const small = synth();
    putPattern(small, 0, 0, { len: 2 }, { 0: stp([60], { vel: 100 }) });
    const sm = asExport(small, { track: 0, pattern: 0 });
    check("9. a two step pattern with C4 on the first: the file's exact bytes (header, tempo track, note track)", Buffer.from(sm.bytes).toString("hex") === KNOWN && sm.report.length === 0);
    const f0 = refRead(sm.bytes);
    check("   the reference reader: format 1, 2 tracks, 384 ticks a quarter, 120 BPM (500000 us), 4/4, the tempo track ends with the pattern",
          f0.format === 1 && f0.ntrks === 2 && f0.division === 384 && same(metaOf(f0.tracks[0], 0x51)[0].data, [7, 0xA1, 0x20]) &&
          same(metaOf(f0.tracks[0], 0x58)[0].data, [4, 2, 24, 8]) && metaOf(f0.tracks[0], 0x2F)[0].tick === 192 && ascii(metaOf(f0.tracks[0], 0x03)[0].data) === "SoundPlant slot 1");
    check("   ... and the exact bytes tell a one-velocity change", Buffer.from(asExport((() => { const o = synth(); putPattern(o, 0, 0, { len: 2 }, { 0: stp([60], { vel: 99 }) }); return o; })(), { track: 0, pattern: 0 }).bytes).toString("hex") !== KNOWN);

    // a pattern with every field: length in quarter steps and in whole steps, nudge both ways, velocity 0 (100), notes out of order, a note past the end
    const rich = richSlot();
    const r2 = asExport(rich, { track: 0, pattern: 0 }), f2 = refRead(r2.bytes);
    check("   step 1 C4 vel 90; step 2 nudged +6 (24 ticks) 2 steps long with notes out of order; step 3 nudged -3; step 4 17 steps long, cut at the pattern's end: each tick, key, velocity",
          same(noteLines(f2.tracks[1]), ["0 on 60 v90 ch1", "48 off 60 v64 ch1", "120 on 64 v100 ch1", "120 on 67 v100 ch1", "180 on 72 v127 ch1", "276 off 72 v64 ch1",
            "288 on 48 v1 ch1", "312 off 64 v64 ch1", "312 off 67 v64 ch1", "384 off 48 v64 ch1"]));
    check("   ... the track's name, and both tracks end at the pattern's 4 steps (384 ticks)", ascii(metaOf(f2.tracks[1], 0x03)[0].data) === "Lead" &&
          metaOf(f2.tracks[1], 0x2F)[0].tick === 384 && metaOf(f2.tracks[0], 0x2F)[0].tick === 384);
    check("   ... and the one thing the file cut is in the report: one note past the pattern's end", same(r2.report.map((x) => x.key), ["cut"]) && r2.report[0].count === 1 && /cut there/.test(r2.report[0].text));

    // a kit on channel 10: sounds as drum notes, at the half sixteenth step
    const drums = synth([1], { 1: "Drums" });
    putPattern(drums, 1, 0, { len: 2, scale: 0 }, { 0: kstp([1, 3], { vel: 80 }), 1: kstp([10], { nudge: 12, len: 3 }) });
    const f3 = refRead(asExport(drums, { track: 1, pattern: 0 }).bytes);
    check("   a kit: kick and hat on step 1 (vel 80), the string on step 2 nudged a quarter step (12 ticks) and 3 quarter steps long, all on channel 10",
          same(noteLines(f3.tracks[1]), ["0 on 36 v80 ch10", "0 on 42 v80 ch10", "24 off 36 v64 ch10", "24 off 42 v64 ch10", "60 on 88 v100 ch10", "96 off 88 v64 ch10"]) &&
          ascii(metaOf(f3.tracks[1], 0x03)[0].data) === "Drums");
    const GM = [36, 38, 42, 46, 39, 45, 50, 63, 82, 88, 89];
    const allSounds = synth([0]);
    putPattern(allSounds, 0, 0, { len: 11, scale: 4 }, Object.fromEntries(GM.map((_, k) => [k, kstp([k + 1])])));
    const fk = refRead(asExport(allSounds, { track: 0, pattern: 0 }).bytes);
    check("   the kit's 11 sounds go out as the table says (kick 36 snare 38 hat 42 open 46 clap 39 ltom 45 htom 50 conga 63 shaker 82 string 88 fm 89), one to a step",
          same(fk.tracks[1].filter((e) => e.on).map((e) => e.key), GM) && new Set(GM).size === 11);
    check("   a melodic track t is on channel t + 1 (tracks 1, 4 and 8)", [0, 3, 7].every((t) => {
      const o = synth(); putPattern(o, t, 0, { len: 1 }, { 0: stp([60]) });
      return refRead(asExport(o, { track: t, pattern: 0 }).bytes).tracks[1].filter((e) => e.on !== undefined).every((e) => e.ch === t);
    }));

    // every step size: a step is 96 ticks a sixteenth; the second step starts at one step, the note is half a step long, the cycle is 3 steps
    const STEP = [48, 96, 192, 288, 384, 480, 576, 768, 1536];
    check("   the 9 step sizes (half a sixteenth to 16) are 48 96 192 288 384 480 576 768 1536 ticks: note on at 1 step, off half a step later, the cycle 3 steps", STEP.every((S, scale) => {
      const o = synth(); putPattern(o, 0, 0, { len: 3, scale }, { 1: stp([60]) });
      const f = refRead(asExport(o, { track: 0, pattern: 0 }).bytes);
      return same(noteLines(f.tracks[1]), [`${S} on 60 v100 ch1`, `${S * 3 / 2} off 60 v64 ch1`]) && metaOf(f.tracks[1], 0x2F)[0].tick === S * 3;
    }));

    // the tempo: every value the FM-1 holds, out and back
    let tempoOk = 0, tempoBad = [];
    for (let x = P.TEMPO_MIN; x <= P.TEMPO_MAX; x++) {
      const o = synth(); o.tempoX10 = x; putPattern(o, 0, 0, { len: 1 }, { 0: stp([60]) });
      const { bytes } = asExport(o, { track: 0, pattern: 0 });
      const us = metaOf(refRead(bytes).tracks[0], 0x51)[0].data.reduce((a, v) => a * 256 + v, 0);
      const back = importOf(synth(), bytes, {}).tempo;
      if (us === Math.round(6e8 / x) && back.x10 === x && !back.clamped) tempoOk++; else tempoBad.push(x);
    }
    check(`   all ${P.TEMPO_MAX - P.TEMPO_MIN + 1} tempi (40.0 to 300.0 BPM): written as 60e6 / BPM microseconds a quarter and read back as the same tempo (wrong: ${tempoBad.slice(0, 5).join(", ") || "none"})`, tempoOk === 2601);

    // a scene: a MIDI track for each track that plays notes; a muted one is left out and said so
    const scn = synth([1], { 0: "Lead", 1: "Drums", 2: "Bass" });
    putPattern(scn, 0, 1, { len: 2 }, { 0: stp([60]) });
    putPattern(scn, 1, 0, { len: 2 }, { 0: kstp([2]) });
    putPattern(scn, 2, 0, { len: 4 }, { 2: stp([36]) });
    putPattern(scn, 4, 0, { len: 2 }, { 0: stp([50]) });
    scn.scenes[3].pat[0] = 1;
    scn.scenes[3].mute = 1 << 4 | 1 << 3;
    const sx = asExport(scn, { scene: 3 }), fs = refRead(sx.bytes);
    check("   scene 4: Lead (pattern 2), Drums and Bass in; track 5 has notes but is muted (said once), track 4 is muted and has none (not said), the rest are empty",
          fs.ntrks === 4 && same(fs.tracks.slice(1).map((t) => ascii(metaOf(t, 0x03)[0].data)), ["Lead", "Drums", "Bass"]) &&
          same(fs.tracks.slice(1).map((t) => t.find((e) => e.on).ch + 1), [1, 10, 3]) && same(sx.report.map((x) => x.key), ["muted"]) && sx.report[0].count === 1 &&
          metaOf(fs.tracks[0], 0x2F)[0].tick === 384 && same(fs.tracks.slice(1).map((t) => metaOf(t, 0x2F)[0].tick), [192, 192, 384]));
    check("   scene 6 plays pattern 1 of each track: Drums, Bass and track 5 (named Track 5)", (() => {
      const f = refRead(asExport(scn, { scene: 5 }).bytes);
      return f.ntrks === 4 && same(f.tracks.slice(1).map((t) => ascii(metaOf(t, 0x03)[0].data)), ["Drums", "Bass", "Track 5"]);
    })());
    scn.scenes[3].mute = 0xFF;
    refusesMidi("   a scene whose notes are all muted has nothing to write", () => asExport(scn, { scene: 3 }), /no notes in the tracks it plays/);

    // what the file cannot carry is counted
    const rp = synth();
    putPattern(rp, 0, 0, { len: 4, groove: 3, lstart: 1, lend: 3 }, {
      0: stp([60], { cond: 50, nudge: -5 }), 1: stp([62], { comp: 3 }), 2: stp([64], { comp2: 1 }), 3: stp([65], { len: 8 }),
    });
    const rr = asExport(rp, { track: 0, pattern: 0 });
    check("   a groove, a loop window, a condition, 2 steps with tricks, a note past the end, a step nudged before the start: each counted, in this order",
          same(rr.report.map((x) => `${x.key} ${x.count}`), ["groove 1", "loop 1", "conds 1", "tricks 2", "cut 1", "early 1"]) &&
          [/groove/, /loop window/, /condition/, /tricks/, /cut there/, /nudged before/].every((re, i) => re.test(rr.report[i].text)));
    check("   ... and every one of those steps is still in the file as a plain note, the early one at tick 0",
          same(noteLines(refRead(rr.bytes).tracks[1]).filter((l) => / on /.test(l)), ["0 on 60 v100 ch1", "96 on 62 v100 ch1", "192 on 64 v100 ch1", "288 on 65 v100 ch1"]));
    const sh = synth();
    putPattern(sh, 0, 0, { len: 4 }, { 0: stp([60], { len: 12 }), 1: stp([60, 64]) });
    const rs2 = asExport(sh, { track: 0, pattern: 0 });
    check("   the same pitch struck again while it sounds: the first is cut short where the second starts (off before on at tick 96), and it is counted",
          same(noteLines(refRead(rs2.bytes).tracks[1]), ["0 on 60 v100 ch1", "96 off 60 v64 ch1", "96 on 60 v100 ch1", "96 on 64 v100 ch1", "144 off 60 v64 ch1", "144 off 64 v64 ch1"]) &&
          same(rs2.report.map((x) => `${x.key} ${x.count}`), ["shortened 1"]));

    const bad = (what, mut, re, o = { track: 0, pattern: 0 }) => {
      const x = synth(); putPattern(x, 0, 0, { len: 2 }, { 0: stp([60]) }); mut(x);
      refusesMidi(`   ${what}`, () => asExport(x, o), re);
    };
    bad("a pattern with no notes cannot be exported", (x) => { x.patterns[0][0].steps[0] = P.newStep(); }, /no notes to export/);
    bad("a nudge of 13 is refused", (x) => { x.patterns[0][0].steps[0].nudge = 13; }, /nudge is -12 to 12/);
    bad("a velocity of 128 is refused", (x) => { x.patterns[0][0].steps[0].vel = 128; }, /velocity 0 to 127/);
    bad("a step size that does not exist is refused", (x) => { x.patterns[0][0].scale = 9; }, /step size/);
    bad("a length of 65 steps is refused", (x) => { x.patterns[0][0].len = 65; }, /length is 1 to 64/);
    bad("a melodic note of 200 is refused", (x) => { x.patterns[0][0].steps[0].notes[0] = 200; }, /up to 127/);
    bad("a track that does not exist", () => {}, /does not exist/, { track: 8, pattern: 0 });
    bad("a pattern that does not exist", () => {}, /does not exist/, { track: 0, pattern: 8 });
    bad("a scene that does not exist", () => {}, /scene does not exist/, { scene: 32 });
    bad("a tempo the FM-1 cannot hold (39.9 BPM)", (x) => { x.tempoX10 = 399; }, /tempo is 40 to 300 BPM/);
    bad("... and 300.1", (x) => { x.tempoX10 = 3001; }, /tempo is 40 to 300 BPM/);
    refusesMidi("   an empty slot", () => M.toMidi({ slots: [null, null, null] }, { slot: 1, track: 0, pattern: 0 }), /Slot 2 is empty/);
  }

  console.log("MIDI round trip: export, then import, gives the pattern back");
  {
    const trip = (pat, kit, o = {}) => {
      const t = kit ? 1 : 3, src = synth(kit ? [1] : []), dst = synth(kit ? [1] : []);
      src.patterns[t][0] = pat;
      dst.patterns[t][0].nlen = pat.nlen;
      const out = asExport(src, { track: t, pattern: 0 });
      const res = M.fromMidi(out.bytes, { slot: dst, track: t, pattern: 0, midiTrack: 1, scale: pat.scale, ...o });
      return { out, res };
    };
    const matches = (res, want, pat, kit) => res.pattern.len === pat.len && res.pattern.scale === pat.scale && res.pattern.steps.every((st, i) => norm(st, kit) === want[i]);

    let patterns = 0, notes = 0, wrong = [];
    for (const kit of [false, true]) for (let scale = 0; scale < 9; scale++) for (const nlen of [50, 25, 33, 100, 7, 0]) {
      const { pat, want } = randomPattern(kit, scale, nlen);
      const { out, res } = trip(pat, kit, { channel: kit ? 9 : 3 });
      patterns++;
      notes += res.notes;
      if (out.report.length || res.report.length || res.notes !== countNotes(pat, kit) || !matches(res, want, pat, kit)) wrong.push(`${kit ? "kit" : "notes"} scale ${scale} nlen ${nlen}`);
    }
    check(`10. ${patterns} random patterns (melodic and kit, all 9 step sizes, 6 note lengths, 1 to 64 steps, ${notes} notes; velocity, length, nudge, up to 4 notes and up to 6 sounds a step): each comes back step for step, with nothing in either report (wrong: ${wrong.slice(0, 4).join("; ") || "none"})`,
          wrong.length === 0 && patterns === 108 && notes > 2000);

    const { pat: pa, want: wa } = randomPattern(false, 1, 50);
    const wrongWant = wa.slice(); const at = pa.steps.findIndex((st, i) => i < pa.len && !P.stepIsEmpty(st));
    wrongWant[at] = wrongWant[at].replace(/"v":\d+/, '"v":3');
    check("   the comparison can tell: a velocity changed in the expectation is not a match", at >= 0 && matches(trip(pa, false, { channel: 3 }).res, wa, pa, false) && !matches(trip(pa, false, { channel: 3 }).res, wrongWant, pa, false));
    check("   all channels (the default) read the same file the same way", (() => {
      const { pat, want } = randomPattern(false, 2, 50);
      return matches(trip(pat, false, { channel: -1 }).res, want, pat, false) && matches(trip(pat, false, {}).res, want, pat, false);
    })());

    // every length code: 1 to 64 quarter steps and 17 to 64 whole steps, one note at a time at step 1 of a 64 step pattern
    const lens = [];
    for (let code = 1; code <= 112; code++) {
      const pat = { ...P.newPattern(), len: 64 }; pat.steps[0] = stp([60], { len: code });
      const res = trip(pat, false, { channel: 3 }).res;
      if (res.pattern.steps[0].len !== (code === 2 ? 0 : code) || res.report.length) lens.push(code);
    }
    check(`   each of the 112 length codes comes back as itself (the one equal to the pattern's note length, 2 quarters, as 0); wrong: ${lens.join(", ") || "none"}`, lens.length === 0);

    // every nudge at every step size
    const nud = [];
    for (let scale = 0; scale < 9; scale++) for (let nudge = -12; nudge <= 12; nudge++) {
      const pat = { ...P.newPattern(), len: 8, scale }; pat.steps[3] = stp([60], { nudge });
      const st = trip(pat, false, { channel: 3 }).res.pattern.steps;
      const moved = scale > 0 && nudge === -12;
      const ok = moved ? st[2].nudge === 12 && st[2].notes[0] === 60 && st[3].notes[0] === 0 : st[3].nudge === nudge && st[3].notes[0] === 60 && st.filter((x) => x.notes[0]).length === 1;
      if (!ok) nud.push(`${scale}:${nudge}`);
    }
    check(`   all 25 nudges at all 9 step sizes (${9 * 25} cases) come back as themselves, except -12 above the half sixteenth step: that is exactly half a step early, and comes back as the step before's +12 (wrong: ${nud.join(", ") || "none"})`, nud.length === 0);

    const edge = synth();
    putPattern(edge, 0, 0, { len: 4 }, { 0: stp([60], { nudge: -12 }), 1: stp([0, 67, 0, 60], { vel: 0, len: 2 }), 3: stp([62], { len: 8 }) });
    const ex = asExport(edge, { track: 0, pattern: 0 }), ey = importOf(synth(), ex.bytes, {});
    check("   a nudge before the start is the first tick (said in the export); notes out of order with gaps come back sorted and packed; velocity 0 comes back 100; a length equal to the default comes back 0; a note past the end comes back cut",
          same(ex.report.map((x) => x.key), ["cut", "early"]) && ey.report.length === 0 && ey.pattern.steps[0].nudge === 0 &&
          same(ey.pattern.steps[1].notes, [60, 67, 0, 0]) && ey.pattern.steps[1].vel === 100 && ey.pattern.steps[1].len === 0 && ey.pattern.steps[3].len === 4 && ey.pattern.len === 4);
    check("   conditions, tricks, groove and the loop window are not in the file: the import has the target's groove and none of the step tricks", (() => {
      const o = synth(); putPattern(o, 0, 0, { len: 2, groove: 5 }, { 0: stp([60], { cond: 20, comp: 2, cval: 9 }) });
      const r = importOf(synth(), asExport(o, { track: 0, pattern: 0 }).bytes, {});
      return r.pattern.steps[0].cond === 0 && r.pattern.steps[0].comp === 0 && r.pattern.steps[0].cval === 0 && r.pattern.groove === 0;
    })());
  }

  console.log("MIDI import: what a pattern cannot hold is counted, never dropped quietly");
  {
    // 96 ticks a quarter: a step (a sixteenth) is 24 ticks, the pattern's note length (half a step) 12
    const file = (notes, o = {}) => smf([[...tempoEv(0, 500000), ...eot()], trackOf(notes, o)], o.file);
    const N = (tick, len, key = 60, extra = {}) => ({ tick, end: tick + len, key, ...extra });
    const imp = (notes, o = {}, over = {}) => importOf(over.slot || synth(over.kit ? [0] : []), file(notes, over), o);
    const stepsOf = (r) => r.pattern.steps.map((st, i) => [i, st]).filter(([, st]) => !P.stepIsEmpty(st));

    const r1 = imp([N(0, 12), N(24, 24, 64, { vel: 90 })]);
    check("11. two notes: steps 1 and 2, velocity, the default length as 0 and 24 ticks as 4 quarter steps; the pattern is as long as the track (2 steps); no report",
          r1.report.length === 0 && r1.notes === 2 && r1.steps === 2 && r1.pattern.len === 2 && r1.pattern.steps[0].len === 0 && r1.pattern.steps[1].len === 4 &&
          r1.pattern.steps[1].vel === 90 && r1.pattern.steps[0].vel === 100 && r1.pattern.steps[1].notes[0] === 64);
    check("   the pattern is as long as the track's end: a note at step 3 gives 3 steps, and the same track ending at tick 480 gives 20",
          imp([N(48, 12)]).pattern.len === 3 && imp([N(48, 12)], {}, { tail: 480 }).pattern.len === 20);

    const far = imp(Array.from({ length: 9 }, (_, k) => N((62 + k) * 24, 12)));
    check("   notes at steps 63 to 71 (9): steps 63 and 64 are kept, the 7 that start after step 64 are counted as beyond", ctr(far) === "beyond 7" && far.notes === 2 && far.pattern.len === 64);
    check("   a note half way between steps 64 and 65 (tick 1524) goes to the earlier, step 64, with nudge +12; one tick later (1525) it is beyond", (() => {
      const a = imp([N(1524, 6)]), b = thrown(() => imp([N(1525, 6)]));
      return a.pattern.steps[63].nudge === 12 && a.pattern.steps[63].notes[0] === 60 && b instanceof M.MidiError && /None of the 1 note/.test(b.message) && /starts after step 64/.test(b.message);
    })());

    const poly = imp([60, 62, 64, 65, 67, 69].map((k) => N(0, 12, k)));
    check("   6 notes on one step: the first 4 are kept, 2 are counted as poly", ctr(poly) === "poly 2" && same(poly.pattern.steps[0].notes, [60, 62, 64, 65]) && poly.notes === 4);
    const mer = imp([N(0, 12), N(5, 12)]);
    check("   the same pitch twice on one step (ticks 0 and 5): one note, 1 merged", ctr(mer) === "merged 1" && mer.notes === 1 && mer.pattern.steps[0].nudge === 0);
    check("   MIDI note 0: counted as note0, the others kept", (() => { const r = imp([N(0, 12, 0), N(24, 12, 60)]); return ctr(r) === "note0 1" && r.notes === 1 && P.stepIsEmpty(r.pattern.steps[0]); })());

    const mix = imp([N(0, 12, 60, { vel: 50 }), N(3, 24, 64, { vel: 90 })]);
    check("   two notes on a step with other velocity, length and timing: 1 mixed; the step keeps the louder velocity (90), the longer length (4), the earlier timing (0)",
          ctr(mix) === "mixed 1" && mix.pattern.steps[0].vel === 90 && mix.pattern.steps[0].len === 4 && mix.pattern.steps[0].nudge === 0 && same(mix.pattern.steps[0].notes, [60, 64, 0, 0]));

    // timing
    const t = (tick, o = {}) => imp([N(tick, 12)], o).pattern.steps;
    const near = [[11, 0, 11], [12, 0, 12], [13, 1, -11], [36, 1, 12], [37, 2, -11]].map(([tick, step, nudge]) => t(tick)[step].nudge === nudge && t(tick)[step].notes[0] === 60);
    check("   nearest step with the nudge for the rest: ticks 11, 12 (half way: the earlier), 13, 36, 37 are step 1 +11, step 1 +12, step 2 -11, step 2 +12, step 3 -11", near.every(Boolean));
    check("   timing off the grid with nudge off (offgrid): 2 notes (ticks 5 and 37) are moved to the nearest step with nudge 0", (() => {
      const r = imp([N(5, 12), N(37, 12, 64)], { nudge: false });
      return ctr(r) === "offgrid 2" && r.pattern.steps[0].nudge === 0 && r.pattern.steps[2].nudge === 0 && r.pattern.steps[2].notes[0] === 64;
    })());
    check("   at 480 a quarter a sixteenth is 120 ticks and a nudge 5: tick 2 is between nudges (offnudge 1) and rounds to nudge 0; tick 5 is nudge 1 and exact", (() => {
      const f = (tick) => importOf(synth(), smf([[...tempoEv(0, 500000), ...eot()], trackOf([N(tick, 60)], { tail: 480 })], { ppq: 480 }), {});
      const a = f(2), b = f(5);
      return ctr(a) === "offnudge 1" && a.pattern.steps[0].nudge === 0 && b.report.length === 0 && b.pattern.steps[0].nudge === 1;
    })());
    check("   the half sixteenth step (a 48th nudge): tick 1 at 96 a quarter is nudge 4, exact", (() => { const r = imp([N(1, 6)], { scale: 0 }); return r.report.length === 0 && r.pattern.steps[0].nudge === 4; })());

    check("   the half sixteenth step reaches a quarter of a step either way: tick 3 is nudge +12, exact; ticks 4 and 6 (half way: the earlier step) are +12 and 7 is step 2 -12, each said once (offnudge)", (() => {
      const f = (tick) => imp([N(tick, 6)], { scale: 0 });
      const a = f(3), b = f(4), c = f(6), d = f(7);
      return a.report.length === 0 && a.pattern.steps[0].nudge === 12 &&
        ctr(b) === "offnudge 1" && b.pattern.steps[0].nudge === 12 && ctr(c) === "offnudge 1" && c.pattern.steps[0].nudge === 12 &&
        ctr(d) === "offnudge 1" && d.pattern.steps[1].nudge === -12 && P.stepIsEmpty(d.pattern.steps[0]);
    })());

    // lengths
    const L = (len, o = {}) => imp([N(0, len)], o);
    check("   a length of 5 ticks (not whole quarter steps of 6): code 1, lenround 1; of 6: code 1, nothing said; of 7: code 1 and said",
          ctr(L(5)) === "lenround 1" && L(5).pattern.steps[0].len === 1 && L(6).report.length === 0 && L(6).pattern.steps[0].len === 1 && ctr(L(7)) === "lenround 1");
    check("   17 steps (408 ticks) is code 65; 17.4 steps (418 ticks) is code 65 with lenround; 64 steps (1536) is 112; 65 steps (1560) is 112 and lenmax; 70 steps likewise",
          L(408).pattern.steps[0].len === 65 && L(408).report.length === 0 && L(418).pattern.steps[0].len === 65 && ctr(L(418)) === "lenround 1" &&
          L(1536).pattern.steps[0].len === 112 && L(1536).report.length === 0 && L(1560).pattern.steps[0].len === 112 && ctr(L(1560)) === "lenmax 1" && ctr(L(1680)) === "lenmax 1");
    check("   lengths: 'the pattern's' sets every note to 0 and reports nothing about length", (() => { const r = L(5, { lengths: "pattern" }); return r.report.length === 0 && r.pattern.steps[0].len === 0; })());

    // channels, tracks, kit
    const two = (o) => importOf(synth(), smf([[...tempoEv(0, 500000), ...eot()], trackOf([N(0, 12, 60, { ch: 0 }), N(24, 12, 62, { ch: 2 }), N(48, 12, 64, { ch: 2 })], { tail: 96 })]), o);
    check("   channels 1 and 3 in one track: all channels mix into one pattern (manych, listing 1, 3); channel 3 alone leaves 1 note out (otherch)",
          ctr(two({})) === "manych 1" && /channels 1, 3/.test(two({}).report[0].text) && ctr(two({ channel: 2 })) === "otherch 1" && two({ channel: 2 }).notes === 2 && /other channels \(1\)/.test(two({ channel: 2 }).report[0].text));
    const multi = smf([[...tempoEv(0, 500000), ...eot()], trackOf([N(0, 12, 60)]), trackOf([N(0, 12, 62), N(24, 12, 64)])]);
    check("   a file with two note tracks: the one chosen is read, the other's 2 notes are counted (tracks 2); the choice of track 2 counts 1", ctr(importOf(synth(), multi, { midiTrack: 1 })) === "tracks 2" &&
          ctr(importOf(synth(), multi, { midiTrack: 2 })) === "tracks 1" && importOf(synth(), multi, { midiTrack: 2 }).pattern.steps[1].notes[0] === 64);

    const DRUMS = [[36, 1], [35, 1], [38, 2], [40, 2], [42, 3], [44, 3], [46, 4], [39, 5], [45, 6], [41, 6], [43, 6], [50, 7], [47, 7], [48, 7], [63, 8], [62, 8], [64, 8],
      [82, 9], [69, 9], [70, 9], [88, 10], [89, 11]];
    const kr = imp(DRUMS.map(([k], i) => N(i * 24, 12, k)), {}, { kit: true });
    check(`   a kit reads ${DRUMS.length} drum notes (the 11 exported ones, and 35 40 44 41 43 47 48 62 64 69 70) as sounds, one to a step`, ctr(kr) === "" && kr.notes === DRUMS.length &&
          DRUMS.every(([, sound], i) => P.kitHas(kr.pattern.steps[i], sound) && P.kitMask(kr.pattern.steps[i]) === 1 << sound - 1));
    const kd = imp([27, 36, 37, 49, 51, 81, 90, 27].map((k, i) => N(i * 24, 12, k)), {}, { kit: true });
    check("   drum notes with no sound (27 twice, 37, 49, 51, 81, 90): 7 counted, listed in the text, and the one kick kept", ctr(kd) === "drums 7" && kd.notes === 1 &&
          /MIDI notes 27, 37, 49, 51, 81, 90/.test(kd.report[0].text));
    check("   a kit step takes any number of sounds (6 at once, no poly), where another track's holds 4", (() => {
      const r = imp([36, 38, 42, 46, 39, 45].map((k) => N(0, 12, k)), {}, { kit: true });
      return r.report.length === 0 && r.notes === 6 && P.kitMask(r.pattern.steps[0]) === 0b111111;
    })());

    // messages that are not notes, notes without an off or an on
    const noisy = importOf(synth(), smf([[...tempoEv(0, 500000), ...eot()], [
      ...ev(0, 0x80, 61, 64), ...ev(0, 0x90, 60, 100), ...ev(0, 0xB0, 7, 100), ...ev(0, 0xC0, 5), ...ev(0, 0xD0, 9), ...ev(0, 0xE0, 0, 64), ...ev(0, 0xA0, 60, 10),
      ...ev(0, 0xF0, 3, 0x7E, 0x7F, 0xF7), ...ev(12, 0x80, 60, 0), ...ev(12, 0x90, 62, 100), ...eot(36)]]), {});
    check("   a note-off with no note (stray 1), a note never switched off (hanging 1, held to the end), 5 other messages and a SysEx (other 6): all counted",
          ctr(noisy) === "stray 1, hanging 1, other 6" && noisy.notes === 2 && noisy.pattern.steps[1].notes[0] === 62);

    // tempo
    const tempoOf = (events) => importOf(synth(), smf([[...events, ...eot()], trackOf([N(0, 12)])]), {});
    const tp = importOf(synth(), smf([[...tempoEv(48, 400000), ...tempoEv(0, 300000), ...eot()], trackOf([N(0, 12)], { head: tempoEv(0, 450113) })]), {});
    check("   three tempo events, the first (by time, in any track) is the one used: 133.3 BPM is 1333; the other 2 are counted (tempos 2)", tp.tempo.x10 === 1333 && !tp.tempo.clamped && ctr(tp) === "tempos 2");
    check("   a tempo slower than the FM-1 goes (10 BPM) is 40.0 and says it was clamped; a faster one (600 BPM) is 300.0", (() => {
      const a = tempoOf(tempoEv(0, 6000000)).tempo, b = tempoOf(tempoEv(0, 100000)).tempo;
      return a.x10 === 400 && a.clamped && b.x10 === 3000 && b.clamped;
    })());
    check("   a file with no tempo gives none (tempo null)", importOf(synth(), smf([trackOf([N(0, 12)])], { format: 0 }), { midiTrack: 0 }).tempo === null);

    // the target's own state: what is replaced is counted, and nothing changes until it is applied
    const tgt = synth();
    putPattern(tgt, 0, 0, { len: 8, groove: 7, quant: 80, nlen: 50, shape: 3, lstart: 2, lend: 6 }, { 0: stp([60]), 1: stp([62], { cond: 20 }), 5: stp([64]) });
    const before = plain(tgt);
    const rp = importOf(tgt, file([N(0, 12, 70)]), {});
    check("   a target with 3 steps and a loop window: replaced 3 and loop are reported; groove 7, quantise 80, shape 3 stay; the loop window is cleared; the model is not touched",
          ctr(rp) === "loop 1, replaced 3" && rp.pattern.groove === 7 && rp.pattern.quant === 80 && rp.pattern.shape === 3 && rp.pattern.lstart === 0 && rp.pattern.lend === 0 &&
          plain(tgt) === before);

    // step size and the file's own time base
    const bySize = [0, 1, 2, 3, 4].map((scale) => where(importOf(synth(), file([N(0, 12), N(72, 12, 62), N(144, 12, 64)]), { scale })));
    check("   notes at ticks 0, 72 and 144 under each step size (12, 24, 48, 72, 96 ticks): steps 0,6,12; 0,3,6; 0,1,3 (72 is half way: the earlier); 0,1,2; 0,1 (144 is half way)",
          same(bySize, ["0,6,12", "0,3,6", "0,1,3", "0,1,2", "0,1"]));
    const music = (q) => importOf(synth(), smf([[...tempoEv(0, 500000), ...eot()], trackOf([N(0, q / 8), N(q, q / 4, 62), N(2 * q, q, 64)], { tail: 4 * q })], { ppq: q }), {});
    const shape = (r) => plain([r.pattern.len, r.report.length, r.pattern.steps.filter((st) => st.notes[0]).map((st) => [st.notes[0], st.len, st.nudge])]);
    const ppqs = [8, 24, 96, 120, 192, 384, 480, 960].map(music);
    check("   the time base does not matter: a note, a step-long note a quarter later and a quarter-long note after that, at 8 to 960 ticks a quarter, are the same pattern: steps 1, 5 and 9, lengths 0, 4 and 16, 16 steps",
          ppqs.every((r) => shape(r) === shape(ppqs[0])) && ppqs[0].pattern.len === 16 && ppqs[0].report.length === 0 &&
          same(ppqs[0].pattern.steps.filter((st) => st.notes[0]).map((st) => st.len), [0, 4, 16]) && where(ppqs[0]) === "0,4,8");
    const one = importOf(synth(), smf([[...tempoEv(0, 500000), ...eot()], trackOf([N(0, 1), N(1, 1, 62), N(2, 1, 64)], { tail: 4 })], { ppq: 1 }), {});
    check("   even at 1 tick a quarter: the notes of ticks 0, 1, 2 are steps 1, 5, 9, a tick (4 steps) is length 16, 16 steps", where(one) === "0,4,8" && one.report.length === 0 &&
          one.pattern.steps[0].len === 16 && one.pattern.len === 16);

    // nothing to import
    refusesMidi("   no notes on the channel chosen: refused, naming it", () => imp([N(0, 12, 60, { ch: 1 })], { channel: 3 }), /no notes on channel 4 in track 2/);
    refusesMidi("   a file whose notes are all past the pattern: refused, with the report's words", () => imp([N(2000, 12), N(2400, 12)]), /None of the 2 notes in this track can go into the pattern.*start after step 64/);
    refusesMidi("   a drum file imported into a kit whose notes are all unknown", () => imp([N(0, 12, 27)], {}, { kit: true }), /None of the 1 note.*no kit sound/);
    refusesMidi("   a track of the file that is not there", () => imp([N(0, 12)], { midiTrack: 5 }), /no track 6/);
    refusesMidi("   a track or pattern of the slot that does not exist", () => imp([N(0, 12)], { track: 8 }), /does not exist/);
    refusesMidi("   a step size that does not exist", () => imp([N(0, 12)], { scale: 9 }), /step size/);
    check("   ... and each refusal leaves the slot as it was", plain(tgt) === before);

    // the bookkeeping: every note is placed or in exactly one count, over random files
    let files = 0, refused = 0;
    const lost = [];
    const KEYS = [0, 36, 37, 38, 42, 60, 61, 62, 64, 99];
    for (let k = 0; k < 400; k++) {
      const list = Array.from({ length: 1 + rng(40) }, () => N(rng(70 * 24 + 30), 1 + rng(80), KEYS[rng(KEYS.length)], { ch: rng(3), vel: 1 + rng(127) }));
      const bytes = file(list);
      for (const kit of [false, true]) for (const channel of [-1, 0, 1]) {
        files++;
        const dst = synth(kit ? [0] : []);
        try {
          const r = importOf(dst, bytes, { channel }), c = counts(r), total = list.length;
          const accounted = r.notes + ["beyond", "poly", "merged", "drums", "note0", "otherch"].reduce((a, key) => a + (c[key] || 0), 0);
          if (accounted !== total || countNotes(r.pattern, kit) !== r.notes) lost.push(`file ${k} kit ${kit} ch ${channel}: ${accounted} of ${total}`);
        } catch (e) {
          if (!(e instanceof M.MidiError)) throw e;
          refused++;
        }
      }
    }
    check(`   ${files} imports of 400 random files (notes on 3 channels, to step 71, 10 pitches, melodic and kit): every note is in the pattern or in one count, and the pattern holds what is said (lost: ${lost.slice(0, 3).join("; ") || "none"}; refused whole: ${refused})`,
          lost.length === 0 && refused < files / 2);
  }

  console.log("MIDI parsing: files from other programs, and files that are damaged");
  {
    const cond = [...tempoEv(0, 500000), ...tempoEv(96, 400000), ...eot(96)];
    // running status (after the first 0x90 and after the controller 0xB0), a SysEx that ends it, a meta event that ends it, a tempo change, ppq 96
    const rsTrack = [
      ...nameEv("lead"),
      ...ev(0, 0x90, 60, 100), ...ev(12, 60, 0),                       // note-on 60, then running status: note-on with velocity 0 is its off
      ...ev(12, 64, 90), ...ev(24, 0x80, 64, 0),                       // running status note-on 64 at 24; a real note-off at 48
      ...ev(0, 0xB0, 7, 100), ...ev(0, 7, 90),                         // a controller, and another on running status
      ...ev(0, 0xF0, 3, 0x7E, 0x7F, 0xF7),                             // SysEx: running status stops
      ...ev(0, 0x90, 67, 80), ...ev(24, 67, 0),                        // note-on 67 at 48, running status off at 72
      ...ev(0, 0xFF, 0x01, 3, 0x61, 0x62, 0x63),                       // a text event: running status stops
      ...ev(24, 0x90, 60, 112), ...ev(24, 60, 0), ...eot(0),           // 60 on at 96, off at 120
    ];
    const rs = smf([cond, rsTrack]);
    const m = M.readMidi(rs);
    check("12. a hand-built file: format 1, ppq 96, the tempo track's two tempi, the note track's name", m.format === 1 && m.ppq === 96 && m.tracks.length === 2 && m.tracks[1].name === "lead" &&
          same(m.tempos.map((x) => `${x.tick}:${x.uspq}`), ["0:500000", "96:400000"]));
    check("   running status, velocity-0 note-offs, SysEx and meta events: the 4 notes with their ticks, ends, keys and velocities",
          plain(m.tracks[1].notes.map((n) => [n.tick, n.end, n.key, n.vel])) === plain([[0, 12, 60, 100], [24, 48, 64, 90], [48, 72, 67, 80], [96, 120, 60, 112]]) &&
          m.tracks[1].other === 3 && m.tracks[1].stray === 0 && m.tracks[1].hanging === 0 && m.tracks[1].endTick === 120);
    const ri = importOf(synth(), rs, {});
    check("   imported at 16 steps a quarter: steps 1 (default length), 2 (4 quarter steps, vel 90), 3 (vel 80) and 5; tempo 120 from the first; 1 other tempo and 3 other messages reported",
          where(ri) === "0,1,2,4" && ri.pattern.steps[0].len === 0 && ri.pattern.steps[1].len === 4 && ri.pattern.steps[1].vel === 90 && ri.pattern.steps[2].vel === 80 && ri.pattern.steps[4].notes[0] === 60 &&
          ri.pattern.steps[4].vel === 112 && ri.pattern.len === 5 && ri.tempo.x10 === 1200 && ctr(ri) === "other 3, tempos 1");

    // format 0: one track with the tempo, the name and the notes of 2 channels
    const f0 = smf([[...tempoEv(0, 500000), ...nameEv("all"), ...ev(0, 0x90, 60, 100), ...ev(0, 0x91, 72, 100), ...ev(12, 0x80, 60, 0), ...ev(0, 0x81, 72, 0), ...tempoEv(0, 250000), ...eot(12)]], { format: 0 });
    const m0 = M.readMidi(f0), i0 = importOf(synth(), f0, { midiTrack: 0, channel: 1 });
    check("   format 0: tempo, name and 2 channels in one track; channel 2 alone gives the one note, the tempo change after it counted", m0.format === 0 && m0.tracks.length === 1 && m0.tracks[0].notes.length === 2 &&
          i0.notes === 1 && i0.pattern.steps[0].notes[0] === 72 && ctr(i0) === "otherch 1, tempos 1" && i0.tempo.x10 === 1200);

    // pairing: the same key on again before its off pairs first on with first off; an unknown chunk is skipped
    const fifo = M.readMidi(smf([[...eot()], [...ev(0, 0x90, 60, 100), ...ev(6, 0x90, 60, 90), ...ev(6, 0x80, 60, 0), ...ev(6, 0x80, 60, 0), ...eot()]])).tracks[1].notes;
    check("   the same key struck twice before its offs: the first off ends the first note", plain(fifo.map((n) => [n.tick, n.end, n.vel])) === plain([[0, 12, 100], [6, 18, 90]]));
    const unk = Uint8Array.from([...smf([[...eot()], trackOf([{ tick: 0, end: 12, key: 60 }])]), ...txt("XFIH"), 0, 0, 0, 2, 9, 9]);
    check("   a chunk of another kind after the tracks is skipped (the spec says so), and is not a track", M.readMidi(unk).tracks.length === 2 && importOf(synth(), unk, {}).notes === 1);

    // not MIDI, headers
    const good = smf([[...tempoEv(0, 500000), ...eot()], trackOf([{ tick: 0, end: 12, key: 60 }])]);
    const withHeader = (...over) => { const b = Uint8Array.from(good); over.forEach(([o, v, n]) => be(v, n).forEach((x, i) => { b[o + i] = x; })); return b; };
    refusesMidi("   not a MIDI file (RIFF)", () => M.readMidi(Uint8Array.from(txt("RIFF....WAVEfmt "))), /not a MIDI file/);
    refusesMidi("   an empty file", () => M.readMidi(new Uint8Array(0)), /not a MIDI file/);
    refusesMidi("   3 bytes", () => M.readMidi(Uint8Array.from(txt("MTh"))), /not a MIDI file/);
    refusesMidi("   a header cut at 13 bytes", () => M.readMidi(good.subarray(0, 13)), /header is incomplete/);
    refusesMidi("   a header that says it is 4 bytes", () => M.readMidi(withHeader([4, 4, 4])), /header is 4 bytes/);
    refusesMidi("   a header that says it is 100 bytes, in a shorter file", () => M.readMidi(withHeader([4, 100, 4])), /header runs past the end/);
    refusesMidi("   format 2", () => M.readMidi(withHeader([8, 2, 2])), /format 2/);
    refusesMidi("   format 5", () => M.readMidi(withHeader([8, 5, 2])), /format 5/);
    for (const [div, fps] of [[0xE728, 25], [0xE250, 30], [0xE878, 24], [0xE378, 29], [0x8000, 128], [0xFFFF, 1]]) {
      refusesMidi(`   SMPTE time (0x${div.toString(16).toUpperCase()}, ${fps} frames a second) is refused with the reason`, () => M.readMidi(withHeader([12, div, 2])), new RegExp(`SMPTE frames \\(${fps} a second\\).*not beats`));
    }
    refusesMidi("   ... and in the import too, with no partial result", () => importOf(synth(), withHeader([12, 0xE728, 2]), {}), /SMPTE/);
    refusesMidi("   0 ticks a quarter", () => M.readMidi(withHeader([12, 0, 2])), /0 ticks/);
    refusesMidi("   0 tracks", () => M.readMidi(withHeader([10, 0, 2])), /no tracks/);
    refusesMidi("   format 0 that says 2 tracks", () => M.readMidi(withHeader([8, 0, 2])), /format 0 MIDI file has one track; this one says 2/);
    refusesMidi("   3 tracks said, 2 held", () => M.readMidi(withHeader([10, 3, 2])), /says it has 3 tracks and holds 2/);
    refusesMidi("   1 track said, 2 held", () => M.readMidi(withHeader([10, 1, 2])), /says it has 1 tracks and holds 2/);
    check("   the time base's edges: 1 and 32767 ticks a quarter are read, anything with the top bit set is SMPTE and refused",
          [0x7FFF, 1].every((d) => M.readMidi(withHeader([12, d, 2])).ppq === d) && [0x8000, 0x9234, 0xFFFF].every((d) => thrown(() => M.readMidi(withHeader([12, d, 2]))) instanceof M.MidiError));

    // one bad track each: the message names the track and the fault
    const trk = (body, o) => smf([[...tempoEv(0, 500000), ...eot()], body], o);
    const bad2 = (what, body, re) => refusesMidi(`   ${what}`, () => M.readMidi(trk(body)), re);
    bad2("a track that is empty (no end-of-track)", [], /MIDI track 2: it has no end-of-track/);
    bad2("a track with notes and no end-of-track", ev(0, 0x90, 60, 100), /no end-of-track event/);
    bad2("an event with no status byte first", [0, 60, 100, ...eot()], /no status byte and there is none to repeat/);
    bad2("running status after a meta event", [...ev(0, 0x90, 60, 100), ...ev(0, 0xFF, 0x01, 0), ...ev(6, 60, 0), ...eot()], /no status byte/);
    bad2("running status after a SysEx", [...ev(0, 0x90, 60, 100), ...ev(0, 0xF0, 1, 0xF7), ...ev(6, 60, 0), ...eot()], /no status byte/);
    bad2("a note-on cut in the middle (no velocity)", [...ev(0, 0x90, 60)], /ends in the middle of an event/);
    bad2("a meta event longer than its track", [...ev(0, 0xFF, 0x01, 50, 65)], /ends in the middle of an event/);
    bad2("a SysEx longer than its track", [...ev(0, 0xF0, 50, 1)], /ends in the middle of an event/);
    bad2("a delta time of 5 bytes", [0x81, 0x80, 0x80, 0x80, 0x00, 0xFF, 0x2F, 0], /longer than 4 bytes/);
    bad2("a delta time that never ends before the track does", [0x81, 0x80], /ends in the middle of an event/);
    bad2("a data byte with its top bit set", ev(0, 0x90, 0x80, 5), /top bit/);
    bad2("a system common message (0xF1)", [...ev(0, 0xF1, 0), ...eot()], /system message \(0xF1\)/);
    bad2("a real-time message (0xF8, a clock)", [...ev(0, 0xF8), ...eot()], /system message \(0xF8\)/);
    bad2("an end-of-track with data", ev(0, 0xFF, 0x2F, 1, 0), /end-of-track event has data/);
    bad2("a tempo of 2 bytes", [...ev(0, 0xFF, 0x51, 2, 7, 0xA1), ...eot()], /not 3 bytes/);
    bad2("a tempo of 0 microseconds", [...tempoEv(0, 0), ...eot()], /0 microseconds/);
    bad2("bytes after the end-of-track", [...eot(), 0], /bytes after its end-of-track/);
    refusesMidi("   a track chunk longer than the file", () => { const b = Uint8Array.from(good); be(1000, 4).forEach((x, i) => { b[14 + 4 + i] = x; }); return M.readMidi(b); }, /cut short: its track 1 runs/);
    refusesMidi("   3 stray bytes after the last track", () => M.readMidi(Uint8Array.from([...good, 1, 2, 3])), /3 stray bytes/);

    // never part of a file: every prefix, every byte of two files altered, random bytes
    const two = synth([1]);
    putPattern(two, 0, 0, { len: 2 }, { 0: stp([60]) });
    putPattern(two, 1, 0, { len: 2 }, { 0: kstp([1]) });
    const richFile = asExport(richSlot(), { track: 0, pattern: 0 }).bytes, sceneFile = asExport(two, { scene: 0 }).bytes;
    for (const [what, bytes] of [["an exported pattern", richFile], ["an exported scene", sceneFile], ["the hand-built file with running status", rs], ["a format 0 file", f0]]) {
      const outcomes = Array.from({ length: bytes.length }, (_, n) => thrown(() => importOf(synth(), bytes.subarray(0, n), { midiTrack: bytes === f0 ? 0 : 1 })));
      check(`   ${what} (${bytes.length} bytes): each of its ${bytes.length} shorter prefixes is refused with a MidiError (none returns part of a file), the whole file is read`,
            outcomes.every((e) => e instanceof M.MidiError) && M.readMidi(bytes).tracks.length >= 1);
    }
    let fuzz = 0, odd = [], rs2 = 0x1B873593;
    const rng2 = (n) => { rs2 = (rs2 ^ rs2 << 13) >>> 0; rs2 = (rs2 ^ rs2 >>> 17) >>> 0; rs2 = (rs2 ^ rs2 << 5) >>> 0; return rs2 % n; };
    for (const bytes of [rs, f0, richFile]) for (let i = 0; i < bytes.length; i++) for (const v of [0x00, 0x7F, 0x80, 0xFF, 0x2F, 0x90, 0x51]) {
      const b = Uint8Array.from(bytes); b[i] = v; fuzz++;
      try {
        const r = M.readMidi(b);
        if (!r.tracks.every((t) => t.notes.every((n) => n.end >= n.tick && n.key < 128 && n.vel > 0 && n.vel < 128))) odd.push(`${i}=${v}: bad note`);
      } catch (e) {
        if (!(e instanceof M.MidiError)) odd.push(`${i}=${v}: ${e.name}`);
      }
    }
    for (let k = 0; k < 600; k++) {
      const b = Uint8Array.from([...txt("MThd"), 0, 0, 0, 6, rng2(2), rng2(3), rng2(3), rng2(3), rng2(256), rng2(256), ...Array.from({ length: rng2(70) }, () => rng2(256))]);
      fuzz++;
      try { M.readMidi(b); } catch (e) { if (!(e instanceof M.MidiError)) odd.push(`random ${k}: ${e.name}`); }
    }
    check(`   ${fuzz} damaged files (every byte of 3 files set to 7 other values, 600 random headers with random bytes): a MidiError or a clean read of notes that are whole, never another error (${odd.slice(0, 3).join("; ") || "none"})`, odd.length === 0);
  }

  console.log("MIDI import into a project: one edit, undone exactly, through the firmware");
  {
    const model = P.decode(images.B);
    const slot = model.slots[0];
    const kitT = Array.from({ length: P.NTRK }, (_, t) => t).find((t) => P.isKitTrack(slot, t));
    const melT = Array.from({ length: P.NTRK }, (_, t) => t).find((t) => !P.isKitTrack(slot, t));
    check(`13. the real slot (house) has a kit track (${kitT + 1}) and a melodic one (${melT + 1}) to import into`, kitT !== undefined && melT !== undefined);

    const src = synth([0]);
    src.tempoX10 = 1330;
    putPattern(src, 1, 0, { len: 12, scale: 2, nlen: 50 }, { 0: stp([48, 55, 60], { vel: 100, len: 4 }), 3: stp([62], { vel: 70, nudge: 5, len: 20 }), 7: stp([60, 64, 67, 72], { vel: 0, len: 70 }), 11: stp([36], { nudge: -7 }) });
    const mel = asExport(src, { track: 1, pattern: 0 });
    const res = M.fromMidi(mel.bytes, { slot, track: melT, pattern: 7, midiTrack: 1, scale: 2 });
    const snap = plain(model), pristine = P.decode(images.B).slots[0];
    const rec = M.applyImport(slot, melT, 7, res, true);
    check("   applying it is one edit: only that pattern and the tempo change, the pattern is the import's, the tempo is the file's (133 BPM)",
          slot.patterns[melT][7] === res.pattern && slot.tempoX10 === 1330 && plain(model) !== snap &&
          slot.patterns.every((row, t) => row.every((p, k) => (t === melT && k === 7) || plain(p) === plain(pristine.patterns[t][k]))));
    check("   the model is still one the FM-1 takes (validate: no problems), and it encodes", P.validate(model).length === 0 && P.encode(model).length > 0);
    M.revertImport(slot, rec);
    check("   undone, the model is exactly as it was (every byte of its encoding, and a deep comparison)", plain(model) === snap && same(P.encode(model), images.B));
    const keep = M.applyImport(slot, melT, 7, res, false);
    check("   applied without the tempo, the tempo stays; undone it is as before", slot.tempoX10 === pristine.tempoX10 && (M.revertImport(slot, keep), plain(model) === snap));
    refusesMidi("   taking the tempo of a file with none is refused", () => M.applyImport(slot, melT, 7, M.fromMidi(smf([trackOf([{ tick: 0, end: 12, key: 60 }])], { format: 0 }), { slot, track: melT, pattern: 7, midiTrack: 0 }), true), /no tempo to take/);
    check("   ... and the model is as it was", plain(model) === snap);

    // through the firmware: the real slot with imports in 5 melodic and 3 kit patterns, every pattern of all 3 slots read back
    const jobs = [];
    for (const [kit, scale, p] of [[false, 0, 0], [false, 1, 1], [false, 3, 2], [false, 5, 3], [false, 8, 4], [true, 0, 0], [true, 2, 1], [true, 4, 2]]) {
      const { pat, want } = randomPattern(kit, scale, [50, 33, 100][rng(3)]);
      const s2 = synth(kit ? [0] : []);
      s2.tempoX10 = 1330;
      s2.patterns[0][0] = pat;
      jobs.push({ kit, scale, p, pat, want, bytes: asExport(s2, { track: 0, pattern: 0 }) });
    }
    const target = P.decode(images.B), ts = target.slots[0];
    jobs.forEach((j) => {
      j.t = j.kit ? kitT : melT;
      ts.patterns[j.t][j.p].nlen = j.pat.nlen;
      j.res = M.fromMidi(j.bytes.bytes, { slot: ts, track: j.t, pattern: j.p, midiTrack: 1, scale: j.pat.scale });
      M.applyImport(ts, j.t, j.p, j.res, j.p === 0 && !j.kit);
    });
    const img = P.encode(target);
    const rr = agrees(img, 0, ts, "midi_host");
    check(`   in the simulator: the image restores, slot 1 loads, ${rr.asked} values and all ${P.NTRK * P.NPATT} pattern listings are the model's (tempo ${ts.tempoX10 / 10}), no failure`, rr.rc === 0 && rr.fails.length === 0 && rr.listing && rr.oks >= rr.asked);

    // and the notes it reports are the pattern the file was written from, step by step
    const rows = (out, t, p) => {
      const lines = out.split("\n"), at = lines.findIndex((l) => l.startsWith(`  track ${t + 1} pattern ${p + 1}:`));
      const head = lines[at].match(/: (\d+) steps, scale (\d+), nlen (\d+)/);
      const steps = [];
      for (let i = at + 1; i < lines.length && /^ {4}[ \d]\d:/.test(lines[i]); i++) {
        const m = lines[i].match(/^ {4}([ \d]\d):((?: \d+)*) {2}vel (\d+) len (\d+) nudge (-?\d+)/);
        steps.push([Number(m[1]) - 1, m[2].trim().split(" ").map(Number).sort((a, b) => a - b), Number(m[3]), Number(m[4]), Number(m[5])]);
      }
      return { len: Number(head[1]), scale: Number(head[2]), nlen: Number(head[3]), steps };
    };
    const notesHeard = jobs.reduce((a, j) => a + j.res.notes, 0);
    const heardNorm = (j) => {
      const heard = rows(rr.out, j.t, j.p), all = Array.from({ length: P.NSTEP }, () => norm(P.newStep(), false));
      heard.steps.forEach(([i, ids, v, l, d]) => { all[i] = JSON.stringify({ n: ids, v, l, d }); });
      return { heard, all };
    };
    const mismatches = jobs.filter((j) => {
      const { heard, all } = heardNorm(j);
      return heard.len !== j.pat.len || heard.scale !== j.pat.scale || plain(all) !== plain(j.want);
    });
    check(`   and the firmware lists, for each of the ${jobs.length} imported patterns, the notes the file was written from at their steps: ${notesHeard} notes with each step's notes, velocity, length, nudge, and the pattern's length and step size (wrong: ${mismatches.map((j) => `${j.kit ? "kit" : "notes"}/${j.scale}`).join(", ") || "none"})`,
          mismatches.length === 0 && notesHeard > 100);
    const { all: tamper } = heardNorm(jobs[1]);
    const first = tamper.findIndex((w) => w !== norm(P.newStep(), false));
    tamper[first] = tamper[first].replace(/\[(\d+)/, (m, n) => `[${Number(n) + 1}`);
    check("   the comparison can tell: one note a semitone off is not the written pattern", plain(tamper) !== plain(jobs[1].want));
    const worse = structuredClone(ts);
    const w1 = worse.patterns[melT][1].steps.findIndex((st) => !P.stepIsEmpty(st));
    worse.patterns[melT][1].steps[w1].nudge += worse.patterns[melT][1].steps[w1].nudge === 12 ? -1 : 1;
    check("   ... and the simulator tells a pattern one nudge off from the imported one", !agrees(img, 0, worse, "midi_host_wrong").listing);
  }

  console.log("demo songs: addDemoSlots puts whole songs into the empty slots and changes nothing else");
  {
    const rec = (img) => records(img).recs.map((r) => r.payload);
    const slotOf = (img, n) => rec(img).slice(1 + n * 7, 8 + n * 7);
    const sameSlot = (a, b) => a.length === b.length && a.every((p, k) => same(p, b[k]));
    const empty = () => new Uint8Array(0);
    const none = () => Array.from({ length: 7 }, empty);
    const settings = (format = 22) => { const s = new Uint8Array(64); put32(s, 0, 0x384D4F4C); put32(s, 4, format); return s; };
    const stream = (k) => Uint8Array.from([2, 0, 0, 0, k, 1, 2, 3]);
    const placeholder = () => Uint8Array.from([2, 0, 0, 0]);
    // a slot with n objects holding data (the settings, then streams): n flash sectors; the rest empty
    const sectors = (n, format = 22) => Array.from({ length: 7 }, (_, k) => k >= n ? empty() : k === 0 ? settings(format) : stream(k));
    // two objects with data and five stream objects that are a placeholder: two sectors
    const sparse = () => [settings(), stream(1), ...Array.from({ length: 5 }, placeholder)];
    const alone = (k, bytes) => Array.from({ length: 7 }, (_, i) => i === k ? bytes : empty());
    const image = (slots, flags = 0, presets = Uint8Array.from([1, 2, 3, 4, 5])) => build([presets, ...slots.flat()], { flags });
    const sectorsOf = (img) => rec(img).slice(1).filter((p) => p.length).length;
    // where record k's payload starts in the file
    const payloadAt = (img, k) => records(img).recs.slice(0, k).reduce((a, r) => a + 8 + r.payload.length, 16 + 8);
    const song = (name, n = 7, format = 22) => ({ name, bytes: image([sectors(n, format), none(), none()]) });

    // the pool: 20 sectors, counted by the objects with data, a placeholder not one
    const user6 = image([sectors(6), none(), none()]), user7 = image([sectors(7), none(), none()]);
    const at20 = P.addDemoSlots(user6, [song("a"), song("b")]);
    check("14. the pool's 20 sectors are allowed: slots of 6, 7 and 7 sectors are put together", at20.placed.length === 2 && sectorsOf(at20.bytes) === 20);
    refuses("   21 sectors (7 + 7 + 7) are MEMORY FULL, refused before anything is sent: a restore that ran out half way would leave the FM-1 half restored",
            () => P.addDemoSlots(user7, [song("a"), song("b")]), /MEMORY FULL.*21 flash sectors.*20.*Choose fewer songs/);
    const sparseSong = { name: "sparse", bytes: image([sparse(), none(), none()]) };
    check("   a demo's placeholders (a stream object that is its format word alone) take no sector: 7 + 2 + 7 fits, which 7 + 7 + 7 would not",
          P.addDemoSlots(user7, [sparseSong, song("b")]).placed.length === 2);
    const userSparse = image([sectors(7), sparse(), none()]);
    check("   and the user's own placeholders take none: 7 + 2 + 7 fits",
          P.addDemoSlots(userSparse, [song("b")]).placed[0].slot === 2);

    // what an empty slot is
    check("   a slot with nothing in it is empty, and so is one of placeholders alone (an older save's): slots 2 and 3",
          same(P.emptySlots(image([sectors(3), alone(0, empty()).map((p, k) => k >= 2 ? placeholder() : p), none()])), [1, 2]));
    const kept = image([alone(1, placeholder()), alone(3, Uint8Array.from([3, 0, 0, 0])), alone(2, Uint8Array.from([2, 0, 0, 0, 0]))]);
    check("   anything else is a project, and kept: a placeholder where the stream header goes, a stream word that is not 2, a placeholder with a byte more",
          same(P.emptySlots(kept), []));
    check("   a settings object alone is a project too (a half-written slot is not cleared)", same(P.emptySlots(image([alone(0, settings()), none(), none()])), [1, 2]));
    refuses("   a backup with no empty slot takes no song: refused, no project overwritten", () => P.addDemoSlots(kept, [song("a")]), /All three slots on the FM-1 hold a project/);
    const holes = image([sectors(3), none(), sparse().map((p, k) => k < 2 ? empty() : p)]);
    const filled = P.addDemoSlots(holes, [song("a"), song("b")]);
    check("   the songs replace a slot of placeholders: slot 3's seven objects are the song's, none of the placeholders is left",
          same(filled.placed.map((p) => p.slot), [1, 2]) && sameSlot(slotOf(filled.bytes, 2), slotOf(song("b").bytes, 0)));

    // a slot of an older format is somebody's project: not decoded, not changed
    const old = image([sectors(3, 15), none(), none()], 0, rec(presetsImg)[0]);
    const withOld = P.addDemoSlots(old, [song("a")]);
    check("   a slot of format 15 (the editor reads only 22) is kept byte for byte and the song goes in the next empty slot",
          sameSlot(slotOf(withOld.bytes, 0), slotOf(old, 0)) && sameSlot(slotOf(withOld.bytes, 1), slotOf(song("a").bytes, 0)) && withOld.placed[0].slot === 1);
    refuses("   (decode would have refused that file: it is why the songs are put in on the raw objects)", () => P.decode(withOld.bytes), /format 15/);

    // real songs from the simulator into a backup of one project
    const A = Uint8Array.from(images.A), B = Uint8Array.from(images.B), before = Uint8Array.from(presetsImg);
    const merged = P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: images.A }, { name: "house", bytes: images.B }]);
    const mm = P.decode(merged.bytes), pm = P.decode(presetsImg);
    check(`   two real songs go into the two empty slots, in order (placed: ${JSON.stringify(merged.placed)})`,
          same(merged.placed.map((p) => p.slot), [1, 2]) && merged.placed.map((p) => p.name).join() === "jungle,house");
    check("   slot 1 (the user's project) and the presets are the same bytes as before, decoded the same",
          sameSlot(slotOf(merged.bytes, 0), slotOf(presetsImg, 0)) && same(rec(merged.bytes)[0], rec(presetsImg)[0]) && plain(mm.slots[0]) === plain(pm.slots[0]));
    check("   slots 2 and 3 are the songs' first slots whole, not their other slots",
          plain(mm.slots[1]) === plain(P.decode(images.A).slots[0]) && plain(mm.slots[2]) === plain(P.decode(images.B).slots[0]) &&
          plain(mm.slots[1]) !== plain(P.decode(images.A).slots[1]));
    check("   the backup and the song files are not changed by it", same(presetsImg, before) && same(images.A, A) && same(images.B, B));
    const secs = Uint8Array.from({ length: 300 }, (_, i) => i * 7 & 255), withSecs = withSections(presetsImg, ["LSMP", secs]);
    const kept2 = P.addDemoSlots(withSecs, [{ name: "jungle", bytes: images.A }]).bytes;
    check("   the samples after the backup come through unchanged", same(kept2.subarray(kept2.length - 312), withSecs.subarray(withSecs.length - 312)));
    const playing = build(rec(presetsImg), { flags: 1 });
    check("   the container's version and flags (taken while playing) are the backup's", same(P.addDemoSlots(playing, [song("a")]).bytes.subarray(4, 12), playing.subarray(4, 12)));
    const sims = [0, 1, 2].map((n) => agrees(merged.bytes, n, mm.slots[n], `demo_slot${n + 1}`));
    check(`   the simulator restores it and loads each of the 3 slots as the model says (${sims.map((r) => `${r.oks}/${r.asked}`).join(" ")} values, ${sims.filter((r) => r.listing).length * 64} pattern listings)`,
          sims.every((r) => r.rc === 0 && r.fails.length === 0 && r.listing && r.oks >= r.asked));

    // what is refused
    refuses("   a backup with all three slots full takes no song", () => P.addDemoSlots(images.C, [{ name: "jungle", bytes: images.A }]), /All three slots on the FM-1 hold a project/);
    refuses("   3 songs for 2 empty slots are refused, and the message says how many", () => P.addDemoSlots(presetsImg, [song("a"), song("b"), song("c")]), /3 songs are chosen and 2 slots are empty\. Choose fewer songs/);
    refuses("   2 songs for 1 empty slot are refused, the message in the singular", () => P.addDemoSlots(image([sectors(2), sectors(2), none()]), [song("a"), song("b")]), /2 songs are chosen and 1 slot is empty/);
    refuses("   no song at all is refused", () => P.addDemoSlots(presetsImg, []), /No demo song is chosen/);
    const flipped = Uint8Array.from(images.A); flipped[payloadAt(images.A, 0)] ^= 1;
    const flippedEnd = Uint8Array.from(images.A); flippedEnd[payloadAt(images.A, 15)] ^= 1;
    refuses("   a song file with a byte changed in its presets is refused, and named", () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: flipped }]), /The demo song jungle cannot be used\. This backup is damaged/);
    refuses("   ... and one changed in its third slot, which is not the one taken (the whole file is checked)", () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: flippedEnd }]), /The demo song jungle cannot be used\. This backup is damaged/);
    refuses("   a song file cut short by a byte is refused", () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: images.A.subarray(0, images.A.length - 1) }]), /The demo song jungle cannot be used/);
    refuses("   a page that is not a backup (a server's error page in its place) is refused", () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: new TextEncoder().encode("<!doctype html><html><body>404 Not Found</body></html>") }]), /The demo song jungle cannot be used\. This file is not a SoundPlant backup/);
    refuses("   a song of format 15 is refused: this page puts format 22 on the FM-1",
            () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: rebuilt(images.A, (p) => { const s = Uint8Array.from(p[1]); put32(s, 4, 15); p[1] = s; }) }]), /The demo song jungle cannot be used: .*format 15/);
    refuses("   a song file with no project in its first slot is refused",
            () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: rebuilt(images.A, (p) => { for (let k = 1; k <= 7; k++) p[k] = empty(); }) }]), /holds no project in its first slot/);
    refuses("   ... and one whose first slot is not a SoundPlant project",
            () => P.addDemoSlots(presetsImg, [{ name: "jungle", bytes: rebuilt(images.A, (p) => { const s = Uint8Array.from(p[1]); s[0] ^= 1; p[1] = s; }) }]), /holds no project in its first slot/);
    const mid = Uint8Array.from(presetsImg); mid[mid.length >> 1] ^= 1;
    const e = thrown(() => P.addDemoSlots(mid, [{ name: "jungle", bytes: images.A }]));
    check("   a damaged backup of the FM-1 is refused too, and not blamed on the song", e instanceof P.ProjectError && /damaged/.test(e.message) && !/demo song/.test(e.message));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(bad ? `project web test FAILED (${bad})` : "project web test passed");
process.exit(bad ? 1 : 0);
