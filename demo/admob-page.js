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
