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
