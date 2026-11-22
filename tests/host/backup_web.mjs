// SPDX-License-Identifier: MPL-2.0
// The backup page's sample section (app/web/backup/extras.js on app/web/samples/soundplant_samples.js, assembled as
// tools/make_pages.py assembles it) against a simulated FM-1 speaking app/samples.c's commands (INFO 15, READ 17,
// BEGIN 11, WRITE 12, HDR 16, END 13, ERASE 14), and against the command line (tools/soundplant_samples.py, fm1_backup.py):
//   1. a backup reads the bank back byte for byte: the image soundplant_samples.py checks; an empty bank: a header alone
//   2. a restore writes it back: the FM-1's bank equals it; an empty bank's restore erases
//   3. answers lost on the way (a read, a write): asked again, the same result; a late answer is not taken
//   4. a damaged section: refused before anything is sent; an FM-1 that refuses (rc): said
//   5. the .soundplant file the page writes (fm1-base's join) is one fm1_backup.py splits and soundplant_samples.py restores from
//   6. the demo songs card (app/web/backup/demos.js on the project codec), in the page as tools/make_pages.py builds it, on a fake DOM and
//      a simulated FM-1 on fake Web MIDI: the songs go into the empty slots and nothing else changes; every failure is said and
//      changes nothing; a slot saved on the FM-1 after the first look is never overwritten
//   node tests/host/backup_web.mjs [PYTHON]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PY = process.argv[2] || process.env.PYTHON || "python3";
const strip = (src) => src.replace(/^export\s+/gm, "").replace(/^import .*?;\n/gm, "");
const code = strip(readFileSync("app/web/samples/soundplant_samples.js", "utf8")) + "\n" + readFileSync("app/web/backup/extras.js", "utf8");
const [EX] = new Function(code)();
const L = new Function(strip(readFileSync("app/web/samples/soundplant_samples.js", "utf8")) +
  "\nreturn { BANK_HDR, BANK_SIZE, BANK_MAGIC, REGIONS, userBank, pack7, unpack7, crc32, parseHeader };")();

let bad = 0;
const check = (what, ok) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) bad++; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

// a simulated FM-1: the bank's 180 KB (virtual offsets), the commands as samples.c answers them
class FakeFM1 {
  constructor(img, { drop = [], late = [], rc = {} } = {}) {
    this.bank = new Uint8Array(L.BANK_SIZE).fill(0xFF);
    if (img) this.bank.set(img);
    this.q = []; this.n = 0; this.drop = drop; this.late = late; this.rc = rc; this.open = false; this.hdr = null;
    this.writes = 0; this.lost = false;
  }
  count() { const h = L.parseHeader(this.bank.subarray(0, L.BANK_HDR)); return h ? h.count : 0; }
  send(bytes) {
    const cmd = bytes[4], a = bytes.slice(5, -1), k = this.n++;
    const r = this.answer(cmd, a);
    if (!r) return true;
    const msg = [0xF0, 0x7D, 0x46, 0x4C, cmd, ...r, 0xF7];
    if (this.drop.includes(k)) return true;                     // the answer lost on the way
    if (this.late.includes(k)) { this.held = msg; return true; } // ... or late: it comes after the next request's
    this.q.push(msg);
    if (this.held && !this.late.includes(k)) { this.q.unshift(this.held); this.held = null; }
    return true;
  }
  answer(cmd, a) {
    const off = (i) => a[i] | a[i + 1] << 7 | a[i + 2] << 14;
    if (cmd === 15) return [2, 0, 0, 0, 0, this.count(), 0, 0];
    if (cmd === 17) {
      const o = off(1), n = a[4] | a[5] << 7;
      if (this.open) return [0, ...a.slice(1, 4), 4];
      return [0, ...a.slice(1, 4), 0, ...L.pack7(this.bank.subarray(o, o + n))];
    }
    if (cmd === 11) { this.open = true; this.hdr = new Uint8Array(L.BANK_HDR); this.bank.fill(0xFF, 0, 4096); return [0, this.rc[11] || 0]; }
    if (cmd === 12) {
      const o = off(1), d = L.unpack7(a.slice(4));
      if (!this.open) return [0, ...a.slice(1, 4), 4];
      this.bank.set(d.subarray(0, 256), o); this.writes++;
      return [0, ...a.slice(1, 4), this.rc[12] || 0];
    }
    if (cmd === 16) { this.hdr.set(L.unpack7(a.slice(2)).subarray(0, 320), a[1] * 320); return [0, a[1], 0]; }
    if (cmd === 13) {
      const h = L.parseHeader(this.hdr);
      const ok = h && L.crc32(this.bank.subarray(L.BANK_HDR, L.BANK_HDR + h.dataLen)) === h.crc;
      if (ok) this.bank.set(this.hdr.subarray(0, 1344));
      this.open = false;
      return [0, ok ? 0 : 6];
    }
    if (cmd === 14) { this.bank.fill(0xFF); return [0, 0]; }
    return null;
  }
  async read(ms) {
    if (!this.q.length) await new Promise((r) => setTimeout(r, Math.min(ms, 20)));
    return this.q.shift() || null;
  }
  drain() { this.q.length = 0; }
}

// a bank of three samples, as the samples page builds it
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return ((seed >>> 8) / 16777216 - 0.5) * 30000; };
const img = L.userBank([30000, 47000, 9000].map((n, k) => ({ name: `smp${k}`, s: Int16Array.from({ length: n }, rnd),
  root: 60, loop: null, bars: 0, rate: 22050 })));
const dir = mkdtempSync(join(tmpdir(), "soundplant-backup-"));
const py = (code) => execFileSync(PY, ["-c", `import sys; sys.path.insert(0, "tools"); sys.path.insert(0, "base/tools")\n${code}`],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// fm1-base's backup protocol, the part of its page between the markers, filled in as make_site.py fills it
const page = readFileSync("base/web/backup/index.html", "utf8");
const proto = /\/\/ --- backup protocol: begin[^\n]*\n([\s\S]*?)\/\/ --- backup protocol: end/.exec(page)[1];
const PORTS_JS = readFileSync("base/web/fm1ports.js", "utf8").replace(/^export\s+/gm, "").replace(/^import .*?;\n/gm, "");
const PB = new Function(`"use strict";\n${proto.replace(/\{\{[A-Z_]+\}\}/g, (k) => ({ "{{NAME}}": "SoundPlant", "{{ID}}": "FM-1_10", "{{MAGIC}}": "LM8B",
  "{{BACKUP_VERSION}}": "1", "{{EXT}}": "soundplant", "{{PORTS_JS}}": PORTS_JS })[k] || k)}\nreturn PB;`)();

console.log("backup page: the samples section");
{
  const dev = new FakeFM1(img);
  const got = await EX.backup(dev);
  check("1. a backup: the bank's image byte for byte", same(got.subarray(L.BANK_HDR), img.subarray(L.BANK_HDR)) &&
        same(got.subarray(0, 1344), img.subarray(0, 1344)));
  check("   ... its summary: 3 samples", /^3 samples \(\d+ KB\)$/.test(EX.check(got)));
  writeFileSync(join(dir, "sec.bin"), got);
  check("   ... the image soundplant_samples.py checks", py(`import soundplant_samples as L\nprint(L.checked(open("${dir}/sec.bin","rb").read(),"x")[6])`).trim() === "3");
  const empty = await EX.backup(new FakeFM1(null));
  check("   an empty bank: a header alone, 0 samples", empty.length === L.BANK_HDR && EX.check(empty) === "no samples");

  const back = new FakeFM1(null);
  await EX.restore(back, got);
  check("2. a restore: the FM-1's bank equals the backup", same(back.bank.subarray(0, got.length).subarray(L.BANK_HDR), got.subarray(L.BANK_HDR)) &&
        back.count() === 3);
  const full = new FakeFM1(img);
  await EX.restore(full, empty);
  check("   an empty bank's restore: erased", full.count() === 0);

  const lossy = new FakeFM1(img, { drop: [3, 40] });
  const got2 = await EX.backup(lossy);
  check("3. a read's answer lost: asked again, the same bytes", same(got2, got));
  const lossyW = new FakeFM1(null, { drop: [5], late: [9] });
  await EX.restore(lossyW, got);
  check("   a write's answer lost, another's late: the same bank", lossyW.count() === 3 &&
        same(lossyW.bank.subarray(L.BANK_HDR, got.length), got.subarray(L.BANK_HDR)));

  const dmg = Uint8Array.from(got); dmg[L.BANK_HDR + 100] ^= 1;
  const dev4 = new FakeFM1(img);
  let e = await err(EX.restore(dev4, dmg));
  check("4. a damaged section: refused, nothing sent", e && /damaged/.test(e.message) && dev4.n === 0);
  e = null; try { EX.check(dmg); } catch (x) { e = x; }
  check("   ... and said when the file is chosen", e && /damaged/.test(e.message));
  const refusing = new FakeFM1(null, { rc: { 12: 3 } });
  e = await err(EX.restore(refusing, got));
  check("   the FM-1 refuses a write: said", e && /write/.test(e.message));

  // 5. the page's file (fm1-base's join: the backup, then "LSMP", length, the bank, its CRC-32)
  py(`import fm1_backup as B\nopen("${dir}/proj.bin","wb").write(B.build([(1, b"p" * 300), (2, b"")], magic=b"LM8B", version=1))`);
  const proj = Uint8Array.from(readFileSync(join(dir, "proj.bin")));
  const file = PB.join(proj, [{ tag: "LSMP", data: got }]);
  writeFileSync(join(dir, "both.soundplant"), file);
  const sp = PB.split(file);
  check("5. the page's .soundplant: its own split gives the backup and the samples", same(sp.image, proj) && same(sp.sections[0].data, got));
  const out = py(`import fm1_backup as B, soundplant_samples as L\nd=open("${dir}/both.soundplant","rb").read()\nimg, s = B.split(d)\n` +
                 `print(img == open("${dir}/proj.bin","rb").read(), s[0][0], L.bank_in(d, "f")[6])`).trim();
  check(`   fm1_backup.py splits it, soundplant_samples.py restores from it (${out})`, out === "True LSMP 3");
}
// ---------------------------------------------------------------- 6. the demo songs card, in the page as make_pages.py builds it
console.log("backup page: the demo songs card");
const html = py(`import make_pages as M
conf = M.base_site.read_conf(M.SRC / "app" / "fm1.toml")
tools = M.base_site.tool_pages(M.SRC / "app", conf, {"NAME": "SoundPlant", "EXTRAS_JS": M.backup_extras(), "EXTRA": "", "TERMINAL": ""})
print(tools["backup/index.html"])`);
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const le32 = (v) => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];
const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;

// the container, written here apart from the codec's: head 16 bytes, records (id, length, CRC-32, payload), the file's CRC-32
function build(payloads, flags = 0) {
  const out = new Uint8Array(16 + payloads.reduce((a, p) => a + 8 + p.length, 4));
  out.set([0x4C, 0x4D, 0x38, 0x42, 1, 0, payloads.length, 0]);
  out.set(le32(flags), 8);
  out.set(le32(PB.crc32(out, 0, 12)), 12);
  let at = 16;
  payloads.forEach((p, k) => {
    out.set([k + 1, 0, p.length & 255, p.length >> 8], at);
    out.set(le32(PB.crc32(p)), at + 4);
    out.set(p, at + 8);
    at += 8 + p.length;
  });
  out.set(le32(PB.crc32(out, 0, at)), at);
  return out;
}
// a slot's seven objects: the settings (the project's magic and format 22), then six stream objects; n of them hold something
const settings = (tag) => { const s = new Uint8Array(64).fill(tag); s.set(le32(0x384D4F4C), 0); s.set(le32(22), 4); return s; };
const stream = (k, tag) => Uint8Array.from([2, 0, 0, 0, k, tag, 7, 7]);
const slot = (tag, n = 7) => Array.from({ length: 7 }, (_, k) => k >= n ? new Uint8Array(0) : k === 0 ? settings(tag) : stream(k, tag));
const none = () => Array.from({ length: 7 }, () => new Uint8Array(0));
const PRESETS = Uint8Array.from({ length: 40 }, (_, i) => 200 + i);
const imageOf = (slots, flags = 0) => build([PRESETS, ...slots.flat()], flags);
const emptyTwo = () => imageOf([slot(9, 3), none(), none()]);

const DIR = "../emu/demos/", CATALOG = DIR + "demos.json";
const LIST = [
  { id: "ambient", file: "ambient.soundplant", genre: "Ambient", bpm: 64, blurb: "Slow pads and bells." },
  { id: "boombap", file: "boombap.soundplant", genre: "Boom bap", bpm: 90, blurb: "A crushed break." },
  { id: "pop", file: "pop.soundplant", genre: "Pop", bpm: 110, blurb: "A flute hook." },
];
// each song is a whole backup with a project in all three slots, as tools/make_demos.py makes them: the card takes the first
const SONGS = LIST.map((_, i) => imageOf([0, 1, 2].map((s) => slot(40 + 10 * i + s))));

// a simulated FM-1 on the backup protocol (device/backup.c: the handshake, the backup's 128-byte frames, restore_rx's reads and
// its question), the same fm1-base's tests/backup_page_test.mjs runs on its own images
class Device {
  constructor(image, o = {}) {
    Object.assign(this, { image, identity: "FM-1_1000", playing: false, answer: true, cutOnRestore: false, onRestore: null, onOk: null }, o);
    this.magic = Buffer.from(image.subarray(0, 4)).toString("latin1");
    this.version = image[4] | image[5] << 8;
    this.nobj = image[6] | image[7] << 8;
    this.q = []; this.ports = null; this.backups = 0; this.restores = 0; this.asked = 0;
  }
  frame(cmd, body) {
    return [0xF0, ...PB.pack7([0, 0x59, cmd, body.length & 255, body.length >> 8, 0, ...body, ~body.reduce((a, v) => a + v, 0) & 255]), 0xF7];
  }
  stream() {
    this.backups++;
    for (let off = 0; off < this.image.length; off += 128) this.q.push(this.frame(PB.BU_REQ, [...le32(off), ...this.image.subarray(off, off + 128)]));
    this.q.push(this.frame(PB.BU_END, [...le32(this.image.length), ...le32(PB.crc32(this.image)), 0, this.image[8]]));   // the flags: the image's
  }
  *puller(n, c) {
    if (this.playing) { yield [PB.FAIL_ADDR | PB.PLAYING, 8]; return; }
    const got = [...(yield [0, 16])];
    const h = Uint8Array.from(got);
    if (Buffer.from(h.subarray(0, 4)).toString("latin1") !== this.magic || (h[4] | h[5] << 8) !== this.version ||
        (h[6] | h[7] << 8) !== this.nobj || u32(h, 12) !== PB.crc32(h, 0, 12)) { yield [(PB.FAIL_ADDR | 3) >>> 0, 8]; return; }
    let pos = 16;
    for (let i = 0; i < this.nobj; i++) {
      const r = yield [pos, 8];
      got.push(...r);
      const ln = r[2] | r[3] << 8;
      pos += 8;
      for (let k = 0; k < ln; k += 512) got.push(...(yield [pos + k, Math.min(512, ln - k)]));
      pos += ln;
    }
    got.push(...(yield [pos, 4]));
    const g = Uint8Array.from(got);
    if (g.length !== n || PB.crc32(g) !== c) { yield [PB.FAIL_ADDR | 6, 8]; return; }
    try { PB.parse(g); } catch (_) { yield [(PB.FAIL_ADDR | 5) >>> 0, 8]; return; }
    yield [PB.ASK_ADDR, 8];
    this.asked++;
    if (!this.answer) { yield [(PB.FAIL_ADDR | PB.DECLINED) >>> 0, 8]; return; }
    this.image = g;
    yield [PB.OK_ADDR, 8];
    if (this.onOk) this.onOk();   // the page has shown the FM-1's question by now
  }
  ask(addr, n) {
    const q = [0, ...le32(addr >>> 0), n & 255, n >> 8, 0];
    this.q.push([0xF0, ...PB.pack7([0, 0x59, 0x30, 8, 0, 0, ...q, ~q.reduce((a, v) => a + v, 0) & 255]), 0xF7]);
    this.wanted = [addr >>> 0, n];
  }
  next(data) {
    const r = this.pull.next(data);
    if (r.done) { this.pull = null; return; }
    this.ask(...r.value);
  }
  rx(d) {
    if (same(d, PB.HS_QUERY)) {
      const t = [...Buffer.from(this.identity), ...new Array(27 - this.identity.length).fill(0)];
      this.q.push([0xF0, ...PB.pack7([0, 0x59, 0x11, 27, 0, 0, ...t, ~t.reduce((a, v) => a + v, 0) & 255]), 0xF7]);
      return;
    }
    const f = PB.parseFrame(d);
    if (f && f.cmd === PB.BU_REQ && Buffer.from(f.body).toString("latin1") === this.magic) { this.stream(); return; }
    if (f && f.cmd === PB.RS_REQ && f.body.length === 8) {
      this.restores++;
      if (this.onRestore) this.onRestore();
      if (this.cutOnRestore) { this.ports.input.state = "disconnected"; return; }
      this.pull = this.puller(u32(f.body, 0), u32(f.body, 4));
      this.next(undefined);
      return;
    }
    const u = PB.unpack7(d.slice(1, -1));
    if (this.pull && this.wanted && u.length >= 15 && u[2] === 0x30) {
      const [addr, n] = this.wanted;
      if (u32(u, 7) === addr && (u[11] | u[12] << 8) === n) this.next(Uint8Array.from(u.slice(14, 14 + n)));
    }
  }
}
// the FM-1 on fake Web MIDI ports: what the page sends reaches the device, what the device says comes back a tick later
function wire(dev) {
  const input = { name: "SoundPlant FM-1", state: "connected", open: async () => {}, onmidimessage: null };
  const output = {
    name: "SoundPlant FM-1", state: "connected", open: async () => {},
    send(bytes) {
      dev.rx(Array.from(bytes));
      const said = dev.q.splice(0);
      setTimeout(() => said.forEach((m) => input.onmidimessage && input.onmidimessage({ data: Uint8Array.from(m) })), 1);
    },
  };
  dev.ports = { input, output };
  return { inputs: new Map([["in", input]]), outputs: new Map([["out", output]]) };
}

// just enough of a page: the elements the backup page and the card use, a tree to find them in
class El {
  constructor(doc, tag) {
    Object.assign(this, { doc, tag, id: "", kids: [], parentElement: null, listeners: {}, attrs: {}, own: "", innerHTML: "",
      hidden: false, disabled: false, checked: false });
  }
  get textContent() { return [this.own, ...this.kids.map((k) => k.textContent)].join(" ").replace(/\s+/g, " ").trim(); }
  set textContent(v) { this.own = String(v); this.kids = []; }
  append(...nodes) { nodes.forEach((n) => { n.parentElement = this; this.kids.push(n); }); }
  replaceChildren(...nodes) { this.kids = []; this.append(...nodes); }
  after(node) { const p = this.parentElement; node.parentElement = p; p.kids.splice(p.kids.indexOf(this) + 1, 0, node); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.doc.focused = this; }
}
const all = (e, f) => [...(f(e) ? [e] : []), ...e.kids.flatMap((k) => all(k, f))];
const BASE_IDS = ["status", "alert", "statusBox", "bar", "backup", "restore", "file", "fileInfo", "ask", "askText", "askYes", "askNo",
  "portpick", "portlist", "pickstatus"];
function makeDoc(noRh) {
  const doc = { focused: null };
  doc.createElement = (tag) => new El(doc, tag);
  doc.root = doc.createElement("main");
  doc.head = doc.createElement("head");
  for (const id of BASE_IDS) { const e = doc.createElement("div"); e.id = id; doc.root.append(e); }
  if (!noRh) {
    const card = doc.createElement("section"), h = doc.createElement("h2");
    h.id = "rh";
    card.append(h);
    doc.root.append(card);
  }
  doc.getElementById = (id) => all(doc.root, (e) => e.id === id)[0] || null;
  return doc;
}
const plain = (h) => h.replace(/<[^>]*>/g, "").replace(/&hellip;/g, "...").replace(/&(lt|gt|quot|amp);/g, (m, k) => ({ lt: "<", gt: ">", quot: '"', amp: "&" })[k]);

// the page's own script on a fake DOM, fake Web MIDI to the simulated FM-1 and a fake fetch: the two outside boundaries
function rig(image, o = {}) {
  const doc = makeDoc(o.noRh);
  const dev = new Device(image, o.device);
  const midi = o.noFm1 ? { inputs: new Map(), outputs: new Map() } : wire(dev);
  const nav = { userAgent: "test", platform: "test", maxTouchPoints: 0 };
  if (!o.noMidi) nav.requestMIDIAccess = async (opts) => { nav.asked = opts; return midi; };
  const site = new Map([[CATALOG, { text: JSON.stringify(LIST) }], ...LIST.map((d, i) => [DIR + d.file, { bytes: SONGS[i] }])]);
  const fetched = [];
  const fakeFetch = async (url) => {
    fetched.push(url);
    const r = site.get(url) || { status: 404 };
    if (r.offline) throw new TypeError("Failed to fetch");
    const status = r.status || 200;
    return {
      ok: status < 400, status, statusText: { 404: "Not Found", 500: "Internal Server Error" }[status] || "",
      json: async () => JSON.parse(r.text),
      arrayBuffer: async () => (r.bytes ? Uint8Array.from(r.bytes) : new TextEncoder().encode(r.text || "")).buffer,
    };
  };
  const page = new Function("document", "window", "navigator", "fetch", "localStorage", `${script}\nreturn { PB, busy: () => busy };`)(
    doc, { addEventListener() {} }, nav, fakeFetch, { getItem: () => null, setItem() {} });
  Object.assign(page.PB.DELAY, { poll: 5, idle: 300, ask: 500, first: 300, hs: 100, hsFull: 100 });
  const el = (id) => doc.getElementById(id);
  const said = () => plain(el("alert").innerHTML + el("status").innerHTML);
  const views = {};
  dev.onRestore = () => {
    views.restore = { show: el("demoShow").disabled, backup: el("backup").disabled, go: el("demoGo").disabled, ask: el("demoAsk").hidden, busy: page.busy() };
  };
  dev.onOk = () => { views.ask = { said: said(), cls: el("statusBox").className }; };
  const boxes = () => all(doc.root, (e) => e.tag === "input");
  return {
    doc, dev, nav, site, fetched, views, el, said, boxes, busy: page.busy,
    isErr: () => el("alert").innerHTML !== "",
    // a click as a browser delivers it: a disabled control gets none
    async click(id) {
      const e = el(id);
      if (e.disabled) return false;
      await Promise.all((e.listeners.click || []).map((f) => f({ target: e })));
      return true;
    },
    tick(i, on = true) {
      const b = boxes()[i];
      if (b.disabled) return false;
      b.checked = on;
      (b.listeners.change || []).forEach((f) => f({ target: b }));
      return true;
    },
  };
}
// nothing changed on the FM-1, and the page is usable again
const rested = (r, before) => same(r.dev.image, before) && !r.el("demoShow").disabled && !r.el("backup").disabled && !r.busy();

{
  const r = rig(emptyTwo());
  const before = Uint8Array.from(r.dev.image);
  const restore = r.el("rh").parentElement;
  const next = restore.parentElement.kids[restore.parentElement.kids.indexOf(restore) + 1];
  check("6. the card follows the Restore card, and has nothing to choose before the FM-1 was looked at",
        next.kids[0].textContent === "Put demo songs on my FM-1" && r.el("demoPick").hidden && r.el("demoAsk").hidden && !r.el("demoShow").disabled);

  await r.click("demoShow");
  const labels = r.boxes().map((b) => b.parentElement.textContent);
  check("   Look at my FM-1: a backup is taken (MIDI asked with SysEx, the link closed again) and every demo song offered with its genre, tempo and blurb",
        r.dev.backups === 1 && r.nav.asked.sysex === true && !r.el("demoPick").hidden && !r.isErr() && r.dev.ports.input.onmidimessage === null &&
        labels.join("|") === "Ambient, 64 bpm Slow pads and bells.|Boom bap, 90 bpm A crushed break.|Pop, 110 bpm A flute hook.");
  check("   it says which slots are empty: 2 and 3 (slot 1 holds a project)",
        r.el("demoSlots").textContent === "slots 2 and 3 on your FM-1 are empty, so you can put up to 2 songs on them." && r.el("demoGo").disabled);

  r.tick(0); r.tick(2);
  const third = r.tick(1);
  check("   two empty slots, two songs: a third box cannot be checked", !third && !r.boxes()[1].checked && r.boxes()[1].disabled &&
        r.el("demoGo").textContent === "Put 2 songs on my FM-1" && !r.el("demoGo").disabled);
  r.tick(2, false);
  check("   unchecking one frees the others again", !r.boxes()[1].disabled && r.el("demoGo").textContent === "Put the song on my FM-1");
  r.tick(2);

  await r.click("demoGo");
  check("   the songs are downloaded, the picked ones only, and the question is asked on the page with the slots and the save warning",
        r.fetched.join() === [CATALOG, DIR + "ambient.soundplant", DIR + "pop.soundplant"].join() && !r.el("demoAsk").hidden &&
        r.el("demoAskText").textContent === "Put 2 songs in slots 2 and 3 (Ambient, Pop)? Nothing else changes. " +
          "Save your project on the FM-1 first: unsaved changes are lost." && r.doc.focused === r.el("demoYes"));
  check("   ... and nothing has gone to the FM-1 before the answer", r.dev.restores === 0 && same(r.dev.image, before));

  await r.click("demoYes");
  const want = imageOf([slot(9, 3), slot(40), slot(60)]);
  check("   Yes: the FM-1 holds its own slot 1 and presets as they were and the picked songs' first slots in slots 2 and 3",
        r.dev.restores === 1 && same(r.dev.image, want) && !same(want, before));
  check("   while it worked the page was busy: Look, Back up and the song button off, the question hidden",
        r.views.restore.busy && r.views.restore.show && r.views.restore.backup && r.views.restore.go && r.views.restore.ask);
  check("   the FM-1's own question RESTORE FROM USB? was passed on to the user", /RESTORE FROM USB\?/.test(r.views.ask.said) && r.views.ask.cls === "status ask");
  check("   done: said where the songs are, the card back at rest, the MIDI link closed",
        /^Done\. SoundPlant has the songs in slots 2 and 3, and reloaded everything\. .*white key for its slot/.test(r.said()) && !r.isErr() &&
        r.el("demoPick").hidden && rested(r, r.dev.image) && r.dev.ports.input.onmidimessage === null);
}
{
  const r = rig(emptyTwo());
  await r.click("demoShow");
  r.tick(0);
  await r.click("demoGo");
  r.tick(1);
  check("   changing a box after the question was asked takes the question away: it never names songs that are no longer chosen", r.el("demoAsk").hidden);
  await r.click("demoGo");
  check("   asked again, it names the new choice", /^Put 2 songs in slots 2 and 3 \(Ambient, Boom bap\)\?/.test(r.el("demoAskText").textContent));
  await r.click("demoNo");
  check("   Cancel: the question goes, nothing is sent, the focus returns to the song button",
        r.el("demoAsk").hidden && r.dev.restores === 0 && r.doc.focused === r.el("demoGo"));
}

// what goes wrong before anything is chosen: said in plain words, nothing offered, the FM-1 untouched
for (const [what, o, re] of [
  ["a browser without Web MIDI", { noMidi: true }, /^This browser has no Web MIDI/],
  ["no FM-1 on the MIDI ports", { noFm1: true }, /^SoundPlant not found/],
  ["an FM-1 that is playing (its backup says so)", { image: imageOf([slot(9, 3), none(), none()], 1) }, /^STOP FIRST\. SoundPlant is playing.*Nothing changed/],
  ["all three slots holding a project", { image: imageOf([slot(9, 3), slot(8, 3), slot(7, 3)]) }, /^All three project slots on SoundPlant hold a project.*only go into empty slots/],
]) {
  const r = rig(o.image || emptyTwo(), o);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoShow");
  check(`   ${what}: said, nothing offered, the FM-1 untouched`, r.isErr() && re.test(r.said()) && r.el("demoPick").hidden && rested(r, before));
}
for (const [what, fix, re] of [
  ["the list of demos answers 404", (r) => r.site.set(CATALOG, { status: 404 }), /^The list of demo songs did not download: the server answered 404 Not Found/],
  ["the list of demos is not JSON (a proxy's page)", (r) => r.site.set(CATALOG, { text: "<html>blocked</html>" }), /^The list of demo songs is not readable/],
  ["the list of demos holds entries the card cannot show", (r) => r.site.set(CATALOG, { text: JSON.stringify([{ file: "x" }]) }), /^The list of demo songs is not what this page expects/],
  ["no connection for the list", (r) => r.site.set(CATALOG, { offline: true }), /^The list of demo songs did not download \(Failed to fetch\)\. Check your internet connection/],
]) {
  const r = rig(emptyTwo());
  fix(r);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoShow");
  check(`   ${what}: said, nothing offered, the FM-1 never asked`, r.isErr() && re.test(r.said()) && r.el("demoPick").hidden && r.dev.backups === 0 && rested(r, before));
}

// what goes wrong after the songs were chosen, before the FM-1 is touched: said, the choice kept, nothing restored
const bent = Uint8Array.from(SONGS[0]);
bent[bent.length >> 1] ^= 1;
for (const [what, fix, re] of [
  ["a song answers 500", (r) => r.site.set(DIR + "ambient.soundplant", { status: 500 }), /^The demo song Ambient did not download: the server answered 500 Internal Server Error/],
  ["no connection for a song", (r) => r.site.set(DIR + "ambient.soundplant", { offline: true }), /^The demo song Ambient did not download \(Failed to fetch\)/],
  ["a song answers 200 with a page that is not a backup", (r) => r.site.set(DIR + "ambient.soundplant", { text: "<!doctype html><title>Not found</title>".repeat(4) }), /^The demo song Ambient cannot be used\./],
  ["a song with one byte changed on the way", (r) => r.site.set(DIR + "ambient.soundplant", { bytes: bent }), /^The demo song Ambient cannot be used\. .*damaged/],
]) {
  const r = rig(emptyTwo());
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoShow");
  fix(r);
  r.tick(0);
  await r.click("demoGo");
  check(`   ${what}: said, no question asked, the choice kept to try again, the FM-1 untouched`,
        r.isErr() && re.test(r.said()) && r.el("demoAsk").hidden && !r.el("demoPick").hidden && !r.el("demoGo").disabled && r.dev.restores === 0 && rested(r, before));
}
{
  const r = rig(imageOf([slot(9, 7), slot(8, 7), none()]));
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoShow");
  r.tick(0);
  await r.click("demoGo");
  check("   a song that does not fit the FM-1's 20 flash sectors (7 + 7 + 7): MEMORY FULL before anything is sent, not half a restore",
        r.isErr() && /^MEMORY FULL: the three slots would take 21 flash sectors and the FM-1 has 20 for them\. Choose fewer songs\./.test(r.said()) &&
        r.el("demoAsk").hidden && r.dev.restores === 0 && rested(r, before));
}

// what goes wrong at the last step
async function chosen(image, o) {
  const r = rig(image, o);
  await r.click("demoShow");
  r.tick(0);
  await r.click("demoGo");
  return r;
}
{
  const r = await chosen(emptyTwo(), { device: { playing: true } });
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   an FM-1 that is playing when it is asked to restore: STOP FIRST, nothing changed",
        r.isErr() && /^STOP FIRST\. SoundPlant is playing/.test(r.said()) && r.dev.restores === 1 && rested(r, before));
}
{
  const r = await chosen(emptyTwo(), { device: { answer: false } });
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   HOME pressed on the FM-1: Not restored, nothing changed", r.isErr() && /^Not restored\. Someone pressed HOME.*Nothing changed/.test(r.said()) && r.dev.asked === 1 && rested(r, before));
}
{
  const r = await chosen(emptyTwo(), { device: { cutOnRestore: true } });
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   the FM-1 unplugged in the middle: said, nothing changed, the MIDI link closed",
        r.isErr() && /disconnected/.test(r.said()) && r.dev.restores === 1 && rested(r, before) && r.dev.ports.input.onmidimessage === null);
}
{
  const r = await chosen(emptyTwo());
  r.dev.image = imageOf([slot(9, 3), none(), none()], 1);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   playing again at the final backup: STOP FIRST, no restore started", r.isErr() && /^STOP FIRST/.test(r.said()) && r.dev.restores === 0 && rested(r, before));
}

// the user saves a project on the FM-1 after the first look, as the question tells them to: the slot they saved is never replaced
{
  const r = await chosen(emptyTwo());
  r.dev.image = imageOf([slot(9, 3), slot(8, 3), none()]);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   a project saved in slot 2 since the look, one song chosen: not restored (it would have replaced the saved project), the card starts again",
        r.isErr() && /^The empty slots changed since you chose: the songs would now go in slot 3, not slot 2\. Nothing changed\. Press Look at my FM-1 to start again\.$/.test(r.said()) &&
        r.dev.restores === 0 && r.el("demoPick").hidden && r.el("demoAsk").hidden && rested(r, before));
}
{
  const r = await chosen(emptyTwo());
  r.tick(1);
  await r.click("demoGo");
  r.dev.image = imageOf([slot(9, 3), slot(8, 3), none()]);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   ... two songs chosen and only one slot empty now: said so, nothing restored",
        r.isErr() && /^2 songs are chosen and 1 slot is empty\. Choose fewer songs\. Nothing changed\. Press Look at my FM-1 to start again\.$/.test(r.said()) && r.dev.restores === 0 && rested(r, before));
}
{
  const r = await chosen(emptyTwo());
  r.dev.image = imageOf([slot(9, 3), slot(8, 3), slot(7, 3)]);
  const before = Uint8Array.from(r.dev.image);
  await r.click("demoYes");
  check("   ... all three slots full now: said so, nothing restored", r.isErr() && /^All three slots on the FM-1 hold a project.*Nothing changed/.test(r.said()) && r.dev.restores === 0 && rested(r, before));
}
{
  let e = null;
  try { rig(emptyTwo(), { noRh: true }); } catch (x) { e = x; }
  check("   a page without the Restore card to follow: the script stops at load and says why, no card half built", e && /no Restore card/.test(e.message));
}

console.log(bad ? `backup web test FAILED (${bad})` : "backup web test passed");
process.exit(bad ? 1 : 0);
