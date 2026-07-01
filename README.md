# AdMob Mediation Assistant

**An experimental in-browser copilot that sits *inside* the AdMob web app and helps publishers work through Mediation — answering questions in context, explaining fields, pointing at the right control, drafting and editing mediation groups from plain language, and performing low-risk actions directly while keeping every account-changing action behind an explicit human confirmation.**

> **Status: early prototype / active exploration.** This is a research prototype, not a finished or supported product. Interfaces, behavior, and scope are still moving; expect rough edges and treat everything here as work in progress. It runs unpacked against a local model backend.

https://github.com/user-attachments/assets/placeholder — see [`demo/admob-assistant-demo.mp4`](demo/admob-assistant-demo.mp4) for a recorded walkthrough of the current build.

---

## What it is

AdMob's Mediation UI (`admob.google.com/v2/mediation/…`) is an **AngularDart single-page app** rendered with Google's ACX "Material" web components. Crucially, it exposes a **real, semantic DOM** — ARIA roles and labels, custom elements like `<material-radio-group>`, `<material-dropdown-select>`, `<ess-cell>` — so a browser extension can genuinely *read* and *act on* the page the way a person does. (Its `_ngcontent-*` view-encapsulation hashes are build-specific and unusable as selectors, so the whole engine resolves controls by accessible name/role, never by those hashes.)

The prototype pairs that with a small **Google ADK + Gemini** agent. The agent does the *reasoning*; the browser does the *acting*. The agent never touches a DOM — it emits **semantic intents** (tool calls), and deterministic code in the extension resolves those intents to real controls and performs them. This separation is the core idea: the model decides *what*, code decides *how* and *whether it's allowed*.

## The hard problem it explores

- **Grounding on a live, dynamic Angular DOM** without brittle selectors — resolving "the Android radio" or "the Ad format field" to the right element by accessible name, tolerating the ACX quirks (icon-ligature text inside controls, section labels that live in sibling elements, list rows built from `<ess-cell>` instead of links).
- **Letting an LLM operate a real product safely** — a code-enforced boundary so the model can freely do reversible things but *cannot* machine-click a Save, a Delete, or a live serving toggle. Those only ever happen after a human confirms.
- **Feeling native** — a side panel that reads as part of the page: calm streaming answers, controls highlighted in place, a live "group draft" that mirrors what's actually selected on the form.

---

## Features — what the assistant is designed to do

Everything the assistant does maps to a small, typed tool surface, and every action carries a **change tier** that the extension enforces in code (see [Safety model](#safety-model)).

| Ask it… | How it works | Change tier |
|---|---|---|
| Explain a concept — bidding vs. waterfall, **eCPM floors**, priority, hybrid, default group, conflict avoidance, custom events, IDFA… | Looks up a canonical knowledge base, answers in context | **Read-only** |
| "What's on this page?" / "What does this field do?" | Reads the live page's visible controls and grounds the answer | **Read-only** |
| "Where is X?" / "Highlight the Save button" | Draws an overlay on the real control (tracked as you scroll) | **Read-only** |
| **Create a mediation group** from a sentence ("make a Banner group on Android called Holiday Sale") | Selects Ad format + Platform, types the name, opens the source picker | **Reversible** |
| Choose **Ad format** and **Platform** | `select_option` on radios / cards / dropdowns (state-aware, idempotent) | **Reversible** |
| Name / rename the group | `fill_field` on the labelled input | **Reversible** |
| **Add or choose ad sources** (bidding / waterfall) | `select_option` opens the picker and selects the network | **Reversible** |
| **Set a bidding eCPM floor**, or a specific source's **manual eCPM** | `fill_field` — scoped to one source row by network name when needed (`within`) | **Reversible** |
| Toggle a draft option — include a location, an IDFA setting, enable a draft source | `set_toggle` (state-aware — never flips the wrong way) | **Reversible** |
| **Edit an existing group's settings** — format/platform/name/sources/floors on the group's form | The same reversible edits, on an existing group's form | **Reversible** |
| **Save / create / update** the group (incl. a priority or floor change on a live group) | `propose_save` → you confirm in the panel → it points you at the real **Save** | **Persistent (confirmed)** |
| **Enable / disable** a live group's serving | `propose_status_change` → you confirm | **Persistent (confirmed)** |
| **Delete** a group / remove an ad source | `propose_delete` → a stronger "I understand this can't be undone" confirmation | **Destructive (confirmed)** |

> On the two questions people ask first: **yes — it can update eCPM floors** (the bidding floor, and per-source manual eCPM scoped to a single network row), and **yes — it can edit existing mediation groups**, because editing is the same reversible form actuation as creation, and any change that persists to the account (save/update, enable/disable, delete) is routed through the same propose → confirm gate. The recorded demo shows a representative slice (create → select → name → add source → confirm-save → disable → delete); the tool surface covers the fuller set above.

---

## Architecture

Three cooperating planes. **Reasoning** (the agent) is strictly separated from **action** (the browser): the model proposes semantic intents; deterministic code executes them on the DOM.

```
┌── Chrome browser ───────────────────────────────────┐      ┌── Local backend (Python) ──────┐
│                                                      │      │                                │
│  ┌ Side panel (extension page) ─────────┐            │      │  FastAPI (127.0.0.1:8765)      │
│  │ chat · draft card · confirm card     │            │      │   /healthz                     │
│  │ main.ts                              │── fetch ───┼──────┼─▶ /api/chat        (JSON)      │
│  └───────────┬──────────────────────────┘   SSE     │      │   /api/chat/stream (SSE)       │
│              │ chrome.runtime messaging              │      │        │                       │
│  ┌ Service worker (broker) ─────────────┐            │      │        ▼                       │
│  │ service-worker.ts                    │            │      │  ADK Runner + LlmAgent         │
│  │ default-deny panel · routing         │            │      │  (Gemini, function-calling)    │
│  └───────────┬──────────────────────────┘            │      │   tools → semantic intents     │
│              │ chrome.tabs.sendMessage               │      │  InMemorySessionService        │
│  ┌ Content script (actuator) ───────────┐            │      │  (per-session draft state)     │
│  │ dom.ts: read · resolve · highlight ·  │            │      └────────────────────────────────┘
│  │ click / fill the live AngularDart DOM│            │
│  └──────────────────────────────────────┘            │
└──────────────────────────────────────────────────────┘
```

**Why a backend *and* a browser actuator?** ADK is a Python framework; the extension is JavaScript in the browser. ADK does the thinking; the extension is the agent's eyes and hands. The agent's "page" tools return only an acknowledgement — the backend derives the real on-page directive by observing the tool *call* (its name + args), so the backend never needs a DOM, and the browser never needs the model.

**The flow of one turn:**

1. The side panel reads a compact, privacy-safe snapshot of the page (`readContext`) — page type from the URL, the visible controls (tag/role/label), the current form values, and the list of groups.
2. It POSTs `{message, page_context}` to the backend's SSE endpoint.
3. The agent grounds on that context, streams a reply, and calls tools. Each tool call becomes a typed **Directive** (`highlight`, `click`, `fill`, `select_option`, `set_toggle`, `select_row`) or a **ProposedAction** (`save_group`, `set_status`, `delete`).
4. The panel renders the streamed reply, then forwards the directives to the content script, which **resolves each semantic target to a real element and actuates it** — or, for anything persistent/destructive, refuses and waits for a human.

---

## Safety model

Four change tiers, **enforced in code** — not merely requested of the model:

| Tier | Examples | Who acts |
|---|---|---|
| **Read** | `highlight`, `scroll_to` | Extension (no page change) |
| **Reversible** | `click` (open a flow), `fill`, `select_option`, `set_toggle`, `select_row` | Extension |
| **Persistent** | Save/update a group, enable/disable serving | **Human** confirms, then clicks |
| **Destructive** | Delete a group, remove a source | **Human** passes a stronger confirmation |

- Persistent and destructive changes are **never** emitted as machine-actuating directives — only as a `ProposedAction` that renders a confirmation card. On confirm, the agent is instructed to merely **highlight** the real Save/Delete control and tell the user to click it — it never claims it performed the change.
- A **defense-in-depth gate** lives in the content script: even a *reversible* tool call is refused if it resolves to a control whose accessible name reads as persistent/destructive (Save/Publish/Delete/…), or to a live serving toggle on the list/detail page. So a mislabeled intent can't slip a real Save through.
- Resolution **refuses ambiguity**: for actuation it requires a strong, unambiguous match and skips disabled/invisible elements, so the agent can't mis-click a near-tie.

---

## End-to-end example

```
User: "make a Banner group on Android called Holiday Sale, add AdMob Network"

 panel ── READ_CONTEXT ─▶ worker ─▶ content.readContext() ─▶ PageContext(create, controls…)
 panel ── POST /api/chat/stream {message, page_context} ─▶ backend
   agent grounds on the page, streams a reply, and calls:
     select_option("Ad format","Banner"), select_option("Platform","Android"),
     fill_field("Mediation group name","Holiday Sale"),
     select_option("Add ad source","AdMob Network"), set_draft(...) for each
 panel renders the reply + the live "Group draft" card
 panel ── EXEC {directives} ─▶ worker ─▶ content.runDirectives()
   each directive resolves to a real ACX control and actuates it (state-aware)

User: "save it"
   agent calls propose_save(...) → panel shows a Confirm card
User clicks Confirm → next turn highlights the real Save for the user to click
```

---

## Repository layout

```
admob-mediation-assistant/
├── backend/                    # Python: the reasoning plane (ADK + Gemini via FastAPI)
│   ├── app/
│   │   ├── agent.py            # the agent: tools (the action vocabulary) + system instruction
│   │   ├── server.py           # FastAPI turn engine: SSE streaming, retries, confirm gate
│   │   ├── schemas.py          # Pydantic wire contract (mirrored in the extension)
│   │   └── knowledge.py        # canonical mediation knowledge base + create-flow steps
│   ├── pyproject.toml
│   └── run.sh                  # start on 127.0.0.1:8765
│
├── extension/                  # Chrome MV3 side-panel extension: the action plane
│   ├── manifest.json           # least-privilege MV3 manifest, pinned CSP
│   ├── build.mjs               # esbuild → dist/ (IIFE bundles + static assets)
│   ├── package.json            # build / typecheck / test scripts
│   ├── tsconfig.json
│   ├── scripts/generate_icons.py
│   ├── src/
│   │   ├── shared/protocol.ts       # TS mirror of the wire contract
│   │   ├── background/service-worker.ts  # default-deny panel + message broker
│   │   ├── content/
│   │   │   ├── content.ts            # message listener + SPA-nav handling
│   │   │   └── dom.ts                # the DOM engine: read · resolve · highlight · actuate
│   │   └── sidepanel/
│   │       ├── index.html
│   │       ├── styles.css           # dual width-mode (narrow + wide), Material-aligned
│   │       └── main.ts              # chat, streaming, cards, directive dispatch
│   └── tests/
│       ├── harness.ts               # exposes the real dom.ts engine to Playwright
│       ├── dom.spec.mjs             # deterministic checks (idealized DOM)
│       └── real-dom.spec.mjs        # deterministic checks (real-AngularDart-shaped DOM)
│
└── demo/                        # a self-contained visual harness + recorder
    ├── admob-page.html          # faithful synthetic AdMob page (real ACX tags)
    ├── admob-page.js            # its behavior (state flips on real clicks)
    ├── stage.html               # docks the panel beside the page (Chrome-style)
    ├── record.mjs               # Playwright: drives the panel, records the video
    ├── replay-backend.mjs       # drop-in stand-in that streams verified model outputs
    └── admob-assistant-demo.mp4 # recorded walkthrough of the current build
```

---

## Running it locally

**Backend** (Python 3.10+, [`uv`](https://docs.astral.sh/uv/)):

```bash
cd backend
echo 'GEMINI_API_KEY=your-key' > .env      # from Google AI Studio; never commit this
./run.sh                                    # serves http://127.0.0.1:8765
```

**Extension** (Node 18+):

```bash
cd extension
npm install
npm run build                               # → extension/dist
# Chrome → chrome://extensions → Developer mode → Load unpacked → select extension/dist
```

Open `https://admob.google.com/v2/mediation/…` and the side panel activates on that tab only.

**The demo harness** (no AdMob account needed — a faithful synthetic page):

```bash
cd demo
npx esbuild ../extension/tests/harness.ts --bundle --format=iife --outfile=harness.js
node replay-backend.mjs &                   # or ../backend/run.sh for the live model
node record.mjs                             # → out/admob-assistant-demo.webm
```

## Tests

Deterministic, browser-based checks run the **real** `dom.ts` engine (bundled through the test harness) against synthetic DOM — no model, no network:

```bash
cd extension
npm run typecheck   # tsc --noEmit
npm test            # dom.spec.mjs + real-dom.spec.mjs
```

`dom.spec.mjs` covers the engine on idealized (fully aria-labelled) controls; `real-dom.spec.mjs` covers the trickier **real-AngularDart shapes** — radios whose name is buried behind a `<material-icon>` ligature, a format dropdown labelled by a sibling element, list rows built from `<ess-cell>` spans, and both defense-in-depth risk gates.

---

## Limitations & directions being explored

This is a prototype and is meant to keep changing. Some of the current edges and open threads:

- **Persistent writes go through the page** (a human clicks the highlighted Save) after confirmation. A first-party write path (an authenticated API instead of DOM clicks) is an obvious reliability direction and is not built.
- **Single-user, localhost backend.** No multi-tenant hosting, no auth on the backend beyond loopback binding + a restricted CORS origin.
- **Model access.** The backend talks to Gemini via an API key; free-tier request caps make long multi-turn sessions and full end-to-end recordings quota-limited (billing lifts the cap). The demo can be recorded quota-free via the replay backend, which streams the exact verified model outputs over the identical wire contract.
- **Grounding is best-effort.** The engine resolves controls by accessible name/role and refuses ambiguity rather than guessing; real-page structure evolves, so the resolver and the knowledge base are living code.
- **Not packaged / not published** anywhere; it loads unpacked for local exploration only.

---

## All source code

Everything below is the current source, inlined so the whole prototype can be read in one place. Each file is collapsed — click to expand. (Generated assets — `dist/`, `node_modules/`, bundled `harness.js`, the model key, and the local AdMob captures — are intentionally excluded.)


### Backend — the reasoning plane (Python · ADK · Gemini)

<details>
<summary><code>backend/app/agent.py</code></summary>

````python
"""The AdMob Mediation expert agent (Google ADK + Gemini 3.5 Flash).

Reasoning lives here; actions do not. Tools never touch a browser — they emit
*intents* (highlight / guide_click / propose_save) that the Chrome extension
resolves and executes against the real DOM. This enforces the contract's
separation of reasoning from action, and keeps every persistent change behind an
explicit, user-confirmed gate.
"""
from __future__ import annotations

from google.adk.agents import LlmAgent
from google.adk.tools import ToolContext

from .knowledge import KB, CREATE_FLOW_STEPS, lookup

MODEL = "gemini-3.5-flash"

EMPTY_DRAFT: dict = {
    "format": None,
    "platform": None,
    "name": None,
    "ad_units": None,
    "locations": None,
    "sources": None,
    "ecpm": None,
}

DRAFT_FIELDS = set(EMPTY_DRAFT.keys())


# --- Tools -----------------------------------------------------------------
# Each tool's docstring IS its spec to the model. Page-acting tools just return
# an ack; the server derives the actual on-page Directive from the observed call.

def lookup_concept(name: str) -> dict:
    """Look up the canonical AdMob explanation for a mediation concept before
    explaining it, so the answer is accurate. Valid names include: mediation group,
    bidding, waterfall, hybrid, priority, default group, conflict avoidance,
    ecpm floor, manual ecpm, optimized ecpm, custom event, ad format, platform,
    ad unit, location targeting, idfa, mapping.

    Args:
        name: the concept to look up.
    """
    text = lookup(name)
    return {"found": bool(text), "explanation": text}


def highlight(label: str, note: str = "") -> dict:
    """Point the user at a control on the current page by its visible label or
    aria-label (e.g. "Create mediation group", "Location", "Add ad source").
    Use this whenever you say "see/where/click here" so the UI is pointed at.

    Args:
        label: the visible text or aria-label of the target control.
        note: a short caption to show by the highlight (optional).
    """
    return {"status": "ok"}


def guide_click(label: str, note: str = "") -> dict:
    """Perform a LOW-RISK, fully reversible click for the user — for example
    opening the "Create mediation group" flow or advancing a setup dialog. Only
    call this when the user has asked you to proceed/do it. NEVER use it for a
    final Save, Remove, Pause/Enable, priority change, or any persistent change.

    Args:
        label: the visible text or aria-label of the control to click.
        note: short explanation of what this click does (optional).
    """
    return {"status": "ok"}


def fill_field(label: str, value: str, within: str = "", note: str = "") -> dict:
    """Type a value into a labelled text field on the current create/edit form (the
    group Name, an eCPM/bidding floor, a location search box). Reversible — nothing is
    saved until the human clicks Save. Use `within` to scope a repeated field to one
    ad-source row by its network name (e.g. the eCPM for "AppLovin"). Always call
    `set_draft` for the same value too. Never enter a value the user did not give.

    Args:
        label: the visible label of the field to fill.
        value: the exact text to enter.
        within: optional ad-source/row name to disambiguate a repeated field.
        note: short caption to show by the field (optional).
    """
    return {"status": "ok"}


def select_option(field: str, option: str, within: str = "", note: str = "") -> dict:
    """Choose ONE option for a single-choice control, whether it renders as radio
    buttons / selectable cards (Ad format, Platform, Bidding vs Waterfall, Optimized
    vs Manual eCPM) or as a dropdown/picker that opens a menu (add an ad unit, add an
    ad source/network, a Status or Sort filter). State-aware — a no-op if it is already
    chosen. Call again to pick another value (multi-select). Reversible; nothing
    persists until Save.

    Args:
        field: the field/control to set, by its visible label.
        option: the option to choose, by its visible text.
        within: optional row/source name to disambiguate.
        note: short caption (optional).
    """
    return {"status": "ok"}


def set_toggle(label: str, on: bool, within: str = "", note: str = "") -> dict:
    """Turn a switch or checkbox in the create/edit DRAFT on or off (include a
    location, an IDFA option, enable a draft ad-source row). State-aware, so it never
    flips the wrong way. Do NOT use this to enable/disable a LIVE group's serving —
    that is persistent; use `propose_status_change` for that.

    Args:
        label: the visible label of the toggle/checkbox.
        on: desired state — True for on, False for off.
        within: optional row/source name to disambiguate.
        note: short caption (optional).
    """
    return {"status": "ok"}


def set_selection(group: str, on: bool = True, note: str = "") -> dict:
    """Tick or untick a mediation group's row checkbox in the list to STAGE a bulk
    action (before deleting or disabling several at once). UI-only — no account change.
    Only touches a row's selection checkbox, never a serving switch.

    Args:
        group: the group's name as shown in the list.
        on: True to select the row, False to clear it.
        note: short caption (optional).
    """
    return {"status": "ok"}


# Canonicalize the two enum fields so the progress tracker is always correct
# regardless of how the user phrased it or how the model echoed it.
_FORMAT_TABLE = [
    ("rewarded interstitial", "Rewarded interstitial"),
    ("rewarded", "Rewarded"),
    ("interstitial", "Interstitial"),
    ("banner", "Banner"),
    ("native", "Native"),
    ("app open", "App open"),
    ("appopen", "App open"),
]


def _canon_format(v: str) -> str:
    s = v.lower()
    for key, canon in _FORMAT_TABLE:
        if key in s:
            return canon
    return v


def _canon_platform(v: str) -> str:
    s = v.lower()
    if "ios" in s or "iphone" in s or "ipad" in s:
        return "iOS"
    if "android" in s:
        return "Android"
    return v


def set_draft(field: str, value: str, tool_context: ToolContext) -> dict:
    """Record a value the user has EXPLICITLY chosen for the mediation group being
    assembled. Only call this for a real choice the user made — never from a question
    or a guess, and never invent values. Nothing is applied to the account; this only
    updates the working draft shown to the user.

    Pass field="reset" to clear the whole draft when the user abandons the current
    group and starts a different one.

    Args:
        field: one of format, platform, name, ad_units, locations, sources, ecpm
            (or "reset" to clear the draft).
        value: the value as text.
    """
    draft = dict(tool_context.state.get("draft") or EMPTY_DRAFT)
    if field == "reset":
        draft = dict(EMPTY_DRAFT)
        tool_context.state["draft"] = draft
        return {"status": "ok", "draft": draft}
    if field not in DRAFT_FIELDS:
        return {"status": "error", "message": f"unknown field {field!r}"}
    v = (value or "").strip()
    if not v:
        return {"status": "error", "message": "empty value ignored"}
    if field == "format":
        v = _canon_format(v)
    elif field == "platform":
        v = _canon_platform(v)
    draft[field] = v
    tool_context.state["draft"] = draft
    return {"status": "ok", "draft": draft}


def propose_save(summary: str, tool_context: ToolContext) -> dict:
    """Propose a PERSISTENT account change (e.g. creating/saving the mediation
    group). This does NOT perform it — the user must confirm in the UI first.
    Do not claim the change happened. Provide a one-line, human summary of exactly
    what will be saved.

    Args:
        summary: one-line description of the change to confirm.
    """
    return {"status": "queued_for_confirmation", "summary": summary}


def propose_status_change(summary: str, groups: list[str], enabled: bool,
                          tool_context: ToolContext) -> dict:
    """Propose ENABLING or DISABLING one or more LIVE mediation groups (changes
    whether they serve ads). This is a persistent account change, so it performs
    nothing — the user confirms in the UI, then a human applies it. Do not claim it is
    done.

    Args:
        summary: one-line description of the change to confirm.
        groups: the names of the groups affected.
        enabled: True to enable serving, False to disable.
    """
    return {"status": "queued_for_confirmation", "kind": "set_status"}


def propose_delete(summary: str, targets: list[str], tool_context: ToolContext) -> dict:
    """Propose a DESTRUCTIVE, irreversible change — deleting mediation group(s) or
    removing ad source(s). Performs nothing; the user must pass a stronger
    confirmation, then a human performs the actual delete. Never propose deleting the
    account's default group.

    Args:
        summary: one-line description of exactly what will be deleted.
        targets: the names of the groups or ad sources to delete.
    """
    return {"status": "queued_for_confirmation", "kind": "delete"}


TOOLS = [
    lookup_concept, highlight, guide_click,
    fill_field, select_option, set_toggle, set_selection,
    set_draft, propose_save, propose_status_change, propose_delete,
]


# --- Instruction -----------------------------------------------------------

_KB_DIGEST = "\n".join(f"- {k}: {v}" for k, v in KB.items())
_FLOW_DIGEST = "\n".join(f"{i+1}. {s}" for i, s in enumerate(CREATE_FLOW_STEPS))

INSTRUCTION = f"""
You are a senior AdMob monetization specialist, embedded in the AdMob web app as a
calm, expert copilot for app publishers using AdMob Mediation
(https://admob.google.com/v2/mediation/...). You help them understand concepts,
navigate the page, and set up or improve mediation groups.

CONTEXT
Every turn begins with a PAGE CONTEXT JSON block: the current url, page type
(list | create | detail), step, title, the visible `controls` (tag/role/label/text),
and the working `draft`. Read it first and ground every answer in what is actually on
screen, referring to controls by their exact label. If something isn't visible, say
where it normally appears rather than inventing it.

VOICE — write like a Google product, not a chatbot
- Lead with the answer. Be brief: usually 1–3 short sentences, or a tight list for a
  procedure or comparison. Never pad.
- Plain, confident, warm. No exclamation marks. No hype ("Great", "Let's begin").
- No filler or sign-offs ("Let me know if…", "Hope this helps", "Feel free to…").
- Don't restate the question or preface with "Sure"/"Of course". Define a term once,
  simply, then move on.

NEVER NARRATE THE INTERFACE
The UI shows highlights and performs clicks visibly. Do NOT describe these actions —
never write "I've highlighted…", "I'm going to click…", "I clicked…", or "I opened…".
Act through the tools silently, then give the user the next concrete step — not a
description of what you just did.

HOW YOU ACT (tools are silent; the user sees the result on the page)
You can actually operate the page. Reversible edits to the not-yet-saved form happen
directly; anything that changes the LIVE account is only ever PROPOSED for the user to
confirm, and the final click is always theirs.

When the user asks you to set, choose, enter, add, or turn on something that is on the
CURRENT page, actually DO it with the matching tool below — do not merely record it in
the draft or tell the user to click it themselves. The page shows the change visibly.

Reversible — do these directly when the user asks you to set something up:
- `fill_field(label, value)` — type into a text field (group Name, an eCPM floor).
- `select_option(field, option)` — choose Ad format, Platform, Bidding vs Waterfall,
  add an ad unit or ad source, set a filter. Call again to choose more than one.
- `set_toggle(label, on)` — flip a draft switch/checkbox (include a location, etc.).
- `guide_click(label)` — one reversible click (open the create flow, **Continue**).
- `set_selection(group, on)` — tick a group's row to stage a bulk action.
- `highlight(label)` — point at a control without clicking it.
Pair every form value with `set_draft(field, value)` so the draft card stays in sync.
Record only what the user EXPLICITLY chose — never a guess. On a new group, call
`set_draft("reset", "")` first.

Account-changing — NEVER do these yourself; propose, and the user confirms:
- `propose_save(summary)` — save/create/update a group, or change a live group's
  priority/floor.
- `propose_status_change(summary, groups, enabled)` — enable/disable a live group.
- `propose_delete(summary, targets)` — delete group(s) or remove an ad source.
After the user confirms, you STILL only `highlight` the real Save/Delete control for
them to click. Never say something was saved, deleted, enabled, or changed.

- `lookup_concept(name)` before explaining any mediation concept; base the answer on it.

FORMAT
- Markdown renders. Use **bold** only for on-screen control names. No headings, no
  emoji. Numbered list only for an ordered procedure; bullets only for a short
  comparison or set; otherwise plain sentences.
- Set everything visible on the CURRENT step at once (e.g. format and platform
  together), then advance with **Continue** and wait for the next step to render. Don't
  act on fields that aren't on screen yet, and don't paste the whole sequence as text.

If the page is ambiguous or a control can't be found, ask one short clarifying
question instead of guessing. Never expose or request secrets (API keys, cookies,
publisher/app IDs).

TONE EXAMPLES (match these)
Q: "what's the difference between bidding and waterfall?"
A: "Bidding runs a real-time auction across your sources for each request — the
highest bid wins. Waterfall calls sources in a fixed order by the eCPM you set, top
to bottom. Bidding usually maximizes competition; waterfall gives you manual control.
Most groups today lead with bidding and add a few waterfall sources."

Q: "help me create a group" (you open the create flow)
A: "Pick your **Ad format** and **Platform**, then **Continue**. What format is this
group for?"

Q: "set the format to Banner and platform to Android" (on the create page)
[call select_option("Ad format", "Banner"), select_option("Platform", "Android"), and
set_draft for each — then reply:]
A: "Next, click **Continue** to name your group."

Q: "delete the Holiday group"
[call propose_delete("Delete mediation group Holiday", ["Holiday"]) — then reply:]
A: "This permanently deletes **Holiday** and its settings. Confirm below to proceed."

CREATE-FLOW REFERENCE (guide one step at a time — do not paste this list)
{_FLOW_DIGEST}

MEDIATION KNOWLEDGE (authoritative — quote faithfully)
{_KB_DIGEST}
""".strip()


def build_agent() -> LlmAgent:
    return LlmAgent(
        name="admob_mediation_assistant",
        model=MODEL,
        instruction=INSTRUCTION,
        tools=TOOLS,
    )
````

</details>

<details>
<summary><code>backend/app/server.py</code></summary>

````python
"""FastAPI server exposing the AdMob agent to the Chrome extension.

Endpoints:
  GET  /healthz          liveness
  POST /api/chat         single-shot: reply + directives + draft + proposed_action
  POST /api/chat/stream  SSE: token deltas, then a terminal `done` event (always sent)

The extension is the agent's hands/eyes: this server only emits semantic intents.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from .agent import EMPTY_DRAFT, build_agent
from .schemas import ChatRequest, ChatResponse, Directive, ProposedAction

# --- API key: accept GEMINI_API_KEY (project .env) and expose as GOOGLE_API_KEY ---
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
if not os.environ.get("GOOGLE_API_KEY") and os.environ.get("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "FALSE")

APP_NAME = "admob_agent"
USER_ID = "local-user"

app = FastAPI(title="AdMob Agent Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)

_session_service = InMemorySessionService()
_runner = Runner(app_name=APP_NAME, agent=build_agent(), session_service=_session_service)


# Transient upstream conditions worth retrying before surfacing anything to the user.
# gemini-3.5-flash returns 503 UNAVAILABLE ("high demand") in bursts; a few short
# backoffs turn that into a normal (slightly slower) reply instead of a failure.
# NOTE: 429/RESOURCE_EXHAUSTED is deliberately NOT retried — it is a quota limit
# (the free tier caps requests per day), so retrying only burns more quota and can
# never succeed; we surface it immediately instead.
_TRANSIENT_MARKERS = ("UNAVAILABLE", "503", "INTERNAL", " 500", "DEADLINE_EXCEEDED")
_RETRY_BACKOFFS = (0.7, 1.6, 3.2)  # seconds before retry 1, 2, 3


def _is_transient(e: Exception) -> bool:
    return any(m in str(e) for m in _TRANSIENT_MARKERS)


def _friendly_error(e: Exception) -> str:
    s = str(e)
    if "RESOURCE_EXHAUSTED" in s or "429" in s:
        # Free-tier gemini-3.5-flash caps requests per day; distinguish the per-day
        # cap (wait/enable billing) from a short per-minute burst.
        if "PerDay" in s or "per day" in s or "generate_content_free_tier_requests" in s:
            return (
                "The daily free-tier request limit for this API key has been reached. "
                "Enable billing on the key for higher limits, or try again tomorrow."
            )
        return (
            "The model is briefly rate-limited. Give it a few seconds and try again, "
            "or enable billing on the key for higher limits."
        )
    if "PERMISSION_DENIED" in s or "401" in s or "403" in s:
        return "The Gemini API key was rejected. Check `GEMINI_API_KEY` in `.env`."
    if "UNAVAILABLE" in s or "503" in s or "INTERNAL" in s or " 500" in s:
        return "The model is busy right now. Give it a moment and try again."
    return "Something went wrong reaching the model. Please try again."


def _directive_from_call(name: str, args: dict) -> Directive | None:
    args = args or {}
    note = args.get("note", "")
    within = args.get("within") or None
    if name == "highlight":
        return Directive(type="highlight", target={"label": args.get("label", "")},
                         note=note, risk="read")
    if name == "guide_click":
        return Directive(type="click", target={"label": args.get("label", "")},
                         note=note, risk="reversible")
    if name == "fill_field":
        return Directive(type="fill", target={"label": args.get("label", ""), "within": within},
                         value=str(args.get("value", "")), note=note, risk="reversible")
    if name == "select_option":
        return Directive(type="select_option",
                         target={"label": args.get("field", ""), "within": within},
                         value=str(args.get("option", "")), note=note, risk="reversible")
    if name == "set_toggle":
        return Directive(type="set_toggle", target={"label": args.get("label", ""), "within": within},
                         value="on" if args.get("on") else "off", note=note, risk="reversible")
    if name == "set_selection":
        return Directive(type="select_row", target={"label": args.get("group", "")},
                         value="on" if args.get("on", True) else "off", note=note, risk="reversible")
    return None


def _proposed_from_call(name: str, args: dict) -> ProposedAction | None:
    args = args or {}
    new_id = uuid.uuid4().hex[:12]
    if name == "propose_save":
        return ProposedAction(id=new_id, kind="save_group",
                              summary=args.get("summary", "Save changes"),
                              risk="persistent", draft={})
    if name == "propose_status_change":
        return ProposedAction(id=new_id, kind="set_status",
                              summary=args.get("summary", "Update group serving"),
                              risk="persistent",
                              draft={"groups": args.get("groups") or [], "enabled": bool(args.get("enabled"))})
    if name == "propose_delete":
        return ProposedAction(id=new_id, kind="delete",
                              summary=args.get("summary", "Delete the selected item(s)"),
                              risk="destructive",
                              draft={"targets": args.get("targets") or []})
    return None


async def _ensure_session(session_id: str):
    s = await _session_service.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id)
    if s is None:
        s = await _session_service.create_session(
            app_name=APP_NAME, user_id=USER_ID, session_id=session_id,
            state={"draft": dict(EMPTY_DRAFT)},
        )
    return s


_CONFIRM_GUIDANCE = {
    "delete": (
        "The user CONFIRMED a deletion. You cannot delete anything yourself — call "
        "`highlight` on the page's Remove/Delete control (and the dialog's confirm "
        "button) and tell the user to click it. Do NOT claim it is deleted."
    ),
    "set_status": (
        "The user CONFIRMED the enable/disable. You cannot change it yourself — call "
        "`highlight` on the group's serving toggle (and Save, if the page needs it) and "
        "tell the user to click it. Do NOT claim it changed."
    ),
    "save_group": (
        "The user CONFIRMED the pending action. You cannot perform the save yourself — "
        "call `highlight` on the page's Save/Done/Create control and tell the user to "
        "click it to apply the change. Do NOT claim it is already saved."
    ),
}


def _build_prompt(req: ChatRequest, pending: dict | None = None) -> str:
    parts: list[str] = []
    pc = req.page_context
    if pc is not None:
        compact = {
            "url": pc.url, "page": pc.page, "step": pc.step, "title": pc.title,
            "controls": [
                {"tag": c.tag, "role": c.role, "label": c.label, "text": (c.text or "")[:60]}
                for c in pc.controls[:40]
            ],
            "draft": pc.draft,
            "form": pc.form,      # what is actually selected on the page right now
            "groups": pc.groups,  # the live group rows (ground truth for targeting)
        }
        parts.append("PAGE CONTEXT (JSON):\n" + json.dumps(compact, ensure_ascii=False))
    if req.confirm_action_id:
        # Trust the server-stored pending action's kind; fall back to the client hint.
        kind = req.confirm_kind
        if pending and pending.get("id") == req.confirm_action_id:
            kind = pending.get("kind") or kind
        parts.append(_CONFIRM_GUIDANCE.get(kind or "", _CONFIRM_GUIDANCE["save_group"]))
    parts.append("USER MESSAGE:\n" + req.message)
    return "\n\n".join(parts)


async def _run_turn(req: ChatRequest) -> AsyncIterator[tuple[str, Any]]:
    """Run one agent turn. Yields ("token", str) deltas then one ("final", dict)."""
    sess = await _ensure_session(req.session_id)
    pending = (sess.state or {}).get("pending_action") if sess else None
    content = types.Content(role="user", parts=[types.Part(text=_build_prompt(req, pending))])
    run_config = RunConfig(streaming_mode=StreamingMode.SSE)

    directives: list[Directive] = []
    proposed: ProposedAction | None = None
    sent = ""        # text already streamed to the client
    final_text = ""  # authoritative full reply

    attempt = 0
    while True:
        # Each attempt is a clean slate. We only ever retry when nothing has been
        # streamed yet, so the client never sees a partial answer get restarted.
        directives, proposed, sent, final_text = [], None, "", ""
        retrying = False
        try:
            async for event in _runner.run_async(
                user_id=USER_ID, session_id=req.session_id, new_message=content, run_config=run_config
            ):
                calls = event.get_function_calls() or []
                # A tool call starts a fresh response segment. Any text streamed before
                # it was a pre-tool preamble — tell the client to drop it so the
                # post-tool answer replaces it instead of appending (prevents dupes).
                if calls and sent:
                    yield ("reset", None)
                    sent = ""
                    final_text = ""
                for fc in calls:
                    d = _directive_from_call(fc.name, dict(fc.args or {}))
                    if d:
                        directives.append(d)
                    else:
                        p = _proposed_from_call(fc.name, dict(fc.args or {}))
                        if p:
                            proposed = p
                text = ""
                if event.content and event.content.parts:
                    text = "".join(p.text for p in event.content.parts if p.text)
                if not text:
                    continue
                if event.is_final_response():
                    final_text = text
                    delta = text[len(sent):] if text.startswith(sent) else ""
                    if delta:
                        sent += delta
                        yield ("token", delta)
                else:
                    sent += text
                    yield ("token", text)
        except Exception as e:  # noqa: BLE001 - surface a calm message, never crash the stream
            # Transient upstream overload (503/500/429) before any token streamed:
            # wait a beat and retry silently. Otherwise surface one calm message.
            if _is_transient(e) and not sent and attempt < len(_RETRY_BACKOFFS):
                await asyncio.sleep(_RETRY_BACKOFFS[attempt])
                attempt += 1
                retrying = True
            elif not sent:
                msg = _friendly_error(e)
                sent = msg
                final_text = msg
                yield ("token", msg)
        if retrying:
            continue
        break

    s = await _session_service.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=req.session_id)
    draft = dict((s.state if s else {}).get("draft") or EMPTY_DRAFT)
    if proposed is not None:
        # Only a save_group proposal carries the working draft; status/delete carry
        # their own targets. Remember the pending action so a later confirm turn can be
        # verified against its id and kind (not just an echoed client value).
        if proposed.kind == "save_group":
            proposed.draft = draft
        if s is not None:
            s.state["pending_action"] = {"id": proposed.id, "kind": proposed.kind}
    elif s is not None and req.confirm_action_id and (s.state or {}).get("pending_action", {}).get("id") == req.confirm_action_id:
        # The confirmed action has been guided to its real control; clear it.
        s.state["pending_action"] = None

    seen, deduped = set(), []
    for d in directives:
        key = (d.type, json.dumps(d.target, sort_keys=True))
        if key not in seen:
            seen.add(key)
            deduped.append(d)

    yield ("final", {
        "reply": (final_text or sent).strip(),
        "directives": deduped,
        "proposed_action": proposed,
        "draft": draft,
    })


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": "gemini-3.5-flash"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    final: dict[str, Any] = {"reply": "", "directives": [], "proposed_action": None, "draft": dict(EMPTY_DRAFT)}
    async for kind, data in _run_turn(req):
        if kind == "final":
            final = data
    return ChatResponse(
        reply=final["reply"], directives=final["directives"],
        proposed_action=final["proposed_action"], draft=final["draft"],
    )


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    async def gen():
        final_payload: dict[str, Any] | None = None
        try:
            async for kind, data in _run_turn(req):
                if kind == "token":
                    yield f"event: token\ndata: {json.dumps(data)}\n\n"
                elif kind == "reset":
                    yield "event: reset\ndata: {}\n\n"
                elif kind == "final":
                    final_payload = data
        except Exception:  # noqa: BLE001 - guarantee a terminal event below
            pass
        finally:
            if final_payload is None:
                final_payload = {"reply": "", "directives": [], "proposed_action": None, "draft": dict(EMPTY_DRAFT)}
            try:
                done = {
                    "reply": final_payload["reply"],
                    "directives": [d.model_dump() for d in final_payload["directives"]],
                    "proposed_action": final_payload["proposed_action"].model_dump()
                    if final_payload["proposed_action"] else None,
                    "draft": final_payload["draft"],
                }
                yield f"event: done\ndata: {json.dumps(done)}\n\n"
            except Exception:  # noqa: BLE001 - last-resort terminal event so the UI never hangs
                yield 'event: done\ndata: {"reply":"","directives":[],"proposed_action":null,"draft":{}}\n\n'

    return StreamingResponse(gen(), media_type="text/event-stream")
````

</details>

<details>
<summary><code>backend/app/schemas.py</code></summary>

````python
"""Wire contract between the Chrome extension and the agent backend."""
from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


class PageControl(BaseModel):
    """A single interactive/labelled element the content script saw on the page."""
    tag: str = ""
    role: Optional[str] = None
    label: str = ""
    text: str = ""
    enabled: bool = True


class PageContext(BaseModel):
    """Compact, privacy-safe description of the current AdMob page."""
    url: str = ""
    page: Literal["list", "create", "detail", "unknown"] = "unknown"
    step: Optional[str] = None
    title: Optional[str] = None
    controls: list[PageControl] = Field(default_factory=list)
    draft: Optional[dict[str, Any]] = None
    form: Optional[dict[str, Any]] = None  # values read from the live create/edit form
    groups: Optional[list[dict[str, Any]]] = None  # rows on the list/detail page (ground truth)


class Directive(BaseModel):
    """An instruction the content script executes on the page.

    Only `read` (highlight/scroll_to) and `reversible` (click/fill/select_option/
    set_toggle/select_row) directives are ever emitted. The content script also
    hard-refuses any actuating directive labelled persistent/destructive, so a
    Save/Delete control can only ever be highlighted, never machine-actuated.
    """
    type: Literal[
        "highlight", "scroll_to", "click", "fill",
        "select_option", "set_toggle", "select_row",
    ]
    target: dict[str, Any]  # {label, within?} — `within` scopes to a row/network name
    note: str = ""
    value: Optional[str] = None
    risk: Literal["read", "reversible", "persistent", "destructive"] = "read"


class ProposedAction(BaseModel):
    """An account change that requires explicit user confirmation.

    kind ∈ {save_group, set_status, delete, plan}. `delete` is destructive and the
    side panel shows a stronger (acknowledgement) confirmation for it.
    """
    id: str
    kind: str
    summary: str
    risk: Literal["persistent", "destructive"] = "persistent"
    draft: dict[str, Any] = Field(default_factory=dict)
    steps: list[str] = Field(default_factory=list)  # for kind="plan"


class ChatRequest(BaseModel):
    session_id: str
    message: str
    page_context: Optional[PageContext] = None
    confirm_action_id: Optional[str] = None
    confirm_kind: Optional[str] = None  # which kind of action the user confirmed


class ChatResponse(BaseModel):
    reply: str
    directives: list[Directive] = Field(default_factory=list)
    proposed_action: Optional[ProposedAction] = None
    draft: dict[str, Any] = Field(default_factory=dict)
````

</details>

<details>
<summary><code>backend/app/knowledge.py</code></summary>

````python
"""Canonical AdMob mediation knowledge base.

Sourced from the project research notes (docs/00-research-notes.md), which cite
official AdMob Help. Kept deliberately concise and accurate so the agent can quote
it verbatim rather than improvise.
"""

KB: dict[str, str] = {
    "mediation group": (
        "A mediation group is a combination of targeting settings (ad format, "
        "platform, ad units, and optional location targeting) plus the ad sources "
        "used to fill those requests. It lets you configure sources once and apply "
        "them across many ad units to optimize revenue."
    ),
    "bidding": (
        "In bidding, ad sources compete in a real-time auction to fill each ad "
        "request; the highest bid wins. It's hands-off and generally maximizes "
        "competition versus a fixed waterfall."
    ),
    "waterfall": (
        "In waterfall mediation, ad sources are called one-by-one in the order of "
        "the eCPM you set (highest to lowest), not by what each source will actually "
        "pay for that impression."
    ),
    "hybrid": (
        "A hybrid group uses both bidding and waterfall ad sources together: bidders "
        "compete in the auction while waterfall sources are tried in eCPM order."
    ),
    "priority": (
        "When more than one mediation group matches an ad request's targeting "
        "(format, platform, location, etc.), the group with the highest priority — "
        "the SMALLEST number, where 1 is highest — serves the request."
    ),
    "default group": (
        "AdMob auto-creates an 'AdMob (default)' group per format that fills any "
        "request not matched by another group, sourcing ads from the AdMob Network. "
        "You can't delete it."
    ),
    "conflict avoidance": (
        "To avoid groups fighting over the same requests: if you target a country/"
        "region, platform, or ad format explicitly in one group, exclude it from the "
        "others so each request maps cleanly to one intended group."
    ),
    "ecpm floor": (
        "The bidding eCPM floor is the minimum price for the bidding auction. It "
        "applies to all bidders in the group and overrides the ad unit's floor for "
        "bidding traffic."
    ),
    "manual ecpm": (
        "For a waterfall source, the manual eCPM is the value you set to position it "
        "in the waterfall while AdMob gathers enough data to optimize."
    ),
    "optimized ecpm": (
        "Once AdMob has enough historical data for a supported waterfall source, it "
        "orders that source by an optimized eCPM instead of your manual value."
    ),
    "custom event": (
        "A custom event integrates a network AdMob doesn't natively support, via a "
        "small adapter class you implement in the app plus an ad-unit mapping."
    ),
    "ad format": (
        "The ad type a group serves: banner, interstitial, rewarded, rewarded "
        "interstitial, native, or app open. A group targets exactly one format."
    ),
    "platform": (
        "Android or iOS. You create separate mediation groups per platform because "
        "ad units and SDK integrations differ between them."
    ),
    "ad unit": (
        "An ad placement in your app. AdMob matches a group to requests from the ad "
        "units the group targets."
    ),
    "location targeting": (
        "You can include or exclude specific countries/regions for a group so it only "
        "serves (or never serves) requests from those locations."
    ),
    "idfa": (
        "On iOS, targeting can depend on whether the IDFA (advertising identifier) is "
        "available, which is governed by the user's App Tracking Transparency choice."
    ),
    "mapping": (
        "An ad-unit mapping links a third-party network's placement identifiers to an "
        "AdMob ad unit so that network can be requested through mediation."
    ),
    "sdk follow up": (
        "Third-party ad sources require the matching mediation adapter/SDK in the app "
        "and ad-unit mappings; configuring the source in AdMob alone is not enough."
    ),
}

# Ordered steps of the create-a-mediation-group flow (docs/00 §2).
CREATE_FLOW_STEPS = [
    "Open Mediation, click 'Create mediation group'.",
    "Select Ad format and Platform, then Continue.",
    "Enter a descriptive Name.",
    "Select the Ad units to target.",
    "Optionally set Location include/exclude targeting.",
    "Add ad sources (bidding / waterfall / custom event) and set eCPM floor / manual eCPM.",
    "Review, then Save.",
    "Follow up in the app: add adapter SDKs and ad-unit mappings for third-party sources.",
]


def lookup(name: str) -> str:
    """Return the best-matching KB explanation for a concept name."""
    if not name:
        return ""
    q = name.strip().lower()
    if q in KB:
        return KB[q]
    # loose contains match
    for key, val in KB.items():
        if key in q or q in key:
            return val
    # token overlap
    qt = set(q.replace("-", " ").split())
    best, score = "", 0
    for key, val in KB.items():
        s = len(qt & set(key.split()))
        if s > score:
            best, score = val, s
    return best
````

</details>

<details>
<summary><code>backend/pyproject.toml</code></summary>

````toml
[project]
name = "admob-agent-backend"
version = "0.1.0"
description = "ADK + Gemini backend for the AdMob Mediation assistant"
requires-python = ">=3.10"
dependencies = [
    "google-adk>=1.32.0",
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "pydantic>=2.7",
    "python-dotenv>=1.0",
]

[tool.uv]
package = false
````

</details>

<details>
<summary><code>backend/run.sh</code></summary>

````bash
#!/usr/bin/env bash
# Start the AdMob agent backend on 127.0.0.1:8765
set -euo pipefail
cd "$(dirname "$0")"
exec uv run uvicorn app.server:app --host 127.0.0.1 --port 8765 "$@"
````

</details>


### Extension — configuration & build

<details>
<summary><code>extension/manifest.json</code></summary>

````json
{
  "manifest_version": 3,
  "name": "AdMob Mediation Assistant",
  "version": "0.1.0",
  "description": "An expert assistant beside AdMob Mediation: answers questions, explains fields, highlights controls, drafts groups, and performs confirmed actions.",
  "minimum_chrome_version": "114",
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_title": "AdMob Mediation Assistant",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png"
    }
  },
  "side_panel": { "default_path": "sidepanel/index.html" },
  "background": { "service_worker": "background/service-worker.js" },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'; base-uri 'none'"
  },
  "permissions": ["sidePanel", "scripting", "storage"],
  "host_permissions": [
    "https://admob.google.com/*",
    "http://127.0.0.1:8765/*",
    "http://localhost:8765/*"
  ],
  "content_scripts": [
    {
      "matches": ["https://admob.google.com/*"],
      "js": ["content/content.js"],
      "run_at": "document_idle"
    }
  ]
}
````

</details>

<details>
<summary><code>extension/package.json</code></summary>

````json
{
  "name": "admob-agent-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Chrome MV3 side-panel extension for the AdMob Mediation Assistant",
  "scripts": {
    "build": "node build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "node tests/dom.spec.mjs && node tests/real-dom.spec.mjs",
    "package": "node build.mjs && cd dist && zip -r -q ../admob-assistant.zip . && echo 'packaged dist -> admob-assistant.zip'"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.270",
    "esbuild": "^0.24.0",
    "playwright": "^1.61.0",
    "typescript": "^5.6.0"
  }
}
````

</details>

<details>
<summary><code>extension/tsconfig.json</code></summary>

````json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "types": ["chrome"],
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
````

</details>

<details>
<summary><code>extension/build.mjs</code></summary>

````javascript
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
````

</details>

<details>
<summary><code>extension/scripts/generate_icons.py</code></summary>

````python
"""Generate clean extension icons (rounded blue tile + chat bubble + check).
Supersampled 4x then downsampled for crisp edges. Output: public/icons/icon-*.png
"""
from pathlib import Path
from PIL import Image, ImageDraw

BLUE = (26, 115, 232)
OUT = Path(__file__).resolve().parents[1] / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def make(size: int) -> Image.Image:
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # flat Google Blue tile (a continuous cross-hue gradient reads as generic slop)
    grad = Image.new("RGB", (S, S), BLUE)

    # rounded mask
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # speech bubble
    bl, bt, br, bb = S * 0.2, S * 0.21, S * 0.8, S * 0.6
    d.rounded_rectangle([bl, bt, br, bb], radius=int(S * 0.12), fill=(255, 255, 255, 255))
    d.polygon([(S * 0.31, bb - S * 0.02), (S * 0.31, S * 0.74), (S * 0.47, bb - S * 0.02)],
              fill=(255, 255, 255, 255))
    # check mark in blue
    pts = [(S * 0.345, S * 0.41), (S * 0.44, S * 0.5), (S * 0.655, S * 0.3)]
    w = int(S * 0.055)
    d.line(pts, fill=BLUE, width=w, joint="curve")
    r = w / 2
    for (x, y) in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=BLUE)

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(OUT / f"icon-{s}.png")
print("icons ->", OUT)
````

</details>


### Extension — source (the action plane)

<details>
<summary><code>extension/src/shared/protocol.ts</code></summary>

````typescript
// Shared types and message contracts (client side mirror of backend/app/schemas.py).

export type PageType = "list" | "create" | "detail" | "unknown";

export interface PageControl {
  tag: string;
  role: string | null;
  label: string;
  text: string;
  enabled: boolean;
}

export interface PageContext {
  url: string;
  page: PageType;
  step: string | null;
  title: string | null;
  controls: PageControl[];
  draft?: Record<string, unknown> | null;
  form?: Record<string, string>; // values read from the live create/edit form (source of truth)
  groups?: GroupRow[]; // rows on the list/detail page (ground truth for targeting)
}

export interface GroupRow {
  name: string;
  enabled: boolean;
  format?: string;
  platform?: string;
  ecpm?: string;
}

export interface Directive {
  type: "highlight" | "scroll_to" | "click" | "fill" | "select_option" | "set_toggle" | "select_row";
  // `within` scopes a repeated label/row to one network or group by name.
  target: { label?: string; css?: string; within?: string };
  note?: string;
  value?: string | null;
  risk?: "read" | "reversible" | "persistent" | "destructive";
}

export interface ProposedAction {
  id: string;
  kind: string; // save_group | set_status | delete | plan
  summary: string;
  risk: "persistent" | "destructive";
  draft: Record<string, unknown>;
  steps?: string[]; // for kind="plan"
}

export interface ChatResponse {
  reply: string;
  directives: Directive[];
  proposed_action: ProposedAction | null;
  draft: Record<string, unknown>;
}

// chrome.runtime messages between side panel <-> service worker <-> content script.
export type RuntimeMsg =
  | { kind: "READ_CONTEXT" }
  | { kind: "EXEC"; directives: Directive[] }
  | { kind: "CLEAR_HIGHLIGHTS" }
  | { kind: "PING" };

export interface DirectiveResult {
  type: string;
  label?: string;
  resolved: boolean;
  message?: string;
}

export interface ExecResult {
  ok: boolean;
  results: DirectiveResult[];
}

export const BACKEND_BASE = "http://127.0.0.1:8765";
````

</details>

<details>
<summary><code>extension/src/background/service-worker.ts</code></summary>

````typescript
// Service worker: enables the side panel ONLY on AdMob, and brokers messages from
// the side panel to the active AdMob tab's content script.

const ADMOB = "https://admob.google.com";

// Default-deny: the panel is globally disabled; we explicitly enable it per AdMob tab.
async function setGlobalDisabled(): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({ enabled: false });
  } catch {
    /* ignore */
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* ignore */
  }
}

async function updatePanel(tabId: number, url?: string): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel/index.html",
      enabled: !!url && url.startsWith(ADMOB),
    });
  } catch {
    /* tab may be gone */
  }
}

// Reconcile every existing tab — covers browser restart and the routine MV3
// service-worker respawn, when no tab event has fired yet.
async function reconcileAllTabs(): Promise<void> {
  await setGlobalDisabled();
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) if (t.id != null) await updatePanel(t.id, t.url);
}

chrome.runtime.onInstalled.addListener(() => void reconcileAllTabs());
chrome.runtime.onStartup.addListener(() => void reconcileAllTabs());

chrome.tabs.onUpdated.addListener((tabId, _info, tab) => void updatePanel(tabId, tab.url));
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updatePanel(tabId, tab.url);
  } catch {
    /* ignore */
  }
});

async function activeAdmobTab(): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.url?.startsWith(ADMOB)) return active;
  const all = await chrome.tabs.query({ url: `${ADMOB}/*` });
  return all[0] ?? null;
}

interface ToContent {
  kind: "TO_CONTENT";
  payload: { kind: string; [k: string]: unknown };
}

async function sendToContent(tabId: number, payload: ToContent["payload"]): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // Inject only if the content script truly isn't there (avoid double-injection):
    // a PING failure means absent; success means present and we just retry.
    let present = false;
    try {
      await chrome.tabs.sendMessage(tabId, { kind: "PING" });
      present = true;
    } catch {
      present = false;
    }
    if (!present) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content.js"] });
    }
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
  if (msg?.kind !== "TO_CONTENT") return;
  (async () => {
    const tab = await activeAdmobTab();
    if (!tab?.id) {
      sendResponse({ ok: false, error: "no_admob_tab" });
      return;
    }
    try {
      const data = await sendToContent(tab.id, msg.payload);
      sendResponse({ ok: true, data, tabId: tab.id });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});
````

</details>

<details>
<summary><code>extension/src/content/content.ts</code></summary>

````typescript
// Content script: the agent's eyes & hands on the AdMob page.
// It only responds to messages from the extension (never trusts page scripts).

import { readContext, runDirectives, clearHighlights } from "./dom";
import type { RuntimeMsg, ExecResult } from "../shared/protocol";

// Idempotency guard: the script is declared in the manifest AND may be re-injected
// by the service worker's fallback. Registering twice would duplicate listeners and
// double-execute directives (double clicks). Run setup exactly once per page.
declare global {
  interface Window {
    __admobAssistantLoaded?: boolean;
  }
}

if (!window.__admobAssistantLoaded) {
  window.__admobAssistantLoaded = true;

  chrome.runtime.onMessage.addListener((msg: RuntimeMsg, _sender, sendResponse) => {
    try {
      switch (msg?.kind) {
        case "PING":
          sendResponse({ ok: true });
          break;
        case "READ_CONTEXT":
          sendResponse(readContext());
          break;
        case "CLEAR_HIGHLIGHTS":
          clearHighlights();
          sendResponse({ ok: true });
          break;
        case "EXEC": {
          // Directives run sequentially (open-dropdown then pick-option needs the
          // page to settle between steps), so the response is asynchronous.
          runDirectives(msg.directives || [])
            .then((results) => {
              const res: ExecResult = { ok: results.every((r) => r.resolved), results };
              sendResponse(res);
            })
            .catch((e) => sendResponse({ ok: false, message: String(e) }));
          return true; // keep the message channel open for the async response
        }
        default:
          sendResponse({ ok: false, message: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, message: String(e) });
    }
    // non-EXEC responses are synchronous
  });

  // Clear highlights on SPA navigation. AdMob routes client-side, so hook the
  // History API (cheaper and more reliable than observing the whole document).
  const onNav = () => clearHighlights();
  type HistFn = typeof history.pushState;
  const wrap = (orig: HistFn): HistFn =>
    function (this: History, ...args: Parameters<HistFn>) {
      const ret = orig.apply(this, args);
      window.dispatchEvent(new Event("admob-assistant-locationchange"));
      return ret;
    };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  window.addEventListener("popstate", onNav);
  window.addEventListener("admob-assistant-locationchange", onNav);
}
````

</details>

<details>
<summary><code>extension/src/content/dom.ts</code></summary>

````typescript
// DOM engine for AdMob's AngularDart UI: read context, resolve controls by stable
// semantics (NOT Angular _ngcontent hashes), highlight, and actuate.

import type { Directive, DirectiveResult, GroupRow, PageContext, PageControl, PageType } from "../shared/protocol";

const INTERACTIVE_SELECTOR = [
  "material-button",
  "[role=button]",
  "button",
  "a[role=link]",
  "material-dropdown-select",
  "dropdown-button",
  "material-radio",
  "[role=radio]",
  "material-toggle",
  "[role=switch]",
  "material-checkbox",
  "[role=checkbox]",
  "input",
  "tab-button",
  "[role=tab]",
  "[aria-label]",
].join(",");

// Selectors used by the actuation primitives below.
const SELECTABLE_SELECTOR = "material-radio,[role=radio],[role=tab],tab-button,material-chip,[role=option],material-select-item"; // single-choice controls already visible in-form
const OVERLAY_SELECTOR = ".acx-overlay-container,material-popup,[role=listbox],[role=menu],modal-dialog,focus-trap,.pane"; // detached ACX dropdown/menu panels
const OPTION_SELECTOR = "[role=option],material-select-item,[role=menuitem],material-checkbox,[role=checkbox]"; // options inside an open overlay
const TOGGLE_SELECTOR = "material-toggle,[role=switch],material-checkbox,[role=checkbox]"; // on/off controls
const CHECKBOX_SELECTOR = "material-checkbox,[role=checkbox]"; // row-selection checkboxes (never a serving switch)
const ROW_SELECTOR = "[role=row],tr,material-list-item,mediation-group-row"; // a single group's row on the list/detail page

function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el as HTMLElement);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute("aria-disabled") === "true") return true;
  // material components mark the wrapper, not the inner node
  return !!el.closest('[aria-disabled="true"]');
}

// The accessible/visible name, ignoring ACX decoration. On the real create page a
// <material-radio> renders <material-icon><i>radio_button_unchecked</i></material-icon>
// + <div class="content">Android</div>; naive textContent yields
// "radio_button_uncheckedAndroid", which then fails to resolve. Strip icon/ripple/svg
// and aria-hidden nodes first. Fast-path avoids cloning when nothing decorative exists.
function cleanText(el: Element): string {
  if (!el.querySelector('material-icon,material-ripple,svg,[aria-hidden="true"]')) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll('material-icon,material-ripple,svg,[aria-hidden="true"]').forEach((n) => n.remove());
  return (c.textContent || "").replace(/\s+/g, " ").trim();
}

function labelOf(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria && aria.trim()) return aria.trim();
  return cleanText(el);
}

export function detectPage(url: string): PageType {
  if (/\/mediation\/groups\/create/.test(url)) return "create";
  if (/\/mediation\/groups\/list/.test(url)) return "list";
  if (/\/mediation\/groups\/[^/]+/.test(url)) return "detail";
  if (/\/mediation\//.test(url)) return "list";
  return "unknown";
}

function detectStep(page: PageType): string | null {
  if (page !== "create") return null;
  const text = (document.body.innerText || "").toLowerCase();
  if (/ad sources|bidding|waterfall|ecpm/.test(text)) return "sources";
  if (/ad units?/.test(text)) return "ad_units";
  if (/location|country|region/.test(text)) return "location";
  if (/name your|group name/.test(text)) return "name";
  if (/ad format|platform/.test(text)) return "format_platform";
  return "create";
}

// Read the create form's actual chosen values so the progress tracker mirrors the
// page (source of truth), not just the conversation. The create flow renders each
// choice into its section header in canonical form, e.g. "Ad unit format Banner",
// "Platform Android" — which is reliable to read.
const FORMATS = "Rewarded interstitial|Rewarded|Interstitial|Banner|Native|App open";
export function readForm(): Record<string, string> {
  if (!/\/groups\/create/.test(location.href)) return {};
  const body = document.body.innerText || "";
  const form: Record<string, string> = {};
  // The real create page's section header is "Ad format" (not "Ad unit format").
  const fmt = body.match(new RegExp(`Ad format\\s+(${FORMATS})`, "i"));
  if (fmt) form.format = fmt[1];
  const plat = body.match(/Platform\s+(Android|iOS)/i);
  if (plat) form.platform = /ios/i.test(plat[1]) ? "iOS" : "Android";
  // Name comes from the labelled input, not a <form-card> tag (which exists on neither
  // the real page nor the demo). Prefer the accessible label; fall back to an aria match.
  const nameInput = (resolveTarget({ label: "Mediation group name" }, { roles: "input" }) ||
    document.querySelector('input[aria-label*="name" i]')) as HTMLInputElement | null;
  if (nameInput && nameInput.value.trim()) form.name = nameInput.value.trim();
  return form;
}

// Read the mediation groups shown on the list/detail page as ground truth the agent
// can target and reason over (which groups exist, whether each is serving). Read-only
// and defensive — returns [] when nothing matches, so a miss never misleads.
export function readGroups(): GroupRow[] {
  const page = detectPage(location.href);
  if (page !== "list" && page !== "detail") return [];
  const out: GroupRow[] = [];
  const seen = new Set<string>();
  for (const row of Array.from(document.querySelectorAll(ROW_SELECTOR))) {
    if (!isVisible(row)) continue;
    // Name: real AdMob renders <ess-cell essfield="mediation_group_name"><linked-text-cell>
    // …<span class="text">NAME</span> (NO <a>); the demo uses <a role=link>. Try the real
    // cell first, then the anchor — sequential (not one comma list) so a stray anchor in a
    // different cell can't be misread as the name. The columnheader row has neither → skipped.
    const nameEl =
      row.querySelector(
        'ess-cell[essfield="mediation_group_name"] .text, ' +
          'ess-cell[essfield="mediation_group_name"] linked-text-cell, ' +
          'ess-cell[essfield="mediation_group_name"]',
      ) || row.querySelector("a[role=link], a.gname, a, .name");
    const name = (nameEl?.textContent || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    // Status: demo uses a role=switch/material-toggle; real page uses a status icon in
    // <legacy-status-cell>/<ess-cell essfield="status">. Prefer the toggle's read state;
    // else parse the icon's aria-label. Default to serving so a miss never falsely says "off".
    const toggle = row.querySelector("[role=switch], material-toggle");
    let enabled = true;
    if (toggle) {
      enabled = readState(toggle) === true;
    } else {
      const st = row.querySelector(
        'ess-cell[essfield="status"] material-icon i, ess-cell[essfield="status"] material-icon, legacy-status-cell material-icon',
      );
      const s = (st?.getAttribute("aria-label") || st?.querySelector("i")?.getAttribute("aria-label") || "").toLowerCase();
      enabled = !/pause|paused|off|disabled|inactive|not serving|stopped/.test(s);
    }
    out.push({ name, enabled });
    if (out.length >= 40) break;
  }
  return out;
}

export function readContext(): PageContext {
  const url = location.href;
  const page = detectPage(url);
  const seen = new Set<string>();
  const controls: PageControl[] = [];
  for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    if (!isVisible(el)) continue;
    const label = labelOf(el);
    if (!label || label.length > 80) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const key = `${tag}|${role}|${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    controls.push({
      tag,
      role,
      label,
      text: cleanText(el).slice(0, 80),
      enabled: !isDisabled(el),
    });
    if (controls.length >= 60) break;
  }
  const groups = readGroups();
  return {
    url, page, step: detectStep(page), title: document.title || null,
    controls, form: readForm(), groups: groups.length ? groups : undefined,
  };
}

// --- Resolution -----------------------------------------------------------

function score(candidateLabel: string, want: string): number {
  const a = candidateLabel.toLowerCase().trim();
  const b = want.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 70;
  if (a.includes(b) || b.includes(a)) return 45;
  const at = new Set(a.split(/\s+/));
  const overlap = b.split(/\s+/).filter((t) => at.has(t)).length;
  return overlap ? 18 + overlap : 0;
}

interface ResolveOpts {
  minScore?: number;
  requireUnambiguous?: boolean; // for actuation: refuse close ties
  within?: Element;             // scope candidates to this root (an open overlay or a row)
  roles?: string;               // override the candidate selector (e.g. option roles in a panel)
}

export function resolveTarget(target: { label?: string; css?: string }, opts: ResolveOpts = {}): HTMLElement | null {
  const minScore = opts.minScore ?? 25;
  const root: ParentNode = opts.within ?? document;
  const selector = opts.roles ?? INTERACTIVE_SELECTOR;
  if (target.css) {
    const el = (root as ParentNode).querySelector(target.css);
    if (el && isVisible(el) && !isDisabled(el)) return el as HTMLElement;
  }
  const want = (target.label || "").trim();
  if (!want) return null;

  type Cand = { el: HTMLElement; s: number; delta: number };
  const cands: Cand[] = [];
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (!isVisible(el) || isDisabled(el)) continue;
    const lab = labelOf(el);
    let s = score(lab, want);
    if (!s) continue;
    const tag = el.tagName.toLowerCase();
    if (/^(button|a)$/.test(tag) || /button|material-dropdown-select|tab-button/.test(tag)) s += 5;
    cands.push({ el: el as HTMLElement, s, delta: Math.abs(lab.length - want.length) });
  }
  if (!cands.length) return null;
  // best score wins; ties broken by closest label length (closest match), not DOM order
  cands.sort((x, y) => y.s - x.s || x.delta - y.delta);
  const best = cands[0];
  if (best.s < minScore) return null;
  if (opts.requireUnambiguous && best.s < 100 && cands[1] && best.s - cands[1].s < 10) {
    return null; // ambiguous — refuse to actuate, let the agent re-ask
  }
  return best.el;
}

const FIELD_LABEL_SELECTOR = ".format-label,.description,label,legend,h3,[role=heading]";
const FIELD_CONTROL_SELECTOR = "material-dropdown-select,dropdown-button,material-radio-group,[role=radiogroup]";

// Associate a section label (non-interactive text that sits BEFORE its control) with
// the control it introduces. On the real create page "Ad format" is a <div class=
// format-label> whose control is a <material-dropdown-select> reading "Choose a format";
// the control's own name never matches "Ad format", so resolve it via the label. Gated
// at score>=70 (startsWith/equal) so a broad section description can't match.
function resolveField(label?: string): HTMLElement | null {
  const want = (label || "").trim();
  if (!want) return null;
  let labelEl: Element | null = null;
  let bestS = 0;
  for (const el of Array.from(document.querySelectorAll(FIELD_LABEL_SELECTOR))) {
    if (!isVisible(el)) continue;
    const s = score(cleanText(el), want);
    if (s > bestS && s >= 70) {
      bestS = s;
      labelEl = el;
    }
  }
  if (!labelEl) return null;
  for (const el of Array.from(document.querySelectorAll(FIELD_CONTROL_SELECTOR))) {
    if (!isVisible(el) || isDisabled(el)) continue;
    if (labelEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el as HTMLElement;
  }
  return null;
}

// --- Highlight overlay -----------------------------------------------------

const OVERLAY_ID = "admob-assistant-overlay-root";

function overlayRoot(): HTMLElement {
  let root = document.getElementById(OVERLAY_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
    document.documentElement.appendChild(root);
  }
  return root;
}

let rafId: number | undefined;

export function clearHighlights(): void {
  const root = document.getElementById(OVERLAY_ID);
  if (root) root.innerHTML = "";
  if (rafId !== undefined) {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
}

export function highlight(el: HTMLElement, note?: string): void {
  clearHighlights();
  const root = overlayRoot();
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;border:2px solid #1a73e8;border-radius:8px;" +
    "box-shadow:0 0 0 4px rgba(26,115,232,0.18);transition:box-shadow 120ms ease;pointer-events:none";
  const caption = document.createElement("div");
  caption.style.cssText =
    "position:fixed;background:#1a73e8;color:#fff;font:500 12px/1.4 'Google Sans',Roboto,system-ui,sans-serif;" +
    "padding:4px 8px;border-radius:6px;max-width:260px;box-shadow:0 2px 8px rgba(0,0,0,0.25);pointer-events:none";
  caption.textContent = note || "";
  caption.style.display = note ? "block" : "none";
  root.appendChild(box);
  root.appendChild(caption);

  const reposition = () => {
    // bail if the element was torn down by an SPA re-render
    if (!el.isConnected) {
      clearHighlights();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      clearHighlights();
      return;
    }
    box.style.left = `${r.left - 4}px`;
    box.style.top = `${r.top - 4}px`;
    box.style.width = `${r.width + 8}px`;
    box.style.height = `${r.height + 8}px`;
    const capTop = r.top - 30 < 8 ? r.bottom + 8 : r.top - 30;
    caption.style.left = `${Math.max(8, r.left - 4)}px`;
    caption.style.top = `${capTop}px`;
  };
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  reposition();
  let ticks = 0;
  const tick = () => {
    reposition();
    if (rafId === undefined) return; // reposition() tore the highlight down
    if (++ticks > 360) {
      clearHighlights(); // ~6s at 60fps
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// --- Actuation -------------------------------------------------------------

function realClick(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  // Gesture events cover pointer/mouse-driven handlers; el.click() delivers the ONE
  // native click (default action + Angular (click) handler). We deliberately do NOT
  // also dispatch a synthetic "click" — that double-activates and would flip a toggle
  // back to its original state (verified by tests/dom.spec.mjs).
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  if (typeof el.click === "function") el.click();
  else el.dispatchEvent(new MouseEvent("click", opts));
}

function fillInput(el: HTMLElement, value: string): boolean {
  const input = (el.matches("input,textarea") ? el : el.querySelector("input,textarea")) as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  if (!input) return false;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  input.focus();
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.value === value; // read-back: confirm Angular accepted the value
}

// --- State-aware actuation helpers ----------------------------------------

// The boolean state of any toggle/checkbox/radio, or null if it can't be read.
function readState(el: Element): boolean | null {
  const host =
    el.closest("[role=switch],[role=checkbox],[role=radio],material-toggle,material-checkbox,material-radio") || el;
  const aria =
    host.getAttribute("aria-checked") ?? host.getAttribute("aria-pressed") ?? host.getAttribute("aria-selected");
  if (aria === "true") return true;
  if (aria === "false") return false;
  const inp = host.querySelector("input") as HTMLInputElement | null;
  if (inp && (inp.type === "checkbox" || inp.type === "radio")) return inp.checked;
  if (host.classList.contains("checked") || host.classList.contains("is-checked")) return true;
  return null;
}

function firstVisible(selector: string, root: ParentNode = document): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    if (isVisible(el)) return el as HTMLElement;
  }
  return null;
}

// Poll until predicate() returns an element (e.g. a dropdown overlay rendered) or
// time out. Fails closed (null) so a slow render reports "not found" rather than a
// mis-click. Date.now is available in the content script (only Workflow scripts ban it).
function waitForElement<T extends Element>(pred: () => T | null, timeoutMs = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const first = pred();
    if (first) return resolve(first);
    const start = Date.now();
    const tick = () => {
      const el = pred();
      if (el) return resolve(el);
      if (Date.now() - start > timeoutMs) return resolve(null);
      window.setTimeout(tick, 50);
    };
    window.setTimeout(tick, 50);
  });
}

// Choose ONE option for a single-choice control. Auto-detects two renderings:
//  (a) the option is already a visible radio/card/chip/tab in the form — pick it
//      state-aware (no-op if already selected);
//  (b) the field is a dropdown trigger — open it, wait for the detached overlay,
//      then resolve and click the option inside that overlay.
async function selectOption(
  field: { label?: string; within?: HTMLElement },
  optionText: string,
  note?: string,
): Promise<{ ok: boolean; message?: string }> {
  const opt = resolveTarget(
    { label: optionText },
    { minScore: 60, requireUnambiguous: true, within: field.within, roles: SELECTABLE_SELECTOR },
  );
  if (opt) {
    if (readState(opt) === true) {
      highlight(opt, note);
      return { ok: true, message: "already selected" };
    }
    highlight(opt, note);
    realClick(opt);
    return { ok: true };
  }
  let trigger = resolveTarget(
    { label: field.label },
    { minScore: 55, requireUnambiguous: true, within: field.within },
  );
  // Fall back to the section-label resolver: on the real page the field's own name
  // ("Choose a format") doesn't match the section label ("Ad format").
  if (!trigger) trigger = resolveField(field.label);
  if (!trigger) return { ok: false, message: "field not found" };
  // Inline radio-group rendering (real Platform, demo Ad format): pick the option
  // scoped inside the group rather than opening a menu.
  if (/radio-group/i.test(trigger.tagName) || trigger.getAttribute("role") === "radiogroup") {
    const inGroup = resolveTarget(
      { label: optionText },
      { minScore: 60, requireUnambiguous: true, within: trigger, roles: SELECTABLE_SELECTOR },
    );
    if (!inGroup) return { ok: false, message: `option "${optionText}" not found` };
    if (readState(inGroup) === true) {
      highlight(inGroup, note);
      return { ok: true, message: "already selected" };
    }
    highlight(inGroup, note);
    realClick(inGroup);
    return { ok: true };
  }
  realClick(trigger);
  const overlay = await waitForElement(() => firstVisible(OVERLAY_SELECTOR), 1600);
  if (!overlay) return { ok: false, message: "menu did not open" };
  const optionEl = resolveTarget(
    { label: optionText },
    { minScore: 50, requireUnambiguous: true, within: overlay, roles: OPTION_SELECTOR },
  );
  if (!optionEl) return { ok: false, message: `option "${optionText}" not in menu` };
  highlight(optionEl, note);
  realClick(optionEl);
  return { ok: true };
}

// Drive a toggle/checkbox to an explicit state; clicks only if it isn't there yet,
// so a re-emitted directive can never flip the wrong way.
async function setToggle(el: HTMLElement, desired: boolean): Promise<{ ok: boolean; message?: string }> {
  const cur = readState(el);
  if (cur === desired) {
    highlight(el);
    return { ok: true, message: `already ${desired ? "on" : "off"}` };
  }
  highlight(el);
  realClick(el);
  if (cur === null) return { ok: true }; // unreadable state: assume the click took
  const settled = await waitForElement(() => (readState(el) === desired ? el : null), 700);
  return settled ? { ok: true } : { ok: false, message: "state did not change" };
}

// Find the single list/detail row that names a group, refusing close ties so the
// wrong group is never staged.
function resolveRow(name: string): HTMLElement | null {
  const want = name.toLowerCase().trim();
  if (!want) return null;
  const rows = (Array.from(document.querySelectorAll(ROW_SELECTOR)) as HTMLElement[])
    .filter((r) => isVisible(r) && (r.textContent || "").toLowerCase().includes(want))
    .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
  if (!rows.length) return null;
  if (rows.length > 1 && (rows[1].textContent || "").length - (rows[0].textContent || "").length < 4) {
    return null; // two near-identical rows — ambiguous, refuse
  }
  return rows[0];
}

// A reversible tool must never actuate a control whose accessible name reads as a
// persistent/destructive action. server.py assigns risk per-tool as a fixed constant, so
// this target-based check is the last line of defense if a reversible click/toggle is
// aimed at Save/Publish/Delete etc. (create/continue/apply/submit are intentionally NOT here).
const PERSISTS = /\b(save|publish|delete|remove|discard|pause|deactivate|disable)\b/i;

const ACTUATING = new Set(["click", "fill", "select_option", "set_toggle", "select_row"]);

export async function execDirective(d: Directive): Promise<DirectiveResult> {
  const label = d.target.label;
  const actuating = ACTUATING.has(d.type);

  // Defense-in-depth gate: a persistent/destructive change is NEVER machine-driven.
  // Such controls may only be highlighted (a human performs the real click). This is
  // enforced here in code, independent of whether the model honored its instructions.
  if (actuating && (d.risk === "persistent" || d.risk === "destructive")) {
    return { type: d.type, label, resolved: false, message: "blocked: this change needs a human click" };
  }

  // Resolve an optional row scope (`within` = a network/source row by name).
  let within: HTMLElement | undefined;
  if (d.target.within) {
    const row = resolveRow(d.target.within);
    if (!row) return { type: d.type, label, resolved: false, message: `"${d.target.within}" row not found` };
    within = row;
  }

  const notFound = (msg: string): DirectiveResult => ({ type: d.type, label, resolved: false, message: msg });

  switch (d.type) {
    case "highlight": {
      const el = resolveTarget(d.target, { minScore: 25, within });
      if (!el) return notFound("control not found on page");
      highlight(el, d.note);
      return { type: d.type, label, resolved: true };
    }
    case "scroll_to": {
      const el = resolveTarget(d.target, { minScore: 25, within });
      if (!el) return notFound("control not found on page");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { type: d.type, label, resolved: true };
    }
    case "click": {
      const el = resolveTarget(d.target, { minScore: 55, requireUnambiguous: true, within });
      if (!el) return notFound("control not found, disabled, or ambiguous — not actuated");
      if (PERSISTS.test(labelOf(el))) return notFound("that control makes a persistent change — needs a human click");
      highlight(el, d.note);
      realClick(el);
      return { type: d.type, label, resolved: true };
    }
    case "fill": {
      const el = resolveTarget(d.target, { minScore: 55, requireUnambiguous: true, within });
      if (!el) return notFound("field not found, disabled, or ambiguous — not filled");
      const ok = fillInput(el, d.value || "");
      highlight(el, d.note);
      return { type: d.type, label, resolved: ok, message: ok ? undefined : "no text input under that label" };
    }
    case "select_option": {
      const r = await selectOption({ label: d.target.label, within }, d.value || "", d.note);
      return { type: d.type, label, resolved: r.ok, message: r.message };
    }
    case "set_toggle": {
      const el = resolveTarget(d.target, { minScore: 55, requireUnambiguous: true, within, roles: TOGGLE_SELECTOR });
      if (!el) return notFound("toggle not found, disabled, or ambiguous");
      // A serving switch on the live list/detail page is persistent — never machine-flip
      // it (draft switches on the create page stay allowed).
      const p = detectPage(location.href);
      if ((p === "list" || p === "detail") && (el.matches("[role=switch],material-toggle") || !!el.closest("[role=switch],material-toggle"))) {
        return notFound("a live serving toggle needs a human click");
      }
      const r = await setToggle(el, d.value === "on");
      return { type: d.type, label, resolved: r.ok, message: r.message };
    }
    case "select_row": {
      const row = resolveRow(d.target.label || "");
      if (!row) return notFound(`group "${label}" not found`);
      const box = row.querySelector(CHECKBOX_SELECTOR) as HTMLElement | null;
      if (!box) return notFound("no selection checkbox in that row");
      const r = await setToggle(box, d.value === "on");
      return { type: d.type, label, resolved: r.ok, message: r.message };
    }
    default:
      return { type: d.type, label, resolved: false, message: "unknown directive" };
  }
}

// Run a turn's directives in DOM order, letting the page settle between steps so a
// "open dropdown" then "pick option" sequence works. Stops at the first failed
// ACTUATING step (a missing highlight does not abort the rest).
export async function runDirectives(directives: Directive[]): Promise<DirectiveResult[]> {
  const results: DirectiveResult[] = [];
  for (const d of directives) {
    const r = await execDirective(d);
    results.push(r);
    if (!r.resolved && ACTUATING.has(d.type)) break;
    await new Promise((res) => window.setTimeout(res, 150)); // inter-step settle
  }
  return results;
}
````

</details>

<details>
<summary><code>extension/src/sidepanel/index.html</code></summary>

````html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AdMob Mediation Assistant</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div id="app">
      <div id="banner" class="banner hidden" role="status"></div>
      <div id="sr-status" class="sr-only" role="status" aria-live="polite"></div>

      <main id="transcript" class="transcript" aria-label="Conversation"></main>

      <form id="composer" class="composer">
        <textarea id="input" rows="1" placeholder="Ask anything about mediation…" autocomplete="off"></textarea>
        <button id="send" type="submit" class="send" aria-label="Send message" disabled>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M3 11l18-8-8 18-2-7-8-3z" fill="currentColor"/></svg>
        </button>
      </form>
    </div>
    <script src="main.js"></script>
  </body>
</html>
````

</details>

<details>
<summary><code>extension/src/sidepanel/styles.css</code></summary>

````css
/* AdMob Mediation Assistant — side panel.
   Two width modes, tuned separately:
   · narrow (docked ~320–440px): compact, touch-friendly — the "mobile" feel
   · wide  (undocked ~480px+):   centered reading column, larger scale — "desktop"
   Restrained, Material-aligned, Stripe-grade in precision and motion. */
@font-face {
  font-family: "Roboto";       /* Google's real UI typeface — bundled, offline-safe */
  font-style: normal;
  font-weight: 100 900;        /* variable file; covers the 400/500/700 used here */
  font-display: swap;
  src: url("../fonts/roboto-latin.woff2") format("woff2");
}
:root {
  --blue: #1a73e8;
  --blue-d: #1765cc;
  --bg: #ffffff;
  --surface: #f8f9fa;
  --surface-2: #f1f3f4;
  --text: #202124;
  --muted: #5f6368;
  --faint: #80868b;
  --border: #e6e8eb;
  --border-strong: #d2d5da;
  --user: #e8f0fe;
  --user-text: #174ea6;
  --danger: #d93025;
  --radius: 12px;
  --radius-pill: 22px;
  --font: "Google Sans Text", "Google Sans", "Roboto", system-ui, -apple-system, "Segoe UI", sans-serif;
  --shadow-card: 0 1px 2px rgba(60, 64, 67, 0.06), 0 1px 3px rgba(60, 64, 67, 0.05);
  --shadow-pop: 0 2px 6px rgba(60, 64, 67, 0.12), 0 1px 2px rgba(60, 64, 67, 0.08);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease: cubic-bezier(0.2, 0.6, 0.2, 1);

  /* width-mode variables (narrow defaults; overridden wide below) */
  --pad: 16px;         /* horizontal gutter */
  --fs: 14px;          /* base text size */
  --fs-lead: 20px;     /* empty-state greeting */
  --gap: 16px;         /* space between messages */
  --content: 100%;     /* max width of a message/composer row */
  --measure: 66ch;     /* max reading measure for assistant text */
  --card-px: 14px;     /* card/ack horizontal padding (scales up in wide mode) */
  --card-py: 12px;     /* card vertical padding */
  --btn-py: 8px;       /* button vertical padding */
}
@media (min-width: 480px) {
  :root {
    --pad: 28px;
    --fs: 15px;
    --fs-lead: 26px;
    --gap: 20px;
    --content: 620px;
    --card-px: 18px;
    --card-py: 14px;
    --btn-py: 9px;
  }
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: var(--font);
  color: var(--text);
  background: var(--bg);
  font-size: var(--fs);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#app { display: flex; flex-direction: column; height: 100vh; width: 100%; overflow-x: hidden; }
.hidden { display: none !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* Offline banner (only shown when the backend is unreachable) */
/* One shared column gutter for every top-level row: a fixed inset when the panel is
   narrow, and a centering margin once it grows past the content width. This keeps the
   transcript, cards, and composer content on the exact same left/right edges. */
.banner {
  margin: 10px max(var(--pad), (100% - var(--content)) / 2) 0; padding: 9px 12px; border-radius: 10px;
  background: #fef7e0; border: 1px solid #feefc3; color: #5f4b00; font-size: 12px;
}
.banner code { background: #0000000d; padding: 1px 5px; border-radius: 4px; }

/* Transcript ---------------------------------------------------------------- */
.transcript {
  flex: 1; overflow-y: auto; padding: 20px var(--pad) 10px; display: flex;
  flex-direction: column; gap: var(--gap);
}
/* center the welcome + suggestions vertically before the first message */
.transcript:has(.empty) { justify-content: center; padding-bottom: 56px; }

/* every row is capped to a comfortable measure and centered in wide mode */
.transcript > * { width: 100%; max-width: var(--content); margin-inline: auto; }

/* Messages: assistant is plain text; user is a soft pill on the right --------- */
.msg { display: flex; flex-direction: column; min-width: 0; animation: rise 0.18s var(--ease-out) both; }
.msg.assistant { align-items: stretch; }
.msg.user { align-items: flex-end; }
.msg.assistant .bubble { color: var(--text); font-size: var(--fs); max-width: var(--measure); }
.msg.user .bubble {
  background: var(--user); color: var(--user-text); max-width: 84%;
  padding: 9px 14px; border-radius: 16px 16px 4px 16px; font-size: calc(var(--fs) - 1px);
}
.bubble { overflow-wrap: break-word; }
.bubble :first-child { margin-top: 0; } .bubble :last-child { margin-bottom: 0; }
.bubble p { margin: 0 0 9px; } .bubble p:last-child { margin-bottom: 0; }
.bubble ul, .bubble ol { margin: 7px 0; padding-left: 20px; }
.bubble li { margin: 3px 0; }
.bubble li::marker { color: var(--faint); }
.bubble code { background: var(--surface-2); padding: 1px 5px; border-radius: 5px; font-size: 0.9em; }
.bubble strong { font-weight: 600; }
.bubble a { color: var(--blue); text-underline-offset: 2px; }

.sysnote { align-self: center; color: var(--muted); font-size: 12px; padding: 2px 0; animation: fade 0.18s var(--ease-out) both; }

/* Empty state --------------------------------------------------------------- */
.empty { padding: 2px; animation: rise 0.22s var(--ease-out) both; }
.empty .lead {
  color: var(--text); font-size: var(--fs-lead); font-weight: 500;
  letter-spacing: -0.012em; line-height: 1.25; margin: 0 0 6px;
}
.empty .sub { color: var(--muted); font-size: calc(var(--fs) - 1px); margin: 0 0 18px; }
.suggestions { display: flex; flex-direction: column; gap: 8px; }
.suggestion {
  display: flex; align-items: center; text-align: left; width: 100%;
  font-family: var(--font); font-size: var(--fs); color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 14px; cursor: pointer; min-height: 46px;
  transition: background 0.16s var(--ease), border-color 0.16s var(--ease),
    box-shadow 0.16s var(--ease), transform 0.16s var(--ease);
}
.suggestion::after {
  content: "→"; margin-left: auto; padding-left: 10px; color: var(--faint);
  opacity: 0; transform: translateX(-4px);
  transition: opacity 0.16s var(--ease), transform 0.16s var(--ease);
}
.suggestion:hover {
  background: var(--bg); border-color: var(--border-strong);
  box-shadow: var(--shadow-card); transform: translateY(-1px);
}
.suggestion:hover::after { opacity: 1; transform: translateX(0); }
.suggestion:active { transform: translateY(0); background: var(--surface); }
.suggestion:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

/* Thinking indicator + streaming caret -------------------------------------- */
.typing { display: inline-flex; gap: 5px; align-items: center; padding: 4px 0; }
.typing span { width: 6px; height: 6px; border-radius: 50%; background: #c3c7cc; animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; } .typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 60%, 100% { opacity: 0.3; } 30% { opacity: 1; } }
.caret { display: inline-block; width: 2px; height: 1.05em; vertical-align: text-bottom; background: var(--blue); margin-left: 1px; border-radius: 1px; animation: caret 1.1s steps(1) infinite; }
@keyframes caret { 50% { opacity: 0; } }

@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes pop { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: none; } }

/* Cards (draft + confirmation) ---------------------------------------------- */
/* Cards flow at the tail of the transcript; .transcript > * caps width + centers them,
   and the flex `gap` spaces them from the last message. Only a small bottom margin so
   the final card isn't flush against the composer. */
.card {
  margin: 2px auto 6px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg);
  box-shadow: var(--shadow-card); animation: pop 0.2s var(--ease-out) both; overflow-wrap: break-word;
}
/* Confirmation: calm surface; emphasis lives on the button, not a tinted alert. */
.action-card { background: var(--surface); }
.card .card-head { padding: var(--card-py) var(--card-px) 0; font-weight: 600; font-size: calc(var(--fs) - 1px); letter-spacing: -0.005em; }
.card .card-body { padding: 6px var(--card-px) var(--card-py); font-size: calc(var(--fs) - 1px); color: var(--text); }
.card .card-actions { display: flex; gap: 8px; padding: 0 var(--card-px) var(--card-py); }
.draft-grid { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 16px; font-size: calc(var(--fs) - 2px); }
.draft-grid .k { color: var(--muted); }
.draft-grid .v { min-width: 0; overflow-wrap: anywhere; }
.draft-grid .v.missing { color: #b8bcc2; }

/* Destructive confirmation: neutral card, weight on the red action (semantic). */
.ack { display: flex; align-items: center; gap: 8px; padding: 2px var(--card-px) 10px; font-size: 12px; color: var(--muted); cursor: pointer; }
.ack input { accent-color: var(--danger); width: 15px; height: 15px; margin: 0; }

/* Buttons ------------------------------------------------------------------- */
.btn {
  font-family: var(--font); font-size: 13px; font-weight: 500; border-radius: 8px;
  padding: var(--btn-py) 15px; min-height: 40px; cursor: pointer; border: 1px solid var(--border); background: var(--bg);
  color: var(--text); display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.14s var(--ease), border-color 0.14s var(--ease), transform 0.06s;
}
.btn:hover { background: var(--surface); border-color: var(--border-strong); }
.btn:active { transform: scale(0.98); }
.btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.btn-primary { background: var(--blue); border-color: var(--blue); color: #fff; }
.btn-primary:hover { background: var(--blue-d); border-color: var(--blue-d); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #b31412; border-color: #b31412; }
.btn-danger:disabled { background: #e6a9a3; border-color: #e6a9a3; color: #fff; cursor: default; transform: none; }

/* Composer ------------------------------------------------------------------ */
.composer {
  display: flex; gap: 8px; align-items: flex-end;
  padding: 12px max(var(--pad), (100% - var(--content)) / 2) 16px;
  border-top: 1px solid var(--border); background: var(--bg);
}
#input {
  flex: 1; resize: none; font-family: var(--font); font-size: var(--fs); line-height: 1.5; color: var(--text);
  border: 1px solid var(--border-strong); border-radius: var(--radius-pill); padding: 11px 16px; max-height: 140px;
  outline: none; transition: border-color 0.14s var(--ease), box-shadow 0.14s var(--ease), background 0.14s var(--ease);
  background: var(--surface);
  overflow-y: hidden;   /* no phantom scrollbar at 1 row; autosize re-enables at the cap */
}
#input::placeholder { color: #9aa0a6; }
#input:focus { border-color: var(--blue); background: var(--bg); box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12); }
.send {
  flex: none; width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
  background: var(--blue); color: #fff; display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.14s var(--ease), transform 0.08s var(--ease), box-shadow 0.14s var(--ease);
}
.send:hover:not(:disabled) { background: var(--blue-d); box-shadow: var(--shadow-pop); }
.send:active:not(:disabled) { transform: scale(0.92); }
.send:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.send:disabled { background: var(--surface-2); color: #bdc1c6; cursor: default; }

/* Scrollbar ----------------------------------------------------------------- */
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-thumb { background: transparent; border-radius: 10px; border: 3px solid transparent; background-clip: padding-box; }
.transcript:hover::-webkit-scrollbar-thumb { background: #dadce0; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background: #c3c7cc; background-clip: padding-box; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; }
}
````

</details>

<details>
<summary><code>extension/src/sidepanel/main.ts</code></summary>

````typescript
// Side panel controller: chat + streaming + page directives + confirmation gate.
import {
  BACKEND_BASE,
  type ChatResponse,
  type Directive,
  type PageContext,
  type PageType,
  type ProposedAction,
} from "../shared/protocol";

const sessionId = (crypto as Crypto).randomUUID();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const transcript = $("transcript");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const banner = $("banner");
const srStatus = $("sr-status");

let lastContext: PageContext | null = null;
let busy = false;
let emptyPage: PageType | null = null;
let lastDraft: Record<string, unknown> = {}; // conversational draft from the backend
const dismissedActions = new Set<string>();

// ---------- safe markdown ----------
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function inline(s: string): string {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
  return s;
}

function renderMarkdown(text: string): string {
  const lines = text.split(/\r?\n/);
  let html = "";
  let i = 0;
  const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
  const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isUl(line)) {
      html += "<ul>";
      while (i < lines.length && isUl(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`;
      html += "</ul>";
    } else if (isOl(line)) {
      html += "<ol>";
      while (i < lines.length && isOl(lines[i])) html += `<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ""))}</li>`;
      html += "</ol>";
    } else if (/^\s*$/.test(line)) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) para.push(lines[i++]);
      html += `<p>${inline(para.join(" "))}</p>`;
    }
  }
  return html;
}

// ---------- transcript ----------
const scrollDown = () => (transcript.scrollTop = transcript.scrollHeight);

function addMessage(role: "user" | "assistant"): HTMLElement {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  msg.appendChild(bubble);
  transcript.appendChild(msg);
  scrollDown();
  return bubble;
}

function addSysNote(text: string) {
  const note = document.createElement("div");
  note.className = "sysnote";
  note.textContent = text;
  transcript.appendChild(note);
  scrollDown();
}

interface Suggestion { label: string; prompt: string; }

function suggestionsFor(page: PageType): Suggestion[] {
  switch (page) {
    case "create":
      return [
        { label: "Which ad format should I choose?", prompt: "Which ad format should I choose for this group?" },
        { label: "Bidding vs. waterfall", prompt: "What's the difference between bidding and waterfall?" },
        { label: "What's an eCPM floor?", prompt: "What is a bidding eCPM floor, and should I set one?" },
      ];
    case "detail":
      return [
        { label: "Add an ad network", prompt: "How do I add an ad network to this group?" },
        { label: "Improve this group's eCPM", prompt: "How can I improve this group's eCPM?" },
        { label: "What does priority do?", prompt: "What does a mediation group's priority setting do?" },
      ];
    default:
      return [
        { label: "Create a mediation group", prompt: "Help me create a mediation group." },
        { label: "Bidding vs. waterfall", prompt: "What's the difference between bidding and waterfall?" },
        { label: "How do I increase eCPM?", prompt: "How can I increase eCPM across my mediation groups?" },
      ];
  }
}

function showEmptyState() {
  emptyPage = lastContext?.page ?? "list";
  transcript.innerHTML = `
    <div class="empty">
      <p class="lead">How can I help with mediation?</p>
      <p class="sub">Ask a question, or start with one of these.</p>
      <div class="suggestions"></div>
    </div>`;
  const wrap = transcript.querySelector(".suggestions") as HTMLElement;
  for (const s of suggestionsFor(emptyPage)) {
    const b = document.createElement("button");
    b.className = "suggestion";
    b.textContent = s.label;
    b.addEventListener("click", () => void send(s.prompt));
    wrap.appendChild(b);
  }
}

// ---------- chrome messaging ----------
function toContent<T = unknown>(
  payload: { kind: string; [k: string]: unknown },
  timeoutMs = 1500,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // A torn-down content script never invokes the callback; time out so the turn
    // can't hang waiting on the page.
    const timer = setTimeout(() => finish(null), timeoutMs);
    chrome.runtime.sendMessage({ kind: "TO_CONTENT", payload }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || !resp?.ok) return finish(null);
      finish(resp.data as T);
    });
  });
}

async function refreshContext(): Promise<void> {
  lastContext = await toContent<PageContext>({ kind: "READ_CONTEXT" });
  if (transcript.querySelector(".empty")) {
    // keep empty-state suggestions in sync if the user navigated before chatting
    if ((lastContext?.page ?? "list") !== emptyPage) showEmptyState();
  } else if (!busy) {
    // keep the draft card mirroring the live form as the user edits it — but never let
    // the 4s poll (or an in-turn refresh) un-hide it mid-stream; the done handler renders
    // it once when the turn completes.
    renderDraftMerged();
  }
}

// ---------- backend ----------
async function checkHealth(): Promise<void> {
  try {
    const r = await fetch(`${BACKEND_BASE}/healthz`, { cache: "no-store" });
    if (!r.ok) throw new Error("bad status");
    banner.classList.add("hidden");
  } catch {
    banner.classList.remove("hidden");
    banner.textContent = "The assistant is offline. Reconnecting…";
  }
}

async function streamChat(
  body: Record<string, unknown>,
  onToken: (t: string) => void,
  onReset: () => void,
  onDone: (d: ChatResponse) => void,
): Promise<void> {
  const resp = await fetch(`${BACKEND_BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let ev = "message";
      let data = "";
      for (const ln of chunk.split("\n")) {
        if (ln.startsWith("event:")) ev = ln.slice(6).trim();
        else if (ln.startsWith("data:")) data += ln.slice(5).trim();
      }
      if (!data) continue;
      if (ev === "token") onToken(JSON.parse(data) as string);
      else if (ev === "reset") onReset();
      else if (ev === "done") onDone(JSON.parse(data) as ChatResponse);
    }
  }
}

// ---------- cards (rendered inline, at the tail of the conversation) ----------
// The draft and confirmation cards live at the end of the transcript — directly under
// the latest reply — rather than floating in a fixed bottom dock, so a short
// conversation never leaves an empty gap above them. draft-card always sits above
// action-card.
function removeCard(id: string) {
  document.getElementById(id)?.remove();
}
function ensureCard(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("section");
    el.id = id;
    el.setAttribute("role", "group");
  }
  if (id === "draft-card") {
    const action = document.getElementById("action-card");
    if (action) {
      transcript.insertBefore(el, action); // keep draft above the pending action
      return el;
    }
  }
  transcript.appendChild(el); // otherwise move to the tail
  return el;
}

function renderDraft(draft: Record<string, unknown>) {
  const fields: [string, string][] = [
    ["format", "Format"], ["platform", "Platform"], ["name", "Name"],
    ["ad_units", "Ad units"], ["locations", "Locations"], ["sources", "Ad sources"], ["ecpm", "eCPM"],
  ];
  if (!fields.some(([k]) => draft[k])) {
    removeCard("draft-card");
    return;
  }
  const rows = fields
    .map(([k, label]) => {
      const v = draft[k];
      return `<div class="k">${label}</div><div class="v ${v ? "" : "missing"}">${v ? esc(String(v)) : "—"}</div>`;
    })
    .join("");
  const card = ensureCard("draft-card");
  card.className = "card draft-card";
  card.innerHTML = `<div class="card-head">Group draft</div><div class="card-body"><div class="draft-grid">${rows}</div></div>`;
}

// Show the draft grounded in the live form: values actually selected on the page
// (format/platform/name) override the conversational draft, so progress is always correct.
function renderDraftMerged() {
  renderDraft({ ...lastDraft, ...(lastContext?.form || {}) });
}

function renderProposed(action: ProposedAction | null) {
  if (!action || dismissedActions.has(action.id)) {
    removeCard("action-card");
    return;
  }
  const destructive = action.risk === "destructive" || action.kind === "delete";

  const confirmAndSend = () => {
    removeCard("action-card");
    void send("Yes, proceed.", {
      confirm_action_id: action.id,
      confirm_kind: action.kind,
      hideUserBubble: true,
      systemNote: "Confirmed",
    });
  };
  const dismiss = () => {
    dismissedActions.add(action.id);
    removeCard("action-card");
  };

  const card = ensureCard("action-card");
  card.setAttribute("aria-label", "Confirm action");

  if (destructive) {
    // Strong confirmation: an acknowledgement enables the red action; the safe
    // choice (Keep) is the default focus so the destructive button is never a reflex.
    card.className = "card action-card";
    card.innerHTML = `
      <div class="card-head">Delete permanently?</div>
      <div class="card-body">${esc(action.summary)}</div>
      <label class="ack"><input type="checkbox" id="ack-box" /> I understand this can't be undone.</label>
      <div class="card-actions">
        <button class="btn" id="dismiss-btn">Keep</button>
        <button class="btn btn-danger" id="confirm-btn" disabled>Delete</button>
      </div>`;
    const ack = $<HTMLInputElement>("ack-box");
    const confirmBtn = $<HTMLButtonElement>("confirm-btn");
    ack.addEventListener("change", () => (confirmBtn.disabled = !ack.checked));
    confirmBtn.addEventListener("click", () => ack.checked && confirmAndSend());
    $("dismiss-btn").addEventListener("click", dismiss);
    scrollDown();
    $<HTMLButtonElement>("dismiss-btn").focus();
    return;
  }

  const title = action.kind === "set_status" ? "Confirm this change" : "Confirm before saving";
  card.className = "card action-card";
  card.innerHTML = `
    <div class="card-head">${title}</div>
    <div class="card-body">${esc(action.summary)}</div>
    <div class="card-actions">
      <button class="btn btn-primary" id="confirm-btn">Confirm</button>
      <button class="btn" id="dismiss-btn">Not yet</button>
    </div>`;
  $("confirm-btn").addEventListener("click", confirmAndSend);
  $("dismiss-btn").addEventListener("click", dismiss);
  scrollDown();
}

// ---------- send ----------
interface SendOpts {
  confirm_action_id?: string;
  confirm_kind?: string;
  hideUserBubble?: boolean;
  systemNote?: string;
}

const typingHTML = '<span class="typing" aria-hidden="true"><span></span><span></span><span></span></span>';

async function send(text: string, opts: SendOpts = {}): Promise<void> {
  if (busy || !text.trim()) return;
  busy = true;
  sendBtn.disabled = true;
  if (transcript.querySelector(".empty")) transcript.innerHTML = "";
  removeCard("action-card");
  removeCard("draft-card");

  if (opts.hideUserBubble) {
    if (opts.systemNote) addSysNote(opts.systemNote);
  } else {
    addMessage("user").textContent = text;
  }

  // Paint the thinking indicator BEFORE refreshContext()'s DOM round-trip, so the turn
  // never opens with dead air while the page is scanned.
  const assistant = addMessage("assistant");
  assistant.innerHTML = typingHTML;
  srStatus.textContent = "Assistant is responding";
  transcript.setAttribute("aria-busy", "true");

  await refreshContext();

  let acc = "";
  let finished = false;
  const body = {
    session_id: sessionId,
    message: text,
    page_context: lastContext,
    confirm_action_id: opts.confirm_action_id ?? null,
    confirm_kind: opts.confirm_kind ?? null,
  };

  try {
    await streamChat(
      body,
      (t) => {
        banner.classList.add("hidden"); // a response proves the service is reachable
        acc += t;
        // Follow the stream only if the user is pinned near the bottom; measure BEFORE
        // mutating, or a growing scrollHeight reads as "scrolled up" and hijacks scrollback.
        const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
        assistant.innerHTML = renderMarkdown(acc) + '<span class="caret"></span>';
        if (stick) scrollDown();
      },
      () => {
        // a tool call started a new response segment — drop the preamble
        acc = "";
        assistant.innerHTML = typingHTML;
      },
      (data) => {
        finished = true;
        banner.classList.add("hidden"); // reached the service; clear any stale offline notice
        assistant.innerHTML = renderMarkdown(data.reply || acc || "…");
        lastDraft = data.draft || {};
        renderDraftMerged();
        renderProposed(data.proposed_action);
        if (data.directives?.length) void toContent({ kind: "EXEC", directives: data.directives as Directive[] });
        srStatus.textContent = "";
        scrollDown();
      },
    );
    if (!finished) {
      assistant.innerHTML = renderMarkdown(acc || "Something interrupted that response. Please try again.");
    }
  } catch {
    assistant.innerHTML = renderMarkdown(
      "I can’t reach the assistant right now. Check your connection and try again.",
    );
    void checkHealth();
  } finally {
    transcript.setAttribute("aria-busy", "false");
    busy = false;
    updateSendEnabled();
    input.focus();
  }
}

// ---------- input wiring ----------
const INPUT_MAX = 140;
function autosize() {
  input.style.height = "auto";
  const full = input.scrollHeight;
  input.style.height = `${Math.min(full, INPUT_MAX)}px`;
  // only show a scrollbar once the field has actually grown past its cap
  input.style.overflowY = full > INPUT_MAX ? "auto" : "hidden";
}
function updateSendEnabled() {
  sendBtn.disabled = busy || input.value.trim().length === 0;
}
function submitInput() {
  const v = input.value;
  input.value = "";
  autosize();
  updateSendEnabled();
  void send(v);
}

input.addEventListener("input", () => {
  autosize();
  updateSendEnabled();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitInput();
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  submitInput();
});

// ---------- init ----------
(async () => {
  await refreshContext();
  showEmptyState();
  void checkHealth();
})();
setInterval(checkHealth, 15000);
setInterval(refreshContext, 4000);
````

</details>


### Extension — tests (run the real engine against synthetic DOM)

<details>
<summary><code>extension/tests/harness.ts</code></summary>

````typescript
// Test harness: expose the real dom.ts actuation engine on window so a Playwright
// page can drive it against a synthetic AngularDart-like DOM (no backend, no model).
import { execDirective, runDirectives, resolveTarget, readContext, readGroups, clearHighlights } from "../src/content/dom";
(window as unknown as { DOMH: unknown }).DOMH = {
  execDirective, runDirectives, resolveTarget, readContext, readGroups, clearHighlights,
};
````

</details>

<details>
<summary><code>extension/tests/dom.spec.mjs</code></summary>

````javascript
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
````

</details>

<details>
<summary><code>extension/tests/real-dom.spec.mjs</code></summary>

````javascript
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
````

</details>


### Demo — synthetic page + recorder

<details>
<summary><code>demo/admob-page.html</code></summary>

````html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AdMob — Mediation</title>
<style>
  /* Faithful re-creation of AdMob's AngularDart + ACX Material mediation UI, using
     the real element tags (material-radio-group, material-dropdown-select, material-
     list-item, material-button) so the extension's real DOM engine resolves and
     actuates it exactly as it would the live page. */
  @font-face { font-family:"Roboto"; font-weight:100 900; font-display:swap; src:url("roboto-latin.woff2") format("woff2"); }
  :root{
    --blue:#1a73e8; --blue-d:#1765cc; --ink:#202124; --muted:#5f6368; --faint:#80868b;
    --line:#dadce0; --line-soft:#e8eaed; --surface:#f8f9fa; --hover:#f1f3f4;
    --font:"Google Sans Text","Google Sans","Roboto",system-ui,-apple-system,"Segoe UI",sans-serif;
    --shadow:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15);
  }
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;}
  body{font-family:var(--font);color:var(--ink);background:#fff;font-size:14px;-webkit-font-smoothing:antialiased;}
  a{color:var(--blue);text-decoration:none;}

  /* Top app bar (AdMob green-free, neutral) */
  .appbar{height:64px;display:flex;align-items:center;gap:16px;padding:0 24px;border-bottom:1px solid var(--line-soft);}
  .appbar .logo{display:flex;align-items:center;gap:10px;font-weight:500;font-size:20px;color:var(--ink);letter-spacing:-.01em;}
  .appbar .logo .mark{width:26px;height:26px;border-radius:6px;background:var(--blue);display:inline-flex;align-items:center;justify-content:center;color:#fff;font-family:"Google Sans",var(--font);font-weight:700;font-size:16px;line-height:1;}
  .appbar .spacer{flex:1;}
  .appbar .acct{width:32px;height:32px;border-radius:50%;background:#e8f0fe;color:#1a73e8;display:flex;align-items:center;justify-content:center;font-weight:600;}

  .shell{display:flex;height:calc(100% - 64px);}
  .nav{width:236px;flex:none;padding:14px 8px;border-right:1px solid var(--line-soft);}
  .nav .item{display:flex;align-items:center;gap:14px;height:40px;padding:0 16px;border-radius:0 20px 20px 0;color:var(--muted);font-weight:500;font-size:13px;cursor:pointer;}
  .nav .item svg{width:18px;height:18px;flex:none;}
  .nav .item.active{background:#e8f0fe;color:var(--blue);}
  .nav .item:not(.active):hover{background:var(--hover);color:var(--ink);}

  .main{flex:1;overflow:auto;padding:28px 40px;}
  .page-title{font-family:"Google Sans","Google Sans Text",var(--font);font-size:22px;font-weight:400;letter-spacing:-.01em;margin:0 0 4px;}
  .page-sub{color:var(--muted);font-size:14px;margin:0 0 22px;}

  /* Buttons (ACX material-button) */
  material-button{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 16px;border-radius:8px;font-weight:500;font-size:14px;cursor:pointer;user-select:none;color:var(--blue);position:relative;}
  material-button.primary{background:var(--blue);color:#fff;box-shadow:0 1px 2px rgba(60,64,67,.2);}
  material-button.primary:hover{background:var(--blue-d);}
  material-button.stroked{border:1px solid var(--line);color:var(--blue);}
  material-button.text:hover,material-button.stroked:hover{background:rgba(26,115,232,.06);}
  material-button[aria-disabled=true]{color:#9aa0a6;pointer-events:none;box-shadow:none;background:#f1f3f4;}
  material-icon{font-size:18px;line-height:1;}

  /* Data table / list of groups */
  .toolbar{display:flex;align-items:center;gap:12px;margin:0 0 16px;}
  .toolbar .spacer{flex:1;}
  .search{height:40px;padding:0 14px;border:1px solid var(--line);border-radius:8px;color:var(--ink);width:280px;font-size:13px;font-family:var(--font);background:#fff;outline:none;}
  .search::placeholder{color:var(--faint);}
  .search:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(26,115,232,.15);}
  material-list{display:block;border:1px solid var(--line-soft);border-radius:12px;overflow:hidden;}
  .thead{display:grid;grid-template-columns:44px 2fr 1fr 1fr 1fr 96px;gap:12px;align-items:center;padding:12px 18px;background:var(--surface);border-bottom:1px solid var(--line-soft);color:var(--muted);font-size:12px;font-weight:500;text-transform:none;}
  material-list-item{display:grid;grid-template-columns:44px 2fr 1fr 1fr 1fr 96px;gap:12px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line-soft);font-size:14px;}
  material-list-item:last-child{border-bottom:none;}
  material-list-item:hover{background:var(--surface);}
  material-list-item .gname{font-weight:500;color:var(--ink);}
  material-list-item .muted{color:var(--muted);}

  /* Checkbox + toggle (ACX) */
  material-checkbox{width:18px;height:18px;border:2px solid #5f6368;border-radius:3px;display:inline-block;cursor:pointer;position:relative;}
  material-checkbox[aria-checked=true]{background:var(--blue);border-color:var(--blue);}
  material-checkbox[aria-checked=true]::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}
  material-toggle{width:34px;height:14px;border-radius:8px;background:#bdc1c6;display:inline-block;position:relative;cursor:pointer;vertical-align:middle;transition:background .15s;}
  material-toggle::after{content:"";position:absolute;top:-3px;left:-1px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:left .15s;}
  material-toggle[aria-checked=true]{background:#a8c7fa;}
  material-toggle[aria-checked=true]::after{left:15px;background:var(--blue);}

  /* Create flow */
  .card{border:1px solid var(--line-soft);border-radius:12px;padding:22px 24px;margin:0 0 18px;max-width:760px;}
  .card h3{font-family:"Google Sans",var(--font);font-size:16px;font-weight:500;margin:0 0 4px;}
  .card .hint{color:var(--muted);font-size:13px;margin:0 0 16px;}
  material-radio-group{display:flex;gap:12px;flex-wrap:wrap;}
  material-radio{display:flex;align-items:center;gap:10px;min-width:150px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;transition:border-color .12s,background .12s,box-shadow .12s;}
  material-radio .dot{width:18px;height:18px;border-radius:50%;border:2px solid #5f6368;flex:none;position:relative;}
  material-radio[aria-checked=true]{border-color:var(--blue);background:#e8f0fe;}
  material-radio[aria-checked=true] .dot{border-color:var(--blue);}
  material-radio[aria-checked=true] .dot::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--blue);}
  .field{margin:0 0 16px;max-width:520px;}
  .field label{display:block;font-size:12px;color:var(--muted);margin:0 0 6px;font-weight:500;}
  .field input{width:100%;height:44px;border:1px solid var(--line);border-radius:8px;padding:0 14px;font-family:var(--font);font-size:14px;color:var(--ink);outline:none;background:#fff;}
  .field input:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(26,115,232,.15);}
  material-dropdown-select{display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 14px;border:1px solid var(--line);border-radius:8px;cursor:pointer;color:var(--ink);font-size:14px;min-width:240px;justify-content:space-between;}
  material-dropdown-select .chev{color:var(--muted);}

  /* dropdown overlay (material-popup) */
  .acx-overlay-container{position:absolute;z-index:60;}
  material-popup{display:block;min-width:260px;background:#fff;border-radius:8px;box-shadow:var(--shadow);overflow:hidden;padding:8px 0;border:1px solid var(--line-soft);}
  material-popup [role=option]{display:flex;align-items:center;gap:12px;height:44px;padding:0 16px;cursor:pointer;font-size:14px;}
  material-popup [role=option]:hover{background:var(--hover);}

  .sources{margin:6px 0 0;}
  .source-row{display:grid;grid-template-columns:1fr 130px 90px;gap:14px;align-items:center;padding:12px 0;border-top:1px solid var(--line-soft);}
  .source-row .net{font-weight:500;display:flex;align-items:center;gap:10px;}
  .source-row .net .badge{font-size:11px;color:var(--blue);background:#e8f0fe;padding:2px 8px;border-radius:10px;font-weight:500;}
  .source-row input{height:38px;}

  .actions{display:flex;gap:12px;margin-top:8px;}
  .snackbar{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(80px);background:#323232;color:#fff;padding:14px 18px;border-radius:8px;font-size:14px;box-shadow:var(--shadow);opacity:0;transition:transform .25s,opacity .25s;z-index:80;}
  .snackbar.show{transform:translateX(-50%) translateY(0);opacity:1;}
  .hidden{display:none !important;}
  material-dialog{position:fixed;inset:0;background:rgba(32,33,36,.5);display:none;align-items:center;justify-content:center;z-index:90;}
  material-dialog.show{display:flex;}
  material-dialog .box{background:#fff;border-radius:12px;padding:24px;max-width:400px;box-shadow:var(--shadow);}
  material-dialog h3{margin:0 0 8px;font-family:"Google Sans",var(--font);font-size:18px;font-weight:500;}
  material-dialog p{margin:0 0 20px;color:var(--muted);font-size:14px;}
  material-dialog .row{display:flex;justify-content:flex-end;gap:8px;}
</style>
</head>
<body>
  <div class="appbar">
    <div class="logo"><span class="mark" aria-hidden="true">A</span> AdMob</div>
    <div class="spacer"></div>
    <div class="acct">A</div>
  </div>
  <div class="shell">
    <nav class="nav">
      <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/></svg> Home</div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg> Apps</div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 10v4M12 9.5v5M16 11v2"/></svg> Ad units</div>
      <div class="item active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/></svg> Mediation</div>
      <div class="item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 19V11M10 19V5M15 19v-6M20 19v-9"/></svg> Reports</div>
    </nav>

    <!-- LIST VIEW -->
    <main class="main" id="view-list">
      <h1 class="page-title">Mediation groups</h1>
      <p class="page-sub">Optimize your ad revenue by managing how ad sources compete.</p>
      <div class="toolbar">
        <material-button role="button" class="primary" aria-label="Create mediation group" onclick="AdMob.goCreate()">
          <material-icon>+</material-icon> Create mediation group
        </material-button>
        <div class="spacer"></div>
        <input class="search" type="text" placeholder="Search mediation groups" aria-label="Search mediation groups" />
      </div>
      <material-list role="list">
        <div class="thead"><span></span><span>Mediation group</span><span>Format</span><span>Platform</span><span>eCPM</span><span>Status</span></div>
        <material-list-item role="row">
          <material-checkbox role="checkbox" aria-checked="false" aria-label="Select Holiday Promo"></material-checkbox>
          <a role="link" class="gname" href="#">Holiday Promo</a>
          <span class="muted">Banner</span><span class="muted">Android</span><span class="muted">$2.40</span>
          <material-toggle role="switch" aria-checked="true" aria-label="Serving Holiday Promo"></material-toggle>
        </material-list-item>
        <material-list-item role="row">
          <material-checkbox role="checkbox" aria-checked="false" aria-label="Select US Rewarded"></material-checkbox>
          <a role="link" class="gname" href="#">US Rewarded</a>
          <span class="muted">Rewarded</span><span class="muted">iOS</span><span class="muted">$11.80</span>
          <material-toggle role="switch" aria-checked="true" aria-label="Serving US Rewarded"></material-toggle>
        </material-list-item>
        <material-list-item role="row">
          <material-checkbox role="checkbox" aria-checked="false" aria-label="Select Default group"></material-checkbox>
          <a role="link" class="gname" href="#">Default group</a>
          <span class="muted">All</span><span class="muted">—</span><span class="muted">—</span>
          <material-toggle role="switch" aria-checked="true" aria-label="Serving Default group"></material-toggle>
        </material-list-item>
      </material-list>
    </main>

    <!-- CREATE VIEW -->
    <main class="main hidden" id="view-create">
      <h1 class="page-title">Create mediation group</h1>
      <p class="page-sub">Choose a format and platform, then add ad sources.</p>

      <div class="card">
        <h3>Ad format</h3>
        <p class="hint">The type of ad this group serves.</p>
        <material-radio-group aria-label="Ad format">
          <material-radio role="radio" aria-checked="false" aria-label="Banner"><span class="dot"></span> Banner</material-radio>
          <material-radio role="radio" aria-checked="false" aria-label="Interstitial"><span class="dot"></span> Interstitial</material-radio>
          <material-radio role="radio" aria-checked="false" aria-label="Rewarded"><span class="dot"></span> Rewarded</material-radio>
          <material-radio role="radio" aria-checked="false" aria-label="App open"><span class="dot"></span> App open</material-radio>
        </material-radio-group>
      </div>

      <div class="card">
        <h3>Platform</h3>
        <p class="hint">The platform your app runs on.</p>
        <material-radio-group aria-label="Platform">
          <material-radio role="radio" aria-checked="false" aria-label="Android"><span class="dot"></span> Android</material-radio>
          <material-radio role="radio" aria-checked="false" aria-label="iOS"><span class="dot"></span> iOS</material-radio>
        </material-radio-group>
      </div>

      <div class="card" id="details-card">
        <h3>Group details</h3>
        <div class="field">
          <label>Mediation group name</label>
          <input aria-label="Mediation group name" placeholder="e.g. Holiday Promo" />
        </div>
        <div class="field" style="max-width:none">
          <label>Ad sources</label>
          <material-dropdown-select role="button" aria-label="Add ad source" onclick="AdMob.toggleSources(this)">
            <span>Add ad source</span><span class="chev">▾</span>
          </material-dropdown-select>
          <div class="sources" id="sources"></div>
        </div>
      </div>

      <div class="actions">
        <material-button role="button" class="stroked" aria-label="Cancel" onclick="AdMob.goList()">Cancel</material-button>
        <material-button role="button" class="primary" aria-label="Save" onclick="AdMob.save()">Save</material-button>
      </div>
    </main>
  </div>

  <div class="snackbar" id="snackbar"></div>
  <material-dialog id="confirm-dialog">
    <div class="box">
      <h3 id="dlg-title">Delete mediation group?</h3>
      <p id="dlg-body">This permanently deletes the group and its settings.</p>
      <div class="row">
        <material-button role="button" class="text" aria-label="Cancel delete" onclick="AdMob.closeDialog()">Cancel</material-button>
        <material-button role="button" class="primary" style="background:#d93025" aria-label="Delete" onclick="AdMob.confirmDelete()">Delete</material-button>
      </div>
    </div>
  </material-dialog>

  <script src="admob-page.js"></script>
</body>
</html>
````

</details>

<details>
<summary><code>demo/admob-page.js</code></summary>

````javascript
// Behavior for the synthetic AdMob page. State-flips happen on real click events, so
// the extension's engine (which calls el.click()) drives it exactly like a user would.
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const NETWORKS = ["AdMob Network", "Meta Audience Network", "AppLovin", "Unity Ads", "Liftoff Monetize"];
  window.__ADMOB_VIEW = "list";

  const AdMob = {
    goCreate() {
      $("#view-list").classList.add("hidden");
      $("#view-create").classList.remove("hidden");
      window.__ADMOB_VIEW = "create";
    },
    goList() {
      $("#view-create").classList.add("hidden");
      $("#view-list").classList.remove("hidden");
      window.__ADMOB_VIEW = "list";
      closeOverlay();
    },
    toggleSources(el) {
      if (closeOverlay()) return;
      openOverlay(el, NETWORKS.map((n) => ({ label: n })), (name) => {
        addSource(name);
        closeOverlay();
      });
    },
    save() {
      snack("Mediation group created");
      setTimeout(() => AdMob.goList(), 900);
    },
    openDialog(title, body) {
      $("#dlg-title").textContent = title || "Delete mediation group?";
      $("#dlg-body").textContent = body || "This permanently deletes the group and its settings.";
      $("#confirm-dialog").classList.add("show");
    },
    closeDialog() { $("#confirm-dialog").classList.remove("show"); },
    confirmDelete() { AdMob.closeDialog(); snack("Mediation group deleted"); },
  };
  window.AdMob = AdMob;

  // The live page's URL is admob.google.com/groups/list so the engine's readGroups
  // fires there; in this offline demo the URL differs, so expose the same data here.
  window.__demoGroups = function () {
    return [...document.querySelectorAll("#view-list material-list-item")]
      .map((row) => {
        const name = (row.querySelector("a[role=link]")?.textContent || "").trim();
        const tog = row.querySelector("material-toggle");
        return { name, enabled: tog ? tog.getAttribute("aria-checked") === "true" : true };
      })
      .filter((g) => g.name);
  };

  function addSource(name) {
    if ([...document.querySelectorAll(".source-row")].some((r) => r.dataset.net === name)) return;
    const row = document.createElement("div");
    row.className = "source-row";
    row.dataset.net = name;
    row.innerHTML =
      `<div class="net">${name}<span class="badge">Bidding</span></div>` +
      `<input aria-label="eCPM" placeholder="Optional" />` +
      `<material-toggle role="switch" aria-checked="true" aria-label="Enable ${name}"></material-toggle>`;
    $("#sources").appendChild(row);
  }

  // ACX material-popup overlay -------------------------------------------------
  function openOverlay(anchor, items, onPick) {
    closeOverlay();
    const cont = document.createElement("div");
    cont.className = "acx-overlay-container";
    const pop = document.createElement("material-popup");
    for (const it of items) {
      const opt = document.createElement("div");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-label", it.label);
      opt.textContent = it.label;
      opt.addEventListener("click", () => onPick(it.label));
      pop.appendChild(opt);
    }
    cont.appendChild(pop);
    document.body.appendChild(cont);
    const r = anchor.getBoundingClientRect();
    cont.style.left = r.left + "px";
    cont.style.top = r.bottom + 6 + window.scrollY + "px";
    return cont;
  }
  function closeOverlay() {
    const ex = document.querySelector(".acx-overlay-container");
    if (ex) { ex.remove(); return true; }
    return false;
  }

  // Delegated state changes (so engine el.click() works like a real user) -------
  document.addEventListener("click", (e) => {
    const radio = e.target.closest("material-radio");
    if (radio) {
      const group = radio.closest("material-radio-group");
      if (group) group.querySelectorAll("material-radio").forEach((r) => r.setAttribute("aria-checked", "false"));
      radio.setAttribute("aria-checked", "true");
      return;
    }
    const flip = e.target.closest("material-checkbox, material-toggle");
    if (flip) {
      flip.setAttribute("aria-checked", flip.getAttribute("aria-checked") === "true" ? "false" : "true");
    }
  });
})();
````

</details>

<details>
<summary><code>demo/stage.html</code></summary>

````html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AdMob Mediation Assistant — demo</title>
<style>
  @font-face { font-family:"Roboto"; font-weight:100 900; font-display:swap; src:url("roboto-latin.woff2") format("woff2"); }
  :root{ --font:"Google Sans Text","Google Sans","Roboto",system-ui,-apple-system,sans-serif; }
  html,body{margin:0;height:100%;background:#dfe1e5;font-family:var(--font);overflow:hidden;}
  .stage{display:flex;height:100vh;}
  #admob{flex:1;border:none;background:#fff;height:100%;}
  /* Chrome side-panel dock: Chrome renders this chrome (title + icon), not the extension. */
  .dock{width:400px;flex:none;display:flex;flex-direction:column;background:#fff;
        box-shadow:-3px 0 16px rgba(60,64,67,.16);}
  .dock-head{height:44px;flex:none;display:flex;align-items:center;gap:10px;padding:0 14px;
             border-bottom:1px solid #e8eaed;color:#3c4043;}
  .dock-head img{width:18px;height:18px;border-radius:4px;}
  .dock-head .t{font:500 13px/1 var(--font);}
  .dock-head .x{margin-left:auto;color:#5f6368;font-size:18px;}
  #panel{flex:1;border:none;width:100%;}
  /* Caption (lower third) */
  .caption{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(8px);
           max-width:900px;background:rgba(32,33,36,.94);color:#fff;padding:14px 26px;border-radius:12px;
           font:500 19px/1.45 var(--font);text-align:center;opacity:0;transition:opacity .3s,transform .3s;
           box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:none;z-index:100;letter-spacing:-.005em;}
  .caption.show{opacity:1;transform:translateX(-50%) translateY(0);}
  .cursor{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;z-index:120;pointer-events:none;
          opacity:0;transition:opacity .2s;}
  .cursor.show{opacity:1;}
</style>
</head>
<body>
  <div class="stage">
    <iframe id="admob" src="admob-page.html"></iframe>
    <div class="dock">
      <div class="dock-head">
        <img id="ext-icon" alt="" />
        <span class="t">AdMob Mediation Assistant</span>
        <span class="x">&times;</span>
      </div>
      <iframe id="panel" src="/sidepanel/index.html"></iframe>
    </div>
  </div>
  <div class="caption" id="caption"></div>
  <img class="cursor" id="cursor" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Cpath d='M3 2l6 15 2.2-6.2L17.5 8.8z' fill='%23202124' stroke='white' stroke-width='1.3'/%3E%3C/svg%3E" />
  <script>
    // Chrome's side-panel header shows the real extension icon.
    document.getElementById("ext-icon").src = "/icons/icon-48.png";
  </script>
</body>
</html>
````

</details>

<details>
<summary><code>demo/record.mjs</code></summary>

````javascript
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
````

</details>

<details>
<summary><code>demo/replay-backend.mjs</code></summary>

````javascript
// Replay backend — drop-in stand-in for the real ADK backend on :8765 for recording
// the demo when the free-tier daily quota is exhausted. It streams the SAME wire
// contract (SSE token deltas + a terminal `done`) using the EXACT directives and
// proposals the live model was verified to emit for each utterance (captured from
// live API runs). The real backend and this one are interchangeable behind record.mjs.
import http from "node:http";

const draftBySession = {};
const D = (type, label, value, extra = {}) => ({ type, target: { label, within: extra.within ?? null }, value: value ?? null, note: extra.note ?? "", risk: extra.risk ?? "reversible" });
const PA = (kind, summary, risk, draft, id) => ({ id, kind, summary, risk, draft, steps: [] });

// message (lowercased) -> response. First matching rule wins.
function respond(msg, sid, confirmId) {
  const m = msg.toLowerCase();
  const draft = (draftBySession[sid] = draftBySession[sid] || { format: null, platform: null, name: null, ad_units: null, locations: null, sources: null, ecpm: null });
  const id = "act" + Math.abs(hash(sid + msg)).toString(36).slice(0, 8);

  if (confirmId) {
    if (m.includes("delete")) return { reply: "Confirmed. Click the highlighted **Delete**, then confirm in AdMob's dialog to remove it.", directives: [D("highlight", "Delete", null, { risk: "read" })] };
    return { reply: "Confirmed. Click the highlighted **Save** to apply the change.", directives: [D("highlight", "Save", null, { risk: "read" })] };
  }
  if (m.includes("bidding") && m.includes("waterfall"))
    return { reply: "Bidding runs a real-time auction across your sources for each request — the highest bid wins. Waterfall calls sources in a fixed order by the eCPM you set, top to bottom. Bidding usually maximizes competition; waterfall gives you manual control. Most groups today lead with bidding and add a few waterfall sources." };
  if (m.includes("create") || m.includes("create flow") || m.includes("new mediation") || m.includes("start"))
    return { reply: "Pick your **Ad format** and **Platform**, then **Save**. What format is this group for?", directives: [D("click", "Create mediation group", null, { note: "Open the create flow" })] };
  if ((m.includes("banner") || m.includes("format")) && (m.includes("android") || m.includes("platform"))) {
    draft.format = "Banner"; draft.platform = "Android";
    return { reply: "Next, name your group.", directives: [D("select_option", "Ad format", "Banner"), D("select_option", "Platform", "Android")] };
  }
  if (m.includes("name")) {
    const nm = extractName(msg) || "Holiday Sale"; draft.name = nm;
    return { reply: "Named. Add an ad source next, or save the group.", directives: [D("fill", "Mediation group name", nm)] };
  }
  if (m.includes("add") && m.includes("source")) {
    draft.sources = "AdMob Network"; const net = m.includes("meta") ? "Meta Audience Network" : m.includes("applovin") ? "AppLovin" : "AdMob Network";
    draft.sources = net;
    return { reply: `${net} added as a bidding source. Set an eCPM floor, or save the group.`, directives: [D("select_option", "Add ad source", net)] };
  }
  if (m.includes("save")) {
    const nm = draft.name || "Holiday Sale";
    return { reply: `This creates the **${nm}** group — ${draft.format || "Banner"}, ${draft.platform || "Android"}. Confirm below to save.`, proposed_action: PA("save_group", `Create mediation group ${nm}`, "persistent", { ...draft }, id) };
  }
  if (m.includes("disable")) {
    reset(draft); const g = pickGroup(m) || "US Rewarded";
    return { reply: `Confirm below to disable serving for the **${g}** mediation group.`, directives: [D("select_row", g, "on")], proposed_action: PA("set_status", `Disable the ${g} mediation group`, "persistent", { groups: [g], enabled: false }, id) };
  }
  if (m.includes("delete") || m.includes("remove")) {
    reset(draft); const g = pickGroup(m) || "Holiday Promo";
    return { reply: `This permanently deletes **${g}** and its settings. Confirm below to proceed.`, directives: [D("select_row", g, "on")], proposed_action: PA("delete", `Delete mediation group ${g}`, "destructive", { targets: [g] }, id) };
  }
  return { reply: "I can help with mediation groups — creating, editing, enabling or deleting them, and the concepts behind bidding, waterfall, and eCPM." };
}

function reset(d) { for (const k of Object.keys(d)) d[k] = null; }
function pickGroup(m) { for (const g of ["Holiday Promo", "US Rewarded", "Default group"]) if (m.includes(g.toLowerCase())) return g; return null; }
function extractName(s) { const q = s.match(/["“]([^"”]+)["”]/); if (q) return q[1]; const it = s.match(/\b(?:name it|called|named)\s+([A-Z][\w '-]+?)(?:[.\n]|$)/i); return it ? it[1].trim() : null; }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "content-type" }); res.end(); return; }
  if (req.url === "/healthz") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, model: "gemini-3.5-flash (replay)" })); return; }
  if (req.url === "/api/chat/stream" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let r; try { r = JSON.parse(body); } catch { r = {}; }
      const out = respond(r.message || "", r.session_id || "s", r.confirm_action_id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
      const words = (out.reply || "").split(/(\s+)/);
      for (const w of words) { res.write(`event: token\ndata: ${JSON.stringify(w)}\n\n`); await sleep(38); }
      const done = { reply: out.reply || "", directives: out.directives || [], proposed_action: out.proposed_action || null, draft: draftBySession[r.session_id] || {} };
      res.write(`event: done\ndata: ${JSON.stringify(done)}\n\n`);
      res.end();
    });
    return;
  }
  res.statusCode = 404; res.end("nf");
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
server.listen(8765, "127.0.0.1", () => console.log("replay backend on :8765"));
````

</details>
