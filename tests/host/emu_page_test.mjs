// SPDX-License-Identifier: MPL-2.0
// The browser build as the page runs it (./build.sh --web): fm1-base's page with SoundPlant's bits (tools/emu_page.py),
// its worklet with the emulator's parts, among them "resample": in a browser whose audio runs at 48 kHz (many Macs)
// the FM-1's clock keeps the page's time (without it SoundPlant plays 48/44.1 fast and high). fm1-base's worklet under
// node (base/tests/emu_harness.mjs).
//   node tests/host/emu_page_test.mjs app/build/emu
import { existsSync, readFileSync } from "node:fs";
import { startEmu, check, done } from "../../base/tests/emu_harness.mjs";

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
done();
