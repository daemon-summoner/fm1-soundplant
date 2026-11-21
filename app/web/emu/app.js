// SPDX-License-Identifier: MPL-2.0
// SoundPlant's own part of fm1-base's emulator page (base/web/emu/index.html; fm1-base's build loads it as app_own.js
// beside the emulator's parts, when the emulator is switched on). It works through the page's own names (KEYMAP,
// holdDown, turn, knobs, buttons, shortcuts, controls, node): the projects saved by the earlier page, what each
// control does on hover, and SoundPlant's computer keys: Space PLAY, Enter REC, / SEQ, as everywhere on the page, not
// only on the panel. A control reached with Tab keeps Space and Enter for itself (it presses that control); any other
// focus (the knob the page focuses when it switches on, a click, a touch) does not, so Space is PLAY from the first key.

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

export function attach() {
  moveStore();
  tips();
  keyboard();
}
