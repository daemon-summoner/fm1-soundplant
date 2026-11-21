// SPDX-License-Identifier: MPL-2.0
// Preparing a sample before it goes into the bank: trim, zero-crossing snap, fades, reverse, mono, level and a loop, as
// plain functions on float samples (the samples page, app/web/samples/index.html, inlines this after
// soundplant_samples.js at LIB). None of them changes its arguments. tests/host/samples_web.mjs checks them.
// Copyright (C) 2026 Charles Vestal.
//
// What a bank entry can hold of a sample (dsp/sample.h smp_t): its samples, a rate, a root note, bars and one loop
// (ls, le: the sample engine's loop and ping-pong modes play it). Slices are not stored: the slice engine cuts every
// sample into equal parts at play time (a track's slice count), so a loop's bars and its exact length are all it takes.
import { imaDecode, toInt16 } from "./soundplant_samples.js";

export const MIN_TRIM = 32;                       // the least the engine plays of a sample (dsp/synth.c: regions and loops are 32 samples at least)
export const MIN_LOOP = 32;
export const ZC_RADIUS = 4096;                    // how far a snap looks for a zero crossing, in samples
export const CLIP_RUN = 3;                        // samples in a row at the peak that make a flat top
export const toDb = (v) => 20 * Math.log10(v);
export const fromDb = (d) => Math.pow(10, d / 20);
export const BANK_DB = toDb(30000 / 32768);       // the level the bank gives a new sample (toInt16's 30000): -0.77 dBFS

// the largest |sample| and where (a sample that is not a number or not finite: peak NaN, at it); clipped: the samples in
// flat tops (CLIP_RUN or more in a row at the peak)
export function peakOf(x) {
  let peak = 0, at = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (!Number.isFinite(a)) return { peak: NaN, at: i, clipped: 0 };
    if (a > peak) { peak = a; at = i; }
  }
  let clipped = 0;
  if (peak > 0) {
    const lo = peak * (1 - 1e-9);
    for (let i = 0; i < x.length;) {
      if (Math.abs(x[i]) < lo) { i++; continue; }
      let j = i;
      while (j < x.length && Math.abs(x[j]) >= lo) j++;
      if (j - i >= CLIP_RUN) clipped += j - i;
      i = j;
    }
  }
  return { peak, at, clipped };
}

// the channels as one sound: ch -1 the mean as readWav takes it (the sum from the first channel, over their number),
// else that channel; a single channel is returned itself, not copied
export function mixDown(chs, ch = -1) {
  if (!chs.length) throw new Error("no channels");
  if (!Number.isInteger(ch) || ch < -1 || ch >= chs.length) throw new RangeError(`channel ${ch}: the sound has ${chs.length}`);
  if (ch >= 0) return chs[ch];
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const c of chs) acc += c[i];
    out[i] = acc / chs.length;
  }
  return out;
}

// why [start, end) is no trim of a sound of n samples (null: it is one)
export function legalCut(start, end, n) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "trim: whole samples";
  if (start >= end) return "trim: the start must be before the end";
  if (start < 0 || end > n) return `trim ${start}..${end}: the sound has ${n} samples`;
  if (end - start < Math.min(MIN_TRIM, n)) return `trim: keep ${MIN_TRIM} samples or more`;
  return null;
}
export function checkCut(start, end, n) {
  const why = legalCut(start, end, n);
  if (why) throw new RangeError(why);
}
// [start, end) of x
export function trim(x, start, end) {
  checkCut(start, end, x.length);
  return x.slice(start, end);
}

export function reverse(x) {
  const n = x.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[n - 1 - i];
  return out;
}

// a linear fade in over inN samples and out over outN: the first and the last sample are silent, the gain is 1 from
// inN samples in and until outN samples before the end; the middle is the input's
export function fade(x, inN = 0, outN = 0) {
  if (!Number.isInteger(inN) || !Number.isInteger(outN) || inN < 0 || outN < 0) throw new RangeError("fade: whole samples, 0 or more");
  const n = x.length, out = Float64Array.from(x);
  for (let i = 0; i < Math.min(inN, n); i++) out[i] *= i / inN;
  for (let j = 0; j < Math.min(outN, n); j++) out[n - 1 - j] *= j / outN;
  return out;
}

export function checkGain(db) {
  if (!(Math.abs(db) <= 96)) throw new RangeError(`gain ${db} dB: between -96 and 96`);
}
export function applyGain(x, db) {
  checkGain(db);
  const g = fromDb(db), out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

// the peak at targetDb (dBFS, -96 to 0); a silent sound has no gain to find and is returned as it is.
// -> {x, gain, peak: what the peak was, clipped: the samples in flat tops of the input (levelling cannot undo them), silent}
export function checkTarget(db) {
  if (!(db <= 0 && db >= -96)) throw new RangeError(`normalise to ${db} dBFS: between -96 and 0`);
}
export function normalise(x, targetDb = BANK_DB) {
  checkTarget(targetDb);
  const { peak, clipped } = peakOf(x);
  if (!Number.isFinite(peak)) throw new Error("the sound holds a sample that is not a number");
  if (peak === 0) return { x: Float64Array.from(x), gain: 1, peak: 0, clipped: 0, silent: true };
  const gain = fromDb(targetDb) / peak, out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * gain;
  return { x: out, gain, peak, clipped, silent: false };
}

// the bank's own level as the level field shows it (two decimals) is the bank's exact one
export function levelDb(v) { return v === Math.round(BANK_DB * 100) / 100 ? BANK_DB : v; }

// where a sign change between two samples, or a zero, lies at c: its sample nearer to zero (-1: none there)
function crossAt(x, c) {
  const a = x[c];
  if (a === 0) return c;
  if (c + 1 >= x.length) return -1;
  const b = x[c + 1];
  if (b === 0) return c + 1;
  if ((a < 0) === (b < 0)) return -1;
  return Math.abs(a) <= Math.abs(b) ? c : c + 1;
}

// the zero crossing nearest to sample i within radius, else i itself: a cut there starts or ends at silence and does not click
export function snapZero(x, i, radius = ZC_RADIUS) {
  const n = x.length;
  if (!n) return 0;
  i = Math.max(0, Math.min(n - 1, Math.round(i)));
  for (let d = 0; d <= radius; d++) {
    for (const c of d ? [i - d, i + d] : [i]) {
      if (c < 0 || c >= n) continue;
      const j = crossAt(x, c);
      if (j >= 0) return j;
    }
  }
  return i;
}

// the next zero crossing after i (dir 1) or before it (dir -1); i itself when there is none
export function nextZero(x, i, dir) {
  const n = x.length;
  if (dir < 0) {
    for (let c = Math.min(i, n) - 1; c >= 0; c--) { const j = crossAt(x, c); if (j >= 0 && j < i) return j; }
  } else {
    for (let c = Math.max(i, 0); c < n; c++) { const j = crossAt(x, c); if (j > i) return j; }
  }
  return i;
}

// the trim's "start" or "end" in p put at sample i -> where it lands. A typed value that is no legal cut is refused; a
// dragged one (clamp) stops at the nearest legal place. With snap: the nearest zero crossing of x, when the cut stays legal there.
export function moveCut(x, p, side, i, snap, clamp = false) {
  if (side !== "start" && side !== "end") throw new Error(`no trim end called ${side}`);
  const n = x.length, min = Math.min(MIN_TRIM, n), isStart = side === "start";
  const pair = (v) => (isStart ? [v, p.end, n] : [p.start, v, n]);
  if (clamp) i = isStart ? Math.max(0, Math.min(p.end - min, Math.round(i))) : Math.max(p.start + min, Math.min(n, Math.round(i)));
  checkCut(...pair(i));
  if (!snap) return i;
  const j = snapZero(x, i);
  return legalCut(...pair(j)) ? i : j;
}

// why a loop [ls, le) set by hand is no loop of the part kept [start, end) (null: it is one): inside it, MIN_LOOP samples or more
export function legalLoop(loop, start, end) {
  const [ls, le] = loop;
  if (!Number.isInteger(ls) || !Number.isInteger(le)) return "loop: whole samples";
  if (le <= ls) return "loop: the start must be before the end";
  if (ls < start || le > end) return `loop ${ls}..${le}: inside the trim, ${start}..${end}`;
  if (le - ls < MIN_LOOP) return `loop: ${MIN_LOOP} samples or more`;
  return null;
}
export function checkLoop(loop, start, end) {
  const why = legalLoop(loop, start, end);
  if (why) throw new RangeError(why);
  return loop;
}
// p's loop (else the trim) with its "start" or "end" put at sample i -> the new loop; snap as in moveCut
export function moveLoop(x, p, side, i, snap) {
  if (side !== "start" && side !== "end") throw new Error(`no loop end called ${side}`);
  const cur = p.loop || [p.start, p.end], pair = (v) => (side === "start" ? [v, cur[1]] : [cur[0], v]);
  checkLoop(pair(i), p.start, p.end);
  if (!snap) return pair(i);
  const j = snapZero(x, i);
  return legalLoop(pair(j), p.start, p.end) ? pair(i) : pair(j);
}
// a loop kept inside a trim that moved: clipped to it; null when less than MIN_LOOP of it is left
export function fitLoop(loop, start, end) {
  if (!loop) return null;
  const ls = Math.max(loop[0], start), le = Math.min(loop[1], end);
  return le - ls >= MIN_LOOP ? [ls, le] : null;
}
// a loop in the sound's samples as it lies in the part kept [start, end), played reversed or not
export function mapLoop(loop, start, end, reversed = false) {
  const l = fitLoop(loop, start, end);
  if (!l) return null;
  const n = end - start, a = l[0] - start, b = l[1] - start;
  return reversed ? [n - b, n - a] : [a, b];
}

// ---- a sound being prepared: source {rate, chs: [Float64Array per channel], loop: [ls, le) | null}, and the settings
// p {start, end, channel (-1: the mix), reverse, fadeIn, fadeOut (ms), normTo (dBFS, null: keep the level), gain (dB),
// loop: [ls, le) | null}, all in the source's samples
export function defaults(src, fresh) {
  const n = src.chs[0].length;
  return { start: 0, end: n, channel: -1, reverse: false, fadeIn: 0, fadeOut: 0, normTo: fresh ? BANK_DB : null, gain: 0,
    loop: fitLoop(src.loop, 0, n) };
}
// a fade of ms milliseconds as samples at rate (a number of 0 or more)
export function fadeSamples(ms, rate) {
  if (!(ms >= 0 && Number.isFinite(ms))) throw new RangeError(`fade ${ms} ms: 0 or more`);
  return Math.round(ms * rate / 1000);
}

// the settings applied, in this order: mix, trim, reverse, fades, level (normalise, then gain)
// -> {x, rate, loop, peak (linear: 1 is full scale), over (the peak is above it), silent, clipped (flat-top samples the trimmed input held)}
export function prepare(src, p) {
  let y = trim(mixDown(src.chs, p.channel), p.start, p.end);
  if (p.reverse) y = reverse(y);
  const clipped = peakOf(y).clipped;
  y = fade(y, fadeSamples(p.fadeIn, src.rate), fadeSamples(p.fadeOut, src.rate));
  if (typeof p.normTo === "number") y = normalise(y, p.normTo).x;
  if (p.gain !== 0) y = applyGain(y, p.gain);
  const peak = peakOf(y).peak;
  if (!Number.isFinite(peak)) throw new Error("the sound holds a sample that is not a number");
  return { x: y, rate: src.rate, loop: mapLoop(p.loop, p.start, p.end, p.reverse), peak, over: peak > 1 + 1e-9, silent: peak === 0, clipped };
}

// the peak a prepared sound is stored at, in 16-bit steps (32768 is full scale); refused above full scale: levelling is
// the user's call and a stored sample is never clipped for them
export function peakInt(out) {
  if (out.over) throw new Error(`The peak is ${toDb(out.peak).toFixed(1)} dBFS, over full scale: lower the gain or turn normalise on.`);
  return out.silent ? 30000 : Math.max(1, Math.min(32767, Math.round(out.peak * 32768)));
}

// a prepared sound as a new item for build() (soundplant_samples.js): the bank resamples, emphasises and encodes it
// at that peak, and its loop goes in a file's way ([start, last sample in the loop]); base: the item's other fields
export function newItem(out, base) {
  return { ...base, x: out.x, sr: out.rate, loop: out.loop ? [out.loop[0], out.loop[1] - 1] : null, peak: peakInt(out) };
}
// a prepared sound that was a stored one, as an item at its own rate: its samples as they are to be stored (no
// resample or emphasis again: a stored sample has them), its loop as the bank holds it ([ls, le))
export function storedItem(out, base) {
  return { ...base, s: toInt16(out.x, peakInt(out)), rate: out.rate, loop: out.loop };
}

// the editable source of a sample read back from the bank (or made smaller): its stored samples as floats
export function sourceOfStored(it) {
  const s = it.adpcm ? imaDecode(it.adpcm, it.n) : it.s, x = new Float64Array(s.length);
  for (let i = 0; i < s.length; i++) x[i] = s[i] / 32768;
  return { rate: it.rate, chs: [x], loop: it.loop || null };
}
// the source of a new item ({x, sr, loop: [start, last sample]})
export function sourceOfNew(it) {
  return { rate: it.sr, chs: [it.x], loop: it.loop ? [it.loop[0], it.loop[1] + 1] : null };
}

// what the editor opens for a list item: the source and settings of its last edit, else the item as it is
export function editOf(it) {
  const stored = !it.x;
  if (it.prep) return { src: it.prep.src, p: { ...it.prep.p }, stored };
  const src = stored ? sourceOfStored(it) : sourceOfNew(it);
  return { src, p: defaults(src, !stored), stored };
}
// the list item an edit makes: base's name, root, bars and the like kept (not its samples, checkpoints or picture, which
// are the old sound's), the sound from out; prep: what editOf gives back next time
export function editedItem(out, base, stored, prep) {
  const keep = { name: base.name, root: base.root, rootSet: base.rootSet, bars: base.bars, rate: base.rate, flags: base.flags,
    file: base.file, isNew: base.isNew };
  return { ...(stored ? storedItem(out, keep) : newItem(out, keep)), edited: true, prep };
}

// a prepared sound as a mono 16-bit WAV file; a loop goes in a 'smpl' chunk (its end is the loop's last sample)
export function encodeWav(out) {
  const s = toInt16(out.x, peakInt(out)), n = s.length, extra = out.loop ? 68 : 0;
  const buf = new Uint8Array(44 + n * 2 + extra), d = new DataView(buf.buffer);
  const tag = (o, t) => { for (let i = 0; i < 4; i++) buf[o + i] = t.charCodeAt(i); };
  tag(0, "RIFF"); d.setUint32(4, buf.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, out.rate, true);
  d.setUint32(28, out.rate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  tag(36, "data"); d.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, s[i], true);
  if (out.loop) {
    const o = 44 + n * 2;
    tag(o, "smpl"); d.setUint32(o + 4, 60, true);
    d.setUint32(o + 8 + 8, Math.round(1e9 / out.rate), true);   // the sample period, ns
    d.setUint32(o + 8 + 28, 1, true);                           // one loop
    d.setUint32(o + 8 + 44, out.loop[0], true);
    d.setUint32(o + 8 + 48, out.loop[1] - 1, true);
  }
  return buf;
}
