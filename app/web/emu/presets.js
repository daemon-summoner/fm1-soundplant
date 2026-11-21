// SPDX-License-Identifier: MPL-2.0
// The Preset lab of SoundPlant's emulator page: every factory preset (presets.json, tools/make_presets.py: the firmware's own
// table, in its order) by engine, with a filter box. A click or Enter puts the preset on a track of the running firmware
// (the worklet's "lab" commands, app_worklet.js, which call app/web.c web_preset: what the PRESETS knob does) and plays a
// short phrase on the panel's own keys, as a player would. The sound and the four knobs are read back from the firmware, and
// the panel's knobs tweak it live. start() builds the list when the page loads; connect(ctx) joins it to the firmware
// once it is switched on (app.js).

// white keys 1, 3 and 5 of the panel (C, E, G), each held for `hold` ms, then `rest` ms of quiet
export const PHRASE = [{ white: 0, hold: 220, rest: 40 }, { white: 2, hold: 220, rest: 40 }, { white: 4, hold: 700, rest: 0 }];

// whether every word of `text` is in the preset's name, engine, role or genres
export function matches(p, text) {
  const hay = [p.name, p.engine, p.role, ...p.genres].join(" ").toLowerCase();
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export const engineOf = (list, state) => list.engines[state.engine] ?? `engine ${state.engine}`;

// the factory preset a track's sound is (by name and engine), or null: a sound of the user's own, or one that was changed
export function presetOf(list, state) {
  const engine = engineOf(list, state);
  return list.presets.find((p) => p.name === state.name && p.engine === engine) || null;
}

// "T3: soft lead, knit"; a sound named for its engine (a new project's kit) once
export function titleOf(list, state) {
  const p = presetOf(list, state), name = p ? p.name : state.name || "no name", engine = engineOf(list, state);
  return `T${state.track + 1}: ${name === engine ? name : `${name}, ${engine}`}`;
}

export const knobText = (state) => state.knobs.filter((k) => k.label).map((k) => `${k.label} ${k.value}`).join(", ");

// the worklet's lab commands as promises: apply(track, index), track(track), info(), watch(on) answer with the firmware's
// state { track, engine, name, knobs } (watch: nothing) or reject with the firmware's words; onState(f) takes the
// states it posts while watched. No answer in `timeout` ms rejects.
export function client(port, timeout = 4000) {
  const waiting = new Map(), watchers = [];
  let seq = 0;
  port.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "app" || !m.lab) return;
    if (m.lab === "state") {
      for (const f of watchers) f(m.state);
    } else if (waiting.has(m.id)) {
      waiting.get(m.id)(m);
    }
  });
  const call = (c) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("The emulator did not answer."));
    }, timeout);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      waiting.delete(id);
      if (m.ok) resolve(m.state);
      else reject(new Error(m.error || "The emulator refused."));
    });
    port.postMessage({ type: "app", lab: { ...c, id } });
  });
  return {
    apply: (track, index) => call({ op: "apply", track, index }),
    track: (track) => call({ op: "track", track }),
    info: () => call({ op: "info" }),
    watch: (on) => call({ op: "watch", on }),
    onState: (f) => watchers.push(f),
  };
}

// the audition: a tap of EDIT (the Engine page, where the keys play the selected track), then PHRASE on the keys.
// hold(id, kind, v) and release(id) are the page's holdDown and letGo; a newer play() takes over from an older one.
export function player({ hold, release, sleep, edit, white }) {
  let run = 0;
  return async function play() {
    const me = ++run;
    release("lab-key");
    hold("lab-btn", "btn", edit);
    await sleep(80);
    release("lab-btn");
    await sleep(70);
    for (const n of PHRASE) {
      if (me !== run) return false;
      hold("lab-key", "key", white[n.white]);
      await sleep(n.hold);
      if (me !== run) return false;
      release("lab-key");
      await sleep(n.rest);
    }
    return true;
  };
}

// the row above or below `from` (dir -1 or 1): the nearest row, and in it the item nearest across
function vertical(items, from, dir) {
  const r = from.getBoundingClientRect(), cx = r.left + r.width / 2;
  let best = null, bestRow = Infinity, bestAcross = Infinity;
  for (const b of items) {
    const q = b.getBoundingClientRect(), row = dir * (q.top - r.top), across = Math.abs(q.left + q.width / 2 - cx);
    if (row <= 4) continue;
    if (row < bestRow - 4 || (Math.abs(row - bestRow) <= 4 && across < bestAcross)) {
      best = b;
      bestRow = row;
      bestAcross = across;
    }
  }
  return best;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alertPage = (text) => showAlert(text);   // the page's own alert line

async function build() {
  const $ = (id) => document.getElementById(id);
  const root = $("presets");
  if (!root) throw new Error("The page has no Preset lab section.");
  const res = await fetch(new URL("presets.json", import.meta.url));
  if (!res.ok) throw new Error(`presets.json: ${res.status}`);
  const list = await res.json();
  if (list.presets.length !== list.count) throw new Error(`presets.json lists ${list.presets.length} presets and says ${list.count}.`);

  const search = $("presets-search"), trackSel = $("presets-track"), again = $("presets-again"), count = $("presets-count"),
    listEl = $("presets-list"), nowTitle = $("presets-now-title"), nowKnobs = $("presets-now-knobs"), off = $("presets-off"),
    note = $("presets-status"), problem = $("presets-error");
  let link = null, latest = 0, tabbed = null;
  const buttons = [], rows = [], groups = [];

  const say = (text) => { problem.textContent = ""; note.textContent = text; };
  const fail = (text) => { note.textContent = ""; problem.textContent = text; alertPage(text); };

  for (const g of list.groups) {
    const el = document.createElement("div"), h = document.createElement("h3"), why = document.createElement("p"),
      ul = document.createElement("ul");
    h.id = `presets-g-${g.engine}`;
    h.textContent = g.engine;
    why.textContent = `${g.blurb} Knobs: ${g.knobs.join(", ")}.`;
    el.className = "preset-group";
    el.setAttribute("role", "group");
    el.setAttribute("aria-labelledby", h.id);
    ul.className = "preset-items";
    el.append(h, why, ul);
    const mine = [];
    for (const p of list.presets.filter((q) => q.engine === g.engine)) {
      const li = document.createElement("li"), b = document.createElement("button"), name = document.createElement("b"),
        desc = document.createElement("small");
      b.type = "button";
      b.className = "preset";
      b.setAttribute("aria-disabled", "true");        // until the firmware is on: a press says so
      b.dataset.index = String(p.index);
      b.tabIndex = -1;
      name.textContent = p.name;
      desc.textContent = p.desc;
      b.append(name, desc);
      li.append(b);
      ul.append(li);
      buttons.push(b);
      rows.push({ li, p });
      mine.push(li);
    }
    groups.push({ el, mine });
    listEl.append(el);
  }
  const visible = () => buttons.filter((b) => !b.closest("[hidden]"));
  const rove = (b) => {
    if (tabbed) tabbed.tabIndex = -1;
    tabbed = b;
    if (b) b.tabIndex = 0;
  };
  rove(buttons[0] || null);

  const filter = () => {
    const q = search.value.trim();
    let shown = 0;
    for (const { li, p } of rows) {
      li.hidden = !matches(p, q);
      shown += li.hidden ? 0 : 1;
    }
    for (const g of groups) g.el.hidden = g.mine.every((li) => li.hidden);
    count.textContent = !q ? `${list.count} presets.` : shown ? `${shown} of ${list.count} presets match "${q}".` : `No preset matches "${q}".`;
    if (!tabbed || tabbed.closest("[hidden]")) rove(visible()[0] || null);
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      const first = visible()[0];
      if (!first) return;
      e.preventDefault();
      rove(first);
      first.focus();
    } else if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      filter();
    }
  });
  filter();

  // the firmware's sound on the selected track, as the worklet read it
  const show = (s) => {
    const p = presetOf(list, s);
    trackSel.value = String(s.track);
    nowTitle.textContent = titleOf(list, s);
    nowKnobs.replaceChildren(...s.knobs.filter((k) => k.label).map((k) => {
      const cell = document.createElement("span"), label = document.createElement("small"), value = document.createElement("b");
      label.textContent = k.label;
      value.textContent = k.value;
      cell.append(label, value);
      return cell;
    }));
    for (const b of buttons) {
      if (p && Number(b.dataset.index) === p.index) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  };

  const pick = async (p) => {
    const me = ++latest;
    if (!link) {
      say(`Switch the FM-1 on above, then pick ${p.name} again: the sound comes from the running firmware.`);
      return;
    }
    try {
      alertPage("");
      const track = Number(trackSel.value);
      const got = await link.client.apply(track, p.index);
      if (got.track !== track || presetOf(list, got) !== p) {
        throw new Error(`The FM-1 has "${got.name}" (${engineOf(list, got)}) on T${got.track + 1}, not ${p.name} on T${track + 1}: ` +
          "the list and the firmware are out of step. Reload the page.");
      }
      show(got);
      if (me !== latest) return;
      say(`${p.name} is on T${track + 1}: ${p.engine}, ${p.desc}. Knobs: ${knobText(got)}.`);
      await link.play();
    } catch (e) {
      fail(e && e.message || String(e));
    }
  };
  listEl.addEventListener("click", (e) => {
    const b = e.target.closest("button.preset");
    if (!b) return;
    rove(b);
    pick(list.presets[Number(b.dataset.index)]);
  });
  listEl.addEventListener("keydown", (e) => {
    const b = e.target.closest("button.preset");
    if (!b || e.metaKey || e.ctrlKey || e.altKey) return;
    const items = visible(), i = items.indexOf(b), to = (t) => {
      e.preventDefault();
      if (t) {
        rove(t);
        t.focus();
      }
    };
    if (e.key === "ArrowRight") to(items[i + 1]);
    else if (e.key === "ArrowLeft") to(items[i - 1]);
    else if (e.key === "ArrowDown") to(vertical(items, b, 1));
    else if (e.key === "ArrowUp") to(vertical(items, b, -1));
    else if (e.key === "Home") to(items[0]);
    else if (e.key === "End") to(items.at(-1));
    else if (link && link.panel.shortcuts.checked && (link.panel.keymap[e.code] || {}).key !== undefined) {
      e.preventDefault();                         // the computer keys play the sound from the list too
      if (!e.repeat) link.panel.hold("k" + e.code, "key", link.panel.keymap[e.code].key);
    }
  });
  again.addEventListener("click", async () => {
    try {
      await link.play();
    } catch (e) {
      fail(e && e.message || String(e));
    }
  });
  trackSel.addEventListener("change", async () => {
    try {
      const got = await link.client.track(Number(trackSel.value));
      show(got);
      say(`T${got.track + 1} is selected: ${got.name || "no name"}, ${engineOf(list, got)}. The keys play it.`);
    } catch (e) {
      fail(e && e.message || String(e));
    }
  });

  return {
    // the firmware is on: `connection` is { client, play, panel }
    async join(connection) {
      try {
        link = connection;
        link.client.onState(show);
        await link.client.watch(true);
        show(await link.client.info());
        for (const b of buttons) b.removeAttribute("aria-disabled");
        trackSel.disabled = again.disabled = false;
        off.hidden = true;
        say("");
      } catch (e) {
        link = null;
        fail(`The Preset lab could not start: ${e && e.message || e}`);
      }
    },
  };
}

let built = null;

// the list, from the page's own script as it loads; the promise is the view connect() joins to the firmware
export function start() {
  if (!built) built = build();
  return built;
}

// the emulator is on (app.js attach): join the list to the running firmware once the worklet says it is ready
export async function connect(ctx) {
  if (!built) throw new Error("The Preset lab was not started by the page.");
  const port = ctx.node.port;
  const ready = new Promise((resolve) => port.addEventListener("message", (e) => { if (e.data.type === "ready") resolve(); }));
  port.start();
  const view = await built;
  await ready;
  const panel = { hold: holdDown, release: letGo, edit: BTN.EDIT, white: WHITE_K, keymap: KEYMAP, shortcuts };
  await view.join({ client: client(port), play: player({ ...panel, sleep }), panel });
}
