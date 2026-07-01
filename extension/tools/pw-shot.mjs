// Playwright screenshot harness for the side panel.
// Serves dist/ over loopback (so backend CORS allows it), loads the REAL built
// panel at the true 384px panel width with a minimal `chrome` shim so main.js runs,
// optionally sends a message to the live backend, then screenshots.
//
//   node tools/pw-shot.mjs <out.png> [message] [waitMs]
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve("dist");
const PORT = 5599;
const out = process.argv[2] || "/tmp/pw.png";
const msg = process.argv[3] || "";
const waitMs = Number(process.argv[4] || (msg ? 9000 : 500));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.join(DIST, rel);
  if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// Minimal chrome shim: READ_CONTEXT -> a representative page context; EXEC -> ok.
// PW_CREATE=1 simulates the create page with live form state (for the draft card).
const ctx = process.env.PW_CREATE
  ? { url: "https://admob.google.com/v2/mediation/groups/create", page: "create", title: "AdMob",
      form: { format: "Banner", platform: "Android" }, controls: [] }
  : { url: "https://admob.google.com/v2/mediation/groups/list", page: "list", title: "AdMob",
      controls: [{ tag: "material-button", label: "Create mediation group", enabled: true },
                 { tag: "material-button", label: "Filter", enabled: true }] };
const shim = `window.chrome={runtime:{lastError:null,sendMessage:(m,cb)=>{const k=m&&m.payload&&m.payload.kind;const data=k==='READ_CONTEXT'?${JSON.stringify(ctx)}:{ok:true};if(cb)cb({ok:true,data});}}};`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 384, height: 860 }, deviceScaleFactor: 2 });
await page.addInitScript(shim);
await page.goto(`http://127.0.0.1:${PORT}/sidepanel/index.html`, { waitUntil: "load" });
await page.waitForTimeout(500);
if (msg) {
  await page.fill("#input", msg);          // dispatches input -> autosize runs
  if (waitMs > 0) {                         // waitMs 0 = fill only (don't send)
    await page.click("#send");
    await page.waitForTimeout(waitMs);
  } else {
    await page.waitForTimeout(150);
  }
}
await page.screenshot({ path: out });
await browser.close();
server.close();
console.log("shot ->", out);
