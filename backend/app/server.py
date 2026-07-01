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
