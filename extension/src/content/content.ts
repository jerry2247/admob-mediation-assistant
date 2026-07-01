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
