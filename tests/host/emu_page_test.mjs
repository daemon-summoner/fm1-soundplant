// SPDX-License-Identifier: MPL-2.0
// The browser build as the page runs it (./build.sh --web): fm1-base's page with SoundPlant's bits (tools/emu_page.py),
// its worklet with the emulator's parts, among them "resample": in a browser whose audio runs at 48 kHz (many Macs)
// the FM-1's clock keeps the page's time (without it SoundPlant plays 48/44.1 fast and high). fm1-base's worklet under
// node (base/tests/emu_harness.mjs). The garden's feed too: what the firmware's tracks do, as the page's garden gets it.
//   node tests/host/emu_page_test.mjs app/build/emu
import { existsSync, readFileSync } from "node:fs";
import { startEmu, check, done } from "../../base/tests/emu_harness.mjs";
import { PANEL_BTN, PANEL_ENC, PANEL_WHITE_K } from "../../base/web/fm1panel.js";

const dir = process.argv[2] || "app/build/emu";
const page = readFileSync(`${dir}/index.html`, "utf8");
check(page.includes("<title>SoundPlant in the browser</title>") && page.includes('<section class="help">'), "fm1-base's page with SoundPlant's name and help");
check(page.includes("{{") === false, "no placeholder left in the page");
const read = (f) => existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, "utf8") : "";
check(read("app_own.js").includes("SoundPlant") && read("app.js").includes("app_own.js"), "SoundPlant's app.js on the page");
check(read("app_worklet.js").includes("resample_worklet.js") && existsSync(`${dir}/parts/resample_worklet.js`), "the worklet has the part resample");
// Space is PLAY and Enter is REC from the first key after switching on, where the page has focused a knob without a Tab:
// only a control reached with Tab keeps them to press itself
const own = await import(`data:text/javascript;base64,${Buffer.from(read("app_own.js")).toString("base64")}`);
const f = own.tabFocus();
check(!f.keeps(" ", true) && !f.keeps("Enter", true), "Space and Enter are the panel's keys on a control focused without Tab");
f.tab();
check(f.keeps(" ", true) && f.keeps("Enter", true), "after Tab, Space and Enter press the control that has the focus");
check(!f.keeps(" ", false) && !f.keeps("p", true), "after Tab, off the controls and other keys are still the panel's");
f.pointer();
check(!f.keeps(" ", true), "a click or touch gives Space back to PLAY");
const emu = await startEmu(dir, { sampleRate: 48000 });
emu.run(500);
const t0 = emu.ex.web_now();
emu.run(1000);
const ms = emu.ex.web_now() - t0;
check(Math.abs(ms - 1000) <= 12, `at 48 kHz the FM-1 ran ${ms} ms in the page's 1000`);

// the garden: the page has it, the build carries its modules, and the worklet feeds it only while it is open
check(page.includes('<section class="garden"') && page.includes('id="garden-open"'), "the page has the garden and its button");
check(["garden.js", "garden_core.js", "garden_gl.js"].every((f) => existsSync(`${dir}/${f}`)), "the build has the garden's three modules");
check(page.includes('id="garden-screen"') && /\.garden-screen-pop\s+\.device canvas/.test(page) && page.includes("garden-screen-huge"),
  "the page has the Screen button and the styles that pop the FM-1's screen out of its panel");
check(!/^\s*(import\s*["']\.|(import|export)\b[^\n]*\bfrom\s*["']\.)/m.test(read("app_own.js")), "app.js loads the garden only when it is opened (no static relative import)");
const { decodeSnapshot, stepOn, seedFromSnapshot, SNAP_SIZE } = await import(`data:text/javascript;base64,${Buffer.from(read("garden_core.js")).toString("base64")}`);
const tap = (kind, mask) => { emu.send({ type: kind, mask }); emu.run(100); emu.send({ type: kind, mask: 0 }); emu.run(100); };
const BTN = { HOME: 1 << 6, SEQ: 1 << 9, PLAY: 1 << 10 };
const feed = () => emu.take("app").filter((m) => m.garden !== undefined);
emu.take("app");
tap("buttons", BTN.PLAY);
emu.run(1000);
check(feed().length === 0, "the garden closed: the worklet posts no snapshot, even while the FM-1 plays");
tap("buttons", BTN.PLAY);

emu.send({ type: "app", garden: true });
emu.run(1000);
const idle = feed();
check(idle.length >= 58 && idle.length <= 63, `the garden open: ${idle.length} snapshots in the page's second (60 a second)`);
check(idle.every((m, i) => typeof m.at === "number" && (i === 0 || m.at > idle[i - 1].at)) && idle.every((m) => m.garden.byteLength === SNAP_SIZE),
  "each snapshot has the page's clock and the size the page decodes, in time order");
let snap = decodeSnapshot(idle.at(-1).garden);
check(!snap.playing && snap.trk.every((k) => k.hits === 0 && k.maskLo === 0 && k.maskHi === 0), "a new project that stands still: nothing plays, no track has steps or hits");
check(snap.trk.length === 8 && snap.tempo === 120 && snap.trk[0].engine === 8, `eight tracks, 120 bpm, track 1 a drumline (engine ${snap.trk[0].engine})`);

tap("buttons", BTN.SEQ);
tap("keys", 1 << 0);
emu.run(300);
snap = decodeSnapshot(feed().at(-1).garden);
check(stepOn(snap.trk[0], 0) && !stepOn(snap.trk[0], 1) && snap.trk.slice(1).every((k) => k.maskLo === 0 && k.maskHi === 0),
  "a step set on track 1 is on its pattern mask (step 1 only), and no other track has one");
tap("buttons", BTN.PLAY);
feed();
emu.run(3000);
snap = decodeSnapshot(feed().at(-1).garden);
check(snap.playing && snap.stepTick > 0, `playing: the step clock runs (${snap.stepTick})`);
check(snap.trk[0].hits >= 1 && snap.trk.slice(1).every((k) => k.hits === 0), `track 1 played its step (${snap.trk[0].hits} hits) and the empty tracks played none`);

emu.send({ type: "app", garden: false });
feed();
emu.run(500);
check(feed().length === 0, "the garden closed again: the snapshots stop");

// the demo picker (app.js, tools/make_demos.py): a demo's image restored into the running firmware through the worklet's
// backup part, as the page does it; the firmware still plays the project above
check(["demos", "demo-play", "demo-load", "demo-undo", "demos-confirm", "demo-yes", "demo-no"].every((id) => page.includes(`id="${id}"`)),
  "the page has the demo picker, its confirmation and its Undo");
const demos = JSON.parse(read("demos/demos.json") || "[]");
check(demos.length >= 10 && new Set(demos.map((d) => d.id)).size === demos.length && demos.every((d) => existsSync(`${dir}/demos/${d.file}`)),
  `${demos.length} demos listed, each with its image`);
const imageOf = (d) => { const b = readFileSync(`${dir}/demos/${d.file}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const ask = (m) => { emu.take("backup"); emu.send({ type: "app", part: "backup", ...m }); emu.run(50); return emu.take("backup").at(-1); };
const look = () => { feed(); emu.run(100); return decodeSnapshot(feed().at(-1).garden); };
const techno = demos.find((d) => d.id === "techno");
const patTracks = new Set([...readFileSync(new URL("../../tools/demos/web/techno.xy", import.meta.url), "utf8").matchAll(/^pat ([1-8]) /gm)].map((m) => m[1])).size;

emu.send({ type: "app", garden: true });
emu.run(200);
snap = look();
const own120 = ask({ cmd: "make" });
check(snap.playing && snap.tempo === 120 && own120.playing === true, "before a demo: the firmware plays the 120 bpm project, and the backup part says it plays");
const refused = ask({ cmd: "restore", image: imageOf(techno) });
emu.run(200);
snap = look();
check(refused.restored === 10 && snap.playing && snap.tempo === 120 && stepOn(snap.trk[0], 0) && snap.trk.slice(1).every((k) => k.maskLo === 0 && k.maskHi === 0),
  `a restore while it plays is refused (rc ${refused.restored}) and the project is as it was`);
tap("buttons", BTN.PLAY);
emu.run(300);
snap = look();
check(!snap.playing && ask({ cmd: "make" }).playing === false, "stopped: the firmware and the backup part agree");

const fresh = seedFromSnapshot(snap);
const ok = ask({ cmd: "restore", image: imageOf(techno) });
emu.run(300);
snap = look();
check(ok.restored === 0 && snap.tempo === techno.bpm && snap.trk.filter((k) => k.maskLo | k.maskHi).length === patTracks,
  `the techno demo restored: ${snap.tempo} bpm, ${snap.trk.filter((k) => k.maskLo | k.maskHi).length} tracks with steps (its script has ${patTracks})`);
check(snap.trk.slice(0, 6).map((k) => k.engine).join() === "8,10,3,1,2,5", `its engines: drumline, acid, bellows, rayon, jacquard, voile (${snap.trk.map((k) => k.engine)})`);
check(seedFromSnapshot(snap) !== fresh, "the garden's seed has changed: the demo grows its own garden");

// the picker's "Load and play": SEQ, HOME and one SELECT step lead to the Song page from any page, then PLAY plays the song
tap("buttons", BTN.SEQ);
tap("buttons", BTN.HOME);
emu.send({ type: "enc", role: 0, n: 1 });
emu.run(150);
let was = snap.trk.map((k) => k.hits);
tap("buttons", BTN.PLAY);
feed();
emu.run(2500);
snap = decodeSnapshot(feed().at(-1).garden);
let gained = snap.trk.map((k, i) => k.hits - was[i]);
check(snap.playing && snap.scene === 0 && gained[0] > 0 && gained[5] > 0 && [1, 2, 3, 4].every((i) => gained[i] === 0),
  `the song plays from its intro: the kit and the voile play (${gained[0]}, ${gained[5]} hits), the 303, the stabs, the tubular and the pad wait`);
const introMs = Math.round((8 * 4 * 60000) / techno.bpm);
emu.run(introMs + 700 - 2500);
snap = decodeSnapshot(feed().at(-1).garden);
gained = snap.trk.map((k, i) => k.hits - was[i]);
check(snap.playing && snap.scene === 2 && snap.songPos === 2 && gained[1] > 0, `after its two intro scenes (8 bars, ${introMs} ms) the song moved on to its groove: the 303 plays (${gained[1]} hits)`);

// negative: while the demo plays, another one is refused and the playing one stays
const garage = demos.find((d) => d.id === "garage");
const second = ask({ cmd: "restore", image: imageOf(garage) });
emu.run(200);
snap = look();
check(second.restored === 10 && snap.playing && snap.tempo === techno.bpm, `a second demo while one plays is refused (rc ${second.restored}); it stays at ${snap.tempo} bpm`);
tap("buttons", BTN.PLAY);
emu.run(300);

// negative: an image that is not this firmware's or is damaged is refused with the code the picker words, and nothing changes
const damaged = new Uint8Array(imageOf(garage));
damaged[40] ^= 0xff;
const bad = ask({ cmd: "restore", image: damaged.buffer });
emu.run(200);
snap = look();
check(bad.restored !== 0 && bad.restored !== 10 && snap.tempo === techno.bpm, `a damaged image is refused (rc ${bad.restored}) and the project stays`);

// every demo restores, and plays: the tempo the list names, tracks with steps, and notes started within 3 s of PLAY
for (const d of demos) {
  const r = ask({ cmd: "restore", image: imageOf(d) });
  emu.run(200);
  snap = look();
  const tracks = snap.trk.filter((k) => k.maskLo | k.maskHi).length;
  was = snap.trk.map((k) => k.hits);
  tap("buttons", BTN.SEQ);
  tap("buttons", BTN.HOME);
  emu.send({ type: "enc", role: 0, n: 1 });
  emu.run(150);
  tap("buttons", BTN.PLAY);
  feed();
  emu.run(3000);
  const p = decodeSnapshot(feed().at(-1).garden);
  const played = p.trk.reduce((n, k, i) => n + k.hits - was[i], 0);
  check(r.restored === 0 && snap.tempo === d.bpm && tracks >= 4 && p.playing && played > 0,
    `${d.id}: restored (rc ${r.restored}), ${snap.tempo} of ${d.bpm} bpm, ${tracks} tracks with steps, ${played} notes in 3 s of PLAY`);
  tap("buttons", BTN.PLAY);
  emu.run(200);
}
// the garden's seed hashes the engines and steps, so every demo grows its own garden
const seeds = new Set();
for (const d of demos) {
  ask({ cmd: "restore", image: imageOf(d) });
  emu.run(200);
  seeds.add(seedFromSnapshot(look()));
}
check(seeds.size === demos.length, `the ${demos.length} demos grow ${seeds.size} different gardens`);

// the Preset lab (presets.js, the worklet's lab commands, app/web.c web_preset), through the real worklet: the page's own
// client and player drive the firmware as the page does. Last, because it changes the project.
check(["presets", "presets-search", "presets-track", "presets-again", "presets-count", "presets-list", "presets-now-title", "presets-now-knobs",
  "presets-status", "presets-error"].every((id) => page.includes(`id="${id}"`)) && page.includes('import("./presets.js")') && /html\.garden-on\s+\.presets/.test(page),
  "the page has the Preset lab, loads its module, and hides it while the garden is open");
check(existsSync(`${dir}/presets.js`) && existsSync(`${dir}/presets.json`), "the build has the lab's module and its list");
const labJs = await import(`data:text/javascript;base64,${Buffer.from(read("presets.js")).toString("base64")}`);
const presets = JSON.parse(read("presets.json") || "{}");
const engineId = (name) => presets.engines.indexOf(name);
const listeners = [];
const deliver = () => {                         // the worklet's lab messages to the client, as the page's port gets them
  for (let i = 0; i < emu.msgs.length;) {
    const m = emu.msgs[i];
    if (m.type === "app" && m.lab) { emu.msgs.splice(i, 1); for (const f of listeners) f({ data: m }); } else i++;
  }
};
const pump = (ms) => { for (let t = 0; t < ms; t += 10) { emu.run(10); deliver(); } };
const lab = labJs.client({ addEventListener: (type, f) => { if (type === "message") listeners.push(f); }, postMessage: (m) => { emu.send(m); deliver(); } });
const rejected = async (promise) => { try { await promise; return ""; } catch (e) { return e.message || "(no words)"; } };

// the list is the firmware's table: the count, and every index puts the preset of that name and engine on the track
const countOk = (l) => l.presets.length === l.count && l.count === emu.ex.web_presets();
check(countOk(presets) && !countOk({ ...presets, presets: presets.presets.slice(1) }) && !countOk({ ...presets, count: presets.count + 1 }),
  `presets.json lists ${presets.count} presets, as many as the firmware has (${emu.ex.web_presets()}); a list one short, or a count one over, is not`);
const got = [];
let mismatch = [];
for (const p of presets.presets) {
  const s = await lab.apply(5, p.index);
  snap = look();
  got.push(s.name);
  if (s.name !== p.name || s.engine !== engineId(p.engine) || snap.trk[5].engine !== s.engine || s.track !== 5) mismatch.push(`${p.index} ${p.name}`);
}
check(got.length === presets.count && mismatch.length === 0 && !got.every((n, i) => n === presets.presets[(i + 1) % got.length].name),
  `all ${got.length} presets applied by index to T6: the firmware's name and engine (and the garden's) are the list's (wrong: ${mismatch.slice(0, 4)})`);

// a preset goes on the track asked for, becomes the selected one, and leaves the other tracks alone
snap = look();
const before = snap.trk.map((k) => k.engine), hitsBefore = snap.trk.map((k) => k.hits);
const bell = presets.presets.find((p) => engineId(p.engine) !== before[2] && p.engine === "rayon") || presets.presets.find((p) => engineId(p.engine) !== before[2]);
let st = await lab.apply(2, bell.index);
snap = look();
check(st.track === 2 && st.name === bell.name && snap.trk[2].engine === engineId(bell.engine) && snap.trk[2].engine !== before[2]
  && snap.trk.every((k, i) => i === 2 || k.engine === before[i]),
  `${bell.name} (${bell.engine}) on T3: its engine ${before[2]} -> ${snap.trk[2].engine}, the other seven tracks' engines the same`);
check(st.knobs.length === 4 && st.knobs.every((k) => k.label && k.value) && st.knobs[0].label === presets.groups.find((g) => g.engine === bell.engine).knobs[0],
  `the firmware's knob labels are read back: ${labJs.knobText(st)}`);

// the audition: the page's player on the real keys, one preset of each engine; the sound comes from the keys, and from the
// selected track alone
const held = {}, mask = { btn: 0, key: 0 };
const send = (kind) => emu.send({ type: kind === "btn" ? "buttons" : "keys", mask: mask[kind] >>> 0 });
let peak = 0;
const play = labJs.player({
  hold: (id, kind, v) => { held[id] = { kind, v }; mask[kind] |= 1 << v; send(kind); },
  release: (id) => { const h = held[id]; if (!h) return; delete held[id]; mask[h.kind] &= ~(1 << h.v); send(h.kind); },
  sleep: async (ms) => { peak = Math.max(peak, emu.run(ms)); deliver(); },
  edit: PANEL_BTN.EDIT,
  white: PANEL_WHITE_K,
});
const loud = [];
for (const g of presets.groups) {
  const p = presets.presets.find((q) => q.engine === g.engine);
  await lab.apply(2, p.index);
  emu.run(2500);
  const quiet = emu.run(300);
  snap = look();
  const hits = snap.trk.map((k) => k.hits);
  peak = 0;
  await play();
  snap = look();
  const gained = snap.trk.map((k, i) => k.hits - hits[i]);
  loud.push({ engine: g.engine, name: p.name, quiet, peak, own: gained[2], others: gained.filter((n, i) => i !== 2).reduce((a, b) => a + b, 0) });
}
const heard = loud.filter((l) => l.peak > 0.02 && l.peak > 10 * l.quiet && l.own >= 3 && l.others === 0);
check(heard.length >= 3 && new Set(heard.map((l) => l.engine)).size === heard.length,
  `the audition is heard on ${heard.length} of ${loud.length} engines (${loud.map((l) => `${l.engine} ${l.peak.toFixed(2)}`).join(", ")}), each phrase played its three notes on T3 and no other track`);
check(loud.every((l) => l.quiet < 0.005), `with no key down a preset is silent (loudest ${Math.max(...loud.map((l) => l.quiet)).toFixed(4)} before the phrase)`);

// a request that is wrong is refused in words the page shows, and nothing changes
const prior = await lab.info();
const wrongs = [[2, 9999], [2, presets.count], [2, -1], [2, 1.5], [2, NaN], [2, "3"], [2, 2 ** 32 + 3], [8, 0], [-1, 0], [2.5, 0], [2 ** 32 + 2, 0]];
const answers = [];
for (const [track, index] of wrongs) answers.push(await rejected(lab.apply(track, index)));
check(answers.every((a) => a) && /no preset 9999/i.test(answers[0]) && answers[0].includes(String(presets.count)),
  `${wrongs.length} wrong requests (past the last preset, negative, fractional, NaN, a string, a wrapped 32-bit number, a track that is not one) are all refused: "${answers[0]}" / "${answers[7]}"`);
const now = await lab.info();
snap = look();
check(now.name === prior.name && now.engine === prior.engine && now.track === prior.track && snap.trk[2].engine === now.engine,
  "after those refusals the track still has its sound");
check(!(await rejected(lab.apply(2, 0))) && (await lab.info()).name === presets.presets[0].name, "and the next good request works");
emu.send({ type: "app", lab: { op: "bogus", id: 99 } });
const bogus = emu.take("app").find((m) => m.lab === "bogus");
check(bogus && bogus.ok === false && /no command/.test(bogus.error) && bogus.id === 99, `an unknown lab command is answered with an error ("${bogus && bogus.error}")`);
const silent = labJs.client({ addEventListener() {}, postMessage() {} }, 30);
check(/did not answer/.test(await rejected(silent.info())), "a worklet that does not answer is an error, not a wait that never ends");

// the selected track: a track that is none is refused, one that is is selected and the keys play it
st = await lab.track(3);
check(st.track === 3 && /no track 8/.test(await rejected(lab.track(8))) && (await lab.info()).track === 3, "T4 selected; a track 8 is refused and T4 stays selected");

// what a knob turn does shows at once, and only while someone watches: the lab asks for it
const states = [];
lab.onState((s) => states.push(s));
await lab.watch(true);
pump(300);
const first = states.at(-1);
states.length = 0;
pump(500);
check(first && first.knobs.length === 4 && states.length === 0, "watched: the state arrives once, then nothing while nothing changes");
emu.send({ type: "enc", role: PANEL_ENC.KNOB1, n: 3 });
pump(300);
check(states.length >= 1 && states.at(-1).knobs[0].label === first.knobs[0].label && states.at(-1).knobs[0].value !== first.knobs[0].value,
  `KNOB 1 turned: "${first.knobs[0].label} ${first.knobs[0].value}" becomes "${states.at(-1) && states.at(-1).knobs[0].label} ${states.at(-1) && states.at(-1).knobs[0].value}" in the lab's state`);
await lab.watch(false);
states.length = 0;
emu.send({ type: "enc", role: PANEL_ENC.KNOB1, n: 3 });
pump(300);
check(states.length === 0, "not watched: no state is posted");

// HOME held and REC undoes a preset, as the page says
const keep = await lab.info();
const other = presets.presets.find((p) => p.name !== keep.name && p.engine !== presets.engines[keep.engine]);
await lab.apply(keep.track, other.index);
for (const m of [1 << PANEL_BTN.HOME, (1 << PANEL_BTN.HOME) | (1 << PANEL_BTN.REC), 1 << PANEL_BTN.HOME, 0]) {
  emu.send({ type: "buttons", mask: m });
  pump(100);
}
const undone = await lab.info();
check(undone.name === keep.name && undone.engine === keep.engine, `HOME held and REC puts ${keep.name} back after ${other.name}`);

// the name read back: preset and engine, the engine once for a sound named for it, a sound of the user's own by its name
const asked = (name, engine) => labJs.titleOf(presets, { track: 2, engine: engineId(engine), name, knobs: [] });
check(asked("soft lead", "knit") === "T3: soft lead, knit" && asked("kit", "kit") === "T3: kit" && asked("my pad", "rayon") === "T3: my pad, rayon"
  && asked("", "acid") === "T3: no name, acid" && asked("knit", "rayon") === "T3: knit, rayon",
  "the lab's title: preset and engine, a name that is the engine's said once, a name of the user's own kept, none worded");

// the filter
const byWord = (w) => presets.presets.filter((p) => labJs.matches(p, w)).length;
check(byWord("") === presets.count && byWord("rayon") === presets.presets.filter((p) => p.engine === "rayon").length && byWord("GLASS bell") >= 1
  && byWord("glass") > byWord("glass rayon") && byWord("zzzz") === 0,
  `the filter: all ${byWord("")} for no words, ${byWord("rayon")} for an engine, "glass" ${byWord("glass")} and "glass rayon" ${byWord("glass rayon")}, none for nonsense`);
done();
