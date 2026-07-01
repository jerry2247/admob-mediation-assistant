// Deterministic verification of the actuation engine against a synthetic AngularDart
// DOM. Verifies select_option (radio + dropdown overlay), set_toggle (state-aware),
// select_row (checkbox not switch), fill (read-back), and the enforceRiskGate block.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import fs from "node:fs";

const OUT = process.argv[2] || "/tmp/dom-verify.png";
// Bundle the real dom.ts through the harness so we test shipping code, not a copy.
const BUNDLE = "/tmp/admob-harness.js";
execSync(`npx esbuild tests/harness.ts --bundle --format=iife --outfile=${BUNDLE}`, { stdio: "inherit" });
const harness = fs.readFileSync(BUNDLE, "utf8");

const DOM = `
<style>
  material-radio,material-toggle,material-checkbox,material-button,material-dropdown-select,
  [role=option]{ display:inline-block; min-width:80px; min-height:22px; border:1px solid #ccc; margin:3px; padding:4px 8px; }
  [role=row]{ display:block; min-height:30px; padding:6px; border:1px solid #eee; }
  .acx-overlay-container{ display:block; min-width:160px; min-height:40px; border:1px solid #99f; padding:6px; }
</style>
<h3>Ad format</h3>
<material-radio role="radio" aria-label="Banner" aria-checked="false">Banner</material-radio>
<material-radio role="radio" aria-label="Interstitial" aria-checked="false">Interstitial</material-radio>
<h3>Platform</h3>
<material-radio role="radio" aria-label="Android" aria-checked="false">Android</material-radio>
<material-radio role="radio" aria-label="iOS" aria-checked="false">iOS</material-radio>
<h3>Group name</h3>
<div><input aria-label="Group name" /></div>
<h3>Location</h3>
<material-toggle role="switch" aria-label="Include United States" aria-checked="false">US</material-toggle>
<h3>Ad source</h3>
<material-dropdown-select role="button" aria-label="Add ad source">Add ad source</material-dropdown-select>
<h3>Groups list</h3>
<div role="row"><a role="link" aria-label="Holiday">Holiday</a>
  <material-checkbox role="checkbox" aria-label="Select Holiday" aria-checked="false">sel</material-checkbox>
  <material-toggle role="switch" aria-label="Serving Holiday" aria-checked="true">on</material-toggle></div>
<div role="row"><a role="link" aria-label="Default group">Default group</a>
  <material-checkbox role="checkbox" aria-label="Select Default" aria-checked="false">sel</material-checkbox></div>
<h3>Per-source eCPM</h3>
<div role="row"><span aria-label="AppLovin-label">AppLovin</span><input aria-label="eCPM" /></div>
<div role="row"><span aria-label="AdMob-label">AdMob Network</span><input aria-label="eCPM" /></div>
<h3>Save</h3>
<material-button role="button" aria-label="Save">Save</material-button>
`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 384, height: 900 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body>${DOM}</body></html>`, { waitUntil: "load" });

// Instrument: every actionable element records clicks; some emulate AngularDart behavior.
await page.evaluate(() => {
  const w = window;
  w.__clicks = [];
  const record = (el) => el.addEventListener("click", () => w.__clicks.push(el.getAttribute("aria-label")));
  document.querySelectorAll("[aria-label]").forEach(record);
  // radios/toggles/checkboxes flip aria-checked on click (state-aware behavior)
  document.querySelectorAll("material-radio,material-toggle,material-checkbox").forEach((el) => {
    el.addEventListener("click", () => el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true"));
  });
  // the dropdown trigger opens a detached overlay with options
  const dd = document.querySelector('[aria-label="Add ad source"]');
  dd.addEventListener("click", () => {
    if (document.querySelector(".acx-overlay-container")) return;
    const ov = document.createElement("div");
    ov.className = "acx-overlay-container";
    ov.innerHTML = '<div role="option" aria-label="AdMob Network">AdMob Network</div><div role="option" aria-label="AppLovin">AppLovin</div>';
    document.body.appendChild(ov);
    ov.querySelectorAll('[role=option]').forEach((o) => o.addEventListener("click", () => w.__clicks.push("opt:" + o.getAttribute("aria-label"))));
  });
});
await page.addScriptTag({ content: harness });

const run = (d) => page.evaluate((dir) => window.DOMH.execDirective(dir), d);
const results = {};

results.selectRadio = await run({ type: "select_option", target: { label: "Ad format" }, value: "Banner", risk: "reversible" });
results.selectRadioAgain = await run({ type: "select_option", target: { label: "Ad format" }, value: "Banner", risk: "reversible" }); // idempotent
results.fill = await run({ type: "fill", target: { label: "Group name" }, value: "Holiday", risk: "reversible" });
results.toggle = await run({ type: "set_toggle", target: { label: "Include United States" }, value: "on", risk: "reversible" });
results.dropdown = await run({ type: "select_option", target: { label: "Add ad source" }, value: "AppLovin", risk: "reversible" });
results.selectRow = await run({ type: "select_row", target: { label: "Holiday" }, value: "on", risk: "reversible" }); // checkbox, not switch
results.withinFill = await run({ type: "fill", target: { label: "eCPM", within: "AppLovin" }, value: "2.50", risk: "reversible" }); // right row only
results.gateBlocked = await run({ type: "click", target: { label: "Save" }, risk: "persistent" }); // MUST be blocked

const clicks = await page.evaluate(() => window.__clicks);
const nameVal = await page.evaluate(() => document.querySelector('[aria-label="Group name"]').value);
const bannerChecked = await page.evaluate(() => document.querySelector('[aria-label="Banner"]').getAttribute("aria-checked"));
const ecpmVals = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label="eCPM"]')).map((i) => i.value));

await page.screenshot({ path: OUT });
await b.close();

// Assertions
const A = [];
const check = (name, cond) => A.push(`${cond ? "PASS" : "FAIL"}  ${name}`);
check("select_option radio resolved", results.selectRadio.resolved === true);
check("radio Banner got clicked", clicks.includes("Banner"));
check("radio idempotent (no 2nd click)", clicks.filter((c) => c === "Banner").length === 1 && results.selectRadioAgain.message === "already selected");
check("banner ends checked", bannerChecked === "true");
check("fill resolved + read-back", results.fill.resolved === true && nameVal === "Holiday");
check("set_toggle resolved", results.toggle.resolved === true);
check("dropdown opened + option picked", results.dropdown.resolved === true && clicks.includes("opt:AppLovin"));
check("select_row clicked the row CHECKBOX", results.selectRow.resolved === true && clicks.includes("Select Holiday"));
check("select_row did NOT touch the serving switch", !clicks.includes("Serving Holiday"));
check("within-scoped fill hit the right row only", results.withinFill.resolved === true && ecpmVals[0] === "2.50" && ecpmVals[1] === "");
check("risk gate BLOCKED persistent Save", results.gateBlocked.resolved === false && /human click/.test(results.gateBlocked.message || ""));
check("Save was NOT clicked", !clicks.includes("Save"));
console.log("\n" + A.join("\n"));
console.log("\nclicks:", JSON.stringify(clicks));
console.log(A.every((l) => l.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
