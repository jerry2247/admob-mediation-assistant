# Extension — AdMob Mediation Assistant (Chrome MV3)

The user-facing **side panel** plus the page **actuator** (content script).
TypeScript, bundled with esbuild.

## Build & load

```bash
npm install
npm run build     # → dist/
# Chrome: chrome://extensions → enable Developer mode → Load unpacked → select dist/
```

Open `https://admob.google.com/v2/mediation/groups/list` and click the extension's
side-panel icon. The backend (`../backend/run.sh`) must be running; the panel's
status dot turns green when it's reachable. `npm run package` zips `dist/`.

## Layout

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest — least-privilege permissions + pinned CSP |
| `src/sidepanel/` | Side panel UI: streaming chat, draft card, confirmation card |
| `src/content/dom.ts` | DOM engine: read context · resolve control · highlight · click/fill |
| `src/content/content.ts` | Content-script message handler (idempotent) |
| `src/background/service-worker.ts` | Default-deny side-panel policy + message broker |
| `src/shared/protocol.ts` | Wire types (mirror of `backend/app/schemas.py`) |
| `build.mjs` | esbuild build script |

Design: [`../docs/09-design.md`](../docs/09-design.md) §6–7.
