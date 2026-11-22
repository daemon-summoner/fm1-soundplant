// SPDX-License-Identifier: MPL-2.0
// The Backup page's "Put demo songs on my FM-1" card: the demo songs the emulator's picker offers (emu/demos/) put into the FM-1's
// empty project slots, and nothing else on it changed. It takes a backup, adds the songs with addDemoSlots()
// (app/web/project/soundplant_project.js) and restores that, so the FM-1 asks RESTORE FROM USB? as for any restore.
// tools/make_pages.py inlines it after the project codec, in the page's script; it uses the page's PB, FW, connect, say,
// sayProgress, progress, setBusy, esc, bar and busy at click time. tests/host/backup_web.mjs runs the assembled page.
const DEMO_DIR = "../emu/demos/";
const DEMO_STYLE = `
.demos { border: 0; margin: 0 0 .8rem; padding: 0; }
.demos legend { font-weight: 600; padding: 0; margin-bottom: .4rem; }
.demos label { display: flex; gap: .6rem; align-items: baseline; margin: 0 0 .5rem; cursor: pointer; }
.demos label span { display: block; color: var(--muted); font-size: .92rem; }
.demos input { accent-color: var(--teal); flex: none; }`;

function demoEl(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...kids);
  return el;
}

// "slot 2", "slots 2 and 3", "slots 1, 2 and 3" from slot indexes 0 to 2
function demoSlotWords(slots) {
  const n = slots.map((s) => s + 1);
  return n.length === 1 ? `slot ${n[0]}` : `slots ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

async function demoGet(url, what) {
  let r;
  try { r = await fetch(url); } catch (e) { throw new Error(`${what} did not download (${e.message}). Check your internet connection and try again.`); }
  if (!r.ok) throw new Error(`${what} did not download: the server answered ${r.status}${r.statusText ? " " + r.statusText : ""}. Try again later.`);
  return r;
}

async function demoCatalog() {
  const r = await demoGet(DEMO_DIR + "demos.json", "The list of demo songs");
  let list;
  try { list = await r.json(); } catch (e) { throw new Error(`The list of demo songs is not readable (${e.message}). Try again later.`); }
  const ok = (d) => d && typeof d.file === "string" && typeof d.genre === "string" && typeof d.blurb === "string" && Number.isFinite(d.bpm);
  if (!Array.isArray(list) || !list.length || !list.every(ok)) throw new Error("The list of demo songs is not what this page expects. Try again later.");
  return list;
}

async function demoBytes(url, what) {
  const r = await demoGet(url, what);
  try { return new Uint8Array(await r.arrayBuffer()); } catch (e) { throw new Error(`${what} did not download (${e.message}). Try again.`); }
}

const demoStopFirst = () => `<b>STOP FIRST.</b> ${esc(FW.name)} is playing. Press <kbd>PLAY</kbd> on the FM-1 to stop it, then try again. Nothing changed.`;

function demoInstall() {
  const rh = document.getElementById("rh");
  if (!rh || !rh.parentElement) throw new Error("The Backup page has no Restore card for the demo songs card to follow.");
  const show = demoEl("button", { id: "demoShow", type: "button", className: "primary", textContent: "Look at my FM-1" });
  const slotsNote = demoEl("p", { id: "demoSlots" });
  const songs = demoEl("fieldset", { className: "demos" });
  const go = demoEl("button", { id: "demoGo", type: "button", className: "primary", disabled: true });
  const pick = demoEl("div", { id: "demoPick", hidden: true }, slotsNote, songs, demoEl("div", { className: "row" }, go));
  const askText = demoEl("p", { id: "demoAskText" });
  const yes = demoEl("button", { id: "demoYes", type: "button", className: "primary", textContent: "Put them on my FM-1" });
  const no = demoEl("button", { id: "demoNo", type: "button", className: "quiet", textContent: "Cancel" });
  const ask = demoEl("div", { id: "demoAsk", className: "ask", hidden: true }, askText, demoEl("div", { className: "row" }, yes, no));
  ask.setAttribute("role", "group");
  ask.setAttribute("aria-labelledby", "demoAskText");
  const card = demoEl("section", { className: "card" },
    demoEl("h2", { id: "demoHead", textContent: "Put demo songs on my FM-1" }),
    demoEl("p", {
      textContent: "SoundPlant's demo songs, the ones the emulator plays. This puts the ones you choose into empty project slots on your FM-1 " +
        "and changes nothing else: a slot with a project in it, your presets and your samples stay as they are. Stop SoundPlant first. " +
        "Your FM-1 needs the latest SoundPlant (the Install page has it): an older one cannot open these songs.",
    }),
    demoEl("div", { className: "row" }, show), pick, ask);
  card.setAttribute("aria-labelledby", "demoHead");
  document.head.append(demoEl("style", { textContent: DEMO_STYLE }));
  rh.parentElement.after(card);

  let list = null, backup = null, free = [], chosen = null, plan = null;
  const boxes = [];
  const picks = () => boxes.flatMap((b, i) => (b.checked ? [i] : []));
  const sync = () => {
    const n = picks().length;
    go.disabled = busy || n === 0;
    go.textContent = n > 1 ? `Put ${n} songs on my FM-1` : "Put the song on my FM-1";
    for (const b of boxes) b.disabled = busy || (!b.checked && n >= free.length);
  };
  const lock = (on) => {
    setBusy(on);
    show.disabled = on;
    if (on) ask.hidden = true;
    sync();
  };
  const reset = () => {
    pick.hidden = true;
    ask.hidden = true;
    boxes.length = 0;
    backup = chosen = plan = null;
    free = [];
  };
  const fail = (e) => { progress(null); say(esc(e.message), "err"); };
  const takeBackup = async (link) => {
    say(`Receiving the backup from ${esc(FW.name)}&hellip;`);
    progress(0);
    const got = await PB.backup(link, (n) => { sayProgress(`Receiving the backup: ${n.toLocaleString("en")} bytes`); bar.removeAttribute("value"); });
    progress(null);
    return got;
  };

  async function look() {
    if (busy) return;
    reset();
    lock(true);
    let dev = null;
    try {
      list = await demoCatalog();
      dev = await connect();
      const got = await takeBackup(dev.link);
      if (got.flags & 1) { say(demoStopFirst(), "err"); return; }
      free = emptySlots(got.image);
      if (!free.length) {
        say(`All three project slots on ${esc(FW.name)} hold a project, so a demo song has no slot to go in. The demos only go into empty slots. Nothing changed.`, "err");
        return;
      }
      backup = got.image;
      slotsNote.textContent = free.length === 1
        ? `${demoSlotWords(free)} on your FM-1 is empty, so you can put one song on it.`
        : `${demoSlotWords(free)} on your FM-1 are empty, so you can put up to ${free.length} songs on them.`;
      songs.replaceChildren(demoEl("legend", { textContent: "Demo songs" }), ...list.map((d) => {
        const box = demoEl("input", { type: "checkbox" });
        box.addEventListener("change", () => { ask.hidden = true; sync(); });
        boxes.push(box);
        return demoEl("label", {}, box, demoEl("div", {}, demoEl("b", { textContent: `${d.genre}, ${d.bpm} bpm` }), demoEl("span", { textContent: d.blurb })));
      }));
      pick.hidden = false;
      say(`Choose ${free.length === 1 ? "the song" : `up to ${free.length} songs`} to put in ${demoSlotWords(free)}.`);
    } catch (e) {
      fail(e);
    } finally {
      if (dev) dev.link.close();
      lock(false);
    }
  }

  async function review() {
    const at = picks();
    if (busy || !at.length) return;
    lock(true);
    try {
      say("Downloading the demo songs&hellip;");
      const got = [];
      for (const i of at) got.push({ name: list[i].genre, bytes: await demoBytes(DEMO_DIR + list[i].file, `The demo song ${list[i].genre}`) });
      const merged = addDemoSlots(backup, got);
      chosen = got;
      plan = merged.placed;
      askText.textContent = `Put ${got.length === 1 ? "1 song" : `${got.length} songs`} in ${demoSlotWords(plan.map((p) => p.slot))} ` +
        `(${plan.map((p) => p.name).join(", ")})? Nothing else changes. Save your project on the FM-1 first: unsaved changes are lost.`;
      ask.hidden = false;
      yes.focus();
      say("The songs are downloaded. Answer the question below to put them on your FM-1.");
    } catch (e) {
      fail(e);
    } finally {
      lock(false);
    }
  }

  // the FM-1 may have been saved to since the first look (the question says to): the songs go into the slots empty now,
  // and the question that was answered must still be true of them
  function remerge(image) {
    let merged;
    try { merged = addDemoSlots(image, chosen); } catch (e) {
      if (!(e instanceof ProjectError)) throw e;
      reset();
      throw new Error(`${e.message} Nothing changed. Press Look at my FM-1 to start again.`);
    }
    if (merged.placed.some((p, i) => p.slot !== plan[i].slot)) {
      const now = demoSlotWords(merged.placed.map((p) => p.slot)), was = demoSlotWords(plan.map((p) => p.slot));
      reset();
      throw new Error(`The empty slots changed since you chose: the songs would now go in ${now}, not ${was}. Nothing changed. Press Look at my FM-1 to start again.`);
    }
    return merged;
  }

  async function put() {
    if (busy || !plan) return;
    lock(true);
    let dev = null;
    try {
      dev = await connect();
      const now = await takeBackup(dev.link);
      if (now.flags & 1) { say(demoStopFirst(), "err"); return; }
      const merged = remerge(now.image);
      const where = demoSlotWords(merged.placed.map((p) => p.slot));
      say(`Sending the songs to ${esc(FW.name)}&hellip;`);
      progress(0);
      const code = await PB.restore(dev.link, merged.bytes, (what, pct) => {
        if (what === "progress") { sayProgress(`Sending the songs: ${Math.floor(pct)} percent`, Math.floor(pct)); progress(pct); }
        if (what === "ask") {
          progress(100);
          say(`Sent and checked. ${esc(FW.name)} now asks <b>RESTORE FROM USB?</b> on the FM-1. Press <kbd>SEL</kbd> to put the songs on, or <kbd>HOME</kbd> to keep what you have.`, "ask");
        }
      });
      progress(null);
      if (code === 0) {
        reset();
        say(`Done. ${esc(FW.name)} has ${merged.placed.length === 1 ? "the song" : "the songs"} in ${where}, and reloaded everything. To play one, hold <kbd>HOME</kbd> and press the white key for its slot (1 to 3).`);
      } else if (code === PB.PLAYING) say(demoStopFirst(), "err");
      else if (code === PB.DECLINED) say("Not restored. Someone pressed <kbd>HOME</kbd> on the FM-1, or nobody answered within a minute. Nothing changed.", "err");
      else say(`Not restored. There was a problem with ${esc(PB.ERRORS[code] || "code " + code)}.` + (code === 12 ? "" : " Nothing changed. Try again."), "err");
    } catch (e) {
      fail(e);
    } finally {
      if (dev) dev.link.close();
      lock(false);
    }
  }

  show.addEventListener("click", look);
  go.addEventListener("click", review);
  yes.addEventListener("click", put);
  no.addEventListener("click", () => { ask.hidden = true; go.focus(); });
}

demoInstall();
