// SPDX-License-Identifier: MPL-2.0
// The Night Garden's page side: app.js loads this when the Garden button is pressed. open() puts a canvas under the
// emulator's docked panel, asks the worklet for the tracks' snapshots (app_worklet.js, 60 a second while this is open),
// keeps the garden (garden_core.js) fed with them and paints it (garden_gl.js) every frame, with the master mix's bass,
// mids and highs from an analyser on the emulator's output. Everything it needs from the page is in the section
// #garden (page.html); a missing piece is an error, not a garden without its toolbar.
import { createGarden, ingest, update, prepareView, buildInstances, frameUniforms, decodeSnapshot, seedFromSnapshot,
  setIntensity, INTENSITY, hash32 } from "./garden_core.js";
import { createRenderer } from "./garden_gl.js";

const KEY = "soundplant-garden-intensity";
const NAMES = Object.keys(INTENSITY);            // calm, trippy, wild
const PANEL = ["small", "large", "off"];
const SCREEN = ["docked", "large", "huge"];     // the FM-1's LCD: in its panel, or popped out above the docked board
const MAX_PIXELS = 2.4e6;                      // the render target's cap: the trail, scene and bloom buffers are 16-bit floats
const MIN_SCALE = 0.5, MAX_SCALE = 1, START_SCALE = 0.75;
const REST_FRAME = 0.05;                       // at rest the garden paints 20 times a second
const IDLE_BAR = 5;                            // seconds without the pointer before the toolbar fades
const HINT_SECONDS = 9;

let panelMode = 0, screenMode = 0;             // kept across opens within a page visit

function must(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the page has no #${id}`);
  return el;
}

function storedIntensity() {
  try {
    const v = localStorage.getItem(KEY);
    return NAMES.includes(v) ? v : null;
  } catch (e) {
    console.warn("garden: the intensity could not be read from storage, using the default:", e);
    return null;
  }
}

function storeIntensity(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch (e) {
    console.warn("garden: the intensity could not be kept:", e);
  }
}

// bass, mids and highs of what the emulator plays, 0..1, quick to rise and slow to fall
function bandMeter(ac, node) {
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  an.smoothingTimeConstant = 0.5;
  node.connect(an);
  const bins = new Uint8Array(an.frequencyBinCount), hz = ac.sampleRate / an.fftSize;
  const bands = [[30, 150], [300, 3000], [5000, 12000]].map(([lo, hi]) =>
    [Math.max(1, Math.round(lo / hz)), Math.min(bins.length - 1, Math.round(hi / hz))]);
  return {
    read(out, dt) {
      an.getByteFrequencyData(bins);
      ["bass", "mid", "high"].forEach((name, i) => {
        const [a, b] = bands[i];
        let s = 0;
        for (let k = a; k <= b; k++) s += bins[k];
        const x = Math.min(1, Math.max(0, (s / (b - a + 1) / 255 - 0.35) / 0.55));
        out[name] += (x - out[name]) * (1 - Math.exp(-dt / (x > out[name] ? 0.04 : 0.25)));
      });
    },
    close() { node.disconnect(an); },
  };
}

export function open({ node, ac, onclose }) {
  const section = must("garden"), hint = must("garden-hint"), alertEl = must("garden-alert");
  const bar = section.querySelector(".garden-bar");
  const intensityButtons = [...section.querySelectorAll("[data-intensity]")];
  const regrow = must("garden-regrow"), panelButton = must("garden-panel"), screenButton = must("garden-screen"), fullButton = must("garden-full"), closeButton = must("garden-close");
  if (!bar || intensityButtons.length !== NAMES.length) throw new Error("the page's garden toolbar is incomplete");
  const root = document.documentElement;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const delay = Math.min(0.3, (ac.baseLatency || 0) + (ac.outputLatency || 0));

  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Night garden: a plant for each track. It starts when the emulator's first snapshot arrives.");
  section.prepend(canvas);
  section.hidden = false;
  root.classList.add("garden-on");
  let renderer;
  try {
    renderer = createRenderer(canvas);
  } catch (e) {
    root.classList.remove("garden-on");
    section.hidden = true;
    canvas.remove();
    throw e;
  }

  let intensity = reduced ? "calm" : storedIntensity() || "trippy";
  let st = null, last = null, nonce = 0, failed = false, closed = false, raf = 0;
  let offset = null;                                  // page seconds minus audio seconds, as small as the messages' delays allow
  let scale = START_SCALE, sizeDirty = true, lastChange = 0, windowFrames = 0, slowFrames = 0, warm = 20;
  let lastFrame = 0, lastLabel = "", lastLabelT = 0, lostSince = 0, idleTimer = 0;
  const meter = bandMeter(ac, node);
  const openedAt = performance.now() / 1000;

  function fail(e) {
    failed = true;
    cancelAnimationFrame(raf);
    alertEl.textContent = "The garden stopped: " + ((e && e.message) || e);
  }

  function pageTime(at) {
    if (!Number.isFinite(at)) throw new Error(`garden: a snapshot arrived with the time ${at}`);
    const d = performance.now() / 1000 - at;
    offset = offset === null || d < offset ? d : offset + (d - offset) * 0.02;
    return at + offset;
  }

  function grow(snap) {
    st = createGarden(hash32(seedFromSnapshot(snap), nonce), {
      engines: snap.trk.map((k) => k.engine), intensity, reduced, delay,
    });
  }

  function take(bytes, t) {
    const snap = decodeSnapshot(bytes);
    last = snap;
    if (!st) grow(snap);
    ingest(st, snap, t);
  }

  function setPressed() {
    for (const b of intensityButtons) b.setAttribute("aria-pressed", String(b.dataset.intensity === intensity));
  }

  function choose(name) {
    if (reduced && name !== "calm") return;
    intensity = name;
    storeIntensity(name);
    if (st) setIntensity(st, name);
    setPressed();
  }

  function showPanel() {
    root.classList.toggle("garden-panel-large", PANEL[panelMode] === "large");
    root.classList.toggle("garden-panel-off", PANEL[panelMode] === "off");
    panelButton.textContent = "Panel: " + PANEL[panelMode];
  }

  function showScreen() {
    root.classList.toggle("garden-screen-pop", screenMode > 0);
    root.classList.toggle("garden-screen-huge", SCREEN[screenMode] === "huge");
    screenButton.textContent = "Screen: " + SCREEN[screenMode];
  }

  function describe() {
    if (!st) return "Night garden: a plant for each track. It starts when the emulator's first snapshot arrives.";
    const tracks = st.plants.map((p, i) => `track ${i + 1}, a ${p.species.name}${p.muted ? ", muted" : p.act > 0.15 ? ", playing" : ""}`);
    return `Night garden at ${Math.round(st.tempo)} BPM, ${st.playing ? "playing" : "stopped"}. ${tracks.join("; ")}.`;
  }

  function applySize() {
    const r = section.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = r.width * dpr * scale, h = r.height * dpr * scale;
    if (w * h > MAX_PIXELS) { const f = Math.sqrt(MAX_PIXELS / (w * h)); w *= f; h *= f; }
    renderer.resize(w, h);
    sizeDirty = false;
  }

  // the render scale follows the frame rate: a window of frames that is mostly slow steps down, one with none slow steps up
  function govern(dt, now) {
    if (dt > 0.5) return;
    if (warm > 0) { warm--; return; }
    windowFrames++;
    if (dt > 0.024) slowFrames++;
    if (windowFrames < 90) return;
    const slow = slowFrames;
    windowFrames = 0; slowFrames = 0;
    if (slow >= 27 && scale > MIN_SCALE) scale = Math.max(MIN_SCALE, scale - 0.125);
    else if (slow === 0 && scale < MAX_SCALE && now - lastChange > 10) scale = Math.min(MAX_SCALE, scale + 0.125);
    else return;
    lastChange = now;
    sizeDirty = true;
    warm = 10;
  }

  function paint(dt) {
    if (sizeDirty) applySize();
    prepareView(st, renderer.width / renderer.height);
    buildInstances(st, renderer.instances);
    frameUniforms(st);
    renderer.render(st, dt);
  }

  function draw(now) {
    if (!st) return;
    if (st.rest && now - lastFrame < REST_FRAME) return;
    const dt = lastFrame ? now - lastFrame : 1 / 60;
    lastFrame = now;
    meter.read(st.audio, Math.min(dt, 0.1));
    update(st, now);
    paint(dt);
    govern(dt, now);
    if (renderer.lost) {
      lostSince = lostSince || now;
      if (now - lostSince > 3) alertEl.textContent = "The graphics context was lost and has not come back. Close the garden and open it again.";
    } else if (lostSince) {
      lostSince = 0;
      alertEl.textContent = "";
    }
    if (now - lastLabelT > 1) {
      lastLabelT = now;
      const label = describe();
      if (label !== lastLabel) { lastLabel = label; canvas.setAttribute("aria-label", label); }
    }
    if (now - openedAt > HINT_SECONDS) hint.hidden = true;
  }

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    try {
      draw(ms / 1000);
    } catch (e) {
      fail(e);
      throw e;
    }
  }

  function wake() {
    section.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!bar.matches(":focus-within")) section.classList.add("idle"); }, IDLE_BAR * 1000);
  }

  const keepFocus = (e) => e.preventDefault();       // a click here must not take the keys away from the panel
  const onResize = () => { sizeDirty = true; };
  const ro = new ResizeObserver(onResize);
  const onVisible = () => { node.port.postMessage({ type: "app", garden: !document.hidden }); };
  const onFull = () => { fullButton.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen"; };
  const onFullClick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch (e) {
      alertEl.textContent = "Full screen is not available here: " + ((e && e.message) || e);
    }
  };
  const onRegrow = () => {
    if (!last) return;
    nonce++;
    grow(last);
    ingest(st, last, performance.now() / 1000);
  };
  const onPanel = () => { panelMode = (panelMode + 1) % PANEL.length; showPanel(); };
  const onScreen = () => { screenMode = (screenMode + 1) % SCREEN.length; showScreen(); };
  const intensityHandlers = intensityButtons.map((b) => [b, () => choose(b.dataset.intensity)]);

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    clearTimeout(idleTimer);
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("fullscreenchange", onFull);
    section.removeEventListener("pointerdown", keepFocus);
    section.removeEventListener("mousedown", keepFocus);
    section.removeEventListener("pointermove", wake);
    section.removeEventListener("pointerdown", wake);
    bar.removeEventListener("focusin", wake);
    regrow.removeEventListener("click", onRegrow);
    panelButton.removeEventListener("click", onPanel);
    screenButton.removeEventListener("click", onScreen);
    fullButton.removeEventListener("click", onFullClick);
    closeButton.removeEventListener("click", close);
    for (const [b, h] of intensityHandlers) b.removeEventListener("click", h);
    node.port.postMessage({ type: "app", garden: false });
    meter.close();
    if (document.fullscreenElement) document.exitFullscreen().catch((e) => console.warn("garden: leaving full screen:", e));
    renderer.dispose();
    canvas.remove();
    alertEl.textContent = "";
    section.hidden = true;
    root.classList.remove("garden-on", "garden-panel-large", "garden-panel-off", "garden-screen-pop", "garden-screen-huge");
    if (globalThis.gardenDebug && globalThis.gardenDebug.canvas === canvas) delete globalThis.gardenDebug;
    onclose();
  }

  function step(to) {
    if (!st) return;
    let t = st.t < 0 ? to : st.t;
    while (to - t > 1 / 60) { t += 1 / 60; update(st, t); }
    update(st, to);
  }

  // for the page's own checks (tests/browser by hand): stop the live loop and drive the garden at times of its own
  globalThis.gardenDebug = {
    canvas,
    get state() { return st; },
    get renderer() { return renderer; },
    freeze() { cancelAnimationFrame(raf); },
    at(t, bytes, draw = true) {
      if (bytes) {
        const snap = decodeSnapshot(bytes);
        last = snap;
        if (!st) grow(snap);
        step(t);
        ingest(st, snap, t);
      } else {
        step(t);
      }
      if (draw) paint(1 / 60);
    },
  };

  intensityButtons.forEach((b) => { b.disabled = reduced && b.dataset.intensity !== "calm"; });
  setPressed();
  showPanel();
  showScreen();
  onFull();
  fullButton.hidden = !document.fullscreenEnabled;
  hint.hidden = false;
  alertEl.textContent = "";
  section.addEventListener("pointerdown", keepFocus);
  section.addEventListener("mousedown", keepFocus);
  section.addEventListener("pointermove", wake);
  section.addEventListener("pointerdown", wake);
  bar.addEventListener("focusin", wake);
  regrow.addEventListener("click", onRegrow);
  panelButton.addEventListener("click", onPanel);
  screenButton.addEventListener("click", onScreen);
  fullButton.addEventListener("click", onFullClick);
  closeButton.addEventListener("click", close);
  for (const [b, h] of intensityHandlers) b.addEventListener("click", h);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("fullscreenchange", onFull);
  ro.observe(section);
  wake();
  node.port.postMessage({ type: "app", garden: true });
  raf = requestAnimationFrame(frame);

  return {
    snapshot(bytes, at) {
      if (failed || closed) return;
      try {
        take(bytes, pageTime(at));
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    close,
  };
}
