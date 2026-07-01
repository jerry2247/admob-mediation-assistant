// Deterministic verification against REAL-AngularDart-shaped DOM (unlike dom.spec.mjs,
// which uses idealized aria-labelled controls). These fixtures mirror the actual AdMob
// captures: material-radio carries no aria-label and wraps a <material-icon> ligature +
// a <div class="content"> label; the format field is a <material-dropdown-select> reading
// "Choose a format" labelled by a sibling <div class="format-label">; the groups list uses
// <ess-cell essfield="mediation_group_name"> spans (no <a>) and an icon status (no switch).
// Proves: cleanText() ligature stripping, resolveField(), readGroups() real-cell reads,
// and the target-based persistent/serving risk gates.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import fs from "node:fs";

const BUNDLE = "/tmp/admob-harness.js";
execSync(`npx esbuild tests/harness.ts --bundle --format=iife --outfile=${BUNDLE}`, { stdio: "inherit" });
const harness = fs.readFileSync(BUNDLE, "utf8");

const CREATE_DOM = `
<style> material-radio,material-dropdown-select,material-button,[role=option]{display:block;min-height:24px;border:1px solid #ccc;margin:3px;padding:4px 8px;} material-radio-group{display:block;} .acx-overlay-container{display:block;min-height:40px;border:1px solid #99f;} </style>
<div class="format-label">Ad format</div>
<material-dropdown-select role="button"><material-icon><i>arrow_drop_down</i></material-icon><span class="button-text">Choose a format</span></material-dropdown-select>
<div class="description">Platform</div>
<material-radio-group role="radiogroup">
  <material-radio role="radio" aria-checked="false"><material-icon><i>radio_button_unchecked</i></material-icon><div class="content">Android</div></material-radio>
  <material-radio role="radio" aria-checked="false"><material-icon><i>radio_button_unchecked</i></material-icon><div class="content">iOS</div></material-radio>
</material-radio-group>
<div><label>Mediation group name</label><input aria-label="Mediation group name" /></div>
<material-button role="button"><material-icon><i>save</i></material-icon> Save</material-button>
`;

const LIST_DOM = `
<style> [role=row]{display:block;border:1px solid #eee;padding:6px;} </style>
<div role="row"><div role="columnheader">Mediation group</div><div role="columnheader">Status</div></div>
<div role="row">
  <ess-cell essfield="mediation_group_name"><linked-text-cell><span class="text">US Rewarded</span></linked-text-cell></ess-cell>
  <ess-cell essfield="status"><legacy-status-cell><material-icon aria-label="Serving"><i aria-label="Serving">check_circle</i></material-icon></legacy-status-cell></ess-cell>
</div>
<div role="row">
  <ess-cell essfield="mediation_group_name"><linked-text-cell><span class="text">Holiday Promo</span></linked-text-cell></ess-cell>
  <ess-cell essfield="status"><legacy-status-cell><material-icon aria-label="Paused"><i aria-label="Paused">pause_circle</i></material-icon></legacy-status-cell></ess-cell>
</div>
<material-toggle role="switch" aria-label="Serving US Rewarded" aria-checked="true">on</material-toggle>
`;

const b = await chromium.launch();
const A = [];
const check = (name, cond) => A.push(`${cond ? "PASS" : "FAIL"}  ${name}`);

async function load(url, dom) {
  const page = await b.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
  await page.route("https://admob.google.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body>${dom}</body></html>` }),
  );
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => {
    const w = window;
    w.__clicks = [];
    document.querySelectorAll("material-radio,material-button,material-toggle,material-dropdown-select").forEach((el) => {
      el.addEventListener("click", () => w.__clicks.push((el.querySelector(".content,.button-text")?.textContent || el.textContent || "").trim().replace(/\s+/g, " ")));
    });
    document.querySelectorAll("material-radio,material-toggle").forEach((el) =>
      el.addEventListener("click", () => el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true")),
    );
    const dd = document.querySelector("material-dropdown-select");
    if (dd) dd.addEventListener("click", () => {
      if (document.querySelector(".acx-overlay-container")) return;
      const ov = document.createElement("div");
      ov.className = "acx-overlay-container";
      ov.innerHTML = '<div role="option">Banner</div><div role="option">Interstitial</div>';
      document.body.appendChild(ov);
      ov.querySelectorAll("[role=option]").forEach((o) => o.addEventListener("click", () => w.__clicks.push("opt:" + o.textContent)));
    });
  });
  await page.addScriptTag({ content: harness });
  return page;
}

// ---- CREATE page: cleanText, resolveField, readContext labels, persistent-click gate ----
{
  const page = await load("https://admob.google.com/v2/mediation/groups/create", CREATE_DOM);
  const run = (d) => page.evaluate((dir) => window.DOMH.execDirective(dir), d);

  // Platform is a real radio-group; the radio's name comes from text ("Android") behind a
  // material-icon ligature. Without cleanText this scores too low and returns null.
  const platform = await run({ type: "select_option", target: { label: "Platform" }, value: "Android", risk: "reversible" });
  const androidChecked = await page.evaluate(() => document.querySelectorAll("material-radio")[0].getAttribute("aria-checked"));

  // Ad format's control reads "Choose a format"; only the sibling .format-label says
  // "Ad format", so this must resolve via resolveField and open the dropdown.
  const format = await run({ type: "select_option", target: { label: "Ad format" }, value: "Banner", risk: "reversible" });

  // readContext must expose the CLEAN label "Android", not "radio_button_uncheckedAndroid".
  const labels = await page.evaluate(() => window.DOMH.readContext().controls.map((c) => c.label));

  // A reversible click aimed at a text-labelled "Save" must be refused by the target gate.
  const saveGate = await run({ type: "click", target: { label: "Save" }, risk: "reversible" });

  const clicks = await page.evaluate(() => window.__clicks);
  check("cleanText: select_option(Platform, Android) resolved", platform.resolved === true);
  check("cleanText: Android radio ended checked", androidChecked === "true");
  check("resolveField: select_option(Ad format, Banner) resolved via dropdown", format.resolved === true && clicks.includes("opt:Banner"));
  check("readContext label is clean 'Android' (ligature stripped)", labels.includes("Android") && !labels.some((l) => /radio_button/.test(l)));
  check("gate: reversible click on 'Save' blocked", saveGate.resolved === false && /human click/.test(saveGate.message || ""));
  check("gate: 'Save' was NOT clicked", !clicks.includes("Save"));
  await page.close();
}

// ---- LIST page: readGroups real cells + icon status, and live-serving toggle gate ----
{
  const page = await load("https://admob.google.com/v2/mediation/groups/list", LIST_DOM);
  const groups = await page.evaluate(() => window.DOMH.readGroups());
  const toggleGate = await page.evaluate((dir) => window.DOMH.execDirective(dir), {
    type: "set_toggle", target: { label: "Serving US Rewarded" }, value: "off", risk: "reversible",
  });
  const clicks = await page.evaluate(() => window.__clicks);

  const byName = Object.fromEntries(groups.map((g) => [g.name, g.enabled]));
  check("readGroups: found both groups by ess-cell name (header skipped)", groups.length === 2 && "US Rewarded" in byName && "Holiday Promo" in byName);
  check("readGroups: 'US Rewarded' read as serving (icon)", byName["US Rewarded"] === true);
  check("readGroups: 'Holiday Promo' read as paused (icon)", byName["Holiday Promo"] === false);
  check("gate: set_toggle on a live serving switch blocked", toggleGate.resolved === false && /human click/.test(toggleGate.message || ""));
  check("gate: serving switch was NOT flipped", !clicks.includes("on"));
  await page.close();
}

await b.close();
console.log("\n" + A.join("\n"));
console.log(A.every((l) => l.startsWith("PASS")) ? "\nALL PASS" : "\nSOME FAILED");
process.exit(A.every((l) => l.startsWith("PASS")) ? 0 : 1);
