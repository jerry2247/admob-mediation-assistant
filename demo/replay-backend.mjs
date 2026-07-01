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
