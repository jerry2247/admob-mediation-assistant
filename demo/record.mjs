// Records the demo video: real side panel (dist) docked beside a faithful AdMob page,
// the panel's chrome messaging wired to the REAL dom.ts engine running on the AdMob
// frame, driven by the REAL backend (live model). Captions are baked into the stage.
//
//   node record.mjs [outDir]
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const DIST = path.resolve(HERE, "../extension/dist");
const OUT = process.argv[2] || path.resolve(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });
const PORT = 5610;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

// Serve /demo/* from demo dir, everything else from dist (panel, fonts, icons).
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = rel.startsWith("/demo/") ? path.join(HERE, rel.slice(6)) : path.join(DIST, rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } else { res.statusCode = 404; res.end("nf"); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const harness = fs.readFileSync(path.join(HERE, "harness.js"), "utf8");
const chromeShim = `
window.chrome = { runtime: { lastError: null, onMessage: { addListener(){} },
  sendMessage: function(msg, cb){
    try {
      var p = (msg && msg.payload) ? msg.payload : msg;
      var aw = null; try { aw = window.top.document.getElementById('admob').contentWindow; } catch(e){}
      if (!aw || !aw.DOMH) { if(cb) cb({ok:false}); return; }
      var k = p && p.kind;
      if (k === 'READ_CONTEXT') {
        var ctx = aw.DOMH.readContext();
        ctx.page = aw.__ADMOB_VIEW || ctx.page;
        ctx.url = (aw.__ADMOB_VIEW==='create') ? 'https://admob.google.com/v2/mediation/groups/create'
                                               : 'https://admob.google.com/v2/mediation/groups/list';
        if (aw.__ADMOB_VIEW !== 'create' && aw.__demoGroups) ctx.groups = aw.__demoGroups();
        if(cb) cb({ok:true, data: ctx});
      } else if (k === 'EXEC') {
        aw.DOMH.runDirectives(p.directives||[]).then(function(r){ if(cb) cb({ok:true, data:{ok:true, results:r}}); });
        return true;
      } else if (k === 'CLEAR_HIGHLIGHTS') { aw.DOMH.clearHighlights(); if(cb) cb({ok:true}); }
      else if (k === 'PING') { if(cb) cb({ok:true}); }
      else { if(cb) cb({ok:false}); }
    } catch(e){ if(cb) cb({ok:false, message:String(e)}); }
  } } };`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
await ctx.addInitScript(harness);
await ctx.addInitScript(chromeShim);
const page = await ctx.newPage();
page.on("console", (m) => { const t = m.text(); if (/error|fail/i.test(t)) console.log("  [console]", t.slice(0, 120)); });

await page.goto(`http://127.0.0.1:${PORT}/demo/stage.html`, { waitUntil: "load" });
const panel = page.frameLocator("#panel");
const admob = page.frameLocator("#admob");

// Wait until the AdMob frame's engine is live and the panel has synced context.
await page.waitForFunction(() => {
  const a = document.getElementById("admob");
  return a && a.contentWindow && a.contentWindow.DOMH;
}, { timeout: 15000 });
await sleep(1500);

// ---- scene helpers --------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function caption(text) {
  await page.evaluate((t) => {
    const c = document.getElementById("caption");
    c.classList.remove("show");
    setTimeout(() => { c.textContent = t; c.classList.add("show"); }, 180);
  }, text);
  await sleep(500);
}
async function type(text) {
  const inp = panel.locator("#input");
  await inp.click();
  await inp.fill("");
  await inp.pressSequentially(text, { delay: 26 });
  await sleep(350);
}
async function send() {
  await panel.locator("#send").click();
  // wait for the turn to complete (transcript aria-busy toggles true -> false)
  try { await panel.locator('#transcript[aria-busy="true"]').waitFor({ timeout: 4000 }); } catch {}
  try { await panel.locator('#transcript[aria-busy="false"]').waitFor({ timeout: 45000 }); } catch {}
  await sleep(1400); // let directives/highlights settle on the page
}
async function ask(text) { await type(text); await send(); }

// ---- the demo -------------------------------------------------------------
const scenes = [];
async function scene(cap, fn) { scenes.push([cap, fn]); }

await caption("An expert assistant for AdMob Mediation — right inside the product.");
await sleep(2600);

await caption("Ask it anything. It answers in context.");
await ask("What's the difference between bidding and waterfall?");
await sleep(1800);

await caption("It can drive the page for you — starting the create flow.");
await ask("Create a new mediation group.");
await sleep(1400);

await caption("Choosing the format and platform, from plain language.");
await ask("Make it a Banner group on Android.");
await sleep(1600);

await caption("Naming the group — typed straight into the form.");
await ask("Name it Holiday Sale.");
await sleep(1600);

await caption("Adding an ad source — it opens the picker and selects it.");
await ask("Add the AdMob Network ad source.");
await sleep(1600);

await caption("Saving always waits for your explicit confirmation.");
await ask("Save the group.");
await sleep(800);
// confirm in the panel, then a human completes the real Save
try {
  await panel.locator("#confirm-btn").click({ timeout: 4000 });
  await sleep(3500);
  await admob.locator('[aria-label="Save"]').click({ timeout: 3000 });
  await sleep(2200);
} catch (e) { console.log("  save-confirm skipped:", String(e).slice(0, 60)); }

await caption("Back on the list, it can disable a live group — behind a confirmation.");
await ask("Disable the US Rewarded group.");
await sleep(2600);
try { await panel.locator("#dismiss-btn").click({ timeout: 2500 }); } catch {}

await caption("Deleting is destructive, so it takes an explicit acknowledgement.");
await ask("Delete the Holiday Promo group.");
await sleep(1400);
try {
  await panel.locator("#ack-box").check({ timeout: 3000 });
  await sleep(1800);
} catch (e) { console.log("  delete-ack skipped:", String(e).slice(0, 60)); }

await caption("Answers, guidance, and confirmed actions — right beside AdMob.");
await sleep(3000);
await page.evaluate(() => document.getElementById("caption").classList.remove("show"));
await sleep(600);

await page.close();
const video = await page.video();
const raw = await video.path();
await ctx.close();
await browser.close();
server.close();
const final = path.join(OUT, "admob-assistant-demo.webm");
fs.renameSync(raw, final);
console.log("VIDEO:", final);
