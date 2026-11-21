// SPDX-License-Identifier: MPL-2.0
// The night garden's logic (app/web/emu/garden_core.js) under node: the snapshot it reads from the firmware, its
// physics at any frame rate, the genomes, the glitch schedule and the guard on flashing, and what it hands the renderer.
//   node tests/host/garden_core.mjs
import { check, done } from "../../base/tests/emu_harness.mjs";
import * as C from "../../app/web/emu/garden_core.js";

const ENGINES = [8, 0, 1, 2, 3, 4, 5, 10];

// a snapshot as app/web.c lays it out (32-byte header, then 8 tracks of 32 bytes), written here by offset and not by
// decodeSnapshot, so a change in either side shows
function bytesOf(h = {}, tracks = []) {
  const buf = new ArrayBuffer(32 + 32 * 8), dv = new DataView(buf);
  dv.setUint16(0, h.version ?? 1, true);
  dv.setUint16(2, h.size ?? 288, true);
  dv.setUint8(4, h.playing ?? 0); dv.setUint8(5, h.scene ?? 0); dv.setUint8(6, h.bar16 ?? 0); dv.setUint8(7, h.songPos ?? 0);
  dv.setUint16(8, h.tempoX10 ?? 1200, true); dv.setUint16(10, h.solo ?? 0, true);
  dv.setUint32(12, h.stepTick ?? 0, true); dv.setUint32(16, h.barSix ?? 0, true);
  dv.setUint16(20, h.mute ?? 0, true); dv.setUint32(24, h.reads ?? 0, true);
  for (let t = 0; t < 8; t++) {
    const o = 32 + 32 * t, k = tracks[t] ?? {};
    dv.setUint8(o, k.engine ?? ENGINES[t]); dv.setUint8(o + 1, k.flags ?? 0); dv.setUint8(o + 2, k.step ?? 0);
    dv.setUint8(o + 3, k.len ?? 16); dv.setUint8(o + 4, k.lstart ?? 0); dv.setUint8(o + 5, k.lend ?? 15);
    dv.setUint8(o + 6, k.held ?? 0); dv.setUint8(o + 7, k.note ?? 60); dv.setUint8(o + 8, k.vel ?? 100);
    dv.setUint8(o + 9, k.vol ?? 100); dv.setUint8(o + 10, k.pan ?? 64); dv.setUint8(o + 11, k.cut ?? 90);
    dv.setUint8(o + 12, k.res ?? 20); dv.setUint8(o + 13, k.send1 ?? 0); dv.setUint8(o + 14, k.send2 ?? 0);
    dv.setInt8(o + 15, k.groove ?? 0); dv.setUint16(o + 16, k.peak ?? 0, true); dv.setUint16(o + 18, k.hits ?? 0, true);
    dv.setUint8(o + 20, k.pat ?? 0); dv.setUint8(o + 21, k.scale ?? 0);
    dv.setUint32(o + 24, k.maskLo ?? 0x1111, true); dv.setUint32(o + 28, k.maskHi ?? 0, true);
  }
  return buf;
}
// a decoded snapshot for the garden: hits(i) is track i's hit counter, over(i) its other fields
const snapOf = (h = {}, hits = () => 0, over = () => ({})) =>
  C.decodeSnapshot(bytesOf(h, Array.from({ length: 8 }, (_, i) => ({ hits: hits(i), ...over(i) }))));

// ---- decodeSnapshot
{
  const tracks = Array.from({ length: 8 }, (_, t) => ({
    engine: ENGINES[t], flags: t === 2 ? 5 : t === 3 ? 2 : 0, step: 3 + t, len: 12 + t, lstart: t, lend: 20 + t, held: t % 3,
    note: 40 + t, vel: 90 + t, vol: 80 + t, pan: 10 + t, cut: 50 + t, res: 30 + t, send1: 20 + t, send2: 10 + t, groove: t - 4,
    peak: 8192 + t, hits: 1000 + 61 * t, pat: t, scale: 2, maskLo: 0x80000001 + t, maskHi: 0x40000002 + t,
  }));
  const s = C.decodeSnapshot(bytesOf({ playing: 1, scene: 5, bar16: 9, songPos: 3, tempoX10: 1375, solo: 4, stepTick: 123456, barSix: 77, mute: 6, reads: 9 }, tracks));
  check(s.playing === true && s.scene === 5 && s.bar16 === 9 && s.songPos === 3 && s.tempo === 137.5 && s.solo === 4 &&
    s.stepTick === 123456 && s.barSix === 77 && s.mute === 6 && s.reads === 9, "the header's fields decode");
  const k = s.trk[2];
  check(s.trk.length === 8 && k.engine === 1 && k.muted === true && k.soloed === false && k.soloOn === true && k.step === 5 && k.len === 14 &&
    k.lstart === 2 && k.lend === 22 && k.held === 2 && k.note === 42 && k.vel === 92 && k.vol === 82 && k.pan === 12 && k.cut === 52 &&
    k.res === 32 && k.send1 === 22 && k.send2 === 12 && k.groove === -2 && k.peak === 8194 / 16384 && k.hits === 1122 && k.pat === 2 &&
    k.scale === 2 && k.maskLo === 0x80000003 && k.maskHi === 0x40000004, "a track's fields decode, flags as muted / soloed / solo on, groove signed, peak scaled");
  check(s.trk[3].soloed === true && s.trk[3].muted === false && C.stepOn(s.trk[0], 0) && C.stepOn(s.trk[0], 31) && !C.stepOn(s.trk[0], 1) &&
    C.stepOn(s.trk[0], 33) && C.stepOn(s.trk[0], 62) && !C.stepOn(s.trk[0], 63), "the 64-bit step mask reads across both halves");
  const sub = new Uint8Array(40 + 288); sub.set(new Uint8Array(bytesOf({ playing: 1 })), 40);
  check(C.decodeSnapshot(sub.subarray(40)).playing === true, "a view into a larger buffer decodes at its own offset");
  let e = ""; try { C.decodeSnapshot(bytesOf({ version: 2 })); } catch (x) { e = x.message; }
  check(/version 2/.test(e), "a snapshot of another version is refused, naming it");
  e = ""; try { C.decodeSnapshot(bytesOf({ size: 320 })); } catch (x) { e = x.message; }
  check(/expected 288/.test(e), "a snapshot whose size field is wrong is refused");
  e = ""; try { C.decodeSnapshot(bytesOf().slice(0, 100)); } catch (x) { e = x.message; }
  check(/expected 288/.test(e), "a snapshot cut short is refused");
  e = ""; try { C.decodeSnapshot(new ArrayBuffer(8)); } catch (x) { e = x.message; }
  check(/header/.test(e), "less than a header is refused");
}

// ---- the garden's seed, genomes
{
  const a = snapOf(), b = snapOf({}, () => 0, (i) => (i === 4 ? { maskHi: 1 } : {})), c = snapOf({}, () => 0, (i) => (i === 0 ? { engine: 0 } : {}));
  check(C.seedFromSnapshot(a) === C.seedFromSnapshot(snapOf()), "the same patterns give the same seed");
  const low = snapOf({}, () => 0, (i) => (i === 4 ? { maskLo: 0x1110 } : {}));
  check(C.seedFromSnapshot(a) !== C.seedFromSnapshot(b) && C.seedFromSnapshot(a) !== C.seedFromSnapshot(low), "one step more or fewer in a pattern, in either half of its mask, gives another seed");
  check(C.seedFromSnapshot(a) !== C.seedFromSnapshot(c), "another engine on a track gives another seed");
  const g1 = C.createGarden(11, { engines: ENGINES }), g2 = C.createGarden(11, { engines: ENGINES }), g3 = C.createGarden(12, { engines: ENGINES });
  const same = g1.plants.every((p, i) => p.genome.cur.every((v, j) => v === g2.plants[i].genome.cur[j]));
  const differ = g1.plants.every((p, i) => p.genome.cur.some((v, j) => v !== g3.plants[i].genome.cur[j]));
  check(same, "the same seed grows the same genomes");
  check(differ, "another seed gives every plant another genome");
  let inRange = true;
  for (let seed = 0; seed < 200; seed++) {
    for (let sp = 0; sp < C.SPECIES.length; sp++) {
      const g = C.seedGenome(seed, sp % 8, C.SPECIES[sp]);
      for (let i = 0; i < C.NG; i++) if (!(g.cur[i] >= C.GENE_RANGE[i][0] && g.cur[i] <= C.GENE_RANGE[i][1])) inRange = false;
    }
  }
  check(inRange, "every seeded gene is inside its range, for 200 seeds and every species");
  const g = C.seedGenome(3, 1, C.SPECIES[2]);
  let ok = true, most = 0;
  for (let n = 0; n < 500; n++) {
    const before = Float64Array.from(g.tgt);
    C.mutate(g, C.mulberry32(n));
    let moved = 0;
    for (let i = 0; i < C.NG; i++) {
      if (!(g.tgt[i] >= C.GENE_RANGE[i][0] && g.tgt[i] <= C.GENE_RANGE[i][1])) ok = false;
      if (g.tgt[i] !== before[i]) moved++;
    }
    most = Math.max(most, moved);
    g.cur.set(g.tgt);
  }
  check(ok && most <= 2, `a mutation keeps every gene in range and moves at most two (most ${most})`);
  const h = C.seedGenome(3, 1, C.SPECIES[2]), start = Float64Array.from(h.cur);
  C.mutate(h, C.mulberry32(9));
  C.glideGenome(h, 1);
  const mid = h.cur.some((v, i) => v !== start[i] && v !== h.tgt[i]);
  for (let i = 0; i < 40; i++) C.glideGenome(h, 1);
  check(mid && h.cur.every((v, i) => Math.abs(v - h.tgt[i]) < 1e-6), "a mutated gene glides to its target, not jumps to it");
  let threw = "";
  try { C.createGarden(1, { engines: [0, 1, 2, 3, 4, 5, 6, 11] }); } catch (x) { threw = x.message; }
  check(/engine 11 has no plant/.test(threw), "an engine the garden has no plant for is an error, not a blank");
}

// ---- time, not frames: the same garden stepped at 30 and at 144 frames a second
{
  function run(dt) {
    const st = C.createGarden(7, { engines: ENGINES, intensity: "calm" });
    const poses = [];
    C.ingest(st, snapOf(), 0); C.update(st, 0);
    for (let k = 1; k <= Math.round(3 / dt); k++) {
      const t = k * dt;
      if (Math.abs(t - 0.5) < 1e-9) C.ingest(st, snapOf({}, (i) => (i === 0 ? 1 : 0)), t);
      C.update(st, t);
      const sixth = (t - 0.5) * 6;
      if (t > 0.5 - 1e-9 && Math.abs(sixth - Math.round(sixth)) < 1e-6) poses.push(Array.from(st.plants[0].px).concat(Array.from(st.plants[0].py)));
    }
    return { st, poses };
  }
  const a = run(1 / 30), b = run(1 / 144);
  let worst = 0, swing = 0;
  for (let i = 0; i < a.poses.length; i++) {
    for (let j = 0; j < a.poses[i].length; j++) worst = Math.max(worst, Math.abs(a.poses[i][j] - b.poses[i][j]));
    swing = Math.max(swing, ...a.poses[i].slice(0, 8).map(Math.abs));
  }
  check(a.poses.length === b.poses.length && a.poses.length >= 12 && worst < 1e-3, `the stem's pose after a hit agrees at 30 and 144 fps (worst ${worst.toExponential(1)})`);
  check(swing > 0.02, `and the hit does bend the stem (a swing of ${swing.toFixed(3)} stem heights), so that agreement is not two stills`);
  let springs = 0;
  for (let i = 0; i < a.st.plants[0].s.length; i++) springs = Math.max(springs, Math.abs(a.st.plants[0].s[i] - b.st.plants[0].s[i]));
  check(springs < 2e-3, `a plant's springs end in the same place at either rate (worst ${springs.toExponential(1)})`);
  check(a.st.plants[0].nHit === 1 && b.st.plants[0].nHit === 1, "one hit is one hit at either rate");
}

// ---- hits: the counter, wherever and however often the snapshots come
{
  const mk = () => C.createGarden(5, { engines: ENGINES });
  const regular = mk(), jitter = mk(), burst = mk();
  let counter = 0;
  C.ingest(regular, snapOf(), 0); C.ingest(jitter, snapOf(), 0); C.ingest(burst, snapOf(), 0);
  const rng = C.mulberry32(3);
  let tj = 0;
  for (let f = 1; f <= 240; f++) {
    if (f % 20 === 0) counter++;
    const s = snapOf({}, (i) => (i === 2 ? counter : 0));
    C.ingest(regular, s, f / 60);
    tj = Math.max(tj + 1 / 600, f / 60 + (rng() - 0.5) * 0.012);
    C.ingest(jitter, s, tj);
  }
  C.ingest(burst, snapOf({}, (i) => (i === 2 ? 1 : 0)), 0.5);
  C.ingest(burst, snapOf({}, (i) => (i === 2 ? 2 : 0)), 0.5);
  C.ingest(burst, snapOf({}, (i) => (i === 2 ? 3 : 0)), 0.5);
  check(regular.plants[2].nHit === 12 && jitter.plants[2].nHit === 12, `12 counted hits arrive as 12 hits, on time or jittered (${regular.plants[2].nHit}, ${jitter.plants[2].nHit})`);
  check(burst.plants[2].nHit === 3, "snapshots that arrive in one go keep their hits apart");
  check(regular.plants[1].nHit === 0, "a track that did not play has no hits");
  const wrap = mk();
  C.ingest(wrap, snapOf({}, (i) => (i === 0 ? 65535 : 0)), 0);
  C.ingest(wrap, snapOf({}, () => 0), 0.1);
  check(wrap.plants[0].nHit === 1, "the 16-bit hit counter wrapping past 65535 is one hit");
  const lots = mk();
  C.ingest(lots, snapOf(), 0);
  C.ingest(lots, snapOf({}, (i) => (i === 0 ? 40 : 0)), 0.1);
  check(lots.plants[0].nHit === 4, "a burst of 40 hits between two looks is drawn as 4, not 40");
}

// ---- the glitch schedule
{
  const sched = (ctx, n) => { const o = []; for (let s = 0; s < n; s++) { const g = C.glitchStart(s, ctx); if (g) o.push(`${s}:${g.id}:${g.dur}`); } return o.join(" "); };
  check(sched({ seed: 1, intensity: "trippy" }, 512) === "268:0:6 359:10:12 388:0:2 455:7:8", "the glitches of seed 1 on Trippy are the pinned ones");
  check(sched({ seed: 2, intensity: "trippy" }, 512) !== sched({ seed: 1, intensity: "trippy" }, 512), "another seed glitches elsewhere");
  const flashIn = (intensity, n) => { let calm = 0, flash = 0, total = 0; for (let s = 0; s < n; s++) { const g = C.glitchStart(s, { seed: 9, intensity }); if (g) { total++; if (C.GLITCHES[g.id].flash) flash++; if (!C.GLITCHES[g.id].calm) calm++; } } return { calm, flash, total }; };
  const calm = flashIn("calm", 60000), trippy = flashIn("trippy", 60000), wild = flashIn("wild", 60000);
  check(calm.total > 100 && calm.flash === 0 && calm.calm === 0, `Calm glitches (${calm.total} in 60000 sixteenths), none of them a flash type or a hard one`);
  check(trippy.flash > 100 && wild.flash > trippy.flash, `Trippy and Wild do draw flash types (${trippy.flash}, ${wild.flash}), more on Wild`);
  check(wild.total > 3 * trippy.total && trippy.total > 2 * calm.total, `and glitch more often as the intensity rises (${calm.total}, ${trippy.total}, ${wild.total})`);
}

// ---- the guard on flashing
{
  const g = new C.FlashGuard(3, 1);
  const first = [0, 0.1, 0.2, 0.3, 0.9].map((t) => g.take(t));
  check(first.join() === "true,true,true,false,false", "three flash events go through in a second, the fourth waits");
  check(g.take(1.0) === true && g.take(1.05) === false, "the first one's second is over at 1.0, and only one place opens");
  const d = new C.FlashGuard(3, 1), granted = [];
  for (let t = 0; t < 20; t += 0.01) if (d.take(t)) granted.push(t);
  let worst = 0;
  for (const t of granted) worst = Math.max(worst, granted.filter((x) => x >= t && x < t + 1).length);
  check(worst === 3 && granted.length >= 55, `asked every 10 ms for 20 s, it grants at most 3 in any second, and does grant (${granted.length}, at most ${worst} in one)`);
  // the whole garden: starts that need the guard, over minutes of a busy Wild garden
  const st = C.createGarden(21, { engines: ENGINES, intensity: "wild" });
  const starts = [];
  let tick = 0;
  C.ingest(st, snapOf({ playing: 1, stepTick: 0 }), 0);
  for (let f = 1; f <= 60 * 300; f++) {
    const t = f / 60;
    if (f % 8 === 0) tick++;
    C.ingest(st, snapOf({ playing: 1, stepTick: tick, tempo: 180 }, (i) => Math.floor(f / 15) * (i % 2)), t);
    const before = st.active.length;
    C.update(st, t);
    for (let k = before; k < st.active.length; k++) if (C.GLITCHES[st.active[k].id].flash) starts.push(st.active[k].t0);
  }
  let per = 0;
  for (const t of starts) per = Math.max(per, starts.filter((x) => x >= t && x < t + 1).length);
  check(starts.length >= 20 && per <= 3, `Wild at 180 BPM for 5 minutes started ${starts.length} flash-type glitches, at most ${per} in a second`);
  const calm = C.createGarden(21, { engines: ENGINES, intensity: "calm" });
  let seen = 0, flashes = 0, tk = 0;
  C.ingest(calm, snapOf({ playing: 1 }), 0);
  for (let f = 1; f <= 60 * 600; f++) {
    if (f % 8 === 0) tk++;
    C.ingest(calm, snapOf({ playing: 1, stepTick: tk, tempo: 180 }), f / 60);
    C.update(calm, f / 60);
    for (const g of calm.active) { seen++; if (C.GLITCHES[g.id].flash || !C.GLITCHES[g.id].calm) flashes++; }
  }
  check(seen > 0 && flashes === 0, `Calm for 10 minutes had glitches in force and none a flash or hard type (${seen} frames with one)`);
}

// ---- rewind: the plants go back to where they were
{
  const mk = () => C.createGarden(8, { engines: ENGINES, intensity: "trippy" });
  const a = mk(), b = mk(), ref = mk();
  const feed = (st, t) => C.ingest(st, snapOf({}, (i) => (i === 0 && t >= 0.5 ? 1 : 0)), t);
  for (let f = 0; f <= 48; f++) { feed(a, f / 60); C.update(a, f / 60); feed(b, f / 60); C.update(b, f / 60); }
  const at08 = Array.from(b.plants[0].px);
  for (let f = 0; f <= 72; f++) { feed(ref, f / 60); C.update(ref, f / 60); }
  const noRewind = Array.from(ref.plants[0].px);
  let during = null;
  for (let f = 49; f <= 72; f++) {
    const t = f / 60;
    if (f === 60) a.rewind = { t0: 1.0, dur: 0.4 };
    feed(a, t); C.update(a, t);
    if (f === 72) during = Array.from(a.plants[0].px);
  }
  const back = Math.max(...during.map((v, i) => Math.abs(v - at08[i])));
  const plain = Math.max(...noRewind.map((v, i) => Math.abs(v - at08[i])));
  check(back < 1e-9, `at 1.2 s of a rewind started at 1.0 s the stem is where it was at 0.8 s (${back.toExponential(1)})`);
  check(plain > 1e-3, `and not because the stem sits still (it moved ${plain.toExponential(1)} without the rewind)`);
  let later = null;
  for (let f = 73; f <= 120; f++) { feed(a, f / 60); C.update(a, f / 60); feed(ref, f / 60); C.update(ref, f / 60); later = f; }
  const lost = Math.max(...Array.from(a.plants[0].px).map((v, i) => Math.abs(v - ref.plants[0].px[i])));
  check(later === 120 && a.rewind === null && lost < 1e-9, `after the rewind the clock is on real time again, with no time lost (${lost.toExponential(1)})`);
}

// ---- the field and the plants' states
{
  const xs = new Float64Array([0, 0.1, 0.2, 0.1, 0, 0.3, 0.2, 0.05]), zs = new Float64Array([0, 0.05, 0, 0.2, 0.1, 0.1, 0.3, 0.05]);
  const apart = () => { let m = 1e9; for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) m = Math.min(m, Math.hypot(xs[i] - xs[j], zs[i] - zs[j])); return m; };
  const before = apart();
  C.relax(xs, zs, 1.3);
  check(before < 0.3 && apart() >= 1.3 - 1e-6, `eight plants piled within 0.3 end at least 1.3 apart (${before.toFixed(2)} before, ${apart().toFixed(3)} after)`);
  const st = C.createGarden(2, { engines: ENGINES });
  const play = (t0, t1, over) => {
    for (let t = t0; t <= t1 + 1e-9; t += 1 / 60) { C.ingest(st, snapOf({}, () => 0, over), t); C.update(st, t); C.prepareView(st, 16 / 9); C.frameUniforms(st); }
  };
  play(0, 6, () => ({}));
  const pool = (i) => st.u.uPool[i * 4 + 3];
  check(pool(3) > 0.34 && pool(2) > 0.34, "a track that is on has its full light on the ground");
  play(6, 12, (i) => (i === 3 ? { flags: 1 } : {}));
  check(pool(3) < 0.14 && pool(2) > 0.34, `muted for 6 s, a plant's light has wilted to ${pool(3).toFixed(2)} and its neighbour's has not`);
  let close = 1e9;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) close = Math.min(close, Math.hypot(st.u.uPool[i * 4] - st.u.uPool[j * 4], st.u.uPool[i * 4 + 1] - st.u.uPool[j * 4 + 1]));
  check(close > 1.2, `the plants stay apart as they move (${close.toFixed(2)} at the closest)`);
  play(12, 20, () => ({}));
  check(pool(3) > 0.3, `un-muted, the plant comes back (${pool(3).toFixed(2)})`);
  play(20, 26, (i) => (i === 5 ? { flags: 2 | 4 } : { flags: 4 }));   // soloed: flags 2; solo on: 4
  const zOf = (i) => st.u.uPool[i * 4 + 1], dim = (i) => st.plants[i].s[10];   // (10: the plant's dimming spring, C_DIM)
  const others = [0, 1, 2, 3, 4, 6, 7];
  check(others.every((i) => zOf(5) > zOf(i) + 1) && Math.abs(st.u.uPool[5 * 4]) < 0.1, "on a solo the soloed plant steps to the front and the middle");
  check(dim(5) < 0.2 && others.every((i) => dim(i) > 0.8), "and the others dim while it stays lit");
  play(26, 32, () => ({ flags: 0 }));
  check(others.every((i) => dim(i) < 0.2), "the dimming goes when the solo does");
}

// ---- what it hands the renderer
{
  const buf = new Float32Array(C.MAX_INSTANCES * C.FLOATS);
  for (const intensity of ["calm", "trippy", "wild"]) {
    const st = C.createGarden(31, { engines: ENGINES, intensity });
    let worst = 0, bad = 0, dropped = 0, tick = 0;
    for (let f = 0; f <= 60 * 40; f++) {
      const t = f / 60;
      if (f % 8 === 0) tick++;
      C.ingest(st, snapOf({ playing: 1, stepTick: tick }, (i) => Math.floor(f / (12 + i)), (i) => ({ step: tick % 16, held: i % 3, peak: 9000, send1: 90, send2: 90, maskLo: 0xffffffff, maskHi: 0xffffffff, len: 64 })), t);
      C.update(st, t);
      if (f % 30 === 0) {
        C.prepareView(st, f % 60 === 0 ? 16 / 9 : 9 / 16);
        const n = C.buildInstances(st, buf);
        C.frameUniforms(st);
        worst = Math.max(worst, n); dropped += st.dropped;
        for (let i = 0; i < n * C.FLOATS; i++) if (!Number.isFinite(buf[i])) bad++;
        for (const v of Object.values(st.u)) for (const x of (typeof v === "number" ? [v] : v)) if (!Number.isFinite(x)) bad++;
      }
    }
    check(worst > 800 && worst <= C.MAX_INSTANCES && dropped === 0 && bad === 0, `${intensity}: a full garden is ${worst} sprites of ${C.MAX_INSTANCES}, none dropped, every number finite`);
  }
  const st = C.createGarden(31, { engines: ENGINES });
  C.ingest(st, snapOf({ playing: 1 }), 0); C.update(st, 1); C.prepareView(st, 1.5);
  const small = new Float32Array(100 * C.FLOATS), n = C.buildInstances(st, small);
  check(n === 100 && st.dropped > 0, `a buffer too small for the frame is filled and the rest counted as dropped (${n} kept, ${st.dropped} dropped)`);
  const u = C.frameUniforms(st);
  const sum = u.uBiome.reduce((a, b) => a + b, 0);
  check(Math.abs(sum - 1) < 1e-6 && u.uPhase >= 0 && u.uPhase < 1 && u.uTrail > 0.8 && u.uTrail < 1, "the biomes' weights add to one and the beat phase is inside its bar");
  // the screen: what is above, right and ahead of a level camera lands up, right and in front, and the basis the sky shader
  // and the sprites use (fwd, right, up) is the one the view-projection matrix draws with
  {
    const cam = C.createGarden(1, { engines: ENGINES });
    cam.cam.pos.set([1, 1.5, 6]); cam.cam.tgt.set([1, 1.5, 0]); cam.cam.roll = 0; cam.cam.fov = 0.96;
    C.prepareView(cam, 1.6);
    const o = new Float64Array(3), at = (x, y, z) => C.project(cam.v.vp, x, y, z, o).slice();
    const mid = at(1, 1.5, 0), above = at(1, 2.5, 0), right = at(2, 1.5, 0);
    check(Math.abs(mid[0]) < 1e-9 && Math.abs(mid[1]) < 1e-9 && above[1] > 0.1 && Math.abs(above[0]) < 1e-9, "a point above the target lands above the middle of the screen");
    check(right[0] > 0.1 && Math.abs(right[1]) < 1e-9, "a point to the right of the target (the camera looks along -z) lands on the right of the screen");
    check(cam.v.up[1] > 0.99 && cam.v.right[0] > 0.99 && cam.v.fwd[2] < -0.99, "the sky shader's basis agrees: up is up, right is +x, forward is -z");
    cam.cam.roll = Math.PI / 2;
    C.prepareView(cam, 1.6);
    const rolled = at(1 + cam.v.right[0] * 0.5 + cam.v.up[0] * 0.5, 1.5 + cam.v.right[1] * 0.5 + cam.v.up[1] * 0.5, 0 + cam.v.right[2] * 0.5 + cam.v.up[2] * 0.5);
    check(rolled[0] > 0.05 && rolled[1] > 0.05, "a rolled camera's right and up are the directions the matrix draws as right and up");
  }
  const idle = C.createGarden(4, { engines: ENGINES });
  C.ingest(idle, snapOf(), 0);
  const frames = [];
  for (let f = 0; f <= 60 * 12; f++) {
    C.update(idle, f / 60);
    if (f === 60 * 10 || f === 60 * 11) { C.prepareView(idle, 1.6); C.buildInstances(idle, buf); frames.push(Float32Array.from(buf.subarray(0, idle.instances * C.FLOATS))); }
  }
  let moved = 0;
  for (let i = 0; i < Math.min(frames[0].length, frames[1].length); i++) if (Math.abs(frames[0][i] - frames[1][i]) > 1e-4) moved++;
  check(moved > 100 && idle.idleT > 11.9 && idle.rest === false, `stopped, the garden still breathes (${moved} numbers moved in a second, idle clock ${idle.idleT.toFixed(1)} s)`);
  check(C.chooseShot(1, 3, 0.9, 4) === 5 && C.chooseShot(1, 3, 0.9, -1) !== 5 || C.chooseShot(1, 4, 0.9, -1) !== 5, "a soloed track takes the camera to macro");
}

done();
