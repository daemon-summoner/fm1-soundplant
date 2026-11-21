// SPDX-License-Identifier: MPL-2.0
// SoundPlant's own part of fm1-base's emulator page (base/web/emu/index.html; fm1-base's build loads it as app_own.js
// beside the emulator's parts, when the emulator is switched on). It works through the page's own names (KEYMAP,
// holdDown, turn, knobs, buttons, shortcuts, controls, node): the projects saved by the earlier page, what each
// control does on hover, and SoundPlant's computer keys: Space PLAY, Enter REC, / SEQ, as everywhere on the page, not
// only on the panel. A control reached with Tab keeps Space and Enter for itself (it presses that control); any other
// focus (the knob the page focuses when it switches on, a click, a touch) does not, so Space is PLAY from the first key.
// The Garden button opens garden.js (the night garden: a plant per track, drawn from the snapshots app_worklet.js sends
// while it is open); it is loaded then, not with the page. The demo songs box loads a song into the running firmware.
// The Preset lab (presets.js: the page lists the factory presets as it loads; here it is joined to the firmware once that is on)
// puts a preset on a track of the running firmware and plays it on the panel's keys.

// the projects the page kept before it was fm1-base's (its own key), moved to fm1-base's page's key once
const OLD_STORE = "xy-emu-store", STORE = "soundplant-emu-store";
function moveStore() {
  try {
    const old = localStorage.getItem(OLD_STORE);
    if (old === null) return;
    if (localStorage.getItem(STORE) === null) localStorage.setItem(STORE, old);
    localStorage.removeItem(OLD_STORE);
  } catch { /* private window: nothing kept */ }
}

// what each control does, on hover and for a screen reader (the Buttons list below the panel says the same)
const TIP = { FX: "Sends and effects", SEL: "The page's list: copy, paste, weave, presets", ENV: "Envelope and filter",
  LFO: "LFO", EDIT: "The sound", GLO: "Mix, master and setup", HOME: "Arrange; held, the shift key", SAVE: "Save",
  ARP: "Players: arp, strum, hold", SEQ: "Steps; held, play the notes a step takes", PLAY: "Start / stop",
  REC: "Held: record; stopped, a tap: step record", "OCT-": "An octave down", "OCT+": "An octave up", SELECT: "Page",
  ALGORITHM: "Track", PRESETS: "Next sound", MASTER: "Volume" };
function tips() {
  for (const [n, b] of Object.entries(buttons)) if (TIP[n]) { b.hit.title = TIP[n]; b.hit.setAttribute("aria-description", TIP[n]); }
  for (const [n, k] of Object.entries(knobs)) {
    if (!TIP[n] || n === "MASTER") continue;
    const how = k.hit.getAttribute("aria-description");
    k.hit.title = TIP[n];
    k.hit.setAttribute("aria-description", how ? `${TIP[n]}. ${how}` : TIP[n]);
  }
}

// whether the focused control keeps Space and Enter: only after Tab, until the next pointer press
export function tabFocus() {
  let viaTab = false;
  return {
    tab() { viaTab = true; },
    pointer() { viaTab = false; },
    keeps(key, onControl) { return onControl && viaTab && (key === " " || key === "Enter"); },
  };
}

// the computer's keys: fm1-base's map (white keys Q-I, A-K; black keys 1-0, -; Esc HOME; Z / X octave) and SoundPlant's
const KNOB_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
function keyboard() {
  const map = { ...KEYMAP, Space: { btn: BTN.PLAY }, Enter: { btn: BTN.REC }, Slash: { btn: BTN.SEQ } };
  const focus = tabFocus();
  controls.addEventListener("pointerdown", () => focus.pointer(), true);
  addEventListener("keydown", (e) => { if (e.key === "Tab") focus.tab(); }, true);
  addEventListener("keydown", (e) => {
    if (!node || !shortcuts.checked || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t !== document.body && t !== document.documentElement && !controls.contains(t)) return;   // the page's fields
    const hit = t.closest ? t.closest(".hit") : null;
    if (hit && hit.classList.contains("knob") && KNOB_KEYS.has(e.key)) return;   // a knob turns with its keys
    if (focus.keeps(e.key, hit !== null)) return;   // reached with Tab: presses it
    if (e.code === "ArrowUp" || e.code === "ArrowDown") {
      turn(knobs.SELECT, e.code === "ArrowUp" ? 1 : -1);
      e.preventDefault(); e.stopPropagation();
      return;
    }
    const m = map[e.code];
    if (!m) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) holdDown("k" + e.code, m.key !== undefined ? "key" : "btn", m.key !== undefined ? m.key : m.btn);
  }, true);
}

// the open garden (garden.js open()'s controller), or null
let garden = null;

// the garden's snapshots, from app_worklet.js (the worklet's { type: "app" } messages)
export function message(m) {
  if (m.garden && garden) garden.snapshot(m.garden, m.at);
}

// the Garden button: on once the emulator is running (the worklet's "ready"), and straight away with #garden in the address
function gardenButton(ctx) {
  const button = document.getElementById("garden-open");
  const toggle = async () => {
    if (garden) { garden.close(); return; }
    button.disabled = true;
    try {
      const mod = await import(new URL("./garden.js", import.meta.url));
      garden = mod.open({ node: ctx.node, ac: ctx.ac, onclose() { garden = null; button.setAttribute("aria-pressed", "false"); } });
      button.setAttribute("aria-pressed", "true");
    } catch (e) {
      ctx.status("The garden could not open: " + (e && e.message || e));
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener("click", toggle);
  ctx.node.port.addEventListener("message", (e) => {
    if (e.data.type !== "ready") return;
    button.disabled = false;
    if (location.hash === "#garden") toggle();
  });
  ctx.node.port.start();
}

// ---- the demo songs (tools/make_demos.py): demos/demos.json lists them, each a backup image (the emulator part "backup"
// restores it into the running firmware). The picker box is in page.html; it asks before it replaces the three projects and
// the presets, keeps what it replaced for Undo, and for Load and play presses the panel's buttons the way a player would.
const UNDO_DEPTH = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a tap of a panel button: the page's own press and let go (a press lasts at least 50 ms: the firmware reads every 16)
async function tapButton(bit) {
  holdDown("demo", "btn", bit);
  await sleep(80);
  letGo("demo");
  await sleep(150);
}

// the song from its first slot, from whatever page the panel is on: SEQ is the Steps page and closes a list or a question,
// HOME from any page but Arrange is Arrange, and one step of SELECT is the Song page, where PLAY plays the song
async function playSong() {
  await tapButton(BTN.SEQ);
  await tapButton(BTN.HOME);
  turn(knobs.SELECT, 1);
  await sleep(150);
  await tapButton(BTN.PLAY);
}

// what the firmware answers to a restore (backup_worklet.js)
function restoreText(rc) {
  if (rc === 10) return "SoundPlant is playing: press PLAY (or Space) to stop it, then load the song.";
  if (rc === 3) return "The emulator did not take that song: it is from another build of SoundPlant. Reload the page and try again.";
  return "That song's file is damaged. Nothing was changed.";
}

function demoPicker(ctx) {
  const $ = (id) => document.getElementById(id);
  const set = $("demos-set"), list = $("demos-list"), play = $("demo-play"), load = $("demo-load"), undo = $("demo-undo"),
    confirm = $("demos-confirm"), yes = $("demo-yes"), no = $("demo-no"), note = $("demos-status"), problem = $("demos-error");
  let demos = [], ready = false, busy = false, pending = null;
  const undos = [];                                       // the images the loads replaced, the last on top

  const say = (text) => { problem.textContent = ""; note.textContent = text; };
  const fail = (text) => { note.textContent = ""; problem.textContent = text; ctx.status(text); };
  const chosen = () => demos.find((d) => d.id === (list.querySelector("input:checked") || {}).value);
  const refresh = () => {
    const free = ready && demos.length > 0 && !busy;
    set.disabled = !free;
    play.disabled = load.disabled = !free || !chosen() || !confirm.hidden;
    undo.hidden = undos.length === 0;
    undo.disabled = !free || !confirm.hidden;
  };

  // the firmware's answers to the picker's questions come to the page's own handler: take them first, so that the page's
  // part for the backup (which would save a file for every "make") sees only the buttons it made itself
  const port = ctx.node.port, page = port.onmessage, waiting = [];
  port.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === "app" && m.part === "backup" && waiting.length) waiting.shift()(m);
    else page.call(port, e);
  };
  const ask = (m, transfer) => new Promise((resolve, reject) => {
    const answer = (reply) => { clearTimeout(timer); resolve(reply); };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(answer), 1);
      reject(new Error("The emulator did not answer."));
    }, 4000);
    waiting.push(answer);
    port.postMessage({ type: "app", part: "backup", ...m }, transfer || []);
  });
  const restore = async (image) => {
    const m = await ask({ cmd: "restore", image }, [image]);
    if (m.none) throw new Error("This build of SoundPlant has no backup, so it cannot load songs.");
    return m.restored;
  };
  // the controls are disabled while a job runs, which drops the focus to the page: give it back when nothing took it
  // (to the picked song when the control is gone: the last Undo hides its button)
  const guard = async (job) => {
    const had = document.activeElement;
    busy = true;
    refresh();
    try { await job(); } catch (e) { fail(e && e.message || String(e)); } finally {
      busy = false;
      refresh();
      if (document.activeElement === document.body && had !== document.body) {
        const back = had.hidden || had.disabled ? list.querySelector("input:checked") || list.querySelector("input") : had;
        if (back) back.focus();
      }
    }
  };

  const closeConfirm = () => { confirm.hidden = true; pending = null; refresh(); };
  const begin = (andPlay) => guard(async () => {
    const demo = chosen();
    if (!demo) return;
    ctx.status("");
    say("");
    const now = await ask({ cmd: "make" });                // the projects as saved: what Undo puts back, and whether it plays
    if (now.none) throw new Error("This build of SoundPlant has no backup, so it cannot load songs.");
    if (now.playing) {
      fail(`SoundPlant is playing: press PLAY (or Space) to stop it, then load ${demo.genre}.`);
      return;
    }
    pending = { demo, andPlay, before: now.backup, opener: andPlay ? play : load };
    $("demos-confirm-text").textContent = `Load ${demo.genre} (${demo.bpm} bpm)? It replaces your three projects and your presets in this browser, ` +
      "and what you have not saved with SAVE is lost. Undo puts back what was saved.";
    yes.textContent = andPlay ? "Replace and play" : "Replace";
    confirm.hidden = false;
    refresh();
    yes.focus();
  });
  const confirmed = () => {
    const { demo, andPlay, before, opener } = pending;
    closeConfirm();
    return guard(async () => {
      const res = await fetch(new URL(`demos/${demo.file}`, import.meta.url));
      if (!res.ok) throw new Error(`The song ${demo.file} could not be fetched (${res.status}).`);
      const rc = await restore(await res.arrayBuffer());
      if (rc !== 0) {
        fail(restoreText(rc));
        return;
      }
      undos.push(before);
      if (undos.length > UNDO_DEPTH) undos.shift();
      if (andPlay) {
        await playSong();
        say(`${demo.genre} is playing from the top: ${demo.bpm} bpm. Press PLAY to stop it.`);
      } else {
        say(`${demo.genre} is loaded: ${demo.bpm} bpm. For the whole song: HOME, turn SELECT to Song, PLAY.`);
      }
    }).then(() => opener.focus());
  };
  const undoLast = () => guard(async () => {
    ctx.status("");
    const image = undos.at(-1).slice(0);
    const rc = await restore(image);
    if (rc !== 0) {
      fail(restoreText(rc));
      return;
    }
    undos.pop();
    say(undos.length ? "Your previous projects are back. Undo goes back one more load." : "Your projects and presets are back.");
  });

  play.addEventListener("click", () => begin(true));
  load.addEventListener("click", () => begin(false));
  yes.addEventListener("click", confirmed);
  no.addEventListener("click", () => {
    const { opener } = pending;
    closeConfirm();
    say("Nothing was changed.");
    opener.focus();
  });
  undo.addEventListener("click", undoLast);
  confirm.addEventListener("keydown", (e) => { if (e.key === "Escape") no.click(); });
  list.addEventListener("change", () => { if (!confirm.hidden) closeConfirm(); refresh(); });

  port.addEventListener("message", (e) => {
    if (e.data.type !== "ready") return;
    ready = true;
    $("demos-off").hidden = true;
    refresh();
  });
  port.start();

  fetch(new URL("demos/demos.json", import.meta.url)).then((res) => {
    if (!res.ok) throw new Error(`demos/demos.json: ${res.status}`);
    return res.json();
  }).then((found) => {
    demos = found;
    for (const d of demos) {
      const tile = document.createElement("label"), pick = document.createElement("input"), name = document.createElement("b"),
        why = document.createElement("small");
      tile.className = "demo";
      pick.type = "radio";
      pick.name = "demo";
      pick.value = d.id;
      name.id = `demo-${d.id}-name`;
      name.textContent = `${d.genre}, ${d.bpm} bpm`;
      why.id = `demo-${d.id}-why`;
      why.textContent = d.blurb;
      pick.setAttribute("aria-labelledby", name.id);
      pick.setAttribute("aria-describedby", why.id);
      tile.append(pick, name, why);
      list.append(tile);
    }
    refresh();
  }).catch((e) => fail(`The demo songs could not be listed: ${e && e.message || e}`));
}

// the Preset lab (presets.js, loaded by the page already: the same module) takes the running firmware
function presetLab(ctx) {
  import(new URL("./presets.js", import.meta.url))
    .then((lab) => lab.connect(ctx))
    .catch((e) => ctx.status("The Preset lab could not start: " + (e && e.message || e)));
}

export function attach(ctx) {
  moveStore();
  tips();
  keyboard();
  gardenButton(ctx);
  demoPicker(ctx);
  presetLab(ctx);
}
