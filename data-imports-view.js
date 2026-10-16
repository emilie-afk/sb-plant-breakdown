// ============================================================
// data-imports-view.js
// The "Data & imports" view: shared-storage connection, import status and
// history, explicit migration of browser snapshots, and shared settings.
//
// Rules:
//   - The dashboard key is typed by the person using the dashboard and kept
//     in THIS browser only. It is never in the code or the build.
//   - Nothing is uploaded or downloaded without a click. Browser snapshots
//     stay exactly where they are until someone chooses to move them.
//   - A failed import shows its reason, and the previous report stays the one
//     shown — the Worker guarantees that; this view says so.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab, BUI */

  var CONN_KEY = "sb-shared-store-v1";
  var SETTINGS_VER_KEY = "sb-shared-settings-versions-v1";
  var STALE_KEY = "sb-shared-stale-days-v1";
  var DI = { reports: null, runs: null, error: null, busy: false, results: {} };
  window.SBDataImports = DI;

  function loadConn() { try { return JSON.parse(localStorage.getItem(CONN_KEY) || "null"); } catch (e) { return null; } }
  function saveConn(c) { try { if (c) localStorage.setItem(CONN_KEY, JSON.stringify(c)); else localStorage.removeItem(CONN_KEY); } catch (e) {} }
  function loadVers() { try { return JSON.parse(localStorage.getItem(SETTINGS_VER_KEY) || "{}"); } catch (e) { return {}; } }
  function saveVers(v) { try { localStorage.setItem(SETTINGS_VER_KEY, JSON.stringify(v)); } catch (e) {} }
  function staleDays() { var n = parseInt((function () { try { return localStorage.getItem(STALE_KEY); } catch (e) { return null; } })(), 10); return isNaN(n) ? 10 : n; }
  function esc(s) { return BUI.esc(s); }

  async function api(path, opts) {
    var c = loadConn();
    if (!c || !c.url || !c.key) throw new Error("Not connected. Enter the shared storage address and key first.");
    opts = opts || {};
    var res;
    try {
      res = await fetch(c.url.replace(/\/+$/, "") + path, {
        method: opts.method || "GET",
        headers: Object.assign({ authorization: "Bearer " + c.key }, opts.body ? { "content-type": "application/json" } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error("Could not reach shared storage at " + c.url + ". (" + (e.message || e) + ")");
    }
    var body = null; try { body = await res.json(); } catch (e) {}
    if (res.status === 401) throw new Error("The dashboard key was rejected.");
    if (res.status === 403) throw new Error("This key is not allowed to do that (it may be the collector key).");
    return { status: res.status, body: body || {} };
  }

  async function refresh() {
    DI.busy = true; DI.error = null; render();
    try {
      var r = await api("/v1/reports");
      var h = await api("/v1/imports?limit=100");
      DI.reports = r.body.reports || [];
      DI.runs = h.body.imports || [];
    } catch (e) { DI.error = e.message; DI.reports = null; DI.runs = null; }
    DI.busy = false; render();
  }

  // ---- render ------------------------------------------------
  function render() {
    var root = document.getElementById("di-root");
    if (!root) return;
    var c = loadConn();
    var parts = [];

    parts.push(
      '<div class="panel"><div class="panel-h"><h2>Shared storage</h2>' +
      '<span class="small">' + (c ? "Connected to " + esc(c.url) : "Not connected — reports live only in this browser") + "</span></div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<input id="di-url" placeholder="https://sb-plant-breakdown.<account>.workers.dev" value="' + esc(c ? c.url : "") + '" style="flex:2;min-width:260px;padding:6px 8px;border:1px solid var(--border);border-radius:6px">' +
      // Masked, but deliberately NOT a password field: browser password
      // managers would otherwise offer to save the dashboard key with the site.
      '<input id="di-key" type="text" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" ' +
      'style="-webkit-text-security:disc" placeholder="Dashboard key" value="' + (c ? "••••••••" : "") + '" style="flex:1;min-width:180px;padding:6px 8px;border:1px solid var(--border);border-radius:6px">' +
      '<button id="di-connect">' + (c ? "Update" : "Connect") + "</button>" +
      (c ? '<button class="tab" id="di-refresh">Refresh</button><button class="tab danger" id="di-disconnect">Disconnect</button>' : "") +
      "</div>" +
      '<div class="small" style="margin-top:6px">The key is kept in this browser only and is never part of the site’s code. ' +
      "Use the <b>dashboard</b> key here, not the collector key.</div>" +
      (DI.error ? '<div class="small" style="color:#b71c1c;margin-top:6px">' + esc(DI.error) + "</div>" : "") +
      (DI.busy ? '<div class="small" style="margin-top:6px">Loading…</div>' : "") +
      "</div>"
    );

    if (c && DI.reports) {
      var st = window.sharedImportStatus(DI.reports, DI.runs, { staleDays: staleDays(), expect: ["shopify", "amazon"],
        today: new Date().toISOString().slice(0, 10) });
      if (st.alerts.length) {
        parts.push('<div class="panel" style="border-color:#ffcc80;background:#fffaf2">' + st.alerts.map(function (a) {
          return '<div style="margin:2px 0">' + (a.level === "error" ? "⛔ " : "⚠ ") + esc(a.message) + "</div>";
        }).join("") + "</div>");
      }
      parts.push('<div class="grid cards">' + ["shopify", "amazon"].map(function (src) {
        var s = st.sources[src];
        return '<div class="card"><div class="label">' + src + '</div><div class="value">' +
          (s.latestPeriod ? esc(s.latestPeriod.start) + " → " + esc(s.latestPeriod.end) : "no reports") + '</div><div class="sub">' +
          s.reports + " report(s) · last successful import " +
          (s.lastSuccessfulImport ? esc(new Date(s.lastSuccessfulImport).toLocaleString()) : "never") +
          (s.lastRun ? "<br>last attempt: <b>" + esc(s.lastRun.outcome) + "</b>" : "") + "</div></div>";
      }).join("") + "</div>");

      parts.push('<div class="panel"><div class="panel-h"><h2>Reports in shared storage <span class="pill">' + DI.reports.length + "</span></h2>" +
        '<span class="small">Overlapping periods are kept as separate reports and are never added together.</span></div>' +
        '<div class="scroll" style="max-height:360px"><table><thead><tr><th>Source</th><th>Period</th><th>Report</th>' +
        '<th class="num">Rev.</th><th class="num">Rows</th><th class="num">Units</th><th class="num">Net / ordered sales</th>' +
        '<th>Imported</th><th></th></tr></thead><tbody>' +
        (DI.reports.map(function (r) {
          var local = snapshots.find(function (x) { return x.meta && x.meta.shared && x.meta.shared.reportId === r.id; });
          return "<tr><td>" + esc(r.source) + "</td><td>" + esc(r.period_start) + " → " + esc(r.period_end) + "</td>" +
            '<td class="small">' + esc(r.report_scope) + (r.has_product_id ? ' <span class="badge ok">product id</span>' : "") + "</td>" +
            '<td class="num">' + r.revision + '</td><td class="num">' + BUI.count(r.row_count) + '</td><td class="num">' + BUI.count(r.totals.units) +
            '</td><td class="num">' + (r.capabilities && r.capabilities.hasRevenue === false ? "—" : BUI.money(r.totals.net)) + "</td>" +
            '<td class="small">' + esc(new Date(r.imported_at).toLocaleString()) + " · " + esc(r.imported_by) + "</td>" +
            "<td>" + (local ? '<span class="small">in this browser</span>'
                            : '<button class="tab" data-di-load="' + esc(r.id) + '">Load into this browser</button>') + "</td></tr>";
        }).join("") || '<tr><td colspan="9" class="empty">No reports yet.</td></tr>') + "</tbody></table></div></div>");

      parts.push('<div class="panel"><div class="panel-h"><h2>Import history <span class="pill">' + DI.runs.length + "</span></h2></div>" +
        '<div class="scroll" style="max-height:320px"><table><thead><tr><th>When</th><th>Source</th><th>Period</th><th>By</th><th>Outcome</th>' +
        '<th class="num">Rows</th><th>Details</th></tr></thead><tbody>' +
        (DI.runs.map(function (r) {
          var cls = r.outcome === "succeeded" ? "up" : (r.outcome === "unchanged" ? "flat" : "down");
          return '<tr><td class="small">' + esc(new Date(r.started_at).toLocaleString()) + "</td><td>" + esc(r.source) + "</td>" +
            '<td class="small">' + esc(r.period_start || "") + (r.period_end ? " → " + esc(r.period_end) : "") + "</td>" +
            '<td class="small">' + esc(r.imported_by) + '</td><td class="' + cls + '"><b>' + esc(r.outcome) + "</b></td>" +
            '<td class="num">' + (r.row_count == null ? "" : BUI.count(r.row_count)) + "</td>" +
            '<td class="small">' + esc(r.error_message || (r.revision ? "revision " + r.revision : "")) + "</td></tr>";
        }).join("") || '<tr><td colspan="7" class="empty">No imports yet.</td></tr>') + "</tbody></table></div></div>");
    }

    // Browser snapshots — always shown, connected or not.
    var local = snapshots.filter(function (s) { return (s.source === "shopify" || s.source === "amazon") && !s.isCatalog; });
    parts.push('<div class="panel"><div class="panel-h"><h2>Reports saved in this browser <span class="pill">' + local.length + "</span></h2>" +
      (c && local.length ? '<button class="tab" id="di-upload-all">Upload all to shared storage…</button>' : "") + "</div>" +
      '<div class="small" style="margin-bottom:6px">These stay in this browser until you upload them. Uploading never deletes them here, ' +
      "and re-uploading an unchanged report writes nothing. The existing backup / restore under “Manage snapshots” still works.</div>" +
      '<div class="scroll" style="max-height:320px"><table><thead><tr><th>Source</th><th>Report</th><th>Period</th><th class="num">Products</th>' +
      "<th>Shared?</th><th></th></tr></thead><tbody>" +
      (local.map(function (s) {
        var res = DI.results[s.id];
        var shared = s.meta && s.meta.shared;
        return "<tr><td>" + esc(s.source) + "</td><td>" + esc(s.label) + "</td><td class=\"small\">" + esc(s.startDate) + " → " + esc(s.endDate) + "</td>" +
          '<td class="num">' + BUI.count(s.products.length) + "</td>" +
          '<td class="small">' + (res ? esc(res) : shared ? "loaded from shared (rev. " + shared.revision + ")" : "only here") + "</td>" +
          "<td>" + (c ? '<button class="tab" data-di-up="' + esc(s.id) + '">Upload</button>' : "") + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="empty">No reports saved in this browser.</td></tr>') + "</tbody></table></div></div>");

    if (c) {
      var vers = loadVers();
      parts.push('<div class="panel"><div class="panel-h"><h2>Shared settings</h2></div>' +
        '<div class="small" style="margin-bottom:6px">Hand-set classifications and confirmed Amazon column mappings, so every browser groups ' +
        "and reads files the same way. Pushing refuses to overwrite a newer shared copy; pull first if it does.</div>" +
        '<table><tbody>' +
        settingRow("classification_overrides", "Classification overrides", Object.keys(window.SBOverrides.load()).length, vers) +
        settingRow("amazon_column_mappings", "Amazon column mappings", Object.keys(window.SBAmazonMappings.load()).length, vers) +
        "</tbody></table></div>");
    }

    parts.push('<div class="panel"><div class="panel-h"><h2>Automatic collection</h2></div>' +
      '<div class="small">Automatic imports come from the Windows collector (<code>collector/</code>), scheduled on a PC by ' +
      "<code>collector/windows/install-task.ps1</code>. This page cannot see whether that task is installed; every run it makes " +
      "appears in the import history above, marked “collector”. By default a run collects month-to-date and, on the 2nd of each month, " +
      "the previous full month, in the store's time zone. A report is marked stale when its newest period ended more than " +
      '<input id="di-stale" type="number" min="1" max="90" value="' + staleDays() + '" style="width:50px"> days ago.</div></div>');

    root.innerHTML = parts.join("");
    wire();
  }

  function settingRow(key, label, localCount, vers) {
    return "<tr><td><b>" + label + "</b></td><td class=\"small\">" + localCount + " in this browser · " +
      (vers[key] ? "shared version " + vers[key] : "not synced yet") + "</td>" +
      '<td><button class="tab" data-di-push="' + key + '">Push to shared</button> ' +
      '<button class="tab" data-di-pull="' + key + '">Pull from shared</button></td>' +
      '<td class="small" id="di-set-' + key + '">' + esc(DI.results["set:" + key] || "") + "</td></tr>";
  }

  // ---- actions -----------------------------------------------
  async function upload(id) {
    var s = snapshots.find(function (x) { return x.id === id; });
    if (!s) return;
    var conv = window.sharedPayloadFromSnapshot(s, { client: "dashboard" });
    if (!conv.ok) { DI.results[id] = conv.reason; render(); return; }
    DI.results[id] = "uploading…"; render();
    try {
      var r = await api("/v1/ingest/product-report", { method: "POST", body: conv.payload });
      var b = r.body;
      if (b.ok && b.reportId) {
        // Link the browser copy to its shared copy, so it is not offered for
        // download again and shows which revision it matches.
        s.meta = s.meta || {};
        s.meta.shared = { reportId: b.reportId, revision: b.revision, linkedAt: new Date().toISOString() };
        window.saveSnapshots();
      }
      DI.results[id] = b.ok
        ? (b.outcome === "unchanged" ? "already in shared storage (unchanged)" : "uploaded — revision " + b.revision +
           (b.overlaps && b.overlaps.length ? " · overlaps " + b.overlaps.length + " other report(s), never summed" : "") +
           (conv.legacy ? " · stored as a legacy snapshot" : ""))
        : "refused: " + ((b.errors || []).map(function (e) { return e.message; }).join(" ") || b.error || b.outcome);
    } catch (e) { DI.results[id] = "failed: " + e.message; }
    await refresh();
  }

  async function loadShared(reportId) {
    try {
      var rep = (DI.reports || []).find(function (r) { return r.id === reportId; });
      var rows = [], offset = 0, page;
      do {
        page = (await api("/v1/reports/" + encodeURIComponent(reportId) + "/rows?offset=" + offset + "&limit=5000")).body.rows || [];
        rows = rows.concat(page); offset += page.length;
      } while (page.length === 5000);
      if (rows.length !== rep.row_count) throw new Error("Expected " + rep.row_count + " rows, received " + rows.length + ".");
      var snap = window.sharedSnapshotFromReport(rep, rows, {
        labelFromDates: window.labelFromDates,
        toSnapshotProduct: window.shopifyToSnapshotProduct,
        amazonSnapshotIdentity: window.amazonSnapshotIdentity,
        classify: function (r) {
          return window.classifyRecord(r, { detectGenus: window.detectGenus, detectNonPlantType: window.detectNonPlantType,
            override: window.makeOverrideLookup(window.SBOverrides.load()) });
        }
      });
      var existing = snapshots.find(function (x) { return x.id === snap.id; });
      if (existing && !confirm("This browser already has “" + existing.label + "”. Replace it with the shared copy (revision " +
                               rep.revision + ")? Make a backup first under Manage snapshots if unsure.")) return;
      snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
      snapshots.push(snap);
      window.saveSnapshots();
      // Select it on its tab when nothing is selected there yet, so the
      // person sees the report straight away instead of an empty picker.
      var st = state[snap.source];
      if (st && (!st.snapshotId || !snapshots.some(function (x) { return x.id === st.snapshotId; }))) {
        st.snapshotId = snap.id; st.mode = "single";
      }
      DI.results[snap.id] = "loaded from shared storage (revision " + rep.revision + ") — open the " +
        (snap.source === "shopify" ? "Shopify" : "Amazon") + " tab to view it";
      render();
    } catch (e) { alert("Could not load the report: " + e.message); }
  }

  async function pushSetting(key) {
    var value = key === "classification_overrides" ? window.SBOverrides.load() : window.SBAmazonMappings.load();
    var vers = loadVers();
    try {
      var r = await api("/v1/settings/" + key, { method: "PUT", body: { value: value, baseVersion: vers[key] || 0, updatedBy: "dashboard" } });
      if (r.status === 409) {
        DI.results["set:" + key] = "Shared copy is newer (version " + r.body.currentVersion + "). Pull first, then push.";
      } else if (r.body.ok) {
        vers[key] = r.body.version; saveVers(vers);
        DI.results["set:" + key] = "pushed — shared version " + r.body.version;
      } else DI.results["set:" + key] = "failed";
    } catch (e) { DI.results["set:" + key] = e.message; }
    render();
  }
  async function pullSetting(key) {
    try {
      var r = await api("/v1/settings/" + key);
      var s = r.body.setting;
      if (!s) { DI.results["set:" + key] = "nothing shared yet"; render(); return; }
      if (!confirm("Replace this browser’s " + key.replace(/_/g, " ") + " with the shared copy (version " + s.version + ")?")) return;
      if (key === "classification_overrides") window.SBOverrides.save(s.value);
      else localStorage.setItem(window.SBAmazonMappings.STORAGE_KEY, JSON.stringify(s.value));
      var vers = loadVers(); vers[key] = s.version; saveVers(vers);
      DI.results["set:" + key] = "pulled — version " + s.version;
    } catch (e) { DI.results["set:" + key] = e.message; }
    render();
  }

  function wire() {
    var g = function (id) { return document.getElementById(id); };
    if (g("di-connect")) g("di-connect").onclick = function () {
      var url = g("di-url").value.trim();
      var key = g("di-key").value.trim();
      var old = loadConn();
      if (/^•+$/.test(key) && old) key = old.key;
      if (!/^https?:\/\//.test(url)) { DI.error = "Enter the full address, starting with https://"; render(); return; }
      if (key.length < 32) { DI.error = "That key is too short to be a dashboard key."; render(); return; }
      saveConn({ url: url, key: key }); refresh();
    };
    if (g("di-refresh")) g("di-refresh").onclick = refresh;
    if (g("di-disconnect")) g("di-disconnect").onclick = function () {
      if (!confirm("Forget the shared storage address and key in this browser? Nothing is deleted anywhere.")) return;
      saveConn(null); DI.reports = null; DI.runs = null; render();
    };
    if (g("di-stale")) g("di-stale").onchange = function (e) {
      try { localStorage.setItem(STALE_KEY, String(Math.max(1, parseInt(e.target.value, 10) || 10))); } catch (x) {}
      render();
    };
    if (g("di-upload-all")) g("di-upload-all").onclick = async function () {
      var ids = snapshots.filter(function (s) { return (s.source === "shopify" || s.source === "amazon") && !s.isCatalog; })
        .map(function (s) { return s.id; });
      if (!confirm("Upload " + ids.length + " report(s) from this browser to shared storage? They stay in this browser too.")) return;
      for (var i = 0; i < ids.length; i++) await upload(ids[i]);
    };
    document.querySelectorAll("[data-di-up]").forEach(function (b) { b.onclick = function () { upload(b.getAttribute("data-di-up")); }; });
    document.querySelectorAll("[data-di-load]").forEach(function (b) { b.onclick = function () { loadShared(b.getAttribute("data-di-load")); }; });
    document.querySelectorAll("[data-di-push]").forEach(function (b) { b.onclick = function () { pushSetting(b.getAttribute("data-di-push")); }; });
    document.querySelectorAll("[data-di-pull]").forEach(function (b) { b.onclick = function () { pullSetting(b.getAttribute("data-di-pull")); }; });
  }

  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (source === "data") {
      render();
      if (loadConn() && !DI.reports && !DI.busy && !DI.error) refresh();
      return;
    }
    return origRenderTab(source);
  };
})();
