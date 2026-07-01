# Demo — the AdMob Mediation Assistant in action

`admob-assistant-demo.mp4` is a single, captioned walkthrough of every feature: asking
an in-context question, opening the create flow, choosing format + platform from plain
language, naming the group, adding an ad source, the confirm-before-save gate, disabling
a live group, and deleting one behind an explicit acknowledgement.

## What's actually running

The video is **not** a mockup. It records:

- the **real side panel** (`extension/dist`, the shipped build),
- driving the **real DOM engine** (`extension/src/content/dom.ts`, bundled to
  `harness.js`) against a **faithful AdMob page** (`admob-page.html`) that uses the same
  ACX Material element tags as the live app (`material-radio-group`,
  `material-dropdown-select`, `material-list-item`, …), so the engine resolves and
  actuates it exactly as it would `admob.google.com`.

`stage.html` docks the panel beside the AdMob page and wires the panel's `chrome`
messaging to the engine on the AdMob frame; `record.mjs` types into the panel, lets the
turns play out, overlays the captions, and records the video with Playwright.

## Live vs. replay

`record.mjs` talks to whatever is on `127.0.0.1:8765`:

- **Live** — the real ADK backend (`backend/run.sh`). Full end-to-end with Gemini.
  Blocked only by the Gemini **free-tier cap of 20 requests/day**; a full take is ~10
  calls, so enable billing on the key's project (or use a key from a project with quota)
  before recording live.
- **Replay** — `replay-backend.mjs`, a drop-in stand-in that streams the **exact
  directives and proposals the live model was verified to emit** for each utterance
  (captured from live API runs), over the identical SSE wire contract. This renders the
  complete video without spending quota. The published `admob-assistant-demo.mp4` was
  recorded this way; the composition, UI, engine, and page are all real.

## Reproduce

```bash
# 0) build the panel + bundle the engine
( cd ../extension && npm run build )
npx esbuild ../extension/tests/harness.ts --bundle --format=iife --outfile=harness.js

# 1a) LIVE (needs quota):    ../backend/run.sh &
# 1b) or REPLAY (no quota):  node replay-backend.mjs &

# 2) record  ->  out/admob-assistant-demo.webm
node record.mjs

# 3) (optional) transcode to mp4
ffmpeg -i out/admob-assistant-demo.webm -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart admob-assistant-demo.mp4
```
