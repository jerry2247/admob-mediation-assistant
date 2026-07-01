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
