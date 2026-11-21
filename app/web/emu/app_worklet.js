// SPDX-License-Identifier: MPL-2.0
// SoundPlant's part of the emulator's worklet. While the page's garden is open ({ type: "app", garden: true }) the
// tracks' state (app/web.c web_garden: what each plays, its filter and sends, its pattern) goes to the page 60 times
// a second as { type: "app", garden: ArrayBuffer, at: currentTime }; closed, it does nothing at all.
// The preset lab (app/web/emu/presets.js) sends { type: "app", lab: { op, id, ... } } and gets { type: "app", lab: op, id,
// ok: true, state } or { ok: false, error } back: op "apply" (track, index: a factory preset onto a track), "track",
// "info", "watch" (on: the state arrives as { lab: "state", state } 10 times a second while it changes, and not at all
// while it does not). state is { track, engine, name, knobs: [{ label, value } x 4] }, as app/web.c web_lab reads it.
const STEP = 1 / 60;
const LAB_STEP = 1 / 10;
const LAB_SIZE = 212;                                // app/web.c lab_t
let on = false;
let next = 0;
let watching = false;
let labNext = 0;
let labLast = "";

// a 0-ended string of ASCII (an AudioWorklet has no TextDecoder)
function ascii(b, at, size) {
  let s = "";
  for (let i = at; i < at + size && b[i]; i++) s += String.fromCharCode(b[i]);
  return s;
}

function labState(fm1) {
  const n = fm1.ex.web_lab_size();
  if (n !== LAB_SIZE) throw new Error(`The preset lab reads ${LAB_SIZE} bytes of the firmware's state; this build gives ${n}.`);
  const b = new Uint8Array(fm1.mem.buffer, fm1.ex.web_lab(), n);
  const knobs = [];
  for (let i = 0; i < 4; i++) knobs.push({ label: ascii(b, 20 + 48 * i, 24), value: ascii(b, 44 + 48 * i, 24) });
  return { track: b[0], engine: b[1], name: ascii(b, 4, 16), knobs };
}

// a whole number the firmware's 32-bit arguments cannot wrap
const whole = (v) => Number.isInteger(v) && v >= 0 && v < 65536;

function labMessage(fm1, c) {
  const reply = (r) => fm1.port.postMessage({ type: "app", lab: c.op, id: c.id, ...r });
  try {
    const ex = fm1.ex;
    if (!ex.web_lab) throw new Error("This build of SoundPlant has no preset lab.");
    if (c.op === "watch") {
      watching = false;
      if (c.on) {
        labState(fm1);                               // (the layout is checked here, once, so process() cannot fail on it)
        watching = true;
        labNext = 0;
        labLast = "";
      }
      reply({ ok: true });
    } else if (c.op === "info") {
      reply({ ok: true, state: labState(fm1) });
    } else if (c.op === "track") {
      if (!whole(c.track) || ex.web_track(c.track) < 0) throw new Error(`There is no track ${c.track} to play.`);
      reply({ ok: true, state: labState(fm1) });
    } else if (c.op === "apply") {
      const n = ex.web_presets();
      if (!whole(c.index) || c.index >= n) throw new Error(`There is no preset ${c.index}: the firmware has ${n}.`);
      if (!whole(c.track) || ex.web_preset(c.track, c.index) < 0) throw new Error(`There is no track ${c.track} to put a preset on.`);
      reply({ ok: true, state: labState(fm1) });
    } else {
      throw new Error(`The preset lab has no command ${c.op}.`);
    }
  } catch (e) {
    reply({ ok: false, error: e && e.message || String(e) });
  }
}

globalThis.fm1App = {
  message(fm1, m) {
    if (m.lab) {
      labMessage(fm1, m.lab);
      return;
    }
    if (m.garden === undefined) return;
    on = !!m.garden;
    next = 0;
  },
  process(fm1) {
    if (watching && currentTime >= labNext) {
      labNext = Math.max(labNext + LAB_STEP, currentTime);
      const state = labState(fm1), key = JSON.stringify(state);
      if (key !== labLast) {
        labLast = key;
        fm1.port.postMessage({ type: "app", lab: "state", state });
      }
    }
    if (!on || currentTime < next) return;
    next = Math.max(next + STEP, currentTime);
    const p = fm1.ex.web_garden();
    const bytes = fm1.mem.buffer.slice(p, p + fm1.ex.web_garden_size());
    fm1.port.postMessage({ type: "app", garden: bytes, at: currentTime }, [bytes]);
  },
};
