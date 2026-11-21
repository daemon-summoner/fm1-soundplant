// SPDX-License-Identifier: MPL-2.0
// The Night Garden's renderer: WebGL2, no libraries. One frame is
//   sky and ground (one of five night biomes, crossfaded)  ->  the plants, one instanced draw of SDF sprites, drawn a
//   second time mirrored where the ground is water  ->  feedback trails (and the datamosh / melt glitches)  ->  bloom
//   (dual Kawase)  ->  composite (screen-space glitches, hue, tone map, flash limiter, vignette, grain).
// Everything between the passes is half-float, so the track inks run past 1.0 into the bloom instead of washing out.
// garden_core.js decides what is on the screen; this file only paints it. It throws when WebGL2 or float render
// targets are missing, so the page can say so.
import { FLOATS, MAX_INSTANCES } from "./garden_core.js";

const FULL_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

const NOISE = `
const float PI = 3.14159265, TAU = 6.2831853;
float h11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float h31(vec3 q) { q = fract(q * .1031); q += dot(q, q.zyx + 31.32); return fract((q.x + q.y) * q.z); }
vec3 h33(vec3 q) { q = fract(q * vec3(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.1, 9.7); a *= .5; }
  return s;
}`;

// ---- sky and ground
const BG_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec3 uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uTanHalf, uAspect, uTime, uBeat, uPhase, uBass, uMid, uHigh, uEnergy;
uniform float uBiome[5];
uniform vec4 uRip[24];
uniform vec3 uRipCol[24];
uniform vec4 uPool[8];
uniform vec3 uPoolCol[8];
${NOISE}

vec3 stars(vec3 d, float dens, float tw) {
  vec3 col = vec3(0.);
  for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 48. : 96.;
    vec3 q = d * sc, c = floor(q), f = fract(q) - .5;
    float h = h31(c + float(l) * 13.);
    if (h > 1. - dens * (l == 0 ? 1. : 1.6)) {
      vec3 off = (h33(c + 7.) - .5) * .6;
      float b = smoothstep(.11, 0., length(f - off)) * (.5 + 1.6 * h31(c + 3.));
      b *= .65 + .35 * sin(uTime * (2. + h * 5.) + h * 40.) * tw;
      col += mix(vec3(.7, .8, 1.), vec3(1., .8, .6), h31(c + 9.)) * b;
    }
  }
  return col;
}
vec3 moon(vec3 d, vec3 m) {
  float c = dot(d, m);
  return vec3(.85, .92, 1.) * (smoothstep(.9993, .9997, c) * 1.8 + pow(max(c, 0.), 180.) * .5 + pow(max(c, 0.), 14.) * .07);
}
vec3 aurora(vec3 d) {
  float e = d.y;
  if (e <= .01) return vec3(0.);
  float a = atan(d.x, -d.z);
  vec2 cs = vec2(cos(a), sin(a));
  vec3 sum = vec3(0.);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float warp = fbm(cs * 2. + vec2(fi * 5., uTime * .05)) * 3.;
    float rib = sin(a * (2. + fi) + warp * (2. + fi * .7) + uTime * (.12 + .05 * fi));
    float curtain = exp(-rib * rib * (3. + fi));
    float rays = .55 + .45 * vn(vec2(a * 45. + fi * 9., e * 2. - uTime * .25));
    float vert = smoothstep(0., .22, e) * exp(-e * (1.6 + fi * .5));
    vec3 hc = mix(vec3(.1, 1., .45), mix(vec3(.1, .7, 1.), vec3(.9, .25, 1.), smoothstep(.25, .7, e)), smoothstep(.05, .35, e));
    sum += hc * curtain * rays * vert * (.9 - .2 * fi);
  }
  return sum;
}

vec3 skyPond(vec3 d) {
  float y = max(d.y, 0.);
  vec3 c = mix(vec3(.03, .05, .17), vec3(.003, .006, .035), pow(y, .35));
  return c + stars(d, .03, 1.) * (.5 + uHigh) + moon(d, normalize(vec3(-.35, .5, -.8)));
}
vec3 skyForest(vec3 d) {
  float y = max(d.y, 0.);
  vec3 c = mix(vec3(.01, .09, .1), vec3(.002, .012, .03), pow(y, .45));
  c += vec3(.02, .1, .09) * fbm(vec2(atan(d.z, d.x) * 2., d.y * 4. + uTime * .02)) * (1. - y);
  return c + stars(d, .018, 1.) * (.4 + uHigh);
}
vec3 skyAurora(vec3 d) {
  float y = max(d.y, 0.);
  vec3 c = mix(vec3(.01, .03, .08), vec3(.002, .005, .02), pow(y, .5));
  return c + stars(d, .035, 1.) * .8 + aurora(d) * (.3 + 1.5 * uMid);
}
vec3 skyNebula(vec3 d) {
  vec3 q = d * 1.8;
  float n1 = fbm(q.xy * 1.5 + vec2(q.z * 2.3, uTime * .02));
  float n2 = fbm(q.yz * 2. + n1 * 2. + 4.7 + uTime * .015);
  vec3 c = mix(vec3(.02, 0., .08), vec3(.7, .05, .55), smoothstep(.35, .85, n1));
  c += vec3(0., .5, .8) * pow(smoothstep(.45, .9, n2), 2.) * .6;
  c *= .35 + .5 * uEnergy + .4 * uBass;
  return c + stars(d, .05, 1.) * (.6 + uHigh);
}
vec3 skyRain(vec3 d) {
  float y = max(d.y, 0.);
  vec3 c = mix(vec3(.28, .04, .22), vec3(.01, .005, .03), pow(y, .35));
  c += vec3(.9, .15, .5) * exp(-y * 14.) * (.35 + .2 * uBass);
  c += vec3(.1, .7, 1.) * exp(-pow(abs(y - .12) * 9., 2.)) * .12;
  c += vec3(.8, .2, .7) * fbm(d.xz / (y + .35) * 1.5 + uTime * .03) * .08;
  return c;
}
vec3 skyOf(int i, vec3 d) {
  if (i == 0) return skyPond(d);
  if (i == 1) return skyForest(d);
  if (i == 2) return skyAurora(d);
  if (i == 3) return skyNebula(d);
  return skyRain(d);
}
vec3 horizonOf(int i) {
  if (i == 0) return vec3(.04, .06, .16);
  if (i == 1) return vec3(.01, .08, .08);
  if (i == 2) return vec3(.02, .04, .1);
  if (i == 3) return vec3(.05, .01, .1);
  return vec3(.28, .04, .22);
}

vec3 ripples(vec2 p, out vec2 grad) {
  vec3 light = vec3(0.);
  grad = vec2(0.);
  for (int i = 0; i < 24; i++) {
    vec4 r = uRip[i];
    if (r.w <= 0.) continue;
    vec2 dd = p - r.xy;
    float dist = length(dd) + 1e-4;
    float x = dist - r.z * 1.7;
    float env = exp(-x * x * 6.) * r.w / (1. + dist * .6) * exp(-r.z * .8);
    float wv = sin(x * 14.);
    grad += dd / dist * env * wv * .5;
    light += uRipCol[i] * env * (.35 + .65 * max(wv, 0.));
  }
  return light;
}
vec3 waterOf(vec3 p, vec3 d, int biome, float k) {
  vec2 grad;
  vec3 rl = ripples(p.xz, grad);
  vec2 w = vec2(vn(p.xz * 1.3 + uTime * .1), vn(p.xz * 1.3 + 9. + uTime * .12)) - .5;
  vec3 n = normalize(vec3(grad.x * 2.5 + w.x * .08, 1., grad.y * 2.5 + w.y * .08));
  vec3 rd = reflect(d, n);
  rd.y = abs(rd.y);
  float fres = .06 + .94 * pow(1. - clamp(-dot(d, n), 0., 1.), 5.);
  vec3 deep = vec3(.004, .02, .05);
  return deep * (1. - fres) + skyOf(biome, rd) * (.2 + .8 * fres) * k + rl;
}
vec3 groundForest(vec3 p) {
  vec2 g = p.xz;
  float moss = fbm(g * .8) * .5 + fbm(g * 3.) * .25;
  vec3 base = mix(vec3(.01, .04, .03), vec3(.03, .12, .07), moss);
  vec2 cell = floor(g * 1.6), f = fract(g * 1.6) - .5;
  float hh = h21(cell);
  vec3 glowc = vec3(0.);
  if (hh > .55) {
    vec2 oc = (h22(cell + 3.) - .5) * .5;
    float dd = dot(f - oc, f - oc);
    float pulse = .45 + .55 * pow(.5 + .5 * sin(uTime * 2. + hh * 30. + uBeat * TAU), 3.) + uHigh;
    vec3 hc = mix(vec3(.1, 1., .8), vec3(1., .2, .9), fract(hh * 7.));
    glowc = hc * (exp(-dd * 90.) * 1.8 + exp(-dd * 14.) * .25) * pulse;
  }
  return base + glowc + vec3(.02, .12, .12) * fbm(g * .25 + uTime * .04) * .6;
}
// frost or stardust on the ground: round points on a jittered grid that thin out with distance, so far ground never aliases
float sparkle(vec3 p) {
  vec2 g = p.xz * 5., id = floor(g), f = fract(g) - .5;
  float on = step(.9, h21(id));
  float r = length(f - (h22(id + 5.) - .5) * .5);
  return on * smoothstep(.2, .02, r) * exp(-length(p - uCamPos) * .09) * (.6 + .4 * sin(uTime * 2. + h21(id + 1.) * 30.));
}
vec3 groundAurora(vec3 p, vec3 d) {
  vec3 rd = normalize(vec3(d.x, -d.y * .8, d.z));
  vec3 base = vec3(.04, .06, .11) * (.6 + .4 * fbm(p.xz * .5));
  return base + skyAurora(rd) * .35 + vec3(.6, .8, 1.) * sparkle(p) * (1. + 3. * uHigh) * .8;
}
vec3 groundNebula(vec3 p, vec3 d) {
  vec3 rd = normalize(vec3(d.x, -d.y, d.z));
  return vec3(.01, .005, .03) + skyNebula(rd) * .4 + vec3(.8, .6, 1.) * sparkle(p) * (1. + 4. * uHigh);
}
vec3 groundRain(vec3 p, vec3 d, float t) {
  vec2 g = p.xz;
  vec2 cell = floor(g);
  vec2 e = abs(fract(g) - .5);
  float ln = max(smoothstep(.47, .5, e.x), smoothstep(.47, .5, e.y));
  vec3 lc = mod(cell.x + cell.y, 2.) < 1. ? vec3(1., .1, .6) : vec3(.1, .8, 1.);
  float pulse = pow(.5 + .5 * cos(length(g) * .6 - uPhase * TAU * 4.), 6.);
  float fade = exp(-t * .05);
  float puddle = smoothstep(.45, .6, fbm(g * .35));
  vec3 rd = normalize(vec3(d.x, -d.y, d.z));
  vec3 grid = lc * ln * (.25 + 1.2 * pulse + .5 * uBass) * fade;
  return vec3(.01, .01, .02) + skyRain(rd) * .6 * puddle + grid * (1. - .5 * puddle);
}
vec3 groundOf(int i, vec3 p, vec3 d, float t) {
  vec3 c;
  if (i == 0) c = waterOf(p, d, 0, 1.);
  else if (i == 1) c = groundForest(p);
  else if (i == 2) c = groundAurora(p, d);
  else if (i == 3) c = groundNebula(p, d);
  else c = groundRain(p, d, t);
  return mix(c, horizonOf(i), 1. - exp(-t * .03));
}
vec3 rainStreaks(vec2 uv) {
  float col = floor(uv.x * uAspect * 70.);
  float speed = 1.2 + h11(col) * 1.5;
  float on = step(.65, h11(col * 3.1));
  float y = fract(uv.y * 1.5 + uTime * speed + h11(col * 7.) + uv.x * .1);
  float s = smoothstep(0., .02, y) * smoothstep(.12, 0., y);
  return vec3(.5, .6, 1.) * s * on * .35;
}

void main() {
  vec2 ndc = vUv * 2. - 1.;
  vec3 d = normalize(uCamFwd + uCamRight * (ndc.x * uTanHalf * uAspect) + uCamUp * (ndc.y * uTanHalf));
  bool ground = d.y < -.0005;
  float t = 0.;
  vec3 p = vec3(0.);
  if (ground) { t = -uCamPos.y / d.y; p = uCamPos + d * t; }
  vec3 col = vec3(0.);
  for (int i = 0; i < 5; i++) {
    float w = uBiome[i];
    if (w < .002) continue;
    col += (ground ? groundOf(i, p, d, t) : skyOf(i, d)) * w;
  }
  if (ground) {
    for (int i = 0; i < 8; i++) {
      vec4 q = uPool[i];
      vec2 dd = p.xz - q.xy;
      col += uPoolCol[i] * q.w * exp(-dot(dd, dd) / max(q.z * q.z, 1e-3)) * .55;
    }
  }
  col += rainStreaks(vUv) * uBiome[4];
  o = vec4(col, 1.);
}`;

// ---- the plants: one instanced quad per sprite, shaded by its kind
const SPRITE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a0;   // centre, kind
layout(location = 1) in vec4 a1;   // half size, rotation, flags
layout(location = 2) in vec4 a2;   // colour, alpha
layout(location = 3) in vec4 a3;   // per-kind parameters
uniform mat4 uViewProj;
uniform vec3 uSpriteR, uSpriteU, uCamPos;
uniform float uFlip, uPad, uTime;
out vec2 vQ;
flat out vec2 vHalf;
flat out float vKind;
flat out float vFlags;
flat out vec4 vCol;
flat out vec4 vP;
flat out float vDist;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2. - 1.;
  float flags = a1.w;
  bool flat1 = mod(flags, 2.) > .5;
  if (uFlip > .5 && flat1) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec2 q = c * a1.xy;
  float cs = cos(a1.z), sn = sin(a1.z);
  vec2 qr = vec2(cs * q.x - sn * q.y, sn * q.x + cs * q.y);
  vec3 pos = flat1 ? a0.xyz + vec3(qr.x, 0., qr.y) : a0.xyz + uSpriteR * qr.x + uSpriteU * qr.y;
  vec3 ctr = a0.xyz;
  if (uFlip > .5) {
    pos.y = -pos.y;
    ctr.y = -ctr.y;
    pos.x += sin(pos.z * 2.3 + uTime * 1.7 + pos.y * 5.) * .035;
  }
  gl_Position = uViewProj * vec4(pos, 1.);
  vQ = q;
  vHalf = a1.xy - uPad;
  vKind = a0.w;
  vFlags = flags;
  vCol = a2;
  vP = a3;
  vDist = distance(ctr, uCamPos);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vQ;
flat in vec2 vHalf;
flat in float vKind;
flat in float vFlags;
flat in vec4 vCol;
flat in vec4 vP;
flat in float vDist;
uniform float uFocus, uDof, uAlphaMul, uTime;
uniform vec3 uFog;
out vec4 o;
float cover(float d, float aa) { return 1. - smoothstep(-aa, aa, d); }
void main() {
  int k = int(vKind + .5);
  float blur = uDof * clamp(abs(vDist - uFocus) / max(uFocus, 1.), 0., 1.) * .07;
  float aa = .004 + blur;
  float damp = 1. / (1. + blur * 14.);
  vec3 c = vCol.rgb;
  float a = 0.;
  bool add = false;
  vec2 hh = max(vHalf, vec2(1e-4));
  if (k == 0) {                                   // stem: a tapered capsule that glows where a hit has run up it
    float t = clamp((vQ.y + hh.y) / (2. * hh.y), 0., 1.);
    float rad = mix(vP.x, vP.y, t);
    float dist = length(vec2(vQ.x, vQ.y - clamp(vQ.y, -hh.y, hh.y))) - rad;
    float nx = clamp(vQ.x / max(rad, 1e-4), -1., 1.);
    a = cover(dist, aa);
    c = c * (.5 + .7 * sqrt(max(1. - nx * nx, 0.))) * (1. + 5. * vP.z) + vec3(.1, .2, .12) * vP.z;
  } else if (k == 1 || k == 2) {                  // petal / leaf: a lens with a tip, a notch and a curl
    float t = (vQ.y + hh.y) / (2. * hh.y);
    float curl = vP.z;
    float xs = vQ.x - curl * t * t * hh.x * (k == 1 ? 1.8 : 1.4);
    float tipk = vP.x;
    float s = pow(clamp(t, 0., 1.), mix(1., .65, tipk));
    float prof = pow(4. * s * (1. - s), mix(.5, .95, tipk));
    float w = hh.x * prof;
    float xn = xs / max(w, 1e-4);
    float tmax = 1. - (k == 1 ? vP.y : 0.) * .5 * (1. - clamp(abs(xn), 0., 1.));
    float dist = max(abs(xs) - w, max((t - tmax) * 2. * hh.y * .5, -t * 2. * hh.y * .5));
    a = cover(dist, aa);
    if (k == 1) {
      c *= mix(.55, 1.15, smoothstep(0., 1., t)) * (1. + .12 * cos(xn * 9.));
      float edge = smoothstep(.55, 1., abs(xn));
      c += vCol.rgb * vP.w * edge * .9;
      if (mod(vFlags, 4.) > 1.5) a *= .08 + .9 * smoothstep(.7, 1., abs(xn)) + smoothstep(.95, 1., t);
      a *= smoothstep(0., .08, t);
    } else {
      c *= .7 + .5 * t;
      float rq = xs / (hh.x * .08);
      c += vCol.rgb * vP.w * 3. * exp(-rq * rq) + vCol.rgb * .1 * cos((t * 14. + abs(xs) / hh.x * 3.) * 2.);
    }
  } else if (k == 3) {                            // flower centre: an ellipse of spiral dots
    vec2 e = vQ / hh;
    float r = length(e);
    a = cover((r - 1.) * min(hh.x, hh.y), aa);
    float ang = atan(e.y, e.x);
    float sp = cos(ang * 13. + r * vP.x * .35) * cos(ang * 21. - r * vP.x * .55);
    float dots = smoothstep(.15, .8, sp) * smoothstep(0., .2, r);
    c = c * (.45 + .9 * dots * (1. - r * .4)) * (1. + vP.y * 1.2) * (.75 + .25 * sqrt(max(1. - r * r * .9, 0.)));
  } else if (k == 4) {                            // halo and mist: light only
    float r = length(vQ) / hh.x;
    c = c * pow(clamp(1. - r, 0., 1.), vP.x);
    add = true;
  } else if (k == 5) {                            // a step's bud, or a drum pod
    float r = length(vQ) / hh.x;
    a = cover((r - 1.) * hh.x, aa);
    float nz = sqrt(max(1. - r * r, 0.));
    if (vP.x > .5) {
      c = c * (.55 + .7 * nz) + vec3(1.) * pow(nz, 8.) * .25 + vec3(1.) * vP.y * smoothstep(.6, 0., r) * .9;
    } else {
      float ring = smoothstep(.55, .8, r) * (1. - smoothstep(.9, 1., r));
      c = c * (.12 + .5 * ring) + vec3(1.) * vP.y * smoothstep(.6, 0., r) * .9;
    }
  } else if (k == 6) {                            // pollen, a firefly: a soft light
    float r = length(vQ) / hh.x;
    c = c * pow(clamp(1. - r, 0., 1.), 2.5);
    add = true;
  } else {                                        // a blade of grass
    float t = clamp((vQ.y + hh.y) / (2. * hh.y), 0., 1.);
    float x = vQ.x - vP.x * t * t * hh.x * 1.2;
    float w = hh.x * (1. - t) * .95 + hh.x * .05;
    a = cover(abs(x) - w, aa) * step(-hh.y, vQ.y) * step(vQ.y, hh.y);
    c = c * (.4 + .9 * t);
  }
  float fk = (1. - exp(-vDist * .028)) * .8;
  if (add) {
    o = vec4(c * (1. - fk) * uAlphaMul, 0.);
  } else {
    float al = a * vCol.a * damp * uAlphaMul;
    o = vec4(mix(c, uFog, fk) * al, al);
  }
}`;

// ---- trails: this frame's scene against the last frame, warped and faded; datamosh blocks keep the old picture
const FEEDBACK_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uScene, uPrev;
uniform float uDecay, uTime, uZoom, uRot, uMelt, uMosh, uAspect;
${NOISE}
void main() {
  vec2 p = vUv - .5;
  p.x *= uAspect;
  float cs = cos(uRot), sn = sin(uRot);
  p = mat2(cs, -sn, sn, cs) * p / uZoom;
  p.x /= uAspect;
  vec2 puv = p + .5;
  puv.y += uMelt * (.01 + .03 * vn(vec2(vUv.x * 14., uTime * .4)));
  vec2 bc = floor(vUv * vec2(uAspect * 14., 14.));
  float tt = floor(uTime * 5.);
  float mosh = step(h21(bc + tt), uMosh * .5);
  puv += (h22(bc + tt * 1.3) - .5) * .12 * mosh;
  vec3 prev = textureLod(uPrev, puv, 0.).rgb;
  vec3 scene = textureLod(uScene, vUv, 0.).rgb;
  o = vec4(mosh > .5 ? prev * .992 : max(scene, prev * uDecay), 1.);
}`;

// ---- bloom
const BLOOM_DOWN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThresh;
vec3 tx(vec2 uv) { return textureLod(uSrc, uv, 0.).rgb; }
void main() {
  vec3 c = tx(vUv) * 4. + tx(vUv + uTexel * vec2(-1., -1.)) + tx(vUv + uTexel * vec2(1., -1.)) + tx(vUv + uTexel * vec2(-1., 1.)) + tx(vUv + uTexel);
  c /= 8.;
  if (uThresh > 0.) {
    float l = max(c.r, max(c.g, c.b));
    float knee = .5;
    float soft = clamp(l - uThresh + knee, 0., 2. * knee);
    soft = soft * soft / (4. * knee + 1e-4);
    c *= max(soft, l - uThresh) / max(l, 1e-4);
  }
  o = vec4(c, 1.);
}`;
const BLOOM_UP_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
vec3 tx(vec2 uv) { return textureLod(uSrc, uv, 0.).rgb; }
void main() {
  vec2 h = uTexel * .5;
  vec3 s = tx(vUv + vec2(-h.x * 2., 0.)) + tx(vUv + vec2(-h.x, h.y)) * 2. + tx(vUv + vec2(0., h.y * 2.)) + tx(vUv + vec2(h.x, h.y)) * 2.
    + tx(vUv + vec2(h.x * 2., 0.)) + tx(vUv + vec2(h.x, -h.y)) * 2. + tx(vUv + vec2(0., -h.y * 2.)) + tx(vUv + vec2(-h.x, -h.y)) * 2.;
  o = vec4(s / 12., 1.);
}`;

// ---- the flash limiter's input: one texel per cell of a LIMIT_GRID x LIMIT_GRID grid, holding the cell's brightness now
// (trail plus bloom, as the composite adds them) and its slow average. Limiting per cell, not per frame, keeps a flash
// in one corner of the picture from passing because the rest of it stays dark.
const LIMIT_GRID = 4;
const LUMA_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTrailTex, uBloomTex, uPrevLuma;
uniform float uLevel, uBloom, uDt, uFirst;
const vec3 W = vec3(.2126, .7152, .0722);
void main() {
  vec2 uv = gl_FragCoord.xy / ${LIMIT_GRID}.;
  float li = dot(textureLod(uTrailTex, uv, uLevel).rgb, W);
  float bl = 0.;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) bl += dot(textureLod(uBloomTex, uv + vec2(float(i), float(j)) * (.33 / ${LIMIT_GRID}.), 0.).rgb, W);
  }
  li += uBloom * bl / 9.;
  float ls = texture(uPrevLuma, uv).x;
  ls = uFirst > .5 ? li : mix(ls, li, 1. - exp(-uDt / .6));
  o = vec4(ls, li, 0., 1.);
}`;

// ---- composite: screen-space glitches, bloom, hue, flash limiter, tone map, vignette, grain
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTrailTex, uBloomTex, uLuma;
uniform float uFx[12];
uniform float uTime, uAspect, uBloom, uExposure, uHue, uBeat;
uniform vec2 uRes;
${NOISE}
vec3 hueRot(vec3 c, float a) {
  float y = dot(c, vec3(.299, .587, .114)), i = dot(c, vec3(.596, -.274, -.322)), q = dot(c, vec3(.211, -.523, .312));
  float cs = cos(a), sn = sin(a);
  float i2 = i * cs - q * sn, q2 = i * sn + q * cs;
  return vec3(y + .956 * i2 + .621 * q2, y - .272 * i2 - .647 * q2, y - 1.106 * i2 + 1.703 * q2);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main() {
  vec2 uv = vUv;
  float derez = uFx[9];
  if (derez > .001) {
    vec2 cells = vec2(mix(1000., 40., derez)) * vec2(uAspect, 1.);
    uv = (floor(uv * cells) + .5) / cells;
  }
  vec2 p = uv * 2. - 1.;
  p.x *= uAspect;
  p.x = mix(p.x, abs(p.x), uFx[7]);
  if (uFx[6] > .001) {
    float a = atan(p.y, p.x), r = length(p), sg = TAU / 6.;
    a = abs(mod(a + uTime * .1, sg) - sg * .5);
    p = mix(p, r * vec2(cos(a), sin(a)), uFx[6]);
  }
  p *= 1. + uFx[8] * .5 * dot(p, p);
  p.x /= uAspect;
  uv = p * .5 + .5;
  uv.x += sin(uv.y * 18. + uTime * 3.) * .01 * uFx[5] + sin(uv.y * 40. + uTime * 20.) * .004 * uFx[11];
  float row = floor(uv.y * 80.);
  float hr = h21(vec2(row, floor(uTime * 14.)));
  uv.x += step(hr, uFx[1] * .35) * (h21(vec2(row, 7.)) - .5) * .25 * uFx[1];
  vec2 bc = floor(uv * vec2(16. * uAspect, 12.));
  float hb = h21(bc + floor(uTime * 9.));
  float on = step(hb, uFx[2] * .18);
  uv += on * (h22(bc) - .5) * .2;
  vec2 dir = (uv - .5) * (.4 + dot(uv - .5, uv - .5) * 4.);
  vec2 off = dir * uFx[0] * .03;
  vec3 c = vec3(textureLod(uTrailTex, uv + off, 0.).r, textureLod(uTrailTex, uv, 0.).g, textureLod(uTrailTex, uv - off, 0.).b);
  vec3 b = vec3(textureLod(uBloomTex, uv + off, 0.).r, textureLod(uBloomTex, uv, 0.).g, textureLod(uBloomTex, uv - off, 0.).b);
  if (on * step(.5, h21(bc + 3.)) > .5) { c = c.gbr; b = b.gbr; }
  // a cell may be at most 12 % off its own slow average, so a pulse faster than the average follows (beats, glitches,
  // whatever) can swing a cell only by that much: that is what holds the flashing under WCAG 2.3.1's three a second
  vec2 lum = texture(uLuma, clamp(uv, 0., 1.)).xy;
  float ratio = (lum.y + .02) / (lum.x + .02);
  float limit = clamp(ratio, .893, 1.12) / ratio;
  vec3 col = (c + b * uBloom) * uExposure * limit;
  if (uHue > .001) col = hueRot(col, uHue * 3. * sin(uTime * 1.3));
  col = aces(col);
  float l = dot(col, vec3(.2126, .7152, .0722));
  col = max(mix(vec3(l), col, 1.22), 0.);
  float vig = 1. - .38 * dot(vUv - .5, vUv - .5) * 2.;
  col *= vig;
  float vhs = uFx[11];
  col *= mix(1., .92 + .08 * sin(vUv.y * uRes.y * 1.1), vhs);
  col += vhs * .05 * h21(vec2(floor(vUv.y * 120.), floor(uTime * 30.))) * smoothstep(.9, 1., fract(vUv.y * .5 - uTime * .15));
  col += (h21(vUv * uRes + fract(uTime) * 91.) - .5) * .03;
  o = vec4(pow(max(col, 0.), vec3(1. / 2.2)), 1.);
}`;

const UNI = {
  uViewProj: "m4", uCamPos: "3", uCamFwd: "3", uCamRight: "3", uCamUp: "3", uSpriteR: "3", uSpriteU: "3",
  uBiome: "1v", uFx: "1v", uRip: "4v", uRipCol: "3v", uPool: "4v", uPoolCol: "3v",
};
// the ground's reflectiveness and the haze colour of each biome (pond, forest, aurora, nebula, rain)
const MIRROR = [0.55, 0, 0.12, 0.3, 0.3];
const FOG = [[0.04, 0.06, 0.16], [0.01, 0.08, 0.08], [0.02, 0.04, 0.1], [0.05, 0.01, 0.1], [0.28, 0.04, 0.22]];

function compile(gl, type, src, name) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`garden: the ${name} shader did not compile: ${log}`);
  }
  return s;
}
function program(gl, vs, fs, name) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs, `${name} vertex`), f = compile(gl, gl.FRAGMENT_SHADER, fs, `${name} fragment`);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`garden: the ${name} program did not link: ${gl.getProgramInfoLog(p)}`);
  const locs = new Map();
  return { p, name, loc(n) {
    if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n));
    return locs.get(n);
  } };
}

function target(gl, w, h, levels = 1) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`garden: this browser cannot render to a float texture (framebuffer status ${status})`);
  return { tex, fbo, w, h };
}

function setUniforms(gl, prog, u) {
  for (const k in u) {
    const l = prog.loc(k);
    if (l === null) continue;
    const v = u[k], kind = UNI[k];
    if (kind === undefined) gl.uniform1f(l, v);
    else if (kind === "m4") gl.uniformMatrix4fv(l, false, v);
    else if (kind === "3") gl.uniform3fv(l, v);
    else if (kind === "1v") gl.uniform1fv(l, v);
    else if (kind === "3v") gl.uniform3fv(l, v);
    else gl.uniform4fv(l, v);
  }
}

export function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance" });
  if (!gl) throw new Error("garden: WebGL2 is not available in this browser");
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) {
    throw new Error("garden: this browser cannot render to float textures (EXT_color_buffer_float)");
  }
  const instances = new Float32Array(MAX_INSTANCES * FLOATS);
  const r = { gl, instances, lost: false, width: 0, height: 0, frames: 0 };
  let G = null;
  let w = 0, h = 0, cur = 0, first = 0;

  function build() {
    const P = {
      bg: program(gl, FULL_VS, BG_FS, "sky"), sprite: program(gl, SPRITE_VS, SPRITE_FS, "plant"),
      fb: program(gl, FULL_VS, FEEDBACK_FS, "trail"), down: program(gl, FULL_VS, BLOOM_DOWN_FS, "bloom down"),
      up: program(gl, FULL_VS, BLOOM_UP_FS, "bloom up"), luma: program(gl, FULL_VS, LUMA_FS, "limiter"),
      comp: program(gl, FULL_VS, COMPOSITE_FS, "composite"),
    };
    const vao = gl.createVertexArray(), buf = gl.createBuffer(), empty = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return { P, vao, buf, empty, T: null, luma: null };
  }

  function alloc() {
    const old = G.T;
    if (old) for (const t of [old.scene, old.trail[0], old.trail[1], ...old.mips]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const mips = [];
    for (let i = 1; i <= 4; i++) mips.push(target(gl, Math.max(1, w >> i), Math.max(1, h >> i)));
    G.T = { scene: target(gl, w, h), trail: [target(gl, w, h, levels), target(gl, w, h, levels)], mips, top: levels - 1 };
    if (!G.luma) G.luma = [target(gl, LIMIT_GRID, LIMIT_GRID), target(gl, LIMIT_GRID, LIMIT_GRID)];
    for (const t of G.T.trail) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    first = 2;
  }

  function full(prog) {
    gl.useProgram(prog.p);
    gl.bindVertexArray(G.empty);
  }
  function draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); }
  function bind(unit, tex, prog, name) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.loc(name), unit);
  }
  function into(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : w, t ? t.h : h);
  }

  r.resize = (pw, ph) => {
    pw = Math.max(2, Math.floor(pw)); ph = Math.max(2, Math.floor(ph));
    if (pw === w && ph === h && G && G.T) return;
    w = pw; h = ph;
    canvas.width = w; canvas.height = h;
    r.width = w; r.height = h;
    if (!r.lost) alloc();
  };

  // paints st (its instances and uniforms already built for this frame); dt is the seconds since the last frame
  r.render = (st, dt) => {
    if (r.lost || !G.T) return;
    const u = st.u, T = G.T, k = Math.min(dt, 0.1) * 60, n = st.instances;
    gl.disable(gl.BLEND);
    // sky and ground
    into(T.scene);
    full(G.P.bg);
    setUniforms(gl, G.P.bg, u);
    draw();
    // plants, then (over water) their reflections beneath them
    let mirror = 0;
    const fog = [0, 0, 0];
    for (let i = 0; i < 5; i++) {
      mirror += st.bw[i] * MIRROR[i];
      for (let c = 0; c < 3; c++) fog[c] += st.bw[i] * FOG[i][c];
    }
    if (n > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, G.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, n * FLOATS);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(G.P.sprite.p);
      gl.bindVertexArray(G.vao);
      setUniforms(gl, G.P.sprite, u);
      gl.uniform3fv(G.P.sprite.loc("uFog"), fog);
      if (mirror > 0.02) {
        gl.uniform1f(G.P.sprite.loc("uFlip"), 1);
        gl.uniform1f(G.P.sprite.loc("uAlphaMul"), mirror * 0.7);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      }
      gl.uniform1f(G.P.sprite.loc("uFlip"), 0);
      gl.uniform1f(G.P.sprite.loc("uAlphaMul"), 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    }
    // trails
    const dst = T.trail[cur], prev = T.trail[1 - cur];
    into(dst);
    full(G.P.fb);
    bind(0, T.scene.tex, G.P.fb, "uScene");
    bind(1, prev.tex, G.P.fb, "uPrev");
    const F = G.P.fb;
    gl.uniform1f(F.loc("uDecay"), Math.pow(u.uTrail, k));
    gl.uniform1f(F.loc("uTime"), u.uTime);
    gl.uniform1f(F.loc("uAspect"), u.uAspect);
    gl.uniform1f(F.loc("uZoom"), 1 + (0.0012 + 0.004 * u.uBass) * k);
    gl.uniform1f(F.loc("uRot"), (0.0008 * Math.sin(u.uTime * 0.37) + 0.003 * (u.uMid - 0.2)) * k);
    gl.uniform1f(F.loc("uMelt"), u.uFx[5]);
    gl.uniform1f(F.loc("uMosh"), u.uFx[3]);
    draw();
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    // bloom: four down, three up (each up pass adds onto the next larger level)
    let src = dst, srcW = w, srcH = h;
    for (let i = 0; i < 4; i++) {
      const m = T.mips[i];
      into(m);
      full(G.P.down);
      bind(0, src.tex, G.P.down, "uSrc");
      gl.uniform2f(G.P.down.loc("uTexel"), 1 / srcW, 1 / srcH);
      gl.uniform1f(G.P.down.loc("uThresh"), i === 0 ? 0.9 : 0);
      draw();
      src = m; srcW = m.w; srcH = m.h;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = 3; i >= 1; i--) {
      const s = T.mips[i], d = T.mips[i - 1];
      into(d);
      full(G.P.up);
      bind(0, s.tex, G.P.up, "uSrc");
      gl.uniform2f(G.P.up.loc("uTexel"), 1 / s.w, 1 / s.h);
      draw();
    }
    gl.disable(gl.BLEND);
    // the flash limiter's brightness per cell: about 20 % of the picture wide, from a trail mip of about 10 texels across
    const lumaIn = G.luma[cur], lumaPrev = G.luma[1 - cur];
    into(lumaIn);
    full(G.P.luma);
    bind(0, dst.tex, G.P.luma, "uTrailTex");
    bind(1, T.mips[0].tex, G.P.luma, "uBloomTex");
    bind(2, lumaPrev.tex, G.P.luma, "uPrevLuma");
    gl.uniform1f(G.P.luma.loc("uLevel"), Math.max(0, T.top - 3));
    gl.uniform1f(G.P.luma.loc("uBloom"), u.uBloom);
    gl.uniform1f(G.P.luma.loc("uDt"), Math.min(dt, 0.1));
    gl.uniform1f(G.P.luma.loc("uFirst"), first > 0 ? 1 : 0);
    draw();
    // composite to the canvas
    into(null);
    full(G.P.comp);
    const C = G.P.comp;
    bind(0, dst.tex, C, "uTrailTex");
    bind(1, T.mips[0].tex, C, "uBloomTex");
    bind(2, lumaIn.tex, C, "uLuma");
    setUniforms(gl, C, u);
    gl.uniform2f(C.loc("uRes"), w, h);
    draw();
    cur = 1 - cur;
    if (first > 0) first--;
    r.frames++;
  };

  // the canvas's pixels as they were just drawn (call right after render): for tests and the page's checks
  r.read = () => {
    const data = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { w, h, data };
  };

  const onLost = (e) => { e.preventDefault(); r.lost = true; };
  const onRestored = () => {
    G = build();
    r.lost = false;
    if (w > 0) alloc();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  r.dispose = () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  };

  G = build();
  return r;
}
