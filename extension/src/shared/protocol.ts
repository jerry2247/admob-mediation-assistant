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
