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
