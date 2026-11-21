// SPDX-License-Identifier: MPL-2.0
// A SoundPlant backup file (the .soundplant file the backup page saves) as an editable model and back: the project
// editor (app/web/project/index.html) and a MIDI import/export build on decode() and encode(). The container is fm1-base's
// (base/tools/fm1_backup.py); a project slot is app/project.c's: a settings object (the packed tracks) and a packed
// stream of patterns_t (app/seq/pattern.h), both LZ-packed by app/lz.c, whose compressor lzCompress() repeats exactly.
//
// What the model holds: the user presets' and kits' names, and for each slot its settings (tempo, groove, start scene
// ...), its 13 tracks' parameters and names, the 8 instrument tracks' 8 patterns of 64 steps, the 32 scenes and the
// song. Everything else (the conductor's and the throws' patterns, the weave, the parameter lock lanes, the kit hits'
// settings, a preset's sound, the sample sections after the backup) is carried as it was, byte for byte: encode() of a
// model nothing changed in gives the same file, and a slot whose patterns are unchanged keeps its packed bytes whether
// or not another part of it changed. tests/host/project_web.mjs checks all of this against images the firmware's
// simulator made and the simulator's restore of an edited one.
//
// Only the format the firmware writes now (PROJ_FORMAT 22) is read: decode() throws on an older slot (the FM-1 migrates it
// when it loads it; load and save it there, then back up again). A slot's project name (settings_t.name) is not read by
// the firmware since projects lost their names, so it is not in the model.

export class ProjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectError";
  }
}

// ---- constants, from app/app.h, app/project.c, app/seq/pattern.h and app/dsp/synth.h
export const NTRK = 8, NALLTRK = 13, NSEQT = 10, NPATT = 8, NSTEP = 64, SN = 4, NSCENE = 32, NSONG = 64, NHIT = 48;
export const NPROJ = 3, NDRUM = 11, NAME_LEN = 12, NENGINE = 11, NTS = 9, NBS = 10, SONG_BARS = 64;
export const COND_AB = 100, COND_NAB = 35, LEN_MAX = NSTEP + 48, NSC = 16;
export const TEMPO_MIN = 400, TEMPO_MAX = 3000;     // tempo x10
export const EG_DRUMLINE = 8;                       // the kit engine: a step's notes are its sounds as bits
// parameter indices in a track's par[] (synth.h TP_*)
export const TP = { ENGINE: 0, VOLUME: 8, LEVEL: 48, PAN: 49, BRAIN: 50, CHAN: 51, N: 318 };
export const ENGINE_NAMES = ["knit", "rayon", "jacquard", "bellows", "cane", "voile", "sample", "slice", "kit", "midi", "acid"];
export const DRUM_SOUND_NAMES = ["kick", "snare", "hat", "open", "clap", "ltom", "htom", "conga", "shaker", "string", "fm"];
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const SCALE_SIXTEENTHS = [0.5, 1, 2, 3, 4, 5, 6, 8, 16];   // a pattern's step in sixteenths (TS_*)

const BACKUP_MAGIC = 0x42384D4C, BACKUP_VERSION = 1, BACKUP_OBJS = 22, BACKUP_HEAD = 16, BACKUP_REC = 8;
const STORE_MAX = 3840, OBJ_PRESETS = 1, PROJ_NOBJ = 7, NSTREAM = 6, POOL_SECTORS = 20;
const PROJ_MAGIC = 0x384D4F4C, PROJ_FORMAT = 22, PROJ_STREAM = 2, PRESETS_FORMAT = 11;
const STREAM_HDR = 16, STREAM_CAP = NSTREAM * (STORE_MAX - 4) - (STREAM_HDR - 4);   // project.c: more is MEMORY FULL
const SET_HDR = 58;                                  // settings_t before trk[]
const TRK_LEN = TP.N + NAME_LEN + 4, TRK_RAW = NALLTRK * TRK_LEN;
const STEP_LEN = 12, TPAT_LEN = NSTEP * STEP_LEN + 8, WVPAT_LEN = 4 + NSTEP * 3, LANE_LEN = 70, SCENE_LEN = 26;
const SONG_LEN = 4 + NSONG * 2, HIT_LEN = 5, NLANE = 96;
const WEAVE0 = NSEQT * NPATT * TPAT_LEN, LANE0 = WEAVE0 + NPATT * WVPAT_LEN, SCENE0 = LANE0 + NLANE * LANE_LEN;
const SONG0 = SCENE0 + NSCENE * SCENE_LEN, HIT0 = SONG0 + SONG_LEN, RAW_LEN = HIT0 + NHIT * HIT_LEN;   // 71572
const PRESET_LEN = NAME_LEN + 2 + 39, KIT_LEN = NAME_LEN + 39 + 264, NUSER_PRESETS = 16, NUSER_KITS = 8;
const PRESETS_KITS = 4 + NUSER_PRESETS * PRESET_LEN, PRESETS_LEN = PRESETS_KITS + NUSER_KITS * KIT_LEN;

const u16 = (b, o) => b[o] | b[o + 1] << 8;
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >> 8 & 255; };
const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >>> 8 & 255; b[o + 2] = v >>> 16 & 255; b[o + 3] = v >>> 24 & 255; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// ---- CRC-32 (zlib's)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(b, start = 0, end = b.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ c >>> 8;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---- app/lz.c: a control byte below 0x80 is that many + 1 literals; from 0x80 a match of (c & 0x7F) + 3 bytes at a
// distance (the next u16 + 1) back, copied a byte at a time (a short distance repeats)
const LZ_MIN = 3, LZ_MAXLEN = 130, LZ_MAXLIT = 128, LZ_HBITS = 11, LZ_MAXDIST = 65536, LZ_NONE = -1;

// the compressor as the firmware runs it, so a repacked stream is the one the FM-1 itself would write: its hash of
// three bytes, the last position of each hash kept as 16 bits (the rest taken from where it is now), a run at distance 1
// tried too, the first of two equal matches kept
export function lzCompress(inp) {
  const n = inp.length;
  if (n >= 0x1000000) throw new ProjectError("lzCompress: more than 16 MB");
  const head = new Uint16Array(1 << LZ_HBITS).fill(0xFFFF);
  const out = new Uint8Array(n + Math.ceil(n / LZ_MAXLIT) + 8);
  let w = 0;
  const hash = (p) => Math.imul(inp[p] << 16 | inp[p + 1] << 8 | inp[p + 2], 2654435761) >>> 32 - LZ_HBITS;
  const matchLen = (cand, i) => {
    let len = 0;
    while (len < LZ_MAXLEN && i + len < n && inp[cand + len] === inp[i + len]) len++;
    return len;
  };
  const literals = (from, to) => {
    while (from < to) {
      const k = Math.min(to - from, LZ_MAXLIT);
      out[w++] = k - 1;
      out.set(inp.subarray(from, from + k), w);
      w += k;
      from += k;
    }
  };
  let i = 0, lit = 0;
  while (i < n) {
    let best = 0, dist = 0;
    if (i + LZ_MIN <= n) {
      const h = hash(i);
      let c = (i & ~(LZ_MAXDIST - 1)) | head[h], len;
      if (c >= i) c = i >= LZ_MAXDIST ? c - LZ_MAXDIST : LZ_NONE;
      head[h] = i & 0xFFFF;
      if (c !== LZ_NONE && i - c <= LZ_MAXDIST && (len = matchLen(c, i)) > best) { best = len; dist = i - c; }
      if (i && (len = matchLen(i - 1, i)) > best) { best = len; dist = 1; }
    }
    if (best < LZ_MIN) { i++; continue; }
    literals(lit, i);
    out[w++] = 0x80 | best - LZ_MIN;
    out[w++] = dist - 1 & 255;
    out[w++] = dist - 1 >> 8;
    for (let k = 1; k < best && i + k + LZ_MIN <= n; k++) head[hash(i + k)] = i + k & 0xFFFF;
    i += best;
    lit = i;
  }
  literals(lit, i);
  return out.slice(0, w);
}

// n bytes from the packed bytes src[pos .. pos + left); throws as the firmware's lz_decompress fails (-1)
export function lzDecompress(src, pos, left, n) {
  const out = new Uint8Array(n), end = pos + left;
  const cut = () => new ProjectError("packed data ends early");
  let w = 0;
  while (w < n) {
    if (pos >= end) throw cut();
    const c = src[pos++];
    if (c < 0x80) {
      let len = c + 1;
      if (len > n - w || len > end - pos) throw len > n - w ? new ProjectError("packed data is longer than it says") : cut();
      while (len--) out[w++] = src[pos++];
      continue;
    }
    let len = (c & 0x7F) + LZ_MIN;
    if (end - pos < 2) throw cut();
    const dist = (src[pos] | src[pos + 1] << 8) + 1;
    pos += 2;
    if (dist > w || len > n - w) throw new ProjectError("packed data points outside what it has made");
    while (len--) { out[w] = out[w - dist]; w++; }
  }
  return out;
}

// ---- steps and patterns
export const newStep = () => ({ notes: [0, 0, 0, 0], vel: 0, len: 0, nudge: 0, comp: 0, cval: 0, cond: 0, comp2: 0, cval2: 0 });
// pattern_init: 16 steps at scale 1, quantise 100, note length half a step
export const newPattern = () => ({
  len: 16, scale: 1, groove: 0, quant: 100, nlen: 50, shape: 0, lstart: 0, lend: 0,
  steps: Array.from({ length: NSTEP }, newStep),
});
export const stepIsEmpty = (st) => st.notes.every((n) => n === 0);
// a step the firmware has cleared (ui.c step_fresh_if_empty): nothing on it, no length, nudge or tricks, velocity 100
function resetStep(st) {
  st.notes = [0, 0, 0, 0];
  st.vel = 100;
  st.len = st.nudge = st.comp = st.cval = st.cond = st.comp2 = st.cval2 = 0;
}
export function clearStep(pat, i) { resetStep(pat.steps[i]); }
function grow(pat, i) { if (i >= pat.len) pat.len = i + 1; }   // a step past the pattern's end lengthens it (ui.c step_toggle)
// a melodic step: the note on or off (up to SN notes); false when the step already holds SN others
export function toggleNote(pat, i, note) {
  const st = pat.steps[i];
  if (stepIsEmpty(st)) resetStep(st);
  const at = st.notes.indexOf(note);
  if (at >= 0) {
    st.notes.splice(at, 1);
    st.notes.push(0);
    if (stepIsEmpty(st)) resetStep(st);
    return true;
  }
  const free = st.notes.indexOf(0);
  if (free < 0) return false;
  st.notes[free] = note;
  grow(pat, i);
  return true;
}
// a kit step's sounds are bits (seq/pattern.h kit_*): sound k (1..11) is bit k - 1 of notes[0] (1..8) and notes[1] (9..11)
export const kitMask = (st) => (st.notes[0] | st.notes[1] << 8) & (1 << NDRUM) - 1;
export const kitHas = (st, sound) => sound >= 1 && sound <= NDRUM && (kitMask(st) >> sound - 1 & 1) === 1;
export function kitSet(st, mask) {
  mask &= (1 << NDRUM) - 1;
  st.notes = [mask & 255, mask >> 8, 0, 0];
}
export function toggleKitSound(pat, i, sound) {
  if (!isInt(sound, 1, NDRUM)) throw new ProjectError(`a kit has sounds 1 to ${NDRUM}, not ${sound}`);
  const st = pat.steps[i];
  if (stepIsEmpty(st)) resetStep(st);
  kitSet(st, kitMask(st) ^ 1 << sound - 1);
  if (stepIsEmpty(st)) resetStep(st); else grow(pat, i);
}
// a step's length (len): 0 the pattern's note length; 1..64 quarter steps; 65..112 whole steps from 17 to 64 (pattern.h)
export const stepLenQuarters = (len) => len <= 64 ? len : (len > LEN_MAX ? NSTEP : len - 48) * 4;
export function stepLenCode(q) {
  if (q <= 64) return q < 1 ? 1 : q;
  const c = Math.floor((q + 3) / 4) + 48;
  return c > LEN_MAX ? LEN_MAX : c;
}
// a step's condition: 0 always; 1..99 that chance in %; COND_AB + k the k-th A:B cycle (1:2 2:2 1:3 2:3 3:3 1:4 ... 8:8)
export function condAB(k) {
  let n = 2;
  k = Math.min(Math.max(k, 0), COND_NAB - 1);
  while (k >= n) { k -= n; n++; }
  return [k + 1, n];
}
export function condText(cond) {
  if (cond === 0) return "always";
  if (cond < COND_AB) return `${cond} %`;
  const [a, b] = condAB(cond - COND_AB);
  return `${a}:${b}`;
}
export const noteName = (n) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
export const isKitTrack = (slot, t) => t < NTRK && slot.tracks[t].par[TP.ENGINE] === EG_DRUMLINE;

// ---- the container
function readSections(file, at) {
  const sections = [];
  while (at < file.length) {
    if (at + 8 > file.length) throw new ProjectError("This backup is damaged (a section after it is cut short).");
    const tag = String.fromCharCode(...file.subarray(at, at + 4)), len = u32(file, at + 4);
    if (at + 8 + len + 4 > file.length) throw new ProjectError(`This backup is damaged (its section ${tag} is cut short).`);
    const data = file.slice(at + 8, at + 8 + len);
    if (u32(file, at + 8 + len) !== crc32(data)) throw new ProjectError(`This backup is damaged (its section ${tag}: a byte changed).`);
    sections.push({ tag, data });
    at += 8 + len + 4;
  }
  return sections;
}

// the file's records, each checked: [{id, payload}], the version and flags, and the sections after the backup
function readContainer(file) {
  if (file.length < BACKUP_HEAD + 4) throw new ProjectError("This file is too short to be a SoundPlant backup.");
  if (u32(file, 0) !== BACKUP_MAGIC) throw new ProjectError("This file is not a SoundPlant backup (it does not start with LM8B).");
  if (u32(file, 12) !== crc32(file, 0, 12)) throw new ProjectError("This backup is damaged (its head).");
  const version = u16(file, 4), count = u16(file, 6), flags = u32(file, 8);
  if (version !== BACKUP_VERSION) throw new ProjectError(`This is a backup of version ${version}; this editor reads version ${BACKUP_VERSION}.`);
  if (count !== BACKUP_OBJS) throw new ProjectError(`This backup holds ${count} parts; a SoundPlant backup holds ${BACKUP_OBJS}.`);
  const records = [];
  let pos = BACKUP_HEAD;
  for (let k = 0; k < count; k++) {
    if (pos + BACKUP_REC > file.length) throw new ProjectError("This backup is cut short.");
    const id = u16(file, pos), len = u16(file, pos + 2), crc = u32(file, pos + 4);
    pos += BACKUP_REC;
    if (id !== OBJ_PRESETS + k) throw new ProjectError(`This backup is damaged (part ${k + 1} is numbered ${id}, not ${OBJ_PRESETS + k}).`);
    if (len > STORE_MAX) throw new ProjectError(`This backup is damaged (part ${k + 1} is ${len} bytes: at most ${STORE_MAX}).`);
    if (pos + len + 4 > file.length) throw new ProjectError("This backup is cut short.");
    const payload = file.slice(pos, pos + len);
    if (crc32(payload) !== crc) throw new ProjectError(`This backup is damaged (part ${k + 1}: a byte changed).`);
    records.push({ id, payload });
    pos += len;
  }
  if (u32(file, pos) !== crc32(file, 0, pos)) throw new ProjectError("This backup is damaged (the whole file's check).");
  return { version, flags, records, sections: readSections(file, pos + 4) };
}

function buildContainer(version, flags, payloads, sections) {
  const size = BACKUP_HEAD + payloads.reduce((a, p) => a + BACKUP_REC + p.length, 4) + sections.reduce((a, s) => a + 12 + s.data.length, 0);
  const out = new Uint8Array(size);
  put32(out, 0, BACKUP_MAGIC);
  put16(out, 4, version);
  put16(out, 6, payloads.length);
  put32(out, 8, flags);
  put32(out, 12, crc32(out, 0, 12));
  let pos = BACKUP_HEAD;
  payloads.forEach((p, k) => {
    put16(out, pos, OBJ_PRESETS + k);
    put16(out, pos + 2, p.length);
    put32(out, pos + 4, crc32(p));
    out.set(p, pos + BACKUP_REC);
    pos += BACKUP_REC + p.length;
  });
  put32(out, pos, crc32(out, 0, pos));
  pos += 4;
  for (const s of sections) {
    for (let i = 0; i < 4; i++) out[pos + i] = s.tag.charCodeAt(i);
    put32(out, pos + 4, s.data.length);
    out.set(s.data, pos + 8);
    put32(out, pos + 8 + s.data.length, crc32(s.data));
    pos += 12 + s.data.length;
  }
  return out;
}

// ---- the user presets (app/project.c presets_load): format 11, 16 presets then 8 kits. Only their names are the model's.
const nameAt = (b, o) => {
  let s = "";
  for (let i = 0; i < NAME_LEN - 1 && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
};
const putName = (b, o, s) => { b.fill(0, o, o + NAME_LEN); for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
const nameOk = (s) => typeof s === "string" && s.length >= 1 && s.length < NAME_LEN && /^[\x20-\x7e]*$/.test(s);

function decodePresets(raw) {
  if (!raw.length) return null;
  const format = raw.length >= 4 ? u32(raw, 0) : null;
  if (format !== PRESETS_FORMAT || raw.length !== PRESETS_LEN) return { format, presets: null, kits: null, _raw: raw };
  const presets = [], kits = [];
  for (let k = 0; k < NUSER_PRESETS; k++) {
    const o = 4 + k * PRESET_LEN;
    presets.push(raw[o] && raw[o + NAME_LEN] < NENGINE ? { name: nameAt(raw, o), engine: raw[o + NAME_LEN] } : null);
  }
  for (let k = 0; k < NUSER_KITS; k++) {
    const o = PRESETS_KITS + k * KIT_LEN;
    kits.push(raw[o] && raw[o + NAME_LEN] === EG_DRUMLINE ? { name: nameAt(raw, o) } : null);
  }
  return { format, presets, kits, _raw: raw };
}

function presetsProblems(p, bad) {
  if (!p || !p.presets) return;
  const check = (what, e, k) => {
    if (e && !nameOk(e.name)) bad.push(`${what} ${k + 1}: its name is 1 to ${NAME_LEN - 1} letters, digits or signs`);
  };
  p.presets.forEach((e, k) => check("User preset", e, k));
  p.kits.forEach((e, k) => check("User kit", e, k));
}

function encodePresets(p) {
  if (!p) return new Uint8Array(0);
  if (!p.presets) return p._raw;
  const out = p._raw.slice();
  const put = (e, o) => { if (e && e.name !== nameAt(out, o)) putName(out, o, e.name); };
  p.presets.forEach((e, k) => put(e, 4 + k * PRESET_LEN));
  p.kits.forEach((e, k) => put(e, PRESETS_KITS + k * KIT_LEN));
  return same(out, p._raw) ? p._raw : out;
}

// ---- a project slot
function trackName(trk, t) { return nameAt(trk, t * TRK_LEN + TP.N); }

function decodeTracks(trk) {
  return Array.from({ length: NALLTRK }, (_, t) => {
    const o = t * TRK_LEN;
    return { name: trackName(trk, t), par: trk.slice(o, o + TP.N), rsv: trk.slice(o + TP.N + NAME_LEN, o + TRK_LEN) };
  });
}

function decodeStep(raw, o) {
  return {
    notes: [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]], vel: raw[o + 4], len: raw[o + 5], nudge: raw[o + 6] << 24 >> 24,
    comp: raw[o + 7], cval: raw[o + 8], cond: raw[o + 9], comp2: raw[o + 10], cval2: raw[o + 11],
  };
}

function decodePattern(raw, o) {
  const p = o + NSTEP * STEP_LEN;
  return {
    len: raw[p], scale: raw[p + 1], groove: raw[p + 2] << 24 >> 24, quant: raw[p + 3], nlen: raw[p + 4], shape: raw[p + 5],
    lstart: raw[p + 6], lend: raw[p + 7],
    steps: Array.from({ length: NSTEP }, (_, k) => decodeStep(raw, o + k * STEP_LEN)),
  };
}

function decodeScene(raw, o) {
  return {
    pat: Array.from(raw.subarray(o, o + NSEQT)), used: raw[o + 10], mute: u16(raw, o + 12),
    brainKey: raw[o + 14], brainScale: raw[o + 15], brainDeg: raw[o + 16] << 24 >> 24, weave: raw[o + 17],
    kmute: [0, 1, 2, 3].map((k) => u16(raw, o + 18 + 2 * k)),
  };
}

function decodeSlot(n, objs) {
  const where = `Slot ${n + 1}`;
  if (!objs[0].length) {
    if (objs.some((o) => o.length)) throw new ProjectError(`${where} has pattern data but no settings.`);
    return null;
  }
  const s = objs[0];
  if (s.length < SET_HDR + 4 || u32(s, 0) !== PROJ_MAGIC) throw new ProjectError(`${where} is damaged (its settings are not a SoundPlant project's).`);
  const format = u32(s, 4);
  if (format !== PROJ_FORMAT) {
    throw new ProjectError(`${where} is a project of format ${format}; this editor reads format ${PROJ_FORMAT}, the one this SoundPlant saves. ` +
      "Load that slot on the FM-1, save it, and make the backup again.");
  }
  const tlen = u32(s, SET_HDR);
  if (tlen > s.length - SET_HDR - 4) throw new ProjectError(`${where} is damaged (its tracks run past their object).`);
  let trk;
  try { trk = lzDecompress(s, SET_HDR + 4, tlen, TRK_RAW); } catch (e) { throw new ProjectError(`${where} is damaged (its tracks: ${e.message}).`); }
  const tempoX10 = u16(s, 20);
  if (tempoX10 < TEMPO_MIN || tempoX10 > TEMPO_MAX || s[30] >= NSCENE || s[31] >= NALLTRK) {
    throw new ProjectError(`${where} is damaged (its tempo, start scene or selected track is out of range).`);
  }

  const st = objs[1];
  if (st.length < STREAM_HDR || u32(st, 0) !== PROJ_STREAM) throw new ProjectError(`${where} is damaged (its patterns are missing).`);
  const rawLen = u32(st, 4), plen = u32(st, 12);
  if (rawLen !== RAW_LEN) throw new ProjectError(`${where} has its patterns in an older layout (${rawLen} bytes, not ${RAW_LEN}): load it on the FM-1, save it, and make the backup again.`);
  if (plen > STREAM_CAP) throw new ProjectError(`${where} is damaged (its packed patterns are ${plen} bytes: at most ${STREAM_CAP}).`);
  const packed = new Uint8Array(plen);
  let got = Math.min(plen, st.length - STREAM_HDR);
  packed.set(st.subarray(STREAM_HDR, STREAM_HDR + got));
  for (let k = 2; got < plen; k++) {
    const o = objs[k];
    if (k > NSTREAM || o.length < 4 || u32(o, 0) !== PROJ_STREAM) throw new ProjectError(`${where} is damaged (its patterns are cut short).`);
    const take = Math.min(plen - got, o.length - 4);
    packed.set(o.subarray(4, 4 + take), got);
    got += take;
  }
  let pats;
  try { pats = lzDecompress(packed, 0, plen, RAW_LEN); } catch (e) { throw new ProjectError(`${where} is damaged (its patterns: ${e.message}).`); }
  if (crc32(pats) !== u32(st, 8)) throw new ProjectError(`${where} is damaged (its patterns do not match their check sum).`);

  const patterns = Array.from({ length: NTRK }, (_, t) => Array.from({ length: NPATT }, (_, p) => decodePattern(pats, (t * NPATT + p) * TPAT_LEN)));
  return {
    tempoX10, swing: s[22], groove: s[23], metronome: s[24], lights: s[25], clock: s[26], sendNotes: s[27], oneCore: s[28], usbFull: s[29],
    scene: s[30], trkSel: s[31], rsv: s.slice(32, 42), master: s.slice(42, 58),
    tracks: decodeTracks(trk),
    patterns,
    scenes: Array.from({ length: NSCENE }, (_, k) => decodeScene(pats, SCENE0 + k * SCENE_LEN)),
    song: {
      len: pats[SONG0], loop: pats[SONG0 + 1],
      slots: Array.from({ length: NSONG }, (_, k) => ({ scene: pats[SONG0 + 4 + 2 * k], rep: pats[SONG0 + 5 + 2 * k] })),
    },
    _src: { objects: objs, head: s.slice(0, SET_HDR), trk, trkPacked: s.slice(SET_HDR + 4, SET_HDR + 4 + tlen), pats },
  };
}

// the slot's values written over its source's bytes: what the model does not hold stays as it was
function patchHead(slot) {
  const h = slot._src.head.slice();
  put16(h, 20, slot.tempoX10);
  h[22] = slot.swing; h[23] = slot.groove; h[24] = slot.metronome; h[25] = slot.lights; h[26] = slot.clock;
  h[27] = slot.sendNotes; h[28] = slot.oneCore; h[29] = slot.usbFull; h[30] = slot.scene; h[31] = slot.trkSel;
  h.set(slot.rsv, 32);
  h.set(slot.master, 42);
  return h;
}

function patchTracks(slot) {
  const trk = slot._src.trk.slice();
  slot.tracks.forEach((t, k) => {
    const o = k * TRK_LEN;
    trk.set(t.par, o);
    if (t.name !== trackName(trk, k)) putName(trk, o + TP.N, t.name);
    trk.set(t.rsv, o + TP.N + NAME_LEN);
  });
  return trk;
}

function patchPatterns(slot) {
  const raw = slot._src.pats.slice();
  slot.patterns.forEach((row, t) => row.forEach((p, k) => {
    const o = (t * NPATT + k) * TPAT_LEN, q = o + NSTEP * STEP_LEN;
    p.steps.forEach((s, i) => {
      const a = o + i * STEP_LEN;
      raw.set(s.notes, a);
      raw[a + 4] = s.vel; raw[a + 5] = s.len; raw[a + 6] = s.nudge & 255; raw[a + 7] = s.comp; raw[a + 8] = s.cval;
      raw[a + 9] = s.cond; raw[a + 10] = s.comp2; raw[a + 11] = s.cval2;
    });
    raw[q] = p.len; raw[q + 1] = p.scale; raw[q + 2] = p.groove & 255; raw[q + 3] = p.quant; raw[q + 4] = p.nlen;
    raw[q + 5] = p.shape; raw[q + 6] = p.lstart; raw[q + 7] = p.lend;
  }));
  slot.scenes.forEach((s, k) => {
    const o = SCENE0 + k * SCENE_LEN;
    raw.set(s.pat, o);
    raw[o + 10] = s.used;
    put16(raw, o + 12, s.mute);
    raw[o + 14] = s.brainKey; raw[o + 15] = s.brainScale; raw[o + 16] = s.brainDeg & 255; raw[o + 17] = s.weave;
    s.kmute.forEach((m, j) => put16(raw, o + 18 + 2 * j, m));
  });
  raw[SONG0] = slot.song.len;
  raw[SONG0 + 1] = slot.song.loop;
  slot.song.slots.forEach((s, k) => { raw[SONG0 + 4 + 2 * k] = s.scene; raw[SONG0 + 5 + 2 * k] = s.rep; });
  return raw;
}

// the arrays a slot is made of, each with the size the patches below index: '' when they all have it
function slotShape(slot) {
  const sized = (a, len) => Array.isArray(a) || ArrayBuffer.isView(a) ? a.length === len : false;
  if (!sized(slot.rsv, 10) || !sized(slot.master, 16)) return "the reserved bytes and the master settings have a fixed size";
  if (!sized(slot.tracks, NALLTRK) || !slot.tracks.every((t) => sized(t.par, TP.N) && sized(t.rsv, 4))) return `it has ${NALLTRK} tracks of ${TP.N} parameters`;
  if (!sized(slot.patterns, NTRK) || !slot.patterns.every((row) => sized(row, NPATT) && row.every((p) => sized(p.steps, NSTEP) && p.steps.every((s) => sized(s.notes, SN))))) {
    return `it has ${NTRK} tracks of ${NPATT} patterns of ${NSTEP} steps of ${SN} notes`;
  }
  if (!sized(slot.scenes, NSCENE) || !slot.scenes.every((s) => sized(s.pat, NSEQT) && sized(s.kmute, 4))) return `it has ${NSCENE} scenes`;
  if (!slot.song || !sized(slot.song.slots, NSONG)) return `its song has ${NSONG} parts`;
  return "";
}

// what the firmware would clamp or cannot store: the values it would change when it loads the slot
function slotProblems(slot, n, bad) {
  const at = `Slot ${n + 1}`;
  const shape = slotShape(slot);
  if (shape) { bad.push(`${at}: ${shape}`); return; }
  const need = (ok, what) => { if (!ok && bad.length < 200) bad.push(`${at}: ${what}`); };
  need(isInt(slot.tempoX10, TEMPO_MIN, TEMPO_MAX), `the tempo is ${slot.tempoX10 / 10} BPM; it runs from ${TEMPO_MIN / 10} to ${TEMPO_MAX / 10}`);
  need(isInt(slot.scene, 0, NSCENE - 1), `the start scene is ${slot.scene + 1}; there are ${NSCENE}`);
  need(isInt(slot.trkSel, 0, NALLTRK - 1), `the selected track is ${slot.trkSel}`);
  for (const f of ["swing", "groove", "metronome", "lights", "clock", "sendNotes", "oneCore", "usbFull"]) need(isInt(slot[f], 0, 255), `${f} is a byte`);
  slot.tracks.forEach((t, k) => {
    const tt = `track ${k + 1}`;
    need(nameOk(t.name) || t.name === "", `${tt}: its name is up to ${NAME_LEN - 1} letters, digits or signs`);
    if (k < NTRK) need(t.par[TP.ENGINE] < NENGINE, `${tt}: engine ${t.par[TP.ENGINE]} does not exist`);
    need(t.par[TP.LEVEL] <= 127, `${tt}: the level is 0 to 127`);
    need(t.par[TP.PAN] <= 127, `${tt}: the pan is 0 to 127`);
  });
  slot.patterns.forEach((row, t) => row.forEach((p, k) => {
    const pp = `track ${t + 1} pattern ${k + 1}`, kit = slot.tracks[t].par[TP.ENGINE] === EG_DRUMLINE;
    need(isInt(p.len, 1, NSTEP), `${pp}: its length is 1 to ${NSTEP} steps`);
    need(isInt(p.scale, 0, NTS - 1), `${pp}: its scale is 0 to ${NTS - 1}`);
    need(isInt(p.groove, -99, 99), `${pp}: its groove is -99 to 99`);
    need(isInt(p.quant, 0, 100) && isInt(p.nlen, 0, 100), `${pp}: its quantise and note length are 0 to 100`);
    need(isInt(p.shape, 0, 255) && isInt(p.lstart, 0, 255) && isInt(p.lend, 0, 255), `${pp}: its shape and loop are bytes`);
    p.steps.forEach((s, i) => {
      const ss = `${pp} step ${i + 1}`;
      need(s.notes.every((v) => isInt(v, 0, kit ? 255 : 127)), `${ss}: its notes are 0 to 127`);
      if (kit) need(s.notes[1] < 1 << NDRUM - 8 && !s.notes[2] && !s.notes[3], `${ss}: a kit step holds its sounds 1 to ${NDRUM} only`);
      need(isInt(s.vel, 0, 127), `${ss}: the velocity is 0 to 127`);
      need(isInt(s.len, 0, LEN_MAX), `${ss}: the length is 0 to ${LEN_MAX}`);
      need(isInt(s.nudge, -12, 12), `${ss}: the nudge is -12 to 12`);
      need(isInt(s.comp, 0, NSC - 1) && isInt(s.comp2, 0, NSC - 1), `${ss}: its tricks are 0 to ${NSC - 1}`);
      need(isInt(s.cval, 0, 255) && isInt(s.cval2, 0, 255), `${ss}: its trick values are bytes`);
      need(isInt(s.cond, 0, COND_AB + COND_NAB - 1), `${ss}: its condition is 0 to ${COND_AB + COND_NAB - 1}`);
    });
  }));
  slot.scenes.forEach((s, k) => {
    const sc = `scene ${k + 1}`;
    need(s.pat.every((v) => isInt(v, 0, NPATT - 1)), `${sc}: each track's pattern is 1 to ${NPATT}`);
    need(isInt(s.used, 0, 1), `${sc}: used is 0 or 1`);
    need(isInt(s.mute, 0, (1 << NSEQT) - 1), `${sc}: the mute mask has ${NSEQT} bits`);
    need(isInt(s.brainKey, 0, 11) && isInt(s.brainScale, 0, NBS - 1), `${sc}: the conductor's key is 0 to 11 and its scale 0 to ${NBS - 1}`);
    need(isInt(s.brainDeg, -128, 127), `${sc}: the conductor's degree is -128 to 127`);
    need(isInt(s.weave, 0, NPATT - 1), `${sc}: its weave pattern is 1 to ${NPATT}`);
    need(s.kmute.every((v) => isInt(v, 0, (1 << NDRUM) - 1)), `${sc}: the kit mutes have ${NDRUM} bits each`);
  });
  need(isInt(slot.song.len, 0, NSONG), `the song has at most ${NSONG} parts`);
  need(isInt(slot.song.loop, 0, 1), "the song's loop is 0 or 1");
  slot.song.slots.forEach((s, k) => {   // (the parts past the song's end play nothing; the firmware stores them as 0 bars)
    const live = k < slot.song.len;
    need(isInt(s.scene, 0, live ? NSCENE - 1 : 255), `song part ${k + 1}: its scene is 1 to ${NSCENE}`);
    need(isInt(s.rep, live ? 1 : 0, live ? SONG_BARS : 255), `song part ${k + 1}: its bars are 1 to ${SONG_BARS}`);
  });
}

function packStream(pats, packed) {
  const objs = [];
  const first = new Uint8Array(STREAM_HDR + Math.min(packed.length, STORE_MAX - STREAM_HDR));
  put32(first, 0, PROJ_STREAM);
  put32(first, 4, RAW_LEN);
  put32(first, 8, crc32(pats));
  put32(first, 12, packed.length);
  first.set(packed.subarray(0, first.length - STREAM_HDR), STREAM_HDR);
  objs.push(first);
  for (let at = first.length - STREAM_HDR; at < packed.length; at += STORE_MAX - 4) {
    const o = new Uint8Array(4 + Math.min(packed.length - at, STORE_MAX - 4));
    put32(o, 0, PROJ_STREAM);
    o.set(packed.subarray(at, at + o.length - 4), 4);
    objs.push(o);
  }
  while (objs.length < NSTREAM) objs.push(new Uint8Array(0));
  return objs;
}

// the slot's seven objects: [settings, stream x 6]; the source's own when nothing in them changed
function slotObjects(slot, n) {
  const shape = slotShape(slot);
  if (shape) throw new ProjectError(`Slot ${n + 1}: ${shape}`);
  const src = slot._src, head = patchHead(slot), trk = patchTracks(slot), pats = patchPatterns(slot);
  const trkSame = same(trk, src.trk), patsSame = same(pats, src.pats), headSame = same(head, src.head);
  if (trkSame && patsSame && headSame) return { objects: src.objects, changed: false };
  const bad = [];
  slotProblems(slot, n, bad);
  if (bad.length) throw new ProjectError(bad.length > 1 ? `${bad[0]} (and ${bad.length - 1} more)` : bad[0]);
  const objects = src.objects.slice();
  if (!trkSame || !headSame) {
    const packed = trkSame ? src.trkPacked : lzCompress(trk);
    if (SET_HDR + 4 + packed.length > STORE_MAX) throw new ProjectError(`Slot ${n + 1}: its tracks do not pack into one object.`);
    const s = new Uint8Array(SET_HDR + 4 + packed.length);
    s.set(head);
    put32(s, SET_HDR, packed.length);
    s.set(packed, SET_HDR + 4);
    objects[0] = s;
  }
  if (!patsSame) {
    const packed = lzCompress(pats);
    if (packed.length > STREAM_CAP) throw new ProjectError(`Slot ${n + 1}: MEMORY FULL, its patterns pack to ${packed.length} bytes and a slot holds ${STREAM_CAP}.`);
    packStream(pats, packed).forEach((o, k) => { objects[1 + k] = o; });
  }
  return { objects, changed: true };
}

// ---- the model
// decode(bytes) -> {container: {version, flags}, presets, slots: [slot | null] x 3, sections: [{tag, data}]}
// presets: null (none saved) or {format, presets: [{name, engine} | null] x 16, kits: [{name} | null] x 8} (format 11; another
// format: presets and kits null, kept as they are)
// slot: {tempoX10, swing, groove, metronome, lights, clock, sendNotes, oneCore, usbFull, scene (the start scene, 0-based),
//   trkSel, rsv, master, tracks: [{name, par (TP.*: engine, level, pan ...), rsv}] x 13 (T1..T8, conductor, throws, FX I,
//   FX II, weave), patterns[track 0..7][pattern 0..7]: {len, scale, groove, quant, nlen, shape, lstart, lend, steps: [{notes,
//   vel, len, nudge, comp, cval, cond, comp2, cval2}] x 64}, scenes: [{pat: [track patterns x 10], used, mute (a bit a
//   sequenced track), brainKey, brainScale, brainDeg, weave, kmute}] x 32, song: {len, loop, slots: [{scene, rep}] x 64}}
// A track's mute is the scene's: a scene mutes the tracks in its mask.
export function decode(bytes) {
  const file = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const { version, flags, records, sections } = readContainer(file);
  const slots = [];
  for (let n = 0; n < NPROJ; n++) slots.push(decodeSlot(n, records.slice(1 + n * PROJ_NOBJ, 1 + (n + 1) * PROJ_NOBJ).map((r) => r.payload)));
  return { container: { version, flags }, presets: decodePresets(records[0].payload), slots, sections };
}

// the problems a model has: what the FM-1 would clamp or not hold ([] = none)
export function validate(model) {
  const bad = [];
  presetsProblems(model.presets, bad);
  model.slots.forEach((s, n) => { if (s) slotProblems(s, n, bad); });
  return bad;
}

// the flash a model's slots take: [{objects, packed (the patterns' packed bytes), cap}] and the sectors of the pool's 20
export function measure(model) {
  let sectors = 0;
  const slots = model.slots.map((s, n) => {
    if (!s) return null;
    const { objects } = slotObjects(s, n);
    const used = objects.filter((o) => o.length).length;
    sectors += used;
    return { objects: used, packed: u32(objects[1], 12), cap: STREAM_CAP };
  });
  return { slots, sectors, pool: POOL_SECTORS };
}

// encode(model) -> the file's bytes; throws a ProjectError naming what cannot be stored
export function encode(model) {
  if (model.slots.length !== NPROJ) throw new ProjectError(`A backup holds ${NPROJ} slots.`);
  const bad = [];
  presetsProblems(model.presets, bad);
  if (bad.length) throw new ProjectError(bad[0]);
  const payloads = [encodePresets(model.presets)];
  let sectors = 0;
  model.slots.forEach((s, n) => {
    const objs = s ? slotObjects(s, n).objects : Array.from({ length: PROJ_NOBJ }, () => new Uint8Array(0));
    sectors += objs.filter((o) => o.length).length;
    payloads.push(...objs);
  });
  if (sectors > POOL_SECTORS) throw new ProjectError(`MEMORY FULL: the three slots take ${sectors} flash sectors and the FM-1 has ${POOL_SECTORS} for them.`);
  return buildContainer(model.container.version, model.container.flags, payloads, model.sections);
}
