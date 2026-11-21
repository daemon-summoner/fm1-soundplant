// SPDX-License-Identifier: MPL-2.0
// SoundPlant patterns as Standard MIDI Files and back, on the project model of soundplant_project.js (the project editor,
// app/web/project/index.html, inlines this file after that one; tools/make_pages.py). toMidi() writes a format 1 file from a
// pattern or a scene; fromMidi() reads a file into a pattern and reports what a pattern could not hold; readMidi() is the
// strict parser under it. tests/host/project_web.mjs checks both ways against a reader of its own and against the
// firmware simulator.
//
// 384 ticks a quarter note: a sixteenth is 96 ticks, so every step size (half a sixteenth to 16), every quarter-step length
// and every nudge the firmware has (a 24th of the step, a 48th at the half-sixteenth step: seq.c step_off) is a whole
// number of ticks. 96 and 480 would give fractions at the half-sixteenth step.

import { ProjectError, NTRK, NPATT, NSTEP, NSCENE, SN, TEMPO_MIN, TEMPO_MAX, LEN_MAX, SCALE_SIXTEENTHS, newStep, stepIsEmpty, kitHas, kitSet, stepLenQuarters, isKitTrack } from "./soundplant_project.js";

export class MidiError extends ProjectError {
  constructor(message) {
    super(message);
    this.name = "MidiError";
  }
}

export const PPQ = 384;
export const GM_DRUM_CHANNEL = 9;   // channel 10, 0-based
// a kit's sounds 1..11 (kick snare hat open clap ltom htom conga shaker string fm) as drum notes; string and fm have no General
// MIDI drum, so they take the two notes above its map to stay apart
export const KIT_GM_NOTES = [36, 38, 42, 46, 39, 45, 50, 63, 82, 88, 89];
// drum notes read as a kit sound besides the table above
export const GM_DRUM_ALIASES = { 35: 1, 40: 2, 44: 3, 41: 6, 43: 6, 47: 7, 48: 7, 62: 8, 64: 8, 69: 9, 70: 9 };
const GM_TO_SOUND = new Map([...KIT_GM_NOTES.map((n, k) => [n, k + 1]), ...Object.entries(GM_DRUM_ALIASES).map(([n, s]) => [Number(n), s])]);

const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const are = (n) => (n === 1 ? "is" : "are");
const stepTicks = (scale) => PPQ / 4 * SCALE_SIXTEENTHS[scale];
const nudgeUnit = (scale) => stepTicks(scale) / (scale === 0 ? 48 : 24);
const roundAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

function newTally() {
  const n = {}, d = {};
  return {
    n, d,
    bump(k, c = 1) { n[k] = (n[k] || 0) + c; },
    note(k, v) { (d[k] ||= new Set()).add(v); },
  };
}

const reportOf = (tally, texts) => Object.keys(texts).filter((k) => tally.n[k]).map((k) => ({
  key: k, count: tally.n[k], text: texts[k](tally.n[k], tally.d[k] ? [...tally.d[k]].sort((a, b) => a - b) : []),
}));

// ---- writing
const be16 = (v) => [v >> 8 & 255, v & 255];
const be24 = (v) => [v >> 16 & 255, v >> 8 & 255, v & 255];
const be32 = (v) => [v >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255];
const vlq = (v) => {
  const out = [v & 127];
  for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) out.unshift(v & 127 | 128);
  return out;
};
const ascii = (s) => Array.from(s, (c) => { const k = c.charCodeAt(0); return k >= 32 && k < 127 ? k : 63; });
const meta = (delta, type, data) => [...vlq(delta), 0xFF, type, ...vlq(data.length), ...data];
const chunk = (id, body) => [...ascii(id), ...be32(body.length), ...body];

const EXPORT_TEXT = {
  muted: (n) => `${plural(n, "track", "tracks")} ${are(n)} muted in this scene and left out.`,
  groove: (n) => `${plural(n, "pattern has", "patterns have")} a groove. MIDI has no way to carry it, so the notes sit on the grid, moved only by each step's nudge.`,
  loop: (n) => `${plural(n, "pattern has", "patterns have")} a loop window. The whole pattern is exported.`,
  conds: (n) => `${plural(n, "step has", "steps have")} a condition (a chance or a cycle such as 2:4). In the file ${n === 1 ? "it is" : "they are"} plain notes.`,
  tricks: (n) => `${plural(n, "step has", "steps have")} tricks. The file leaves them out.`,
  cut: (n) => `${plural(n, "note runs", "notes run")} past the end of ${n === 1 ? "its" : "their"} pattern and ${are(n)} cut there.`,
  shortened: (n) => `${plural(n, "note is", "notes are")} cut short where the same pitch starts again (a MIDI note cannot be held twice at once).`,
  early: (n) => `${plural(n, "step is", "steps are")} nudged before the start of the pattern and ${n === 1 ? "starts" : "start"} at its first tick.`,
};

function noteTrack(slot, t, p, tally) {
  const pat = slot.patterns[t][p], where = `Track ${t + 1} pattern ${p + 1}`;
  if (!inRange(pat.scale, 0, SCALE_SIXTEENTHS.length - 1)) throw new MidiError(`${where}: its step size is not one SoundPlant has.`);
  if (!inRange(pat.len, 1, NSTEP)) throw new MidiError(`${where}: its length is 1 to ${NSTEP} steps.`);
  const S = stepTicks(pat.scale), unit = nudgeUnit(pat.scale), cycle = pat.len * S;
  const kit = isKitTrack(slot, t), ch = kit ? GM_DRUM_CHANNEL : t;
  const held = new Map();
  if (pat.groove) tally.bump("groove");
  if (pat.lstart || pat.lend) tally.bump("loop");
  for (let i = 0; i < pat.len; i++) {
    const st = pat.steps[i];
    const keys = kit ? KIT_GM_NOTES.filter((_, k) => kitHas(st, k + 1)) : [...new Set(st.notes.filter((n) => n))];
    if (!keys.length) continue;
    if (!inRange(st.nudge, -12, 12) || !inRange(st.vel, 0, 127)) throw new MidiError(`${where} step ${i + 1}: the nudge is -12 to 12 and the velocity 0 to 127.`);
    if (keys.some((k) => k > 127)) throw new MidiError(`${where} step ${i + 1}: MIDI notes go up to 127.`);
    if (st.cond) tally.bump("conds");
    if (st.comp || st.comp2) tally.bump("tricks");
    let on = i * S + st.nudge * unit;
    if (on < 0) { on = 0; tally.bump("early"); }
    const want = st.len ? stepLenQuarters(st.len) * (S / 4) : Math.max(1, Math.round(pat.nlen * S / 100));
    if (on + want > cycle) tally.bump("cut", keys.length);
    for (const key of keys) {
      if (!held.has(key)) held.set(key, []);
      held.get(key).push({ on, off: Math.min(on + want, cycle), vel: st.vel || 100 });
    }
  }
  const events = [];
  for (const [key, list] of held) {
    list.sort((a, b) => a.on - b.on);
    list.forEach((n, k) => {
      const next = list[k + 1];
      if (next && next.on < n.off) { tally.bump("shortened"); n.off = next.on; }
      if (n.off > n.on) events.push({ tick: n.on, off: 0, key, vel: n.vel }, { tick: n.off, off: 1, key, vel: 64 });
    });
  }
  events.sort((a, b) => a.tick - b.tick || b.off - a.off || a.key - b.key);
  const body = meta(0, 0x03, ascii(slot.tracks[t].name || `Track ${t + 1}`));
  let at = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - at), (e.off ? 0x80 : 0x90) | ch, e.key, e.vel);
    at = e.tick;
  }
  body.push(...meta(cycle - at, 0x2F, []));
  return { body, end: cycle };
}

function exportJobs(slot, opts, tally) {
  const some = (t, p) => slot.patterns[t][p].steps.slice(0, slot.patterns[t][p].len).some((st) => st.notes.some((n) => n));
  if (opts.scene === undefined) {
    if (!inRange(opts.track, 0, NTRK - 1) || !inRange(opts.pattern, 0, NPATT - 1)) throw new MidiError("That track or pattern does not exist.");
    if (!some(opts.track, opts.pattern)) throw new MidiError(`Track ${opts.track + 1} pattern ${opts.pattern + 1} has no notes to export.`);
    return [{ t: opts.track, p: opts.pattern }];
  }
  if (!inRange(opts.scene, 0, NSCENE - 1)) throw new MidiError("That scene does not exist.");
  const sc = slot.scenes[opts.scene], jobs = [];
  for (let t = 0; t < NTRK; t++) {
    if (!inRange(sc.pat[t], 0, NPATT - 1)) throw new MidiError(`Scene ${opts.scene + 1}: track ${t + 1}'s pattern is 1 to ${NPATT}.`);
    if (!some(t, sc.pat[t])) continue;
    if (sc.mute >> t & 1) tally.bump("muted");
    else jobs.push({ t, p: sc.pat[t] });
  }
  if (!jobs.length) throw new MidiError(`Scene ${opts.scene + 1} has no notes in the tracks it plays.`);
  return jobs;
}

// toMidi(model, {slot, track, pattern} | {slot, scene}) -> {bytes, report}: format 1, the first MIDI track the tempo, then a
// track for each SoundPlant track (a kit's on channel 10, another on the channel of its number). One pass of each pattern;
// what the file cannot carry is in the report: [{key, count, text}].
export function toMidi(model, opts) {
  const slot = model.slots[opts.slot];
  if (!slot) throw new MidiError(`Slot ${opts.slot + 1} is empty.`);
  if (!inRange(slot.tempoX10, TEMPO_MIN, TEMPO_MAX)) throw new MidiError(`Slot ${opts.slot + 1}: the tempo is ${TEMPO_MIN / 10} to ${TEMPO_MAX / 10} BPM.`);
  const tally = newTally();
  const tracks = exportJobs(slot, opts, tally).map((j) => noteTrack(slot, j.t, j.p, tally));
  const end = Math.max(...tracks.map((x) => x.end));
  const conductor = [
    ...meta(0, 0x03, ascii(`SoundPlant slot ${opts.slot + 1}`)),
    ...meta(0, 0x51, be24(Math.round(600000000 / slot.tempoX10))),
    ...meta(0, 0x58, [4, 2, 24, 8]),
    ...meta(end, 0x2F, []),
  ];
  const bytes = Uint8Array.from([
    ...ascii("MThd"), ...be32(6), ...be16(1), ...be16(tracks.length + 1), ...be16(PPQ),
    ...chunk("MTrk", conductor), ...tracks.flatMap((x) => chunk("MTrk", x.body)),
  ]);
  return { bytes, report: reportOf(tally, EXPORT_TEXT) };
}

// ---- reading
const rd16 = (b, o) => b[o] << 8 | b[o + 1];
const rd32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const printable = (data) => Array.from(data, (c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "?")).join("");

// one MTrk chunk: its notes paired on and off (a note-on with velocity 0 is an off; a note with no off is held to the
// track's end), its tempo events, and counts of what is not a note
function readTrack(b, start, end, n) {
  const bad = (what) => new MidiError(`MIDI track ${n}: ${what}.`);
  const out = { name: "", notes: [], tempos: [], other: 0, stray: 0, hanging: 0, endTick: 0 };
  const open = new Map();
  let p = start, tick = 0, status = 0, done = false;
  const need = (k) => { if (p + k > end) throw bad("the file ends in the middle of an event"); };
  const varLen = () => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      need(1);
      const c = b[p++];
      v = v * 128 + (c & 127);
      if (!(c & 128)) return v;
    }
    throw bad("a time or length value is longer than 4 bytes");
  };
  while (p < end && !done) {
    tick += varLen();
    need(1);
    let c = b[p];
    if (c >= 0x80) {
      p++;
      status = c < 0xF0 ? c : 0;
    } else if (status) {
      c = status;
    } else {
      throw bad("an event has no status byte and there is none to repeat");
    }
    if (c === 0xFF) {
      need(1);
      const type = b[p++], len = varLen();
      need(len);
      if (type === 0x2F) {
        if (len) throw bad("its end-of-track event has data");
        out.endTick = tick;
        done = true;
      } else if (type === 0x51) {
        if (len !== 3) throw bad("a tempo event is not 3 bytes long");
        const uspq = b[p] << 16 | b[p + 1] << 8 | b[p + 2];
        if (!uspq) throw bad("a tempo event says 0 microseconds a beat");
        out.tempos.push({ tick, uspq });
      } else if (type === 0x03 && !out.name) {
        out.name = printable(b.subarray(p, p + len));
      }
      p += len;
    } else if (c === 0xF0 || c === 0xF7) {
      const len = varLen();
      need(len);
      p += len;
      out.other++;
    } else if (c >= 0xF0) {
      throw bad(`a system message (0x${c.toString(16).toUpperCase()}) cannot be in a MIDI file`);
    } else {
      const hi = c >> 4, ch = c & 15, k = hi === 0xC || hi === 0xD ? 1 : 2;
      need(k);
      const d1 = b[p], d2 = k === 2 ? b[p + 1] : 0;
      if ((d1 | d2) & 0x80) throw bad("a data byte has its top bit set");
      p += k;
      const id = ch * 128 + d1;
      if (hi === 9 && d2 > 0) {
        const note = { tick, end: -1, ch, key: d1, vel: d2 };
        out.notes.push(note);
        if (!open.has(id)) open.set(id, []);
        open.get(id).push(note);
      } else if (hi === 8 || hi === 9) {
        const queue = open.get(id);
        if (queue && queue.length) queue.shift().end = tick;
        else out.stray++;
      } else {
        out.other++;
      }
    }
  }
  if (!done) throw bad("it has no end-of-track event, so the file is cut short");
  if (p !== end) throw bad("there are bytes after its end-of-track event");
  for (const note of out.notes) {
    if (note.end < 0) { note.end = out.endTick; out.hanging++; }
  }
  return out;
}

// readMidi(bytes) -> {format, ppq, tempos: [{tick, uspq}] (time order), tracks: [{name, notes: [{tick, end, ch, key, vel}],
// tempos, other (controllers, pitch bend, program changes, SysEx), stray (note-offs with no note), hanging, endTick}]}.
// Throws a MidiError for anything that is not a whole, beat-timed, format 0 or 1 file; never returns part of one.
export function readMidi(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 4 || fourcc(b, 0) !== "MThd") throw new MidiError("This is not a MIDI file: it does not start with MThd.");
  if (b.length < 14) throw new MidiError("This MIDI file is cut short: its header is incomplete.");
  const hlen = rd32(b, 4);
  if (hlen < 6) throw new MidiError(`This MIDI file is damaged: its header is ${hlen} bytes and needs 6.`);
  if (8 + hlen > b.length) throw new MidiError("This MIDI file is cut short: its header runs past the end.");
  const format = rd16(b, 8), ntrks = rd16(b, 10), division = rd16(b, 12);
  if (format === 2) throw new MidiError("This is a format 2 MIDI file (separate songs in one file). SoundPlant reads format 0 and 1.");
  if (format > 2) throw new MidiError(`This MIDI file says it is format ${format}; there are formats 0, 1 and 2.`);
  if (division & 0x8000) {
    throw new MidiError(`This MIDI file counts time in SMPTE frames (${256 - (division >> 8)} a second), not beats. SoundPlant reads only files timed in ticks per quarter note; export it again with a tempo-based time base.`);
  }
  if (division === 0) throw new MidiError("This MIDI file says it has 0 ticks to a quarter note.");
  if (ntrks === 0) throw new MidiError("This MIDI file says it has no tracks.");
  if (format === 0 && ntrks !== 1) throw new MidiError(`A format 0 MIDI file has one track; this one says ${ntrks}.`);
  const tracks = [];
  let pos = 8 + hlen;
  while (pos < b.length) {
    if (pos + 8 > b.length) throw new MidiError(`This MIDI file has ${b.length - pos} stray bytes after its last chunk.`);
    const id = fourcc(b, pos), len = rd32(b, pos + 4);
    if (pos + 8 + len > b.length) throw new MidiError(`This MIDI file is cut short: its ${id === "MTrk" ? `track ${tracks.length + 1}` : `${id} chunk`} runs ${pos + 8 + len - b.length} bytes past the end.`);
    if (id === "MTrk") tracks.push(readTrack(b, pos + 8, pos + 8 + len, tracks.length + 1));
    pos += 8 + len;
  }
  if (tracks.length !== ntrks) throw new MidiError(`This MIDI file says it has ${ntrks} tracks and holds ${tracks.length}: it is cut short or damaged.`);
  const tempos = tracks.flatMap((t) => t.tempos).sort((a, c) => a.tick - c.tick);
  return { format, ppq: division, tempos, tracks };
}

const IMPORT_TEXT = {
  beyond: (n) => `${plural(n, "note starts", "notes start")} after step ${NSTEP}, where a pattern ends. ${n === 1 ? "It is" : "They are"} left out.`,
  poly: (n) => `${plural(n, "note", "notes")} would be more than ${SN} on a step (a step holds ${SN}). ${n === 1 ? "It is" : "They are"} left out, the first ${SN} kept.`,
  merged: (n) => `${plural(n, "note", "notes")} sounded the same pitch as another on the same step and ${are(n)} merged into it.`,
  drums: (n, d) => `${plural(n, "drum note has", "drum notes have")} no kit sound (MIDI note${d.length === 1 ? "" : "s"} ${d.join(", ")}). ${n === 1 ? "It is" : "They are"} left out.`,
  note0: (n) => `${plural(n, "note is", "notes are")} MIDI note 0, which a step cannot hold, and left out.`,
  otherch: (n, d) => `${plural(n, "note", "notes")} on other channels (${d.join(", ")}) ${are(n)} left out.`,
  tracks: (n) => `${plural(n, "note", "notes")} in the file's other tracks ${are(n)} left out.`,
  manych: (n, d) => `The notes of channels ${d.join(", ")} are mixed into one pattern.`,
  mixed: (n) => `${plural(n, "step", "steps")} had notes with different velocities, lengths or timing. A step has one of each: it keeps the loudest velocity, the longest length and the earliest timing.`,
  offgrid: (n) => `${plural(n, "note", "notes")} did not fall on the step grid and ${are(n)} moved onto the nearest step.`,
  offnudge: (n) => `${plural(n, "note", "notes")} did not fall on the step grid or its nudge and ${are(n)} rounded to the nearest nudge.`,
  lenround: (n) => `${plural(n, "note's length is", "notes' lengths are")} rounded to a quarter of a step (a whole step past 16).`,
  lenmax: (n) => `${plural(n, "note is", "notes are")} longer than ${NSTEP} steps and cut to ${NSTEP}.`,
  stray: (n) => `${plural(n, "note-off has", "note-offs have")} no note before ${n === 1 ? "it" : "them"} and ${are(n)} ignored.`,
  hanging: (n) => `${plural(n, "note is", "notes are")} never switched off and held to the end of the track.`,
  other: (n) => `${plural(n, "other message", "other messages")} (controllers, pitch bend, program changes, SysEx) ${are(n)} ignored.`,
  tempos: (n) => `${plural(n, "tempo change", "tempo changes")} after the first: a project has one tempo, so only the first is used.`,
  loop: () => "The pattern's loop window is cleared: the whole pattern plays.",
  replaced: (n) => `This replaces the ${plural(n, "step", "steps")} now in the pattern, conditions and tricks included.`,
};

// the length code a note of d ticks gets in a pattern whose step is SL / 8 ticks, and whether it is exact: {code, exact, max}
function lengthCode(D, SL) {
  const w = roundAway(D / SL);
  if (D > NSTEP * SL) return { code: LEN_MAX, exact: false, max: true };
  if (w >= 17) return { code: 48 + w, exact: w * SL === D, max: false };
  const q = Math.min(64, Math.max(1, roundAway(D * 4 / SL)));
  return { code: q, exact: q * SL === D * 4, max: false };
}

// fromMidi(bytes, {slot, track, pattern, midiTrack, channel (0-based; -1 or none: all), scale (default the pattern's),
// nudge (default true: off-grid timing becomes the step's nudge), lengths ("file" (default) or "pattern": every note the
// pattern's own length)}) -> {pattern, tempo: null | {x10, clamped}, report, notes, steps}. The pattern is a new one built on
// the target's (its groove, quantise, note length and shape stay); nothing in the model changes until applyImport().
// A kit track reads drum notes as its sounds; any other track reads them as notes.
export function fromMidi(bytes, opts) {
  const m = readMidi(bytes);
  const { slot, track: t } = opts;
  if (!inRange(t, 0, NTRK - 1) || !inRange(opts.pattern, 0, NPATT - 1)) throw new MidiError("That track or pattern does not exist.");
  const kit = isKitTrack(slot, t), old = slot.patterns[t][opts.pattern];
  const scale = opts.scale ?? old.scale, channel = opts.channel ?? -1, withNudge = opts.nudge !== false, fromFile = opts.lengths !== "pattern";
  if (!inRange(scale, 0, SCALE_SIXTEENTHS.length - 1)) throw new MidiError("That step size is not one SoundPlant has.");
  const trk = m.tracks[opts.midiTrack];
  if (!trk) throw new MidiError(`This file has ${plural(m.tracks.length, "track", "tracks")}; there is no track ${opts.midiTrack + 1}.`);
  const tally = newTally();
  const SL = m.ppq * SCALE_SIXTEENTHS[scale] * 2, NU = scale === 0 ? 48 : 24;   // SL: a step in eighths of a tick
  const defD = old.nlen * SL / 100, defTicks = Math.max(1, Math.round(defD / 8));

  const chosen = [];
  for (const n of trk.notes) {
    if (channel >= 0 && n.ch !== channel) { tally.bump("otherch"); tally.note("otherch", n.ch + 1); } else chosen.push(n);
  }
  if (!chosen.length) throw new MidiError(`There are no notes ${channel >= 0 ? `on channel ${channel + 1} ` : ""}in track ${opts.midiTrack + 1} of this file.`);
  const chans = new Set(chosen.map((n) => n.ch + 1));
  if (chans.size > 1) { tally.bump("manych"); chans.forEach((c) => tally.note("manych", c)); }

  const groups = new Map();
  for (const n of chosen) {
    let key = n.key;
    if (kit) {
      key = GM_TO_SOUND.get(n.key);
      if (!key) { tally.bump("drums"); tally.note("drums", n.key); continue; }
    } else if (!key) {
      tally.bump("note0");
      continue;
    }
    const T = n.tick * 8, k = Math.floor((2 * T + SL - 1) / (2 * SL));   // the nearest step; half way goes to the earlier
    if (k >= NSTEP) { tally.bump("beyond"); continue; }
    if (!groups.has(k)) groups.set(k, []);
    const g = groups.get(k);
    if (g.some((x) => x.key === key)) { tally.bump("merged"); continue; }
    if (!kit && g.length >= SN) { tally.bump("poly"); continue; }
    const off = T - k * SL;
    let nudge = 0, exact = off === 0;
    if (withNudge) {
      nudge = Math.max(-12, Math.min(12, roundAway(off * NU / SL)));
      exact = nudge * SL === off * NU;
    }
    if (!exact) tally.bump(withNudge ? "offnudge" : "offgrid");
    const D = (n.end - n.tick) * 8;
    let code = 0;
    if (fromFile && !(n.end - n.tick === defTicks && Math.abs(D - defD) <= SL / 8)) {
      const l = lengthCode(D, SL);
      code = l.code;
      if (l.max) tally.bump("lenmax");
      else if (!l.exact) tally.bump("lenround");
    }
    g.push({ key, vel: n.vel, D, code, nudge });
  }
  const placed = [...groups.values()].reduce((a, g) => a + g.length, 0);
  if (!placed) {
    const why = reportOf(tally, IMPORT_TEXT).map((l) => l.text).join(" ");
    throw new MidiError(`None of the ${plural(chosen.length, "note", "notes")} in this track can go into the pattern. ${why}`);
  }

  const steps = Array.from({ length: NSTEP }, newStep);
  for (const [k, g] of groups) {
    const st = steps[k];
    if (kit) kitSet(st, g.reduce((mask, x) => mask | 1 << x.key - 1, 0));
    else st.notes = [...g.map((x) => x.key), ...Array(SN - g.length).fill(0)];
    st.vel = Math.max(...g.map((x) => x.vel));
    st.len = g.reduce((a, x) => (x.D > a.D ? x : a)).code;
    st.nudge = g[0].nudge;
    if (g.some((x) => x.vel !== g[0].vel || x.code !== g[0].code || x.nudge !== g[0].nudge)) tally.bump("mixed");
  }
  const last = Math.max(...groups.keys());
  const len = Math.min(NSTEP, Math.max(last + 1, Math.ceil(trk.endTick * 8 / SL)));

  let tempo = null;
  if (m.tempos.length) {
    const raw = Math.round(600000000 / m.tempos[0].uspq), x10 = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, raw));
    tempo = { x10, clamped: x10 !== raw };
    if (m.tempos.length > 1) tally.bump("tempos", m.tempos.length - 1);
  }
  const elsewhere = m.tracks.reduce((a, x, i) => a + (i === opts.midiTrack ? 0 : x.notes.length), 0);
  if (elsewhere) tally.bump("tracks", elsewhere);
  if (trk.other) tally.bump("other", trk.other);
  if (trk.stray) tally.bump("stray", trk.stray);
  if (trk.hanging) tally.bump("hanging", trk.hanging);
  const replaced = old.steps.filter((s) => !stepIsEmpty(s)).length;
  if (replaced) tally.bump("replaced", replaced);
  if (old.lstart || old.lend) tally.bump("loop");

  const pattern = { len, scale, groove: old.groove, quant: old.quant, nlen: old.nlen, shape: old.shape, lstart: 0, lend: 0, steps };
  return { pattern, tempo, report: reportOf(tally, IMPORT_TEXT), notes: placed, steps: groups.size };
}

// the import as one edit of the slot; the record it returns undoes it with revertImport()
export function applyImport(slot, t, p, result, takeTempo) {
  if (takeTempo && !result.tempo) throw new MidiError("This file has no tempo to take.");
  const before = { track: t, pattern: p, steps: slot.patterns[t][p], tempoX10: slot.tempoX10 };
  slot.patterns[t][p] = result.pattern;
  if (takeTempo) slot.tempoX10 = result.tempo.x10;
  return before;
}

export function revertImport(slot, before) {
  slot.patterns[before.track][before.pattern] = before.steps;
  slot.tempoX10 = before.tempoX10;
}
