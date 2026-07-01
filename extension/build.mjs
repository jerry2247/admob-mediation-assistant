// Build the extension into dist/ with esbuild (classic IIFE bundles so the content
// script and service worker load without ESM constraints).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";

const OUT = "dist";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: {
    "background/service-worker": "src/background/service-worker.ts",
    "content/content": "src/content/content.ts",
    "sidepanel/main": "src/sidepanel/main.ts",
  },
  outdir: OUT,
  bundle: true,
  format: "iife",
  target: ["chrome114"],
  platform: "browser",
  logLevel: "info",
});

// Static assets
cpSync("manifest.json", `${OUT}/manifest.json`);
mkdirSync(`${OUT}/sidepanel`, { recursive: true });
cpSync("src/sidepanel/index.html", `${OUT}/sidepanel/index.html`);
cpSync("src/sidepanel/styles.css", `${OUT}/sidepanel/styles.css`);
if (existsSync("public/icons")) cpSync("public/icons", `${OUT}/icons`, { recursive: true });
if (existsSync("public/fonts")) cpSync("public/fonts", `${OUT}/fonts`, { recursive: true });

console.log("✓ built extension -> dist/");
