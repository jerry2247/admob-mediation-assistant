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
