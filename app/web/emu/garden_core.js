// SPDX-License-Identifier: MPL-2.0
// The night garden's logic: no DOM, no GL, so node can test it (tests/host/garden_core.mjs). The firmware's snapshot
// (app/web.c) comes in through decodeSnapshot() and ingest(); update() moves the garden on to a time; buildInstances()
// writes what to draw and frameUniforms() what the shaders need (garden_gl.js draws them). Motion is closed form in
// time (exact springs, damped rings), so it looks the same at 30 and 144 frames a second, and a time can be asked for
// twice: the rewind glitch runs the clock backwards, and every plant is where it was.

export const TAU = Math.PI * 2;
const GOLD = 2.399963229728653;                           // the golden angle, radians
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

// ---- randomness: every random choice is a hash of the seed and a count, so a song grows the same garden each time
export function hash32(a, b = 0) {
  let h = (Math.imul(a | 0, 0x85ebca6b) ^ Math.imul((b | 0) + 0x27d4eb2f, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return h >>> 0;
}
export const unit = (h) => (h >>> 0) / 4294967296;
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the physics the firmware's UI and the README's plants use: all of it a function of time, not of frames
// a critically damped spring to a target, exact for any dt: x and v in out
export function springCd(x, v, target, omega, dt, out) {
  const e = Math.exp(-omega * dt), d = x - target, k = v + omega * d;
  out[0] = target + (d + k * dt) * e;
  out[1] = (v - omega * k * dt) * e;
  return out;
}
// a struck, damped oscillator: seconds since the strike, strength, Hz, decay time constant (s); nothing before the strike
export function ringAt(sec, amp, hz, tau) {
  return sec < 0 ? 0 : amp * Math.exp(-sec / tau) * Math.sin(TAU * hz * sec);
}
// the cantilever's two modes (the README's hero plant): bending along the stem 0..1, 1 at the tip
const BETA = [1.8751040687, 4.6940911330];
function modeShape(i, s) {
  const b = BETA[i], sg = (Math.cosh(b) + Math.cos(b)) / (Math.sinh(b) + Math.sin(b));
  const at = (x) => (Math.cosh(b * x) - Math.cos(b * x)) - sg * (Math.sinh(b * x) - Math.sin(b * x));
  return at(s) / at(1);
}
const SEG = 7;
const MODE = [new Float64Array(SEG + 1), new Float64Array(SEG + 1)];
for (let k = 0; k <= SEG; k++) { MODE[0][k] = modeShape(0, k / SEG); MODE[1][k] = modeShape(1, k / SEG); }
const F1 = 1.55, F2 = F1 * 6.267;                         // Hz of a plant 2 units tall
const Z1 = 0.10, Z2 = 0.16;                               // the modes' damping ratios
const DRIVE1 = 0.2, DRIVE2 = 0.045;                       // a full-velocity hit's bend, as a share of the height

// ---- the snapshot (app/web.c garden_t, 32-byte header then 8 tracks of 32 bytes)
export const SNAP_VERSION = 1;
export const NTRK = 8;
const SNAP_HEAD = 32, SNAP_TRK = 32;
export const SNAP_SIZE = SNAP_HEAD + SNAP_TRK * NTRK;

export function decodeSnapshot(buf) {
  const view = ArrayBuffer.isView(buf);
  const len = buf.byteLength;
  if (len < SNAP_HEAD) throw new Error(`garden snapshot: ${len} bytes, a header is ${SNAP_HEAD}`);
  const dv = new DataView(view ? buf.buffer : buf, view ? buf.byteOffset : 0, len);
  const version = dv.getUint16(0, true), size = dv.getUint16(2, true);
  if (version !== SNAP_VERSION) throw new Error(`garden snapshot: version ${version}, this page reads ${SNAP_VERSION}`);
  if (size !== SNAP_SIZE || len < SNAP_SIZE) throw new Error(`garden snapshot: ${len} bytes with size ${size}, expected ${SNAP_SIZE}`);
  const snap = {
    playing: dv.getUint8(4) !== 0, scene: dv.getUint8(5), bar16: dv.getUint8(6), songPos: dv.getUint8(7),
    tempo: dv.getUint16(8, true) / 10, solo: dv.getUint16(10, true), stepTick: dv.getUint32(12, true),
    barSix: dv.getUint32(16, true), mute: dv.getUint16(20, true), reads: dv.getUint32(24, true), trk: [],
  };
  for (let t = 0; t < NTRK; t++) {
    const o = SNAP_HEAD + SNAP_TRK * t, flags = dv.getUint8(o + 1);
    snap.trk.push({
      engine: dv.getUint8(o), muted: (flags & 1) !== 0, soloed: (flags & 2) !== 0, soloOn: (flags & 4) !== 0,
      step: dv.getUint8(o + 2), len: dv.getUint8(o + 3), lstart: dv.getUint8(o + 4), lend: dv.getUint8(o + 5),
      held: dv.getUint8(o + 6), note: dv.getUint8(o + 7), vel: dv.getUint8(o + 8),
      vol: dv.getUint8(o + 9), pan: dv.getUint8(o + 10), cut: dv.getUint8(o + 11), res: dv.getUint8(o + 12),
      send1: dv.getUint8(o + 13), send2: dv.getUint8(o + 14), groove: dv.getInt8(o + 15),
      peak: dv.getUint16(o + 16, true) / 16384, hits: dv.getUint16(o + 18, true), pat: dv.getUint8(o + 20),
      scale: dv.getUint8(o + 21), maskLo: dv.getUint32(o + 24, true), maskHi: dv.getUint32(o + 28, true),
    });
  }
  return snap;
}
export function stepOn(k, i) {
  return i < 32 ? ((k.maskLo >>> i) & 1) === 1 : ((k.maskHi >>> (i - 32)) & 1) === 1;
}
// the garden's seed: a hash of what is programmed (engines, lengths, steps), so a song grows its own garden
export function seedFromSnapshot(snap) {
  let h = 0x5eed;
  for (const k of snap.trk) {
    h = hash32(h, k.engine | (k.len << 8));
    h = hash32(h, k.maskLo);
    h = hash32(h, k.maskHi);
  }
  return h;
}

// ---- colour
const INK_HEX = [0xff4081, 0xff911e, 0xffe628, 0x3cff78, 0x00e1ff, 0x3c78ff, 0xa05cff, 0xeb40ff];   // the prism theme's T1..T8
export const INKS = INK_HEX.map((x) => [(x >> 16 & 255) / 255, (x >> 8 & 255) / 255, (x & 255) / 255]);
export function rgb2hsv(r, g, b, o) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  o[0] = h; o[1] = mx <= 0 ? 0 : d / mx; o[2] = mx;
  return o;
}
export function hsv2rgb(h, s, v, o) {
  h = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: o[0] = v; o[1] = t; o[2] = p; break;
    case 1: o[0] = q; o[1] = v; o[2] = p; break;
    case 2: o[0] = p; o[1] = v; o[2] = t; break;
    case 3: o[0] = p; o[1] = q; o[2] = v; break;
    case 4: o[0] = t; o[1] = p; o[2] = v; break;
    default: o[0] = v; o[1] = p; o[2] = q;
  }
  return o;
}
const INK_HSV = INKS.map((c) => rgb2hsv(c[0], c[1], c[2], [0, 0, 0]));
const tmp3 = [0, 0, 0];

// ---- genomes: what a plant is made of; each gene glides to its target, so a mutation grows, never pops
export const G = { petals: 0, layers: 1, plen: 2, pwid: 3, tip: 4, notch: 5, curl: 6, stemH: 7, leaves: 8, leafSz: 9,
  hue: 10, glow: 11, spiral: 12, disc: 13, tilt: 14 };
export const NG = 15;
export const GENE_RANGE = [[4, 28], [1, 3], [0.28, 0.7], [0.05, 0.3], [0, 1], [0, 0.5], [-0.6, 0.6], [0.3, 2.7], [0, 7],
  [0.18, 0.45], [-0.09, 0.09], [0.6, 1.5], [0, 1], [0.04, 0.26], [-0.5, 0.5]];
// cup: the polar angle (rad from the stem's direction) a petal opens to when fully open; 0 holds them upright, ~1.2 lays them flat
const species = (name, style, cup, g) => ({ name, style, cup, g: Float64Array.from(g) });
// by engine number (app/dsp/synth.h: knit, rayon, jacquard, bellows, cane, voile, sample, slice, drumline, midi, acid)
//                               petals layers plen  pwid  tip  notch curl  stemH leaves leafSz hue glow spiral disc tilt
export const SPECIES = [
  species("daisy", "ring", .1, [14, 1.2, 0.46, 0.075, 0.2, 0,    0,    1.9, 3, 0.30, 0, 1.0, 0, 0.17, 0]),
  species("lily", "ring", .5, [6,  2,   0.56, 0.15,  0.9, 0,    0.45, 2.1, 4, 0.34, 0, 1.0, 0, 0.09, 0]),
  species("dahlia", "ring", .2, [20, 2.6, 0.42, 0.12,  0.35, 0.12, 0.05, 1.7, 3, 0.28, 0, 1.1, 1, 0.12, 0]),
  species("tulip", "ring", .85, [6,  1.5, 0.60, 0.2,   0.3, 0.15, -0.1, 2.0, 3, 0.32, 0, 1.0, 0, 0.05, 0]),
  species("reed", "ring", 1.15, [7,  1,   0.70, 0.06,  0.6, 0,    0.1,  2.6, 6, 0.42, 0, 0.9, 0, 0.04, 0]),
  species("dandelion", "puff", 0, [24, 1,   0.60, 0.06,  0.5, 0,    0,    2.2, 2, 0.28, 0, 1.0, 0, 0.10, 0]),
  species("poppy", "ring", .45, [4,  2,   0.50, 0.3,   0,   0,    0.2,  1.8, 3, 0.30, 0, 1.0, 0, 0.14, 0]),
  species("succulent", "ring", .15, [9,  3,   0.46, 0.2,   0.5, 0,    -0.15, 0.35, 0, 0.20, 0, 1.0, 0, 0.07, 0]),
  species("pods", "pods", .7, [6,  1,   0.40, 0.2,   0,   0,    0,    1.5, 3, 0.30, 0, 1.0, 0, 0.10, 0]),
  species("ghost", "ring", .25, [8,  1.5, 0.50, 0.14,  0.7, 0.05, 0.1,  1.9, 2, 0.30, 0, 0.9, 0, 0.10, 0]),
  species("flytrap", "trap", 0, [4,  1,   0.60, 0.28,  0.8, 0,    0,    1.6, 3, 0.30, 0, 1.1, 0, 0.06, 0]),
];
export function speciesFor(engine) {
  const s = SPECIES[engine];
  if (!s) throw new Error(`garden: engine ${engine} has no plant (the firmware has ${SPECIES.length} engines)`);
  return s;
}
export function seedGenome(seed, track, sp) {
  const rng = mulberry32(hash32(seed, track + 1));
  const cur = new Float64Array(NG);
  for (let i = 0; i < NG; i++) {
    const [lo, hi] = GENE_RANGE[i];
    cur[i] = clamp(sp.g[i] + (rng() - 0.5) * 0.25 * (hi - lo), lo, hi);
  }
  return { cur, tgt: Float64Array.from(cur) };
}
// one or two genes pick a new target a little way off; the plant glides there over a few seconds (glideGenome)
export function mutate(genome, rng) {
  const n = rng() < 0.5 ? 1 : 2;
  for (let k = 0; k < n; k++) {
    const i = Math.floor(rng() * NG), [lo, hi] = GENE_RANGE[i];
    genome.tgt[i] = clamp(genome.cur[i] + (rng() - 0.5) * 0.6 * (hi - lo), lo, hi);
  }
}
export function glideGenome(genome, dt, tau = 2.2) {
  const f = 1 - Math.exp(-dt / tau);
  for (let i = 0; i < NG; i++) genome.cur[i] += (genome.tgt[i] - genome.cur[i]) * f;
}

// ---- intensity
export const INTENSITY = {
  calm:   { glitchEvery: 256, flash: false, camSpeed: 0.4, trail: 0.8,  shotBars: 16, mutateBars: 16, wind: 0.6, bloom: 0.75 },
  trippy: { glitchEvery: 96,  flash: true,  camSpeed: 1.0, trail: 0.9,  shotBars: 8,  mutateBars: 8,  wind: 1.0, bloom: 1.0 },
  wild:   { glitchEvery: 24,  flash: true,  camSpeed: 1.6, trail: 0.93, shotBars: 4, mutateBars: 4,  wind: 1.5, bloom: 1.25 },
};

// ---- glitches: which one fires on a given sixteenth is a hash of the seed and the step, so a song glitches the same
// way every time and the schedule can be pinned. flash: its start is abrupt (the FlashGuard gates those); calm: gentle
export const GLITCHES = [
  { name: "rgbSplit",    min: 2, max: 6,  flash: true,  calm: false },
  { name: "datamosh",    min: 4, max: 12, flash: true,  calm: false },
  { name: "scanTear",    min: 2, max: 6,  flash: true,  calm: false },
  { name: "stutter",     min: 4, max: 8,  flash: true,  calm: false },
  { name: "melt",        min: 6, max: 16, flash: false, calm: true },
  { name: "kaleido",     min: 4, max: 16, flash: false, calm: false },
  { name: "paletteSwap", min: 8, max: 24, flash: false, calm: true },
  { name: "rewind",      min: 4, max: 10, flash: false, calm: false },
  { name: "mirror",      min: 4, max: 16, flash: false, calm: true },
  { name: "hueCycle",    min: 8, max: 32, flash: false, calm: true },
  { name: "fisheye",     min: 4, max: 12, flash: false, calm: true },
  { name: "derez",       min: 2, max: 6,  flash: true,  calm: false },
];
const CALM_SET = GLITCHES.map((g, i) => (g.calm ? i : -1)).filter((i) => i >= 0);
const ALL_SET = GLITCHES.map((g, i) => i);
const isFill = (step) => ((step >> 4) & 3) === 3 && (step & 15) >= 8;   // the second half of a phrase's last bar

// the glitch that starts on this absolute sixteenth, or null. ctx: { seed, intensity }
export function glitchStart(step, ctx) {
  const cfg = INTENSITY[ctx.intensity];
  const h = hash32(ctx.seed ^ 0x611c, step);
  const p = (1 / cfg.glitchEvery) * (isFill(step) ? 2.5 : 1);
  if (unit(h) >= p) return null;
  const set = cfg.flash ? ALL_SET : CALM_SET;
  const id = set[hash32(h, 1) % set.length], g = GLITCHES[id];
  const dur = g.min + (hash32(h, 2) % (g.max - g.min + 1));
  return { id, step, dur, amt: 0.55 + 0.45 * unit(hash32(h, 3)), seed: hash32(h, 4) };
}
// at most `max` flash-type events in any `win` seconds
export class FlashGuard {
  constructor(max = 3, win = 1) { this.t = new Float64Array(max).fill(-1e9); this.i = 0; this.win = win; }
  take(now) {
    if (now - this.t[this.i] < this.win) return false;
    this.t[this.i] = now;
    this.i = (this.i + 1) % this.t.length;
    return true;
  }
}

// ---- 4x4 matrices (column-major, as WebGL takes them) and the camera
export function mat4Perspective(fovy, aspect, near, far, o) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
  return o;
}
export function mat4LookAt(ex, ey, ez, tx, ty, tz, ux, uy, uz, o) {
  let fx = tx - ex, fy = ty - ey, fz = tz - ez;
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l;
  let sx = fy * uz - fz * uy, sy = fz * ux - fx * uz, sz = fx * uy - fy * ux;
  l = Math.hypot(sx, sy, sz); sx /= l; sy /= l; sz /= l;
  const vx = sy * fz - sz * fy, vy = sz * fx - sx * fz, vz = sx * fy - sy * fx;
  o[0] = sx; o[1] = vx; o[2] = -fx; o[3] = 0;
  o[4] = sy; o[5] = vy; o[6] = -fy; o[7] = 0;
  o[8] = sz; o[9] = vz; o[10] = -fz; o[11] = 0;
  o[12] = -(sx * ex + sy * ey + sz * ez); o[13] = -(vx * ex + vy * ey + vz * ez); o[14] = fx * ex + fy * ey + fz * ez; o[15] = 1;
  return o;
}
export function mat4Mul(a, b, o) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
// a point through a matrix: x, y in -1..1 on the screen, w the depth (negative: behind the camera)
export function project(m, x, y, z, o) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  o[2] = w;
  return o;
}

// ---- the camera director: seven shots, each a function of the time since it began
const SLOW_SHOTS = [0, 2, 6, 1], FAST_SHOTS = [3, 1, 5, 4];
export function chooseShot(seed, phrase, energy, soloTrack) {
  if (soloTrack >= 0) return 5;
  const h = hash32(seed ^ 0xca3e, phrase), pool = unit(h) < energy ? FAST_SHOTS : SLOW_SHOTS;
  return pool[hash32(h, 1) % pool.length];
}
// cam: { pos[3], tgt[3], fov (radians), roll, focus (world distance in focus), dof (0..1) }
export function newCam() { return { pos: new Float64Array(3), tgt: new Float64Array(3), fov: 1, roll: 0, focus: 8, dof: 0 }; }
// ctx: { cx, cz (the garden's middle), head: [x, y, z] of the plant the macro shot looks at, phase }
export function cameraAt(shot, tau, ctx, o) {
  const { cx, cz } = ctx, ph = ctx.phase;
  o.roll = 0; o.dof = 0.15;
  switch (shot) {
    case 0:                                              // dolly: in and out along the garden
      o.pos[0] = cx + 2.2 * Math.sin(tau * 0.17 + ph); o.pos[1] = 1.35 + 0.25 * Math.sin(tau * 0.3); o.pos[2] = cz + 7.5 + 2.8 * Math.sin(tau * 0.11);
      o.tgt[0] = cx; o.tgt[1] = 1.1; o.tgt[2] = cz - 2; o.fov = 0.96; break;
    case 1: {                                            // orbit
      const a = tau * 0.13 + ph, r = 8.8 + 1.4 * Math.sin(tau * 0.21);
      o.pos[0] = cx + r * Math.sin(a); o.pos[1] = 1.7 + 0.6 * Math.sin(tau * 0.29); o.pos[2] = cz + r * Math.cos(a);
      o.tgt[0] = cx; o.tgt[1] = 1.0; o.tgt[2] = cz; o.fov = 0.98; break;
    }
    case 2:                                              // crane: up from the grass to the stars and back
      o.pos[0] = cx + 1.5 * Math.sin(tau * 0.09 + ph); o.pos[1] = 2.6 + 2.3 * Math.sin(tau * 0.17 - 1.57); o.pos[2] = cz + 8.2;
      o.tgt[0] = cx; o.tgt[1] = 1.2; o.tgt[2] = cz - 1; o.fov = 1.05; break;
    case 3: {                                            // fly through between the stems
      const x = cx + 6.4 * Math.sin(tau * 0.2 + ph), z = cz + 1.4 + 3.6 * Math.cos(tau * 0.29 + ph);
      const dx = 6.4 * 0.2 * Math.cos(tau * 0.2 + ph), dz = -3.6 * 0.29 * Math.sin(tau * 0.29 + ph), l = Math.hypot(dx, dz) || 1;
      o.pos[0] = x; o.pos[1] = 0.85 + 0.25 * Math.sin(tau * 0.7); o.pos[2] = z;
      o.tgt[0] = x + 3 * dx / l; o.tgt[1] = 1.15; o.tgt[2] = z + 3 * dz / l; o.fov = 1.2; o.dof = 0.35; break;
    }
    case 4:                                              // top down: the garden as a mandala
      o.pos[0] = cx; o.pos[1] = 10.5; o.pos[2] = cz + 2.6;
      o.tgt[0] = cx; o.tgt[1] = 0; o.tgt[2] = cz; o.roll = tau * 0.22 + ph; o.fov = 1.05; break;
    case 5:                                              // macro on one plant's head
      o.pos[0] = ctx.head[0] + 1.3 * Math.sin(tau * 0.31 + ph); o.pos[1] = ctx.head[1] + 0.15 * Math.sin(tau * 0.5); o.pos[2] = ctx.head[2] + 1.9 + 0.4 * Math.sin(tau * 0.23);
      o.tgt[0] = ctx.head[0]; o.tgt[1] = ctx.head[1]; o.tgt[2] = ctx.head[2]; o.fov = 0.72; o.dof = 1; break;
    default:                                             // side on, as the README's plant
      o.pos[0] = cx + 0.6 * Math.sin(tau * 0.1 + ph); o.pos[1] = 0.9; o.pos[2] = cz + 10.5;
      o.tgt[0] = cx; o.tgt[1] = 1.15; o.tgt[2] = cz - 4; o.fov = 0.78;
  }
  o.focus = Math.hypot(o.tgt[0] - o.pos[0], o.tgt[1] - o.pos[1], o.tgt[2] - o.pos[2]);
  return o;
}
export function blendCam(a, b, u, o) {
  for (let i = 0; i < 3; i++) { o.pos[i] = lerp(a.pos[i], b.pos[i], u); o.tgt[i] = lerp(a.tgt[i], b.tgt[i], u); }
  o.fov = lerp(a.fov, b.fov, u); o.roll = lerp(a.roll, b.roll, u); o.focus = lerp(a.focus, b.focus, u); o.dof = lerp(a.dof, b.dof, u);
  return o;
}

// ---- the field: where the plants stand (busy ones forward, quiet and muted ones back, pan leaning them aside)
export function relax(xs, zs, min, iters = 40) {
  const n = xs.length;
  for (let it = 0; it < iters; it++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j] - xs[i], dz = zs[j] - zs[i], d = Math.hypot(dx, dz);
        if (d >= min) continue;
        let nx, nz;
        if (d < 1e-6) { const a = (i * 7 + j * 3) * 2.399963; nx = Math.cos(a); nz = Math.sin(a); }
        else { nx = dx / d; nz = dz / d; }
        const push = (min - d) / 2 + 1e-9;
        xs[i] -= nx * push; zs[i] -= nz * push; xs[j] += nx * push; zs[j] += nz * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// ---- the garden
const C_OPEN = 0, C_SIZE = 1, C_WILT = 2, C_X = 3, C_Z = 4, C_DIM = 5, NCH = 6;      // a plant's springs, each [value, velocity]
const HITS = 8, POLLEN = 36, FALLING = 5, FLY = 44, RIPPLES = 24, BRIDGES = 10, GRASS = 1800, GRASS_ROWS = 12, PODS = 11, NSTEP = 64;
const MIN_APART = 1.3, IDLE = 1 << 20, NBIOME = 5;
export const FLOATS = 16;
export const MAX_INSTANCES = 6144;
export const PAD = 0.08;                                   // the margin round every sprite for its soft edge, in world units
export const K = { CAPSULE: 0, PETAL: 1, LEAF: 2, DISC: 3, GLOW: 4, BUD: 5, DOT: 6, GRASS: 7 };
export const FX = { split: 0, tear: 1, block: 2, mosh: 3, stutter: 4, melt: 5, kaleido: 6, mirror: 7, fisheye: 8, derez: 9, hue: 10, vhs: 11 };
const BIOME_HUE = [0.58, 0.36, 0.5, 0.78, 0.9];
const sp2 = [0, 0];
const f32 = (n, v = 0) => new Float32Array(n).fill(v);

function createPlant(seed, i, engine) {
  const sp = speciesFor(engine);
  const p = {
    i, engine, species: sp, genome: seedGenome(seed, i, sp), ink: INK_HSV[i % 8],
    hT: new Float64Array(HITS).fill(-1e9), hV: new Float64Array(HITS), hN: new Float64Array(HITS), hS: new Float64Array(HITS),
    nHit: 0, nFired: 0, fired: 0, hitsSeen: -1, lastFireT: -1e9,
    lvl: 0, lvlIn: 0, rate: 0, act: 0, noteHue: 0, bloom: 0,
    s: new Float64Array(NCH * 2),
    vol: 0.8, pan: 0, cut: 0.5, res: 0, s1: 0, s2: 0, held: 0, groove: 0, muted: false, soloed: false, soloOn: false,
    step: 0, len: 16, maskLo: 0, maskHi: 0, vel: 0.7, note: 60,
    grow: 0, growS: 0, quiet: 0, barHits: 0,
    budT: new Float64Array(NSTEP).fill(-1e9), podT: new Float64Array(PODS).fill(-1e9), podV: new Float64Array(PODS),
    pollen: { x: f32(POLLEN), y: f32(POLLEN), z: f32(POLLEN), vx: f32(POLLEN), vy: f32(POLLEN), vz: f32(POLLEN),
      age: f32(POLLEN, 9), life: f32(POLLEN), hue: f32(POLLEN), n: 0 },
    fall: { x: f32(FALLING), y: f32(FALLING), z: f32(FALLING), vx: f32(FALLING), vy: f32(FALLING), a: f32(FALLING),
      av: f32(FALLING), age: f32(FALLING, 9), landed: f32(FALLING), n: 0 },
    px: new Float64Array(SEG + 1), py: new Float64Array(SEG + 1), tipAng: 0, hx: 0, hy: 0, hz: 0,
    col: { petal: new Float64Array(3), inner: new Float64Array(3), disc: new Float64Array(3), stem: new Float64Array(3), leaf: new Float64Array(3) },
    partner: -1, drift: 0,
  };
  p.s[C_SIZE * 2] = 0.9; p.s[C_OPEN * 2] = 0.5;
  for (let k = 0; k <= SEG; k++) p.py[k] = (p.genome.cur[G.stemH] * k) / SEG;
  return p;
}

function makeGrass(seed) {
  const x = f32(GRASS), z = f32(GRASS), h = f32(GRASS), r = f32(GRASS), k = f32(GRASS);
  const rng = mulberry32(hash32(seed, 4242)), pts = [];
  for (let i = 0; i < GRASS; i++) pts.push([(rng() - 0.5) * 30, -15 + 20.5 * (0.4 * rng() + 0.6 * Math.sqrt(rng())), 0.16 + 0.26 * rng(), rng(), rng()]);
  pts.sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < GRASS; i++) { x[i] = pts[i][0]; z[i] = pts[i][1]; h[i] = pts[i][2]; r[i] = pts[i][3]; k[i] = pts[i][4]; }
  const rows = new Int32Array(GRASS_ROWS + 1), rowZ = new Float64Array(GRASS_ROWS);
  for (let i = 0; i <= GRASS_ROWS; i++) rows[i] = Math.floor((i * GRASS) / GRASS_ROWS);
  for (let i = 0; i < GRASS_ROWS; i++) rowZ[i] = z[(rows[i] + rows[i + 1]) >> 1];
  return { x, z, h, r, k, rows, rowZ };
}

export function createGarden(seed, opts = {}) {
  const engines = opts.engines || [8, 0, 1, 2, 0, 3, 4, 5];
  const intensity = opts.intensity || "trippy";
  const st = {
    seed, intensity, reduced: !!opts.reduced, delay: opts.delay || 0,
    t: -1, clock: 0, snap: null, playing: false, tempo: 120, stepTick: 0, tTick: 0, tick: -1, idleT: 0, idleTick: -1,
    barCount: 0, energy: 0, lastActivity: 0, rest: false, lastScene: -1,
    plants: [], co: new Float64Array(NTRK * NTRK),
    cam: newCam(), camFrom: newCam(), camTo: newCam(), camShot: 0, camT0: 0, camBlend: 1, camFocus: -1, shotCount: 0,
    phase: unit(hash32(seed, 77)) * TAU, head: [0, 0, 0], cctx: null,
    gctx: { seed, intensity }, active: [], guard: new FlashGuard(3, 1), rewind: null, fx: new Float64Array(12),
    biomeTarget: hash32(seed, 5) % NBIOME, bw: new Float64Array(NBIOME),
    audio: { bass: 0, mid: 0, high: 0 },
    ripples: { x: f32(RIPPLES), z: f32(RIPPLES), t0: new Float64Array(RIPPLES).fill(-1e9), amp: f32(RIPPLES), hue: f32(RIPPLES), n: 0 },
    bridges: [], fly: { p: new Float32Array(FLY * 3), owner: new Uint8Array(FLY), on: false },
    grass: makeGrass(seed), rh: [1, 0], instances: 0, dropped: 0,
    slotX: new Float64Array(NTRK), slotZ: new Float64Array(NTRK), fieldX: new Float64Array(NTRK), fieldZ: new Float64Array(NTRK),
    v: { view: new Float64Array(16), proj: new Float64Array(16), vp: new Float64Array(16), fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
      sr: [1, 0, 0], su: [0, 1, 0], tanHalf: 0.5, aspect: 1 },
    ck: { depth: new Float64Array(NTRK + GRASS_ROWS), kind: new Uint8Array(NTRK + GRASS_ROWS), idx: new Uint8Array(NTRK + GRASS_ROWS) },
    u: null,
  };
  st.bw[st.biomeTarget] = 1;
  for (let i = 0; i < NTRK; i++) {
    st.plants.push(createPlant(seed, i, engines[i]));
    st.slotX[i] = (i - 3.5) * 1.95;
    st.slotZ[i] = -3.5 + 3 * Math.sin(i * 2.1 + st.phase);
    st.plants[i].s[C_X * 2] = st.slotX[i];
    st.plants[i].s[C_Z * 2] = st.slotZ[i];
  }
  for (let i = 0; i < FLY; i++) st.fly.owner[i] = hash32(seed, 900 + i) % NTRK;
  st.u = makeUniforms();
  return st;
}

export function setIntensity(st, name) {
  if (!INTENSITY[name]) throw new Error(`garden: no intensity "${name}"`);
  st.intensity = name;
  st.gctx.intensity = name;
}

function pushHit(p, t, vel, note, sign) {
  const k = p.nHit % HITS;
  p.hT[k] = t; p.hV[k] = vel; p.hN[k] = note; p.hS[k] = sign;
  p.nHit++;
}

// the snapshot received at time t (seconds): each new hit rings from t + delay, when its sound reaches the ears
export function ingest(st, snap, t) {
  st.snap = snap;
  if (snap.stepTick !== st.stepTick) { st.stepTick = snap.stepTick; st.tTick = t; }
  st.playing = snap.playing;
  st.tempo = snap.tempo > 0 ? snap.tempo : 120;
  const anySolo = snap.trk.some((k) => k.soloed);
  for (let i = 0; i < NTRK; i++) {
    const p = st.plants[i], k = snap.trk[i];
    if (k.engine !== p.engine) {
      p.species = speciesFor(k.engine);
      p.engine = k.engine;
      p.genome.tgt.set(seedGenome(st.seed, i, p.species).cur);
    }
    const dh = p.hitsSeen < 0 ? 0 : (k.hits - p.hitsSeen) & 0xffff;
    p.hitsSeen = k.hits;
    const vel = clamp(k.vel / 127, 0.05, 1);
    for (let n = 0; n < Math.min(dh, 4); n++) {
      pushHit(p, t + st.delay + n * 0.012, vel, k.note, hash32(st.seed ^ k.hits, i * 31 + n) & 1 ? 1 : -1);
    }
    if (dh) {
      st.lastActivity = t;
      p.budT[k.step % NSTEP] = t + st.delay;
      if (p.species.style === "pods") { const pod = k.note % PODS; p.podT[pod] = t + st.delay; p.podV[pod] = vel; }
    }
    p.lvlIn = Math.max(p.lvlIn, Math.min(k.peak * 1.8, 1.2));
    p.vol = k.vol / 127; p.pan = clamp((k.pan - 64) / 64, -1, 1); p.cut = k.cut / 127; p.res = k.res / 127;
    p.s1 = k.send1 / 127; p.s2 = k.send2 / 127; p.held = k.held; p.groove = k.groove / 99;
    p.muted = k.muted; p.soloed = k.soloed; p.soloOn = anySolo;
    p.step = k.step; p.len = clamp(k.len, 1, NSTEP); p.maskLo = k.maskLo; p.maskHi = k.maskHi;
    p.vel = vel; p.note = k.note;
  }
  if (snap.playing) st.lastActivity = t;
}

// the clock the plants are posed at: real time, except a rewind glitch runs it back and on again (net zero) and a
// stutter holds it in 8 Hz steps
function clockAt(st, t) {
  let c = t;
  const r = st.rewind;
  if (r) {
    const u = t - r.t0;
    if (u >= 2 * r.dur) st.rewind = null;
    else if (u >= 0) c = u < r.dur ? r.t0 - u : r.t0 - r.dur + 3 * (u - r.dur);
  }
  return st.fx[FX.stutter] > 0.5 ? Math.floor(c * 8) / 8 : c;
}

const windV = [0, 0, 0];
function wind(st, t, x, y, z) {
  const w = INTENSITY[st.intensity].wind * (st.reduced ? 0.5 : 1) * (0.7 + 0.5 * st.audio.bass), k = st.tempo / 120;
  windV[0] = w * (0.9 * Math.sin(t * 0.7 * k + y * 1.3 + z * 0.4) + 0.4 * Math.sin(t * 1.9 * k + x * 0.9));
  windV[1] = w * 0.25 * Math.sin(t * 1.1 * k + x);
  windV[2] = w * 0.3 * Math.cos(t * 0.8 * k + x * 0.5 + y);
  return windV;
}

// the stem's centreline at clock c: p.px (sideways) and p.py (up), in units of the plant's size, base at 0
export function stemPose(st, p, c) {
  const H = p.genome.cur[G.stemH], sc = (2 / H) * (2 / H);
  const f1 = Math.min(F1 * sc, 6), f2 = Math.min(F2 * sc, 14);
  const t1 = 1 / (Z1 * TAU * f1), t2 = 1 / (Z2 * TAU * f2);
  let a1 = 0, a2 = 0;
  for (let k = 0; k < HITS; k++) {
    const age = c - p.hT[k];
    if (age < 0 || age > 5) continue;
    const w = p.hV[k] * p.hS[k];
    a1 += ringAt(age, w * DRIVE1, f1, t1);
    a2 += ringAt(age, w * DRIVE2, f2, t2);
  }
  const tempo = st.tempo / 120, sway = (0.55 + 0.9 * Math.abs(p.groove)) * (st.reduced ? 0.5 : 1);
  const w1 = 0.035 * sway * (0.6 * Math.sin(c * 0.8 * tempo + p.i * 1.7) + 0.4 * Math.sin(c * 1.9 * tempo + p.i));
  const lean = p.groove * 0.05 + p.genome.cur[G.tilt] * 0.05 + p.pan * 0.03 + p.s[C_WILT * 2] * 0.42 * (p.i % 2 ? 1 : -1);
  const dS = H / SEG;
  let prev = 0, y = 0;
  p.px[0] = 0; p.py[0] = 0;
  for (let k = 1; k <= SEG; k++) {
    const s = k / SEG, d = (a1 * MODE[0][k] + a2 * MODE[1][k] + (w1 + lean) * s * s) * H, dx = d - prev;
    prev = d;
    y += Math.sqrt(Math.max(dS * dS - dx * dx, 0));
    p.px[k] = d; p.py[k] = y;
  }
  p.tipAng = Math.atan2(p.px[SEG] - p.px[SEG - 1], p.py[SEG] - p.py[SEG - 1]);
}

// the bloom pulse the hits make at clock c, shifted later by `delay` seconds
function pulseAt(p, c, delay) {
  let b = 0;
  for (let k = 0; k < HITS; k++) {
    const age = c - delay - p.hT[k];
    if (age < 0 || age > 1.6) continue;
    b += p.hV[k] * Math.exp(-age / 0.16) * (1 + 0.5 * Math.sin(TAU * 3 * age));
  }
  return Math.min(b, 1.6);
}

// a plant's colours: its track's ink, shifted by genome and notes, drawn toward the plant it plays with, greyed when muted
const hsvTmp = [0, 0, 0];
function plantColors(st, p) {
  const wilt = p.s[C_WILT * 2], dim = p.s[C_DIM * 2], c = p.col;
  let h = p.ink[0] + p.genome.cur[G.hue] + p.noteHue;
  if (p.partner >= 0 && p.drift > 0) {
    let dh = st.plants[p.partner].ink[0] - p.ink[0];
    dh -= Math.round(dh);
    h += dh * p.drift;
  }
  const sat = clamp(p.ink[1] * (1 - 0.82 * wilt) * (1 - 0.35 * dim), 0, 1), val = (1 - 0.55 * wilt) * (1 - 0.62 * dim);
  c.petal.set(hsv2rgb(h, sat, val, hsvTmp));
  c.inner.set(hsv2rgb(h - 0.015, sat * 0.55, Math.min(1, val * 1.05), hsvTmp));
  c.disc.set(hsv2rgb(h + 0.07, Math.min(1, sat * 0.95), val * 0.9, hsvTmp));
  c.stem.set(hsv2rgb(h + 0.25, sat * 0.9, val * 0.42, hsvTmp));
  c.leaf.set(hsv2rgb(h + 0.33, sat * 0.9, val * 0.6, hsvTmp));
}

function addRipple(st, x, z, t, amp, hue) {
  const r = st.ripples, i = r.n++ % RIPPLES;
  r.x[i] = x; r.z[i] = z; r.t0[i] = t; r.amp[i] = amp; r.hue[i] = hue;
}

function headOf(st, p) {
  const S = p.s[C_SIZE * 2];
  p.hx = p.s[C_X * 2] + st.rh[0] * p.px[SEG] * S;
  p.hy = p.py[SEG] * S;
  p.hz = p.s[C_Z * 2] + st.rh[1] * p.px[SEG] * S;
}

// a hit's effects once its sound has arrived: pollen, a ripple on the ground, a petal on hard hits, who plays with whom
function fire(st, p, k, t) {
  const ht = p.hT[k], vel = p.hV[k], q = p.pollen;
  const rng = mulberry32(hash32(st.seed ^ 0xb011, (p.i << 20) ^ (p.nFired * 7919)));
  const count = 2 + Math.floor(vel * 5);
  for (let m = 0; m < count; m++) {
    const i = q.n++ % POLLEN, a = ((p.hN[k] % 12) / 12) * Math.PI + (rng() - 0.5) * 1.4, sp = (0.7 + rng() * 1.1) * (0.5 + vel);
    q.x[i] = p.hx; q.y[i] = p.hy; q.z[i] = p.hz;
    q.vx[i] = Math.cos(a) * sp * st.rh[0]; q.vz[i] = Math.cos(a) * sp * st.rh[1] + (rng() - 0.5) * 0.8; q.vy[i] = Math.sin(a) * sp + 0.5;
    q.age[i] = 0; q.life[i] = 1.6 + rng() * 1.6; q.hue[i] = (rng() - 0.5) * 0.08;
  }
  addRipple(st, p.s[C_X * 2], p.s[C_Z * 2], t, 0.5 + vel * 0.7, p.ink[0] + p.noteHue);
  if (vel > 0.78) {
    const f = p.fall, i = f.n++ % FALLING;
    f.x[i] = p.hx; f.y[i] = p.hy; f.z[i] = p.hz; f.vx[i] = rng() - 0.5; f.vy[i] = 0.3;
    f.a[i] = 0; f.av[i] = (rng() - 0.5) * 6; f.age[i] = 0; f.landed[i] = 0;
  }
  for (const o of st.plants) {
    if (o === p || Math.abs(o.lastFireT - ht) >= 0.06) continue;
    st.co[p.i * NTRK + o.i] += 1; st.co[o.i * NTRK + p.i] += 1;
    if (st.co[p.i * NTRK + o.i] > 3.5 && st.bridges.length < BRIDGES && (hash32(st.seed ^ p.nFired, p.i * 8 + o.i) & 3) === 0) {
      st.bridges.push({ a: p.i, b: o.i, t0: t, dur: 1.1 });
    }
  }
  p.lastFireT = ht;
  p.fired++; p.barHits++;
}

function stepParticles(st, p, dt, t) {
  const q = p.pollen, k = 1.3, e = Math.exp(-k * dt), v = (1 - e) / k;
  for (let i = 0; i < POLLEN; i++) {
    if (q.age[i] >= q.life[i]) continue;
    q.age[i] += dt;
    const w = wind(st, t, q.x[i], q.y[i], q.z[i]), ax = w[0], ay = w[1] - 0.42, az = w[2];
    q.x[i] += (q.vx[i] - ax / k) * v + (ax / k) * dt; q.vx[i] = q.vx[i] * e + (ax / k) * (1 - e);
    q.y[i] += (q.vy[i] - ay / k) * v + (ay / k) * dt; q.vy[i] = q.vy[i] * e + (ay / k) * (1 - e);
    q.z[i] += (q.vz[i] - az / k) * v + (az / k) * dt; q.vz[i] = q.vz[i] * e + (az / k) * (1 - e);
    if (q.y[i] < 0.01) { q.y[i] = 0.01; q.vy[i] = 0; }
  }
  const f = p.fall, kf = 1.9, ef = Math.exp(-kf * dt), vf = (1 - ef) / kf;
  for (let i = 0; i < FALLING; i++) {
    if (f.age[i] >= 9) continue;
    f.age[i] += dt;
    if (f.landed[i] > 0) { f.landed[i] += dt; if (f.landed[i] > 1.8) f.age[i] = 9; continue; }
    const ax = 1.6 * Math.sin(f.age[i] * 4 + i * 2), ay = -1.25;
    f.x[i] += (f.vx[i] - ax / kf) * vf + (ax / kf) * dt; f.vx[i] = f.vx[i] * ef + (ax / kf) * (1 - ef);
    f.y[i] += (f.vy[i] - ay / kf) * vf + (ay / kf) * dt; f.vy[i] = f.vy[i] * ef + (ay / kf) * (1 - ef);
    f.a[i] += f.av[i] * dt;
    if (f.y[i] <= 0.02) { f.y[i] = 0.02; f.landed[i] = 0.001; addRipple(st, f.x[i], f.z[i], t, 0.45, p.ink[0]); }
  }
}

// where each plant stands: busy ones forward, quiet and muted ones back, pan leaning it aside, a solo in front and centred
function field(st, dt) {
  const solo = st.plants.findIndex((p) => p.soloed);
  for (const p of st.plants) {
    let x = st.slotX[p.i] + p.pan * 1.5, z = st.slotZ[p.i] + 2.4 * p.act - 1.0 - (p.muted ? 2.5 : 0);
    if (solo >= 0) { if (p.soloed) { x = 0; z = 2.2; } else z -= 2.4; }
    st.fieldX[p.i] = x; st.fieldZ[p.i] = z;
  }
  relax(st.fieldX, st.fieldZ, MIN_APART + 0.05, 60);
  for (const p of st.plants) {
    springCd(p.s[C_X * 2], p.s[C_X * 2 + 1], st.fieldX[p.i], 1.6, dt, sp2); p.s[C_X * 2] = sp2[0]; p.s[C_X * 2 + 1] = sp2[1];
    springCd(p.s[C_Z * 2], p.s[C_Z * 2 + 1], st.fieldZ[p.i], 1.6, dt, sp2); p.s[C_Z * 2] = sp2[0]; p.s[C_Z * 2 + 1] = sp2[1];
  }
}

// the sixteenth `tick` begins at time t; stepSec is how long a sixteenth lasts. Glitches and bars start here
function onStep(st, tick, t, stepSec) {
  const g = glitchStart(tick, st.gctx);
  if (g && (!GLITCHES[g.id].flash || st.guard.take(t))) {
    const dur = g.dur * stepSec;
    st.active.push({ id: g.id, t0: t, dur, amt: g.amt, seed: g.seed });
    if (GLITCHES[g.id].name === "rewind") st.rewind = { t0: t, dur: dur / 2 };
  }
  if ((tick & 15) === 0) onBar(st, t);
}

function onBar(st, t) {
  const cfg = INTENSITY[st.intensity], n = ++st.barCount;
  for (const p of st.plants) {
    if (p.barHits > 0) { p.grow = Math.min(24, p.grow + 1); p.quiet = 0; } else if (++p.quiet >= 16) p.grow = Math.max(0, p.grow - 1);
    p.barHits = 0;
  }
  if (n % cfg.mutateBars === 0) for (const p of st.plants) mutate(p.genome, mulberry32(hash32(st.seed ^ 0x6e7e, n * 8 + p.i)));
  const scene = st.snap ? st.snap.scene : 0, changed = st.lastScene >= 0 && scene !== st.lastScene;
  st.lastScene = scene;
  if (n % 32 === 0 || changed) st.biomeTarget = (st.biomeTarget + 1 + (hash32(st.seed, n) % (NBIOME - 1))) % NBIOME;
  for (let i = 0; i < st.fly.owner.length; i++) {
    let sum = 0;
    for (const p of st.plants) sum += p.act + p.lvl + 0.15;
    let r = unit(hash32(st.seed ^ n, i)) * sum;
    for (const p of st.plants) { r -= p.act + p.lvl + 0.15; if (r <= 0) { st.fly.owner[i] = p.i; break; } }
  }
  if (n % cfg.shotBars === 0 || st.shotCount === 0) newShot(st, t, n);
}

function newShot(st, t, phrase) {
  const solo = st.plants.findIndex((p) => p.soloed), a = st.camFrom, b = st.cam;
  a.pos.set(b.pos); a.tgt.set(b.tgt); a.fov = b.fov; a.roll = b.roll; a.focus = b.focus; a.dof = b.dof;
  st.camShot = chooseShot(st.seed, phrase, st.energy, solo);
  st.camT0 = t; st.camBlend = st.shotCount === 0 ? 1 : 0; st.camFocus = solo;
  st.shotCount++;
}

function camera(st, t, dt, busiest) {
  if (st.shotCount === 0) newShot(st, t, 0);
  if (st.rest) return;
  const speed = INTENSITY[st.intensity].camSpeed * (st.reduced ? 0.4 : 1);
  let cx = 0, cz = 0;
  for (const p of st.plants) { cx += p.s[C_X * 2]; cz += p.s[C_Z * 2]; }
  const hp = st.plants[st.camFocus >= 0 ? st.camFocus : busiest];
  st.head[0] = hp.s[C_X * 2]; st.head[1] = hp.py[SEG] * hp.s[C_SIZE * 2] * 0.92; st.head[2] = hp.s[C_Z * 2];
  const ctx = st.cctx || (st.cctx = { cx: 0, cz: 0, head: st.head, phase: st.phase });
  ctx.cx = cx / NTRK; ctx.cz = cz / NTRK;
  cameraAt(st.camShot, (t - st.camT0) * speed + 3, ctx, st.camTo);
  st.camBlend = clamp(st.camBlend + dt / (2 * 60 / Math.max(st.tempo, 30)), 0, 1);
  blendCam(st.camFrom, st.camTo, smooth(st.camBlend), st.cam);
}

// the glitches in force at time t, folded into st.fx (indexed by FX)
function glitchFx(st, t) {
  const fx = st.fx, a = st.active, scale = st.reduced ? 0.4 : 1;
  fx.fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    const g = a[i], u = (t - g.t0) / g.dur;
    if (u >= 1) { a.splice(i, 1); continue; }
    const env = Math.sin(Math.PI * clamp(u, 0, 1)) * g.amt;
    switch (GLITCHES[g.id].name) {
      case "rgbSplit": fx[FX.split] = Math.max(fx[FX.split], env * scale); break;
      case "datamosh": fx[FX.mosh] = Math.max(fx[FX.mosh], env * scale); fx[FX.block] = Math.max(fx[FX.block], env * 0.6 * scale); break;
      case "scanTear": fx[FX.tear] = Math.max(fx[FX.tear], env * scale); break;
      case "stutter": fx[FX.stutter] = Math.max(fx[FX.stutter], env); break;
      case "melt": fx[FX.melt] = Math.max(fx[FX.melt], env * scale); break;
      case "kaleido": fx[FX.kaleido] = Math.max(fx[FX.kaleido], env); break;
      case "paletteSwap": fx[FX.hue] += (0.18 + 0.5 * unit(g.seed)) * smooth(u * 4) * (1 - smooth((u - 0.8) * 5)); break;
      case "mirror": fx[FX.mirror] = Math.max(fx[FX.mirror], env); break;
      case "hueCycle": fx[FX.hue] += 0.5 * Math.sin(Math.PI * u) * Math.sin(u * 9) * g.amt; break;
      case "fisheye": fx[FX.fisheye] = Math.max(fx[FX.fisheye], env * scale); break;
      case "derez": fx[FX.derez] = Math.max(fx[FX.derez], env * scale); break;
      case "rewind": fx[FX.vhs] = Math.max(fx[FX.vhs], env * scale); break;
      default: throw new Error(`garden: glitch ${g.id} has no effect`);
    }
  }
}

function fireflies(st, dt, c) {
  const f = st.fly, k = 1 - Math.exp(-dt * 1.6);
  for (let i = 0; i < FLY; i++) {
    const p = st.plants[f.owner[i]];
    const r = (0.7 + 1.9 * unit(hash32(st.seed, 300 + i))) * (1.5 - 0.7 * Math.min(1, p.lvl));
    const a = c * (0.3 + 0.4 * unit(hash32(st.seed, 500 + i))) + i * 1.7;
    const tx = p.hx + Math.sin(a) * r, ty = p.hy + 0.2 + Math.sin(a * 1.3 + i) * r * 0.5, tz = p.hz + Math.cos(a * 0.8) * r * 0.7;
    if (!f.on) { f.p[i * 3] = tx; f.p[i * 3 + 1] = ty; f.p[i * 3 + 2] = tz; }
    f.p[i * 3] += (tx - f.p[i * 3]) * k; f.p[i * 3 + 1] += (ty - f.p[i * 3 + 1]) * k; f.p[i * 3 + 2] += (tz - f.p[i * 3 + 2]) * k;
  }
  f.on = true;
}

// move the garden on to time t (seconds, increasing): sixteenths and bars, glitches, every plant, the field, camera
export function update(st, t) {
  const dt = st.t < 0 ? 0 : clamp(t - st.t, 0, 0.25);
  st.t = t;
  if (!st.snap) return;
  st.rest = !st.playing && t - st.lastActivity > 60;

  if (st.playing) {
    const tick = st.stepTick;
    if (st.tick >= 0 && tick > st.tick && tick - st.tick <= 4) for (let k = st.tick + 1; k <= tick; k++) onStep(st, k, t, 60 / st.tempo / 4);
    st.tick = tick;
    st.idleTick = Math.floor(st.idleT / 0.25);
  } else {
    st.tick = -1;
    st.idleT += dt;
    const k = Math.floor(st.idleT / 0.25);
    for (let n = st.idleTick + 1; n <= k; n++) onStep(st, IDLE + n, t, 0.25);
    st.idleTick = k;
  }
  const c = st.clock = clockAt(st, t);

  let energy = 0, busiest = 0, best = -1;
  const f3 = 1 - Math.exp(-dt / 3), fh = 1 - Math.exp(-dt / 0.6), fg = 1 - Math.exp(-dt / 2), fr = 1 - Math.exp(-dt / 1.5);
  for (const p of st.plants) {
    p.lvl = Math.max(p.lvl * Math.exp(-dt / 0.22), p.lvlIn); p.lvlIn = 0;
    p.rate += (p.fired / Math.max(dt, 1 / 240) - p.rate) * fr; p.fired = 0;
    p.act += (Math.min(p.rate / 6, 1) - p.act) * f3;
    p.bloom = pulseAt(p, c, 0);
    energy += p.act * 0.18 + p.lvl * 0.12;
    if (p.act + p.lvl > best) { best = p.act + p.lvl; busiest = p.i; }
    const mute = p.muted ? 1 : 0, dimT = p.soloOn && !p.soloed ? 1 : 0;
    const openT = clamp((st.playing || p.act > 0.05 ? 0.3 : 0.2) + 0.55 * p.cut + 0.22 * p.bloom - 0.65 * mute - 0.1 * dimT
      + (p.species.name === "tulip" ? 0.12 * Math.sin(c * 0.9) : 0), 0.05, 1);
    const sizeT = (0.6 + 0.55 * p.vol) * (p.soloed ? 1.25 : 1) * (1 - 0.18 * mute);
    springCd(p.s[C_OPEN * 2], p.s[C_OPEN * 2 + 1], openT, 9, dt, sp2); p.s[C_OPEN * 2] = sp2[0]; p.s[C_OPEN * 2 + 1] = sp2[1];
    springCd(p.s[C_SIZE * 2], p.s[C_SIZE * 2 + 1], sizeT, 6, dt, sp2); p.s[C_SIZE * 2] = sp2[0]; p.s[C_SIZE * 2 + 1] = sp2[1];
    springCd(p.s[C_WILT * 2], p.s[C_WILT * 2 + 1], mute, 2.2, dt, sp2); p.s[C_WILT * 2] = sp2[0]; p.s[C_WILT * 2 + 1] = sp2[1];
    springCd(p.s[C_DIM * 2], p.s[C_DIM * 2 + 1], dimT, 3, dt, sp2); p.s[C_DIM * 2] = sp2[0]; p.s[C_DIM * 2 + 1] = sp2[1];
    p.noteHue += ((((p.note % 12) / 12) - 0.5) * 0.11 - p.noteHue) * fh;
    p.growS += (p.grow - p.growS) * fg;
    glideGenome(p.genome, dt);
  }
  st.energy += (clamp(energy, 0, 1) - st.energy) * fg;

  const decay = Math.exp(-dt / 20), co = st.co;
  for (let i = 0; i < co.length; i++) co[i] *= decay;
  field(st, dt);

  for (const p of st.plants) {
    plantColors(st, p);
    stemPose(st, p, c);
    headOf(st, p);
    while (p.nFired < p.nHit) {
      if (p.nHit - p.nFired > HITS) p.nFired = p.nHit - HITS;
      const k = p.nFired % HITS;
      if (p.hT[k] > t) break;
      fire(st, p, k, t);
      p.nFired++;
    }
    let partner = -1, top = 2.5;
    for (let b = 0; b < NTRK; b++) if (b !== p.i && co[p.i * NTRK + b] > top) { top = co[p.i * NTRK + b]; partner = b; }
    p.partner = partner;
    p.drift += ((partner < 0 ? 0 : Math.min(0.25, (top - 2.5) / 40)) - p.drift) * (1 - Math.exp(-dt / 4));
    stepParticles(st, p, dt, t);
  }
  for (let i = st.bridges.length - 1; i >= 0; i--) if (t - st.bridges[i].t0 > st.bridges[i].dur) st.bridges.splice(i, 1);
  fireflies(st, dt, c);

  const kb = 1 - Math.exp(-dt / (1.2 * 60 / Math.max(st.tempo, 30)));
  for (let i = 0; i < NBIOME; i++) st.bw[i] += ((i === st.biomeTarget ? 1 : 0) - st.bw[i]) * kb;
  camera(st, t, dt, busiest);
  glitchFx(st, t);
}

// ---- the view: matrices and the sprite basis (plants stand upright for a level camera, face the screen from above)
export function prepareView(st, aspect) {
  const cam = st.cam, v = st.v;
  let fx = cam.tgt[0] - cam.pos[0], fy = cam.tgt[1] - cam.pos[1], fz = cam.tgt[2] - cam.pos[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, ry = 0, rz = fx, rl = Math.hypot(rx, rz);                       // fwd x worldUp
  if (rl < 1e-6) { rx = 1; rz = 0; rl = 1; }
  rx /= rl; rz /= rl;
  let ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;   // right x fwd
  const cr = Math.cos(cam.roll), sr = Math.sin(cam.roll);
  const qx = rx * cr + ux * sr, qy = ry * cr + uy * sr, qz = rz * cr + uz * sr;
  const wx = -rx * sr + ux * cr, wy = -ry * sr + uy * cr, wz = -rz * sr + uz * cr;
  mat4LookAt(cam.pos[0], cam.pos[1], cam.pos[2], cam.tgt[0], cam.tgt[1], cam.tgt[2], wx, wy, wz, v.view);
  mat4Perspective(cam.fov, aspect, 0.1, 80, v.proj);
  mat4Mul(v.proj, v.view, v.vp);
  v.fwd[0] = fx; v.fwd[1] = fy; v.fwd[2] = fz;
  v.right[0] = qx; v.right[1] = qy; v.right[2] = qz;
  v.up[0] = wx; v.up[1] = wy; v.up[2] = wz;
  v.tanHalf = Math.tan(cam.fov / 2); v.aspect = aspect;
  const k = smooth((-fy - 0.3) / 0.6);
  let sx = wx * k, sy = 1 - k + wy * k, sz = wz * k;
  const sl = Math.hypot(sx, sy, sz);
  sx /= sl; sy /= sl; sz /= sl;
  let tx = fy * sz - fz * sy, ty = fz * sx - fx * sz, tz = fx * sy - fy * sx;      // fwd x spriteUp
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  v.sr[0] = tx; v.sr[1] = ty; v.sr[2] = tz; v.su[0] = sx; v.su[1] = sy; v.su[2] = sz;
  const hl = Math.hypot(tx, tz) || 1;
  st.rh[0] = tx / hl; st.rh[1] = tz / hl;
}

// ---- the instance buffer: 16 floats a sprite (see garden_gl.js for what each kind draws)
//   0..2 centre, 3 kind, 4..5 half size (padded by PAD), 6 rotation, 7 flags (1 flat on the ground, 2 outline only),
//   8..11 colour and alpha (alpha 0 adds light), 12..15 per-kind parameters
let F = null, N = 0, DROPPED = 0, CAP = 0;
let RX = 1, RY = 0, RZ = 0, UX = 0, UY = 1, UZ = 0, CX = 0, CY = 0, CZ = 0;

function put(kind, x, y, z, sx, sy, rot, flags, r, g, b, a, p0, p1, p2, p3) {
  if (N >= CAP) { DROPPED++; return; }
  const o = N++ * FLOATS;
  F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = kind; F[o + 4] = sx; F[o + 5] = sy; F[o + 6] = rot; F[o + 7] = flags;
  F[o + 8] = r; F[o + 9] = g; F[o + 10] = b; F[o + 11] = a; F[o + 12] = p0; F[o + 13] = p1; F[o + 14] = p2; F[o + 15] = p3;
}
// a sprite along the 3D segment a-b, as long as it looks on the screen
function seg(kind, ax, ay, az, bx, by, bz, half, flags, r, g, b, a, p0, p1, p2, p3) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const x2 = dx * RX + dy * RY + dz * RZ, y2 = dx * UX + dy * UY + dz * UZ;
  put(kind, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, half + PAD, Math.hypot(x2, y2) / 2 + PAD, Math.atan2(-x2, y2), flags, r, g, b, a, p0, p1, p2, p3);
}
// a sprite from a base along a 3D vector: its length on the screen is at least minFrac of the real length, so a petal
// pointing at the camera still shows; its base stays at the base point
function ray(kind, hx, hy, hz, vx, vy, vz, W, minFrac, flags, r, g, b, a, p0, p1, p2, p3) {
  const x2 = vx * RX + vy * RY + vz * RZ, y2 = vx * UX + vy * UY + vz * UZ, l2 = Math.hypot(x2, y2);
  const L = Math.max(l2, Math.hypot(vx, vy, vz) * minFrac), sh = (L - l2) / 2;
  const dx = l2 > 1e-5 ? x2 / l2 : 0, dy = l2 > 1e-5 ? y2 / l2 : 1;
  put(kind, hx + vx / 2 + (RX * dx + UX * dy) * sh, hy + vy / 2 + (RY * dx + UY * dy) * sh, hz + vz / 2 + (RZ * dx + UZ * dy) * sh,
    W + PAD, L / 2 + PAD, l2 > 1e-5 ? Math.atan2(-x2, y2) : 0, flags, r, g, b, a, p0, p1, p2, p3);
}
const glow = (x, y, z, rad, r, g, b, a, fall) => put(K.GLOW, x, y, z, rad + PAD, rad + PAD, 0, 0, r, g, b, a, fall, 0, 0, 0);

// the head being drawn: its position, normal and the two axes of its plane
let HX = 0, HY = 0, HZ = 0, NX = 0, NY = 1, NZ = 0, E1X = 1, E1Y = 0, E1Z = 0, E2X = 0, E2Y = 0, E2Z = 1;
function headFrame(nx, ny, nz) {
  const l = Math.hypot(nx, ny, nz) || 1;
  NX = nx / l; NY = ny / l; NZ = nz / l;
  let ax = NY * UZ - NZ * UY, ay = NZ * UX - NX * UZ, az = NX * UY - NY * UX, al = Math.hypot(ax, ay, az);
  if (al < 1e-4) { ax = RX; ay = RY; az = RZ; al = 1; }
  E1X = ax / al; E1Y = ay / al; E1Z = az / al;
  E2X = NY * E1Z - NZ * E1Y; E2Y = NZ * E1X - NX * E1Z; E2Z = NX * E1Y - NY * E1X;
}

const SV = new Float64Array(3 * 40), SK = new Float64Array(40), SS = new Float64Array(40), SP = new Float64Array(40), SI = new Int32Array(40);
const WX = new Float64Array(SEG + 1), WY = new Float64Array(SEG + 1), WZ = new Float64Array(SEG + 1);
const rgbTmp = [0, 0, 0];

// one head of petals in layers round a disc, in the plane whose normal is the head frame's: sc scales it, open is how
// far it has opened, delay (s) shifts the bloom pulse later (a ghost's echo), at most capPetals a layer
function headRing(st, p, sc, open, delay, alpha, maxLayers, capPetals, c) {
  const g = p.genome.cur, sp = p.species, cl = p.col, fw = st.v.fwd;
  const cnt = Math.min(g[G.petals], capPetals), nPet = Math.ceil(cnt - 1e-6);
  const lay = Math.min(g[G.layers], maxLayers), nLay = Math.ceil(lay - 1e-6);
  const ghost = sp.name === "ghost";
  for (let l = 0; l < nLay; l++) {
    const ls = (1 - 0.27 * l) * (0.4 + 0.6 * clamp(lay - l, 0, 1)), lr = l / Math.max(nLay, 2);
    const beta = lerp(1.35, sp.cup, open) + 0.2 * l, cb = Math.cos(beta), sb = Math.sin(beta);
    for (let i = 0; i < nPet; i++) {
      const size = i + 1 <= cnt ? 1 : cnt - i;
      const az = lerp(((i + 0.5 * l) / cnt) * TAU, i * GOLD + l * 0.9, g[G.spiral]);
      const pul = pulseAt(p, c, delay + (i / cnt) * 0.1), len = g[G.plen] * sc * ls * size * (1 + 0.22 * pul);
      const ca = Math.cos(az) * cb, sa = Math.sin(az) * cb, o = i * 3;
      SV[o] = (E1X * ca + E2X * sa + NX * sb) * len;
      SV[o + 1] = (E1Y * ca + E2Y * sa + NY * sb) * len;
      SV[o + 2] = (E1Z * ca + E2Z * sa + NZ * sb) * len;
      SK[i] = SV[o] * fw[0] + SV[o + 1] * fw[1] + SV[o + 2] * fw[2];
      SS[i] = size; SP[i] = pul; SI[i] = i;
    }
    for (let i = 1; i < nPet; i++) {                      // far petals first: they sit behind the head
      const idx = SI[i], key = SK[idx];
      let j = i - 1;
      while (j >= 0 && SK[SI[j]] < key) { SI[j + 1] = SI[j]; j--; }
      SI[j + 1] = idx;
    }
    for (let q = 0; q < nPet; q++) {
      const i = SI[q], o = i * 3, boost = 1 + 0.9 * SP[i];
      const rim = ghost ? 0.9 : 0.25 + 0.9 * p.res * (0.6 + 0.4 * Math.sin(c * 9 + i * 1.3));
      ray(K.PETAL, HX, HY, HZ, SV[o], SV[o + 1], SV[o + 2], g[G.pwid] * sc * ls * SS[i], 0.35, ghost ? 2 : 0,
        lerp(cl.petal[0], cl.inner[0], lr) * boost, lerp(cl.petal[1], cl.inner[1], lr) * boost, lerp(cl.petal[2], cl.inner[2], lr) * boost,
        alpha * (0.5 + 0.5 * SS[i]), g[G.tip], g[G.notch], g[G.curl], rim);
    }
  }
}

// a dandelion: thin rays over a sphere, each with a glowing tip
function headPuff(st, p, sc, open, delay, alpha, c) {
  const g = p.genome.cur, cl = p.col, n = Math.round(g[G.petals] * 2.2), pul = pulseAt(p, c, delay);
  const len = g[G.plen] * sc * (0.55 + 0.45 * open) * (1 + 0.2 * pul);
  for (let k = 0; k < n; k++) {
    const z = 1 - (2 * (k + 0.5)) / n, rr = Math.sqrt(1 - z * z), a = k * GOLD, ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
    const vx = (E1X * ca + E2X * sa + NX * z) * len, vy = (E1Y * ca + E2Y * sa + NY * z) * len, vz = (E1Z * ca + E2Z * sa + NZ * z) * len;
    ray(K.PETAL, HX, HY, HZ, vx, vy, vz, 0.01 * sc, 0.25, 0, cl.petal[0] * 0.8, cl.petal[1] * 0.8, cl.petal[2] * 0.8, alpha * 0.8, 1, 0, 0, 0.3);
    const rad = 0.03 * sc * (1 + pul);
    put(K.DOT, HX + vx, HY + vy, HZ + vz, rad + PAD, rad + PAD, 0, 0, cl.inner[0] * 1.8, cl.inner[1] * 1.8, cl.inner[2] * 1.8, 0, 0.5, k, 0, 0);
  }
}

// a drum kit: a cup of petals with a pod for each of its sounds, the one that plays flaring
function headPods(st, p, sc, open, delay, alpha, c) {
  headRing(st, p, sc, open, delay, alpha, 1, 12, c);
  const cl = p.col, g = p.genome.cur;
  for (let j = 0; j < PODS; j++) {
    const age = c - p.podT[j], lit = age >= 0 && age < 1.2 ? p.podV[j] * Math.exp(-age / 0.3) : 0;
    const a = j * GOLD, r = 0.42 * g[G.plen] * sc * Math.sqrt((j + 0.5) / PODS), ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    const rad = 0.07 * sc * (1 + 0.9 * lit), k = 0.5 + 1.6 * lit;
    put(K.BUD, HX + E1X * ca + E2X * sa + NX * 0.05 * sc, HY + E1Y * ca + E2Y * sa + NY * 0.05 * sc, HZ + E1Z * ca + E2Z * sa + NZ * 0.05 * sc,
      rad + PAD, rad + PAD, 0, 0, cl.disc[0] * k, cl.disc[1] * k, cl.disc[2] * k, alpha, 1, 0, lit, 0);
  }
}

// an acid line's flytrap: two lobes that snap shut on each hit, teeth along their edges that lengthen with resonance
function headTrap(st, p, sc, open, delay, alpha, c) {
  const g = p.genome.cur, cl = p.col, pul = pulseAt(p, c, delay);
  const ang = lerp(1.0, 0.08, Math.min(1, pul * 1.2)) * (0.6 + 0.4 * open), ca = Math.cos(ang), sa = Math.sin(ang);
  const L = g[G.plen] * sc, W = g[G.pwid] * sc * 1.3, nt = 3 + Math.floor(p.res * 5), tl = 0.2 * L * (0.6 + p.res);
  for (let side = -1; side <= 1; side += 2) {
    const dx = E1X * side * ca + NX * sa, dy = E1Y * side * ca + NY * sa, dz = E1Z * side * ca + NZ * sa;
    ray(K.LEAF, HX, HY, HZ, dx * L, dy * L, dz * L, W, 0.35, 0, cl.petal[0], cl.petal[1], cl.petal[2], alpha, g[G.tip], 0, 0, 0.6 + p.res);
    for (let j = 0; j < nt; j++) {
      const f = 0.22 + (0.68 * j) / Math.max(nt - 1, 1);
      for (let sd = -1; sd <= 1; sd += 2) {
        ray(K.PETAL, HX + dx * L * f + E2X * sd * W * 0.7, HY + dy * L * f + E2Y * sd * W * 0.7, HZ + dz * L * f + E2Z * sd * W * 0.7,
          E2X * sd * tl + dx * 0.05 * L, E2Y * sd * tl + dy * 0.05 * L, E2Z * sd * tl + dz * 0.05 * L, 0.016 * sc, 0.3, 0,
          cl.inner[0] * 1.4, cl.inner[1] * 1.4, cl.inner[2] * 1.4, alpha, 1, 0, 0, 0.9);
      }
    }
  }
}

function headStyle(st, p, sc, open, delay, alpha, c) {
  switch (p.species.style) {
    case "puff": headPuff(st, p, sc, open, delay, alpha, c); break;
    case "pods": headPods(st, p, sc, open, delay, alpha, c); break;
    case "trap": headTrap(st, p, sc, open, delay, alpha, c); break;
    default: headRing(st, p, sc, open, delay, alpha, 4, 40, c);
  }
}

function drawPlant(st, p, c) {
  headOf(st, p);
  const S = p.s[C_SIZE * 2], bx = p.s[C_X * 2], bz = p.s[C_Z * 2], cl = p.col, g = p.genome.cur, sp = p.species;
  const rx = st.rh[0], rz = st.rh[1], open = clamp(p.s[C_OPEN * 2], 0, 1), wilt = p.s[C_WILT * 2], lvl = Math.min(p.lvl, 1.2);
  const stepSec = 60 / st.tempo / 4;
  HX = p.hx; HY = p.hy; HZ = p.hz;
  for (let k = 0; k <= SEG; k++) { WX[k] = bx + rx * p.px[k] * S; WY[k] = p.py[k] * S; WZ[k] = bz + rz * p.px[k] * S; }

  if (p.s1 > 0.03) {
    const k = 0.1 * p.s1 * (0.6 + lvl);
    glow(bx, p.hy * 0.55, bz, (1 + 2 * p.s1) * S, cl.petal[0] * k, cl.petal[1] * k, cl.petal[2] * k, 0, 1.6);
  }

  // the stem, with a light running up it from each hit and a steady one for notes held
  const last = p.nHit > 0 ? (p.nHit - 1) % HITS : -1, age = last >= 0 ? c - p.hT[last] : -1;
  const wave = age >= 0 ? clamp(age / 0.45, 0, 1.3) : 9, str = age >= 0 ? p.hV[last] * (1 - clamp(age / 0.6, 0, 1)) : 0;
  const heldGlow = 0.12 * Math.min(p.held, 3) / 3;
  for (let k = 0; k < SEG; k++) {
    const s0 = k / SEG, sm = (k + 0.5) / SEG, r0 = S * (0.055 - 0.03 * s0), r1 = S * (0.055 - 0.03 * (s0 + 1 / SEG));
    const gl = str * Math.exp(-(((sm - wave) / 0.16) ** 2)) + heldGlow * (0.6 + 0.4 * Math.sin(c * 6 - sm * 5));
    seg(K.CAPSULE, WX[k], WY[k], WZ[k], WX[k + 1], WY[k + 1], WZ[k + 1], r0, 0, cl.stem[0], cl.stem[1], cl.stem[2], 1, r0, r1, gl, 0);
  }

  // leaves, alternating sides up the stem
  const nLeaf = g[G.leaves], nL = Math.ceil(nLeaf - 1e-6);
  for (let i = 0; i < nL; i++) {
    const f = i + 1 <= nLeaf ? 1 : nLeaf - i, s = 0.18 + (0.6 * (i + 0.5)) / nL, k = Math.min(SEG - 1, Math.floor(s * SEG)), u = s * SEG - k;
    const side = i % 2 ? 1 : -1, len = g[G.leafSz] * S * f * (1.2 - 0.4 * s);
    const a = 0.95 + 0.15 * Math.sin(c * 1.7 + i * 2) + wilt * 0.8 + 0.6 * (p.px[Math.min(SEG, k + 1)] - p.px[k]) * side;
    const lx = side * Math.sin(a) * len, ly = Math.cos(a) * len;
    ray(K.LEAF, lerp(WX[k], WX[k + 1], u), lerp(WY[k], WY[k + 1], u), lerp(WZ[k], WZ[k + 1], u),
      RX * lx + UX * ly, RY * lx + UY * ly, RZ * lx + UZ * ly, 0.34 * len, 0.5, 0, cl.leaf[0], cl.leaf[1], cl.leaf[2], 1, 0.7, 0, side * 0.25, 0.2);
  }

  // the facing of the head: along the stem's end, nodding toward the camera
  const ta = p.tipAng, tcx = CX - bx, tcz = CZ - bz, tcl = Math.hypot(tcx, tcz) || 1, nod = (0.8 + g[G.tilt] * 0.6) * 0.9;
  const hnx = rx * Math.sin(ta) + (tcx / tcl) * nod, hny = Math.cos(ta), hnz = rz * Math.sin(ta) + (tcz / tcl) * nod;

  // side shoots, one for every 8 busy bars, up to three, each with a small flower that follows the big one's beat
  for (let j = 0; j < 3; j++) {
    const a = clamp(p.growS / 8 - j, 0, 1);
    if (a < 0.03) continue;
    const s = 0.4 + 0.15 * j, k = Math.min(SEG - 1, Math.floor(s * SEG)), u = s * SEG - k, side = hash32(st.seed, p.i * 8 + j) & 1 ? 1 : -1;
    const ox = lerp(WX[k], WX[k + 1], u), oy = lerp(WY[k], WY[k + 1], u), oz = lerp(WZ[k], WZ[k + 1], u);
    const dxs = RX * side * 0.5 * S * a + UX * 0.55 * S * a, dys = RY * side * 0.5 * S * a + UY * 0.55 * S * a, dzs = RZ * side * 0.5 * S * a + UZ * 0.55 * S * a;
    const mx = ox + RX * side * 0.42 * S * a, my = oy + RY * side * 0.42 * S * a + 0.2 * S * a, mz = oz + RZ * side * 0.42 * S * a;
    let ax = ox, ay = oy, az = oz;
    for (let m = 1; m <= 3; m++) {
      const t = m / 3, w = 1 - t, qx = w * w * ox + 2 * w * t * mx + t * t * (ox + dxs), qy = w * w * oy + 2 * w * t * my + t * t * (oy + dys),
        qz = w * w * oz + 2 * w * t * mz + t * t * (oz + dzs);
      seg(K.CAPSULE, ax, ay, az, qx, qy, qz, 0.022 * S, 0, cl.stem[0], cl.stem[1], cl.stem[2], 1, 0.022 * S, 0.018 * S, 0, 0);
      ax = qx; ay = qy; az = qz;
    }
    HX = ax; HY = ay; HZ = az;
    headFrame(hnx * 0.6 + RX * side * 0.3, hny, hnz * 0.6 + RZ * side * 0.3);
    headRing(st, p, 0.42 * S * a, open, 0.08 * (j + 1), a, 1, 10, c);
    put(K.DISC, HX, HY, HZ, g[G.disc] * 0.42 * S * a + PAD, g[G.disc] * 0.42 * S * a * 0.7 + PAD, 0, 0, cl.disc[0], cl.disc[1], cl.disc[2], a, 40, 0, 0, 0);
  }

  HX = p.hx; HY = p.hy; HZ = p.hz;
  headFrame(hnx, hny, hnz);

  // the delay send's echoes: faint copies of the head that bloom a few sixteenths late
  const ghosts = Math.floor(p.s2 * 4);
  for (let m = ghosts; m >= 1; m--) {
    HX = p.hx + (RX * 0.45 + UX * 0.14) * m * S * 0.55 * (m % 2 ? 1 : -1);
    HY = p.hy + (RY * 0.45 + UY * 0.14) * m * S * 0.55;
    HZ = p.hz + (RZ * 0.45 + UZ * 0.14) * m * S * 0.55 * (m % 2 ? 1 : -1);
    headRing(st, p, S * (1 - 0.12 * m), open, m * 3 * stepSec, 0.28 * p.s2 / m, 1, 24, c);
  }
  HX = p.hx; HY = p.hy; HZ = p.hz;

  // halo: size and glow follow the track's level
  const hk = (0.12 + 0.45 * lvl) * g[G.glow];
  glow(HX, HY, HZ, g[G.plen] * S * (1.2 + 0.9 * lvl), cl.petal[0] * hk, cl.petal[1] * hk, cl.petal[2] * hk, 0, 2.2);

  headStyle(st, p, S, open, 0, 1, c);

  if (sp.style === "ring") {
    const n2x = NX * RX + NY * RY + NZ * RZ, n2y = NX * UX + NY * UY + NZ * UZ, l2 = Math.hypot(n2x, n2y);
    const ratio = Math.max(0.2, Math.abs(NX * st.v.fwd[0] + NY * st.v.fwd[1] + NZ * st.v.fwd[2])), rad = g[G.disc] * S, pul = p.bloom;
    put(K.DISC, HX, HY, HZ, rad + PAD, rad * ratio + PAD, l2 > 1e-5 ? Math.atan2(-n2x, n2y) : 0, 0,
      cl.disc[0] * (1 + 0.8 * pul), cl.disc[1] * (1 + 0.8 * pul), cl.disc[2] * (1 + 0.8 * pul), 1, 60, pul, 0, 0);
  }

  // the pattern: one bud for each step, round the head in a golden-angle spiral; filled where the step has notes,
  // lit where the playhead is, flaring when the step has just played
  const len = p.len, r0 = g[G.plen] * S * 1.12 + 0.08 * S, r1 = r0 + 0.5 * S;
  for (let k = 0; k < len; k++) {
    const a = k * GOLD + c * 0.05, r = r0 + (r1 - r0) * Math.sqrt((k + 0.5) / len), ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    const ba = c - p.budT[k], bloom = ba >= 0 && ba < 1.5 ? Math.exp(-ba / 0.35) : 0, filled = stepOn(p, k) ? 1 : 0;
    const lit = st.playing && p.step === k ? 1 : 0, rad = 0.04 * S * (1 + 0.8 * bloom + 0.5 * lit), boost = 1 + 1.2 * bloom + 0.9 * lit;
    put(K.BUD, HX + E1X * ca + E2X * sa, HY + E1Y * ca + E2Y * sa, HZ + E1Z * ca + E2Z * sa, rad + PAD, rad + PAD, 0, 0,
      cl.petal[0] * boost, cl.petal[1] * boost, cl.petal[2] * boost, 1, filled, lit, bloom, 0);
  }

  const q = p.pollen;
  for (let i = 0; i < POLLEN; i++) {
    if (q.age[i] >= q.life[i]) continue;
    const u = q.age[i] / q.life[i], fade = (1 - u) ** 1.5 * (0.6 + 0.4 * Math.sin(c * 25 + i * 3));
    hsv2rgb(p.ink[0] + g[G.hue] + q.hue[i], 0.55, 1, rgbTmp);
    put(K.DOT, q.x[i], q.y[i], q.z[i], 0.04 + PAD, 0.04 + PAD, 0, 0, rgbTmp[0] * 1.8 * fade, rgbTmp[1] * 1.8 * fade, rgbTmp[2] * 1.8 * fade, 0, 0.6, i, 0, 0);
  }
  const f = p.fall;
  for (let i = 0; i < FALLING; i++) {
    if (f.age[i] >= 9) continue;
    const fade = f.landed[i] > 0 ? clamp(1 - (f.landed[i] - 1.1) / 0.7, 0, 1) : 1, len2 = g[G.plen] * S * 0.45, flat = f.landed[i] > 0;
    const ph = sp.style === "puff";
    put(K.PETAL, f.x[i], f.y[i], f.z[i], (ph ? 0.01 : g[G.pwid]) * S + PAD, len2 * (ph ? 0.5 : 1) / 2 + PAD, f.a[i], flat ? 1 : 0,
      cl.petal[0], cl.petal[1], cl.petal[2], fade, g[G.tip], g[G.notch], g[G.curl], 0.3);
  }
}

function drawGrassRow(st, r, c) {
  const gr = st.grass, a = gr.rows[r], b = gr.rows[r + 1], bass = st.audio.bass, w = INTENSITY[st.intensity].wind, pond = st.bw[0];
  let hx = 0, hz = 0;
  for (let i = 0; i < NBIOME; i++) { hx += st.bw[i] * Math.cos(BIOME_HUE[i] * TAU); hz += st.bw[i] * Math.sin(BIOME_HUE[i] * TAU); }
  const hue = Math.atan2(hz, hx) / TAU;
  for (let i = a; i < b; i++) {
    if (gr.k[i] < pond * 0.85) continue;
    const x = gr.x[i], z = gr.z[i], h = gr.h[i] * (1 + 0.3 * bass * (0.5 + 0.5 * Math.sin(c * 3 + x))), rr = gr.r[i];
    const sway = Math.sin(c * (0.9 + 0.5 * rr) + x * 0.6 + z * 0.35) * (0.1 + 0.1 * bass) * w;
    hsv2rgb(hue + (rr - 0.5) * 0.12, 0.8, 0.2 + 0.25 * gr.k[i], rgbTmp);
    put(K.GRASS, x, h / 2, z, 0.018 + PAD, h / 2 + PAD, sway, 0, rgbTmp[0], rgbTmp[1], rgbTmp[2], 1, sway * 1.5, 0, 0, 0);
  }
}

function drawFx(st, c) {
  const f = st.fly;
  for (let i = 0; i < FLY; i++) {
    const p = st.plants[f.owner[i]], tw = 0.5 + 0.5 * Math.sin(c * 3 + i * 2.1), k = 2.2 * (0.4 + 0.6 * tw) * (1 - 0.5 * p.s[C_WILT * 2]);
    put(K.DOT, f.p[i * 3], f.p[i * 3 + 1], f.p[i * 3 + 2], 0.05 + PAD, 0.05 + PAD, 0, 0, p.col.petal[0] * k, p.col.petal[1] * k, p.col.petal[2] * k, 0, 0.5, i, 0, 0);
  }
  for (const br of st.bridges) {
    const A = st.plants[br.a], B = st.plants[br.b], gg = A.genome.cur[G.hue];
    hsv2rgb(A.ink[0] + gg, 0.7, 1, rgbTmp);
    for (let m = 0; m < 6; m++) {
      const u = clamp((st.t - br.t0) / br.dur - m * 0.06, 0, 1);
      if (u <= 0 || u >= 1) continue;
      put(K.DOT, lerp(A.hx, B.hx, u), lerp(A.hy, B.hy, u) + Math.sin(Math.PI * u) * 0.7, lerp(A.hz, B.hz, u), 0.05 + PAD, 0.05 + PAD, 0, 0,
        rgbTmp[0] * 2.4, rgbTmp[1] * 2.4, rgbTmp[2] * 2.4, 0, 0.5, m, 0, 0);
    }
  }
}

// every sprite of the frame into f32, far to near; returns how many. Call prepareView first
export function buildInstances(st, buf) {
  F = buf; N = 0; DROPPED = 0; CAP = Math.min(MAX_INSTANCES, Math.floor(buf.length / FLOATS));
  const v = st.v, c = st.clock, ck = st.ck;
  RX = v.sr[0]; RY = v.sr[1]; RZ = v.sr[2]; UX = v.su[0]; UY = v.su[1]; UZ = v.su[2];
  CX = st.cam.pos[0]; CY = st.cam.pos[1]; CZ = st.cam.pos[2];
  let n = 0;
  for (const p of st.plants) {
    ck.depth[n] = (p.s[C_X * 2] - CX) * v.fwd[0] - CY * v.fwd[1] + (p.s[C_Z * 2] - CZ) * v.fwd[2]; ck.kind[n] = 0; ck.idx[n] = p.i; n++;
  }
  for (let r = 0; r < GRASS_ROWS; r++) {
    ck.depth[n] = -CX * v.fwd[0] - CY * v.fwd[1] + (st.grass.rowZ[r] - CZ) * v.fwd[2]; ck.kind[n] = 1; ck.idx[n] = r; n++;
  }
  for (let i = 1; i < n; i++) {                           // far to near
    const d = ck.depth[i], kd = ck.kind[i], ix = ck.idx[i];
    let j = i - 1;
    while (j >= 0 && ck.depth[j] < d) { ck.depth[j + 1] = ck.depth[j]; ck.kind[j + 1] = ck.kind[j]; ck.idx[j + 1] = ck.idx[j]; j--; }
    ck.depth[j + 1] = d; ck.kind[j + 1] = kd; ck.idx[j + 1] = ix;
  }
  for (let i = 0; i < n; i++) {
    if (ck.kind[i] === 0) drawPlant(st, st.plants[ck.idx[i]], c);
    else drawGrassRow(st, ck.idx[i], c);
  }
  drawFx(st, c);
  st.instances = N; st.dropped = DROPPED;
  return N;
}

// ---- what the shaders read each frame
function makeUniforms() {
  return {
    uViewProj: new Float32Array(16), uCamPos: new Float32Array(3), uCamFwd: new Float32Array(3), uCamRight: new Float32Array(3),
    uCamUp: new Float32Array(3), uSpriteR: new Float32Array(3), uSpriteU: new Float32Array(3),
    uTanHalf: 0.5, uAspect: 1, uTime: 0, uBeat: 0, uPhase: 0, uBass: 0, uMid: 0, uHigh: 0, uEnergy: 0,
    uBiome: new Float32Array(NBIOME), uFx: new Float32Array(12), uFocus: 8, uDof: 0,
    uRip: new Float32Array(RIPPLES * 4), uRipCol: new Float32Array(RIPPLES * 3),
    uPool: new Float32Array(NTRK * 4), uPoolCol: new Float32Array(NTRK * 3),
    uTrail: 0.93, uBloom: 1, uExposure: 1, uHue: 0, uPad: PAD,
  };
}

export function frameUniforms(st) {
  const u = st.u, v = st.v, cam = st.cam, cfg = INTENSITY[st.intensity];
  u.uViewProj.set(v.vp);
  u.uCamPos.set(cam.pos); u.uCamFwd.set(v.fwd); u.uCamRight.set(v.right); u.uCamUp.set(v.up); u.uSpriteR.set(v.sr); u.uSpriteU.set(v.su);
  u.uTanHalf = v.tanHalf; u.uAspect = v.aspect; u.uTime = st.clock;
  const stepSec = st.playing ? 60 / st.tempo / 4 : 0.25;
  const into = st.playing ? clamp((st.t - st.tTick) / stepSec, 0, 1) : (st.idleT / 0.25) % 1;
  u.uPhase = (((st.playing ? st.stepTick : st.idleTick) & 15) + into) / 16;
  u.uBeat = (u.uPhase * 4) % 1;
  u.uBass = st.audio.bass; u.uMid = st.audio.mid; u.uHigh = st.audio.high; u.uEnergy = st.energy;
  u.uBiome.set(st.bw); u.uFx.set(st.fx);
  u.uFocus = cam.focus; u.uDof = cam.dof;
  const r = st.ripples;
  for (let i = 0; i < RIPPLES; i++) {
    const age = st.t - r.t0[i], live = age >= 0 && age < 3.5;
    u.uRip[i * 4] = r.x[i]; u.uRip[i * 4 + 1] = r.z[i]; u.uRip[i * 4 + 2] = age; u.uRip[i * 4 + 3] = live ? r.amp[i] : 0;
    hsv2rgb(r.hue[i], 0.75, 1, rgbTmp);
    u.uRipCol[i * 3] = rgbTmp[0]; u.uRipCol[i * 3 + 1] = rgbTmp[1]; u.uRipCol[i * 3 + 2] = rgbTmp[2];
  }
  for (const p of st.plants) {
    const o = p.i * 4, wilt = p.s[C_WILT * 2], k = (0.35 + 0.9 * Math.min(p.lvl, 1.2)) * (1 - 0.7 * wilt);
    u.uPool[o] = p.s[C_X * 2]; u.uPool[o + 1] = p.s[C_Z * 2]; u.uPool[o + 2] = (0.9 + 1.4 * Math.min(p.lvl, 1.2)) * p.s[C_SIZE * 2]; u.uPool[o + 3] = k;
    u.uPoolCol[p.i * 3] = p.col.petal[0]; u.uPoolCol[p.i * 3 + 1] = p.col.petal[1]; u.uPoolCol[p.i * 3 + 2] = p.col.petal[2];
  }
  u.uTrail = cfg.trail; u.uBloom = cfg.bloom; u.uExposure = 1; u.uHue = st.fx[FX.hue];
  return u;
}
