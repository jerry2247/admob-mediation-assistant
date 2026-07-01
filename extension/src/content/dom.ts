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
