// ============================================================
// data-imports-view.js
// Shared reports in the dashboard:
//   1. AUTOMATIC LOADING — on open, the newest saved Shopify report is fetched
//      from shared storage and shown. Nobody selects or uploads a file.
//   2. A STATUS STRIP above the Shopify and Vendors analysis: what period is
//      shown (month-to-date marked partial), when the last automatic
//      collection succeeded, and any collection or refresh failure.
//   3. The "Data settings" panel (button in the header): connection setup,
//      shared reports and import history, uploading browser reports, shared
//      settings, manual file upload (fallback), backup and troubleshooting.
//
// Rules:
//   - Keys are never in the source. A read-only key may be built into the
//     password-protected page (SB_SHARED_URL / SB_SHARED_KEY at build time);
//     otherwise a person enters a key once in Data settings, kept in this
//     browser only.
//   - When a refresh or a collection fails, the last successful analysis stays
//     on screen and the failure is shown above it.
//   - Overlapping reports are never added together: only the newest
//     month-to-date report of a month is shown; older ones are superseded.
//   - Nothing the person uploaded by hand is overwritten by an automatic copy.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab, BUI */

  var CONN_KEY = "sb-shared-store-v1";
  var SETTINGS_VER_KEY = "sb-shared-settings-versions-v1";
  var STALE_KEY = "sb-shared-stale-days-v1";
  var STORE_TZ = "America/Los_Angeles";
  var DI = { reports: null, runs: null, error: null, busy: false, results: {} };
  var AUTO = { status: "idle", error: null, current: null, fullMonth: null, collection: null, checkedAt: null, userPicked: false };
  window.SBDataImports = DI;
  window.SBAutoLoad = AUTO;

  // ---- connection ---------------------------------------------
  // A connection saved in this browser wins; otherwise the read-only
  // connection built into the page (if the build provided one).
  function builtInConn() {
    var meta = function (n) { var el = document.querySelector('meta[name="' + n + '"]'); return el ? el.getAttribute("content") || "" : ""; };
    var d = window.SB_SHARED_DEFAULT || { url: meta("sb-shared-url"), key: meta("sb-shared-key") };
    if (!d || typeof d.url !== "string" || typeof d.key !== "string") return null;
    if (/__SB_/.test(d.url + d.key) || !/^https?:\/\//.test(d.url) || d.key.length < 32) return null;
    return { url: d.url, key: d.key, builtIn: true };
  }
  function savedConn() { try { return JSON.parse(localStorage.getItem(CONN_KEY) || "null"); } catch (e) { return null; } }
  function loadConn() { return savedConn() || builtInConn(); }
  function saveConn(c) { try { if (c) localStorage.setItem(CONN_KEY, JSON.stringify(c)); else localStorage.removeItem(CONN_KEY); } catch (e) {} }
  function loadVers() { try { return JSON.parse(localStorage.getItem(SETTINGS_VER_KEY) || "{}"); } catch (e) { return {}; } }
  function saveVers(v) { try { localStorage.setItem(SETTINGS_VER_KEY, JSON.stringify(v)); } catch (e) {} }
  function staleDays() { var n = parseInt((function () { try { return localStorage.getItem(STALE_KEY); } catch (e) { return null; } })(), 10); return isNaN(n) ? 10 : n; }
  function esc(s) { return BUI.esc(s); }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }

  async function api(path, opts) {
    var c = loadConn();
    if (!c || !c.url || !c.key) throw new Error("Not connected. Enter the shared storage address and key in Data settings.");
    opts = opts || {};
    var res;
    try {
      res = await fetch(c.url.replace(/\/+$/, "") + path, {
        method: opts.method || "GET",
        headers: Object.assign({ authorization: "Bearer " + c.key }, opts.body ? { "content-type": "application/json" } : {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
    } catch (e) {
      throw new Error("Could not reach shared storage. (" + (e.message || e) + ")");
    }
    var body = null; try { body = await res.json(); } catch (e) {}
    if (res.status === 401) throw new Error("The shared-storage key was rejected.");
    if (res.status === 403) throw new Error("This key is not allowed to do that (a read-only or collector key). Enter the dashboard key in Data settings.");
    return { status: res.status, body: body || {} };
  }

  // ---- shared report -> browser snapshot -----------------------
  function classifier() {
    var ov = window.makeOverrideLookup(window.SBOverrides.load());
    return function (r) {
      return window.classifyRecord(r, { detectGenus: window.detectGenus, detectNonPlantType: window.detectNonPlantType, override: ov });
    };
  }
  async function fetchRows(rep) {
    var rows = [], offset = 0, page;
    do {
      page = (await api("/v1/reports/" + encodeURIComponent(rep.id) + "/rows?offset=" + offset + "&limit=5000")).body.rows || [];
      rows = rows.concat(page); offset += page.length;
    } while (page.length === 5000);
    if (rows.length !== rep.row_count) throw new Error("Expected " + rep.row_count + " rows, received " + rows.length + ".");
    return rows;
  }
  function buildSnapshot(rep, rows) {
    var snap = window.sharedSnapshotFromReport(rep, rows, {
      labelFromDates: window.labelFromDates,
      toSnapshotProduct: window.shopifyToSnapshotProduct,
      amazonSnapshotIdentity: window.amazonSnapshotIdentity,
      classify: classifier()
    });
    if (rep.source === "shopify" && rep.report_scope === window.SHARED_SHOPIFY_SCOPE) {
      var info = window.sharedPeriodInfo(rep.period_start, rep.period_end);
      snap.label = info.label;
      snap.meta.periodKind = info.kind;
      snap.meta.partial = info.partial;
    }
    return snap;
  }

  // Loads a shared report into this browser for automatic use. A copy already
  // here at the same revision is reused. A snapshot the person uploaded by
  // hand for the same period is never replaced: the automatic copy gets its
  // own id beside it.
  async function ensureAutoLoaded(rep) {
    var have = snapshots.find(function (x) { return x.meta && x.meta.shared && x.meta.shared.reportId === rep.id && x.meta.auto; });
    if (have && have.meta.shared.revision === rep.revision) return have;
    var snap = buildSnapshot(rep, await fetchRows(rep));
    snap.meta.auto = true;
    snap.meta.loadedAt = new Date().toISOString();
    var clash = snapshots.find(function (x) { return x.id === snap.id && !(x.meta && x.meta.auto); });
    if (clash) { snap.id += "_auto"; snap.label += " · automatic"; }
    snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
    snapshots.push(snap);
    return snap;
  }

  // Period views (combined months, quarters, years) are rebuilt from shared
  // storage whenever they are opened; they are never written to browser storage.
  var origSave = window.saveSnapshots;
  if (typeof origSave === "function" && !origSave._dsWrapped) {
    window.saveSnapshots = function () {
      var all = snapshots;
      snapshots = all.filter(function (x) { return !(x.meta && x.meta.ephemeral); });
      try { return origSave.apply(this, arguments); } finally { snapshots = all; }
    };
    window.saveSnapshots._dsWrapped = true;
  }
  window.SBShared = { api: api, fetchRows: fetchRows, buildSnapshot: buildSnapshot, loadConn: loadConn,
                      renderStatus: function () { renderStatus(); }, openSettings: function (s) { openSettings(s); } };

  // ---- automatic loading --------------------------------------
  async function autoLoad() {
    var c = loadConn();
    if (!c) { AUTO.status = "not_connected"; afterAuto(); return; }
    AUTO.status = "loading"; AUTO.error = null; renderStatus();
    try {
      var reports = (await api("/v1/reports")).body.reports || [];
      // Confirmed classification corrections, read-only, for every viewer.
      try {
        var so = (await api("/v1/settings/classification_overrides")).body.setting;
        if (so && window.SBOverrides && window.SBOverrides.setShared) window.SBOverrides.setShared(so.value, so.version);
      } catch (se) { console.warn("shared classification overrides:", se); }
      var runs = (await api("/v1/imports?limit=100")).body.imports || [];
      var pick = window.sharedPickCurrent(reports);
      AUTO.reports = reports;
      AUTO.collection = window.sharedCollectionStatus(runs, { source: "shopify" });
      AUTO.marketCollection = window.sharedCollectionStatus(runs, { source: "market" });
      AUTO.checkedAt = new Date().toISOString();
      if (!pick.current) { AUTO.status = "none"; AUTO.current = null; afterAuto(); return; }
      var cur = await ensureAutoLoaded(pick.current);
      var full = pick.fullMonth ? await ensureAutoLoaded(pick.fullMonth) : null;
      // Older month-to-date copies of the current month overlap it; they are
      // automatic copies (never hand uploads), so they are retired here.
      snapshots = snapshots.filter(function (x) {
        return !(x.meta && x.meta.auto && x.source === "shopify" && x !== cur && x.meta.periodKind === "month_to_date" &&
                 x.startDate === cur.startDate && x.endDate < cur.endDate);
      });
      window.saveSnapshots();
      AUTO.current = cur; AUTO.fullMonth = full; AUTO.status = "ok";
      if (!AUTO.userPicked || !snapshots.some(function (x) { return x.id === state.shopify.snapshotId; })) {
        state.shopify.snapshotId = cur.id; state.shopify.mode = "single";
      }
      // The period selector (month / quarter / year) works from the same list.
      if (window.SBPeriodView) {
        try { await window.SBPeriodView.onReports(reports, { current: cur, keepSelection: AUTO.userPicked }); }
        catch (pe) { console.warn("period view:", pe); }
      }
    } catch (e) {
      AUTO.status = "offline"; AUTO.error = e.message;
      // Keep the last successful analysis: the newest automatic copy saved in
      // this browser, unless the person is already looking at a report.
      var cached = snapshots.filter(function (x) { return x.source === "shopify" && x.meta && x.meta.auto; })
        .sort(function (a, b) { return b.endDate.localeCompare(a.endDate); })[0] || null;
      AUTO.current = cached;
      if (window.SBPeriodView) window.SBPeriodView.onOffline(e.message);
      if (cached && !snapshots.some(function (x) { return x.id === state.shopify.snapshotId; })) {
        state.shopify.snapshotId = cached.id; state.shopify.mode = "single";
      }
    }
    afterAuto();
  }
  function afterAuto() {
    if (activeTab === "shopify" || activeTab === "vendors") window.renderTab(activeTab);
    else renderStatus();
    if (isSettingsOpen()) render();
  }

  // ---- status strip (above the analysis) -----------------------
  function statusHtml() {
    var snap = snapshots.find(function (x) { return x.id === state.shopify.snapshotId; }) || null;
    var col = AUTO.collection;
    var lines = [];
    var head;
    if (snap && snap.meta && snap.meta.period) {
      var pp = snap.meta.period;
      head = "<b>Sales period:</b> " + esc(window.periodRangeText(snap.startDate, snap.endDate)) +
        (pp.status === "complete" ? ' <span class="badge ok">complete</span>'
          : pp.status === "to_date" ? ' <span class="badge type-other">' + esc(pp.kind) + " to date — partial</span>"
          : ' <span class="badge type-other">partial — incomplete coverage</span>') +
        ' <span class="small">· ' + esc(pp.name) + " · store dates, " + STORE_TZ + " · combined from " + pp.revisionsUsed.length +
        " monthly report" + (pp.revisionsUsed.length === 1 ? "" : "s") + "</span>";
    } else if (snap) {
      var info = snap.meta && snap.meta.current ? window.sharedPeriodInfo(snap.meta.current.start, snap.meta.current.end)
                                                : window.sharedPeriodInfo(snap.startDate, snap.endDate);
      var src = snap.meta && snap.meta.auto ? "automatic collection" : snap.meta && snap.meta.shared ? "shared storage" : "file uploaded in this browser";
      head = "<b>Sales period:</b> " + esc(info.range) + (info.partial ? ' <span class="badge type-other">month to date — partial</span>'
        : info.kind === "full_month" ? ' <span class="badge ok">full month</span>' : "") +
        ' <span class="small">· store dates, ' + STORE_TZ + " · source: " + esc(src) + "</span>";
      var sh = snap.meta && snap.meta.shared && AUTO.reports ? AUTO.reports.filter(function (r) { return r.id === snap.meta.shared.reportId; })[0] : null;
      if (!sh && snap.meta && snap.meta.shared && /superseded/.test(snap.label || "")) {
        head += '<div class="small"><b>Revision ' + snap.meta.shared.revision + " — an earlier, superseded revision</b>, opened for inspection. " +
          "The active revision is used everywhere else.</div>";
      }
      if (sh) {
        head += '<div class="small">Revision ' + sh.revision + (sh.collected_at ? " · collected " + esc(when(sh.collected_at)) : "") +
          " · imported " + esc(when(sh.activated_at || sh.imported_at)) + (sh.confirmed_at ? " · last confirmed " + esc(when(sh.confirmed_at)) : "") + "</div>";
      }
      if (AUTO.current && snap !== AUTO.current && AUTO.status === "ok" && !(window.SBPeriodView && window.SBPeriodView.isActive())) {
        head += '<div class="small">You are viewing an earlier report. Latest saved: ' + esc(AUTO.current.label) +
                ' — <a href="#" data-ds-latest>show latest</a></div>';
      }
    } else if (AUTO.status === "loading") head = "Loading the latest saved Shopify report…";
    else if (AUTO.status === "none") head = "<b>No saved Shopify report yet.</b> Reports appear here automatically after the daily collection.";
    else if (AUTO.status === "not_connected") head = "<b>Saved reports are not connected in this browser.</b> Open ⚙ Data settings (top right) to connect.";
    else head = "No Shopify report to show.";
    lines.push(head);

    if (col) {
      lines.push('<span class="small"><b>Last updated</b> (last successful collection): ' +
        (col.lastSuccessAt ? esc(when(col.lastSuccessAt)) : "none yet") +
        (AUTO.checkedAt ? " · checked " + esc(when(AUTO.checkedAt)) : "") + "</span>");
      if (col.failure) {
        lines.push('<span style="color:#b71c1c">⛔ <b>The last automatic collection failed</b> (' + esc(when(col.failureAt)) + "): " +
          esc(col.failure.error_message || col.failure.error_code || "unknown error") +
          ". The analysis below is the last successful report.</span>");
      } else if (col.stale && col.lastSuccessAt) {
        lines.push('<span style="color:#8a5a00">⚠ No successful collection for more than a day. The collector PC must be on and signed in at the scheduled time.</span>');
      }
    }
    if (AUTO.status === "offline") {
      lines.push('<span style="color:#8a5a00">⚠ Could not refresh from shared storage (' + esc(AUTO.error) + ")." +
        (snap ? " Showing the copy saved in this browser." : "") + "</span>");
    }
    return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">' +
      '<div style="display:flex;flex-direction:column;gap:3px">' + lines.map(function (l) { return "<div>" + l + "</div>"; }).join("") + "</div>" +
      '<div style="display:flex;gap:6px">' + (loadConn() ? '<button class="tab" data-ds-refresh>Refresh</button>' : "") + "</div></div>";
  }
  function renderStatus() {
    ["sb-data-status", "vn-data-status"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = statusHtml();
      el.querySelectorAll("[data-ds-refresh]").forEach(function (b) { b.onclick = function () { autoLoad(); }; });
      el.querySelectorAll("[data-ds-open]").forEach(function (b) { b.onclick = function () { openSettings(); }; });
      el.querySelectorAll("[data-ds-latest]").forEach(function (a) {
        a.onclick = function (e) { e.preventDefault(); AUTO.userPicked = false; state.shopify.snapshotId = AUTO.current.id; window.renderTab(activeTab); };
      });
    });
  }

  // ---- Data settings panel -------------------------------------
  function modal() { return document.getElementById("data-settings-modal"); }
  function isSettingsOpen() { var m = modal(); return !!(m && m.style.display === "flex"); }
  function openSettings(section) {
    var m = modal(); if (!m) return;
    m.style.display = "flex";
    render();
    if (loadConn() && !DI.busy) refresh();
    if (section) {
      var el = document.getElementById(section);
      var adv = document.getElementById("ds-advanced");
      if (el && adv && adv.contains(el)) adv.open = true;
      if (el) el.scrollIntoView({ block: "start" });
    }
  }
  function closeSettings() { var m = modal(); if (m) m.style.display = "none"; }
  window.SBDataSettings = { open: openSettings, close: closeSettings, refresh: autoLoad };

  async function refresh() {
    DI.busy = true; DI.error = null; render();
    try {
      var r = await api("/v1/reports");
      var h = await api("/v1/imports?limit=100");
      var hist = await api("/v1/reports?history=1");
      DI.reports = r.body.reports || [];
      DI.runs = h.body.imports || [];
      DI.history = hist.body.reports || [];
    } catch (e) { DI.error = e.message; DI.reports = null; DI.runs = null; DI.history = null; }
    DI.busy = false; render();
  }

  function render() {
    var root = document.getElementById("di-root");
    var advRoot = document.getElementById("di-advanced");
    if (!root) return;
    var c = loadConn();
    var main = [];
    var parts = [];   // Advanced settings

    main.push(sourcesPanel(c));
    if (c && DI.history) main.push(historyPanel());
    else if (c && DI.busy) main.push('<div class="panel small" id="ds-history-panel">Loading report history…</div>');

    parts.push(
      '<div class="panel" id="ds-connection"><div class="panel-h"><h2>Connection</h2>' +
      '<span class="small">' + (!c ? "Not connected — reports live only in this browser"
        : c.builtIn ? "Using the read-only connection built into this dashboard" : "Connected with a key saved in this browser") + "</span></div>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<input id="di-url" placeholder="https://sb-plant-breakdown.<account>.workers.dev" value="' + esc(c ? c.url : "") + '" style="flex:2;min-width:260px;padding:6px 8px;border:1px solid var(--border);border-radius:6px">' +
      // Masked, but deliberately NOT a password field: browser password
      // managers would otherwise offer to save the dashboard key with the site.
      '<input id="di-key" type="text" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" ' +
      'style="-webkit-text-security:disc" placeholder="Dashboard key" value="' + (savedConn() ? "••••••••" : "") + '">' +
      '<button id="di-connect">' + (savedConn() ? "Update" : "Connect") + "</button>" +
      (c ? '<button class="tab" id="di-refresh">Refresh</button>' : "") +
      (savedConn() ? '<button class="tab danger" id="di-disconnect">Forget this key</button>' : "") +
      "</div>" +
      '<div class="small" style="margin-top:6px">Normal viewing needs no key here when the dashboard was built with its read-only connection. ' +
      "Enter the <b>dashboard</b> key (never the collector key) to upload reports or change shared settings. It is kept in this browser only.</div>" +
      (DI.error ? '<div class="small" style="color:#b71c1c;margin-top:6px">' + esc(DI.error) + "</div>" : "") +
      (DI.busy ? '<div class="small" style="margin-top:6px">Loading…</div>' : "") +
      "</div>"
    );

    if (c && DI.reports) {
      // Only real problems are alerts here. Amazon is optional and uploaded by
      // hand, so having no Amazon report is not one.
      var st = window.sharedImportStatus(DI.reports, DI.runs, { staleDays: staleDays(), expect: ["shopify"],
        today: new Date().toISOString().slice(0, 10) });
      var alerts = st.alerts.filter(function (a) { return a.source === "shopify" || a.level === "error"; });
      if (alerts.length) {
        parts.push('<div class="panel" id="ds-alerts" style="border-color:#ffcc80;background:#fffaf2">' + alerts.map(function (a) {
          return '<div style="margin:2px 0">' + (a.level === "error" ? "⛔ " : "⚠ ") + esc(a.message) + "</div>";
        }).join("") + "</div>");
      }
      var superseded = window.sharedPickCurrent(DI.reports).superseded;
      parts.push('<div class="panel" id="ds-reports"><div class="panel-h"><h2>Reports in shared storage <span class="pill">' + DI.reports.length + "</span></h2>" +
        '<span class="small">Overlapping periods are kept as separate reports and are never added together.</span></div>' +
        '<div class="scroll" style="max-height:360px"><table><thead><tr><th>Source</th><th>Period</th><th>Report</th>' +
        '<th class="num">Rev.</th><th class="num">Rows</th><th class="num">Units</th><th class="num">Net / ordered sales</th>' +
        '<th>Imported</th><th></th></tr></thead><tbody>' +
        (DI.reports.map(function (r) {
          var local = snapshots.find(function (x) { return x.meta && x.meta.shared && x.meta.shared.reportId === r.id; });
          var info = r.source === "shopify" ? window.sharedPeriodInfo(r.period_start, r.period_end) : null;
          return "<tr><td>" + esc(r.source) + "</td><td>" + esc(r.period_start) + " → " + esc(r.period_end) +
            (info && info.partial ? ' <span class="badge type-other">partial</span>' : "") +
            (superseded.indexOf(r.id) >= 0 ? ' <span class="small">(superseded by a newer month-to-date)</span>' : "") + "</td>" +
            '<td class="small">' + esc(r.report_scope) + (r.has_product_id ? ' <span class="badge ok">product id</span>' : "") + "</td>" +
            '<td class="num">' + r.revision + '</td><td class="num">' + BUI.count(r.row_count) + '</td><td class="num">' + BUI.count(r.totals.units) +
            '</td><td class="num">' + (r.capabilities && r.capabilities.hasRevenue === false ? "—" : BUI.money(r.totals.net)) + "</td>" +
            '<td class="small">' + esc(when(r.imported_at)) + " · " + esc(r.imported_by) + "</td>" +
            "<td>" + (local ? '<span class="small">in this browser</span>'
                            : '<button class="tab" data-di-load="' + esc(r.id) + '">Load into this browser</button>') + "</td></tr>";
        }).join("") || '<tr><td colspan="9" class="empty">No reports yet.</td></tr>') + "</tbody></table></div></div>");

      parts.push('<div class="panel" id="ds-history"><div class="panel-h"><h2>Import history <span class="pill">' + DI.runs.length + "</span></h2></div>" +
        '<div class="scroll" style="max-height:320px"><table><thead><tr><th>When</th><th>Source</th><th>Period</th><th>By</th><th>Outcome</th>' +
        '<th class="num">Rows</th><th>Details</th></tr></thead><tbody>' +
        (DI.runs.map(function (r) {
          var cls = r.outcome === "succeeded" ? "up" : (r.outcome === "unchanged" ? "flat" : "down");
          return '<tr><td class="small">' + esc(when(r.started_at)) + "</td><td>" + esc(r.source) + "</td>" +
            '<td class="small">' + esc(r.period_start || "") + (r.period_end ? " → " + esc(r.period_end) : "") + "</td>" +
            '<td class="small">' + esc(r.imported_by) + '</td><td class="' + cls + '"><b>' + esc(r.outcome) + "</b></td>" +
            '<td class="num">' + (r.row_count == null ? "" : BUI.count(r.row_count)) + "</td>" +
            '<td class="small">' + esc(r.error_message || (r.revision ? "revision " + r.revision : "")) + "</td></tr>";
        }).join("") || '<tr><td colspan="7" class="empty">No imports yet.</td></tr>') + "</tbody></table></div></div>");
    }

    // Browser snapshots — always shown, connected or not.
    var local = snapshots.filter(function (s) { return (s.source === "shopify" || s.source === "amazon") && !s.isCatalog && !(s.meta && s.meta.ephemeral); });
    parts.push('<div class="panel" id="ds-browser"><div class="panel-h"><h2>Reports saved in this browser <span class="pill">' + local.length + "</span></h2>" +
      (c && local.length ? '<button class="tab" id="di-upload-all">Upload all to shared storage…</button>' : "") + "</div>" +
      '<div class="small" style="margin-bottom:6px">Automatic copies are refreshed from shared storage. Reports uploaded by hand stay in this browser until you upload them; ' +
      "uploading never deletes them here, and re-uploading an unchanged report writes nothing.</div>" +
      '<div class="scroll" style="max-height:320px"><table><thead><tr><th>Source</th><th>Report</th><th>Period</th><th class="num">Products</th>' +
      "<th>Shared?</th><th></th></tr></thead><tbody>" +
      (local.map(function (s) {
        var res = DI.results[s.id];
        var shared = s.meta && s.meta.shared;
        return "<tr><td>" + esc(s.source) + "</td><td>" + esc(s.label) + "</td><td class=\"small\">" + esc(s.startDate) + " → " + esc(s.endDate) + "</td>" +
          '<td class="num">' + BUI.count(s.products.length) + "</td>" +
          '<td class="small">' + (res ? esc(res) : s.meta && s.meta.auto && shared ? "automatic copy (rev. " + shared.revision + ")"
            : shared ? "loaded from shared (rev. " + shared.revision + ")" : "only here") + "</td>" +
          "<td>" + (c && !(s.meta && s.meta.auto) ? '<button class="tab" data-di-up="' + esc(s.id) + '">Upload</button>' : "") + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="empty">No reports saved in this browser.</td></tr>') + "</tbody></table></div></div>");

    if (c) {
      var vers = loadVers();
      parts.push('<div class="panel" id="ds-settings"><div class="panel-h"><h2>Shared settings</h2></div>' +
        '<div class="small" style="margin-bottom:6px">Hand-set classifications and confirmed Amazon column mappings, so every browser groups ' +
        "and reads files the same way. Pushing needs the dashboard key and refuses to overwrite a newer shared copy; pull first if it does.</div>" +
        '<table><tbody>' +
        settingRow("classification_overrides", "Classification overrides", Object.keys(window.SBOverrides.loadLocal()).length, vers,
          Object.keys(window.SBOverrides.loadShared()).length) +
        settingRow("amazon_column_mappings", "Amazon column mappings", Object.keys(window.SBAmazonMappings.load()).length, vers) +
        "</tbody></table></div>");
    }

    parts.push('<div class="panel" id="ds-collection"><div class="panel-h"><h2>Automatic collection</h2></div>' +
      '<div class="small">Shopify reports are collected automatically by the Windows collector (<code>collector/</code>), scheduled on a PC by ' +
      "<code>collector/windows/install-task.ps1</code>. Each run collects month-to-date (labelled <b>partial</b>) and, on the 2nd of each month, " +
      "the previous full month, using the store's calendar (" + STORE_TZ + "). Failed runs appear in the import history and above the analysis. " +
      "Amazon reports are uploaded by hand. A report is marked stale when its newest period ended more than " +
      '<input id="di-stale" type="number" min="1" max="90" value="' + staleDays() + '" style="width:50px"> days ago.</div></div>');

    root.innerHTML = main.join("");
    if (advRoot) advRoot.innerHTML = parts.join("");
    // Technical details stay folded away unless something needs them.
    var adv = document.getElementById("ds-advanced");
    if (adv && (!c || DI.error) && !adv._userToggled) adv.open = true;
    wire();
  }

  // ---- Data sources: what feeds the dashboard, in plain words ----------
  function sourcesPanel(c) {
    var col = AUTO.collection;
    var shop;
    if (!c) {
      shop = '<div><b>Shopify</b> · not connected in this browser</div>' +
        '<div class="small">Reports cannot load automatically here. <a href="#" data-ds-advanced>Set up the connection</a> under Advanced settings.</div>';
    } else if (AUTO.status === "offline" || DI.error) {
      shop = '<div><b>Shopify</b> · could not reach saved reports just now</div>' +
        '<div class="small">The last saved analysis stays on screen. Try Refresh; details are under Advanced settings.</div>';
    } else {
      shop = '<div><b>Shopify connected</b> · Updates automatically</div>' +
        '<div class="small">Last updated ' + (col && col.lastSuccessAt ? esc(when(col.lastSuccessAt)) : "—") +
        (col && col.failure ? ' · <span style="color:#b71c1c">the last automatic collection failed (' + esc(when(col.failureAt)) +
          '); see Advanced settings → Troubleshooting</span>' : "") + "</div>";
    }
    var az = (DI.reports || AUTO.reports || []).filter(function (r) { return r.source === "amazon"; });
    var latestAz = az.slice().sort(function (a, b) { return b.period_end.localeCompare(a.period_end); })[0];
    var amazon = az.length
      ? '<div><b>Amazon</b> · ' + az.length + " report" + (az.length === 1 ? "" : "s") + ", latest " +
        esc(window.periodRangeText(latestAz.period_start, latestAz.period_end)) + '</div><div class="small">Uploaded by hand</div>'
      : '<div><b>Amazon</b></div><div class="small" style="color:var(--muted)">No Amazon reports yet</div>';
    var mk = (DI.reports || AUTO.reports || []).filter(function (r) { return r.source === "market"; });
    var latestMk = mk.slice().sort(function (a, b) { return b.period_end.localeCompare(a.period_end); })[0];
    var market = mk.length
      ? '<div><b>Market (ShipStation)</b> · Updates automatically</div><div class="small">' + mk.length + " period" + (mk.length === 1 ? "" : "s") +
        ", latest " + esc(window.periodRangeText(latestMk.period_start, latestMk.period_end)) +
        " · Product Sales report, other stores only (Succulents Box stores left out)</div>"
      : '<div><b>Market (ShipStation)</b></div><div class="small" style="color:var(--muted)">No market data yet; it is collected with Shopify once the collector is set up for ShipStation</div>';
    // The latest market collection failed after the last success (for example
    // the collector's ShipStation sign-in ran out): say so plainly.
    var mf = AUTO.marketCollection && AUTO.marketCollection.failure;
    if (mf) {
      var signIn = /sign[\s-]?in|login|captcha/i.test((mf.error_code || "") + " " + (mf.error_message || ""));
      market += '<div class="small" style="color:#8a5a00">' + (signIn
        ? "ShipStation sign-in needed on the collector PC (<code>npm run login:shipstation</code>). The last market data stays in place."
        : "Latest market collection failed: " + esc(mf.error_message || mf.error_code || "unknown error") + ". The last market data stays in place.") + "</div>";
    }
    return '<div class="panel" id="ds-sources"><div class="panel-h"><h2>Data sources</h2></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<div>' + shop + "</div>" + (c ? '<button class="tab" id="ds-src-refresh">Refresh</button>' : "") + "</div>" +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<div>' + market + "</div></div>" +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0">' +
        '<div>' + amazon + '</div><button class="tab" data-upload="amazon">Upload Amazon report</button></div></div>';
  }

  // ---- report history: every revision, coverage, gaps, downloads ----
  function historyPanel() {
    var hist = DI.history || [];
    var cov = ["shopify", "market", "amazon"].map(function (src) {
      var auth = window.periodAuthoritativeMonths(DI.reports || [], { source: src, scope: src === "market" ? window.MARKET_SCOPE : undefined });
      var av = window.periodAvailability(auth, {});
      return "<b>" + src + "</b>: " + (av.earliest
        ? "history from " + esc(av.earliest) + " to " + esc(av.latest) +
          (av.gaps.length ? ' · <span style="color:#8a5a00">no report for ' + av.gaps.map(esc).join(", ") + "</span>" : " · no gaps")
        : "no monthly reports yet") +
        (auth.ignored.length ? ' · <span class="small">' + auth.ignored.length + " non-monthly or overlapping report(s) kept separate</span>" : "");
    }).join("<br>");
    var filter = DI.histFilter || "shopify";
    var rows = hist.filter(function (r) { return filter === "all" || r.source === filter; });
    return '<div class="panel" id="ds-history-panel"><div class="panel-h"><h2>Report history <span class="pill">' + hist.length + " revision" + (hist.length === 1 ? "" : "s") + "</span></h2>" +
      '<select id="ds-hist-filter"><option value="shopify"' + (filter === "shopify" ? " selected" : "") + '>Shopify</option>' +
      '<option value="amazon"' + (filter === "amazon" ? " selected" : "") + '>Amazon</option><option value="market"' + (filter === "market" ? " selected" : "") + '>Market (ShipStation)</option><option value="all"' + (filter === "all" ? " selected" : "") + ">All</option></select></div>" +
      '<div class="small" style="margin-bottom:6px">' + cov + "<br>Every revision is kept. The active revision is used by default; earlier ones can be opened or downloaded. " +
      "Sales period dates are the store's calendar; collected and imported are when the data was fetched and saved.</div>" +
      '<div class="scroll" style="max-height:380px"><table><thead><tr><th>Source</th><th>Sales period</th><th>Status</th><th class="num">Rev.</th>' +
      '<th>Collected</th><th>Imported</th><th>TZ · currency</th><th class="num">Included net</th><th class="num">Excluded net</th><th class="num">Rows</th><th></th></tr></thead><tbody>' +
      (rows.map(function (r) {
        var incl = r.includedTotals ? BUI.money(r.includedTotals.net) : (r.totals && r.capabilities && r.capabilities.hasRevenue === false ? "—" : BUI.money(r.totals.net));
        return "<tr" + (r.status === "superseded" ? ' style="opacity:.7"' : "") + "><td>" + esc(r.source) + "</td>" +
          "<td>" + esc(window.periodRangeText(r.period_start, r.period_end)) + "</td>" +
          "<td>" + (completenessOf(r) === "complete" ? '<span class="badge ok">complete</span>' : '<span class="badge type-other">partial</span>') +
          (r.status === "superseded" ? ' <span class="small">superseded</span>' : ' <span class="small"><b>active</b></span>') + "</td>" +
          '<td class="num">' + r.revision + "</td>" +
          '<td class="small">' + esc(when(r.collected_at)) + "</td>" +
          '<td class="small">' + esc(when(r.activated_at || r.imported_at)) + " · " + esc(r.imported_by) + "</td>" +
          '<td class="small">' + esc(r.timezone) + " · " + esc(r.currency) + "</td>" +
          '<td class="num">' + incl + (r.includedTotals ? "" : ' <span class="small" title="No exclusion split was recorded at import">(all)</span>') + "</td>" +
          '<td class="num">' + (r.excludedTotals ? BUI.money(r.excludedTotals.net) : "—") + "</td>" +
          '<td class="num">' + BUI.count(r.row_count) + "</td>" +
          '<td style="white-space:nowrap"><button class="tab" data-hist-dl="' + esc(r.id) + '">⬇ CSV</button> ' +
          '<button class="tab" data-hist-open="' + esc(r.id) + '">Open</button></td></tr>';
      }).join("") || '<tr><td colspan="11" class="empty">No reports yet.</td></tr>') + "</tbody></table></div></div>";
  }

  // Reports stored before the Worker recorded completeness: a month-to-date
  // slice is partial; otherwise complete if it was imported after the period
  // ended (store date approximated conservatively as UTC − 8 h).
  function completenessOf(r) {
    if (r.completeness) return r.completeness;
    if (window.sharedPeriodInfo(r.period_start, r.period_end).kind === "month_to_date") return "partial";
    var d = new Date(Date.parse(r.imported_at) - 8 * 3600000).toISOString().slice(0, 10);
    return d > r.period_end ? "complete" : "partial";
  }
  function csvCell(v) { var t = v == null ? "" : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
  async function downloadRevision(id) {
    var rep = (DI.history || []).filter(function (r) { return r.id === id; })[0];
    if (!rep) return;
    try {
      var rows = await fetchRows(rep);
      var M = ["units", "gross", "disc", "ret", "net", "tax", "total"];
      var lines = [
        ["# Source", rep.source], ["# Report", rep.report_scope], ["# Sales period", rep.period_start + " to " + rep.period_end],
        ["# Status", completenessOf(rep)], ["# Revision", rep.revision + (rep.status === "superseded" ? " (superseded)" : " (active)")],
        ["# Collected", rep.collected_at || ""], ["# Imported", rep.activated_at || rep.imported_at],
        ["# Timezone", rep.timezone], ["# Currency", rep.currency], []
      ].map(function (r) { return r.map(csvCell).join(","); });
      var head = ["product_id", "asin", "title", "vendor", "product_type", "sales_channel"].concat(M, ["glance_views", "inventory"], M.map(function (k) { return "prior_" + k; }));
      lines.push(head.join(","));
      rows.forEach(function (r) {
        lines.push([r.productId, r.asin, r.title, r.vendor, r.productType, r.salesChannel]
          .concat(M.map(function (k) { return r.cur[k]; }), [r.cur.glance, r.cur.inv], M.map(function (k) { return r.prior ? r.prior[k] : ""; }))
          .map(csvCell).join(","));
      });
      var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = rep.source + "_" + rep.period_start + "_" + rep.period_end + "_r" + rep.revision + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    } catch (e) { alert("Could not download: " + e.message); }
  }
  // Opens one stored revision on its own (for inspection). Earlier revisions
  // get their own id, so they never replace the active copy.
  async function openRevision(id) {
    var rep = (DI.history || []).filter(function (r) { return r.id === id; })[0];
    if (!rep) return;
    try {
      var snap = buildSnapshot(rep, await fetchRows(rep));
      snap.meta.ephemeral = true;
      if (rep.status === "superseded") { snap.id += "_r" + rep.revision; snap.label += " · revision " + rep.revision + " (superseded)"; }
      else snap.id += "_view";
      snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
      snapshots.push(snap);
      var src = snap.source === "amazon" ? "amazon" : "shopify";
      state[src].snapshotId = snap.id; state[src].mode = "single";
      if (src === "shopify") AUTO.userPicked = true;
      if (window.SBPeriodView) window.SBPeriodView.noteIndividual(src);
      closeSettings();
      if (typeof window.switchTab === "function") window.switchTab(src); else window.renderTab(src);
    } catch (e) { alert("Could not open the report: " + e.message); }
  }

  function settingRow(key, label, localCount, vers, sharedCount) {
    return "<tr><td><b>" + label + "</b></td><td class=\"small\">" +
      (sharedCount != null ? sharedCount + " confirmed (shared, applied automatically) · " + localCount + " unconfirmed in this browser · " : localCount + " in this browser · ") +
      (vers[key] ? "shared version " + vers[key] : "not synced yet") + "</td>" +
      '<td><button class="tab" data-di-push="' + key + '">Push to shared</button> ' +
      '<button class="tab" data-di-pull="' + key + '">Pull from shared</button>' +
      (key === "classification_overrides" ? ' <button class="tab" data-di-export-ov="1">Download for review</button>' : "") + "</td>" +
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
      var snap = buildSnapshot(rep, await fetchRows(rep));
      var existing = snapshots.find(function (x) { return x.id === snap.id; });
      if (existing && !(existing.meta && existing.meta.auto) &&
          !confirm("This browser already has “" + existing.label + "”. Replace it with the shared copy (revision " +
                   rep.revision + ")? Make a backup first under Backup if unsure.")) return;
      snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
      snapshots.push(snap);
      window.saveSnapshots();
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
    // Classification: the shared corrections plus this browser's changes, so
    // a push never drops a correction someone else confirmed.
    var value = key === "classification_overrides"
      ? Object.assign({}, window.SBOverrides.loadShared(), window.SBOverrides.loadLocal())
      : window.SBAmazonMappings.load();
    var vers = loadVers();
    try {
      var r = await api("/v1/settings/" + key, { method: "PUT", body: { value: value, baseVersion: vers[key] || 0, updatedBy: "dashboard" } });
      if (r.status === 409) {
        DI.results["set:" + key] = "Shared copy is newer (version " + r.body.currentVersion + "). Pull first, then push.";
      } else if (r.body.ok) {
        vers[key] = r.body.version; saveVers(vers);
        if (key === "classification_overrides") { window.SBOverrides.setShared(value, r.body.version); window.SBOverrides.save({}); }
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
      if (key === "classification_overrides") { window.SBOverrides.setShared(s.value, s.version); window.SBOverrides.save({}); }
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
      var old = savedConn();
      if (/^•+$/.test(key) && old) key = old.key;
      if (!/^https?:\/\//.test(url)) { DI.error = "Enter the full address, starting with https://"; render(); return; }
      if (key.length < 32) { DI.error = "That key is too short to be a dashboard key."; render(); return; }
      saveConn({ url: url, key: key }); refresh(); autoLoad();
    };
    if (g("di-refresh")) g("di-refresh").onclick = function () { refresh(); autoLoad(); };
    if (g("di-disconnect")) g("di-disconnect").onclick = function () {
      if (!confirm("Forget the key saved in this browser? Nothing is deleted anywhere." +
                   (builtInConn() ? " The dashboard falls back to its built-in read-only connection." : ""))) return;
      saveConn(null); DI.reports = null; DI.runs = null; render(); autoLoad();
    };
    if (g("di-stale")) g("di-stale").onchange = function (e) {
      try { localStorage.setItem(STALE_KEY, String(Math.max(1, parseInt(e.target.value, 10) || 10))); } catch (x) {}
      render();
    };
    if (g("di-upload-all")) g("di-upload-all").onclick = async function () {
      var ids = snapshots.filter(function (s) { return (s.source === "shopify" || s.source === "amazon") && !s.isCatalog && !(s.meta && s.meta.auto); })
        .map(function (s) { return s.id; });
      if (!confirm("Upload " + ids.length + " report(s) from this browser to shared storage? They stay in this browser too.")) return;
      for (var i = 0; i < ids.length; i++) await upload(ids[i]);
    };
    document.querySelectorAll("[data-di-up]").forEach(function (b) { b.onclick = function () { upload(b.getAttribute("data-di-up")); }; });
    document.querySelectorAll("[data-di-load]").forEach(function (b) { b.onclick = function () { loadShared(b.getAttribute("data-di-load")); }; });
    document.querySelectorAll("[data-di-push]").forEach(function (b) { b.onclick = function () { pushSetting(b.getAttribute("data-di-push")); }; });
    document.querySelectorAll("[data-di-pull]").forEach(function (b) { b.onclick = function () { pullSetting(b.getAttribute("data-di-pull")); }; });
    document.querySelectorAll("[data-di-export-ov]").forEach(function (b) { b.onclick = function () {
      var blob = new Blob([JSON.stringify(window.SBOverrides.exportForReview(), null, 2)], { type: "application/json" });
      var u = URL.createObjectURL(blob), el = document.createElement("a");
      el.href = u; el.download = "classification-overrides-for-review.json"; document.body.appendChild(el); el.click();
      setTimeout(function () { URL.revokeObjectURL(u); el.remove(); }, 0);
    }; });
    document.querySelectorAll("[data-hist-dl]").forEach(function (b) { b.onclick = function () { downloadRevision(b.getAttribute("data-hist-dl")); }; });
    document.querySelectorAll("[data-hist-open]").forEach(function (b) { b.onclick = function () { openRevision(b.getAttribute("data-hist-open")); }; });
    if (g("ds-src-refresh")) g("ds-src-refresh").onclick = function () { refresh(); autoLoad(); };
    document.querySelectorAll("[data-ds-advanced]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); var d = g("ds-advanced"); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } };
    });
    if (g("ds-hist-filter")) g("ds-hist-filter").onchange = function (e) { DI.histFilter = e.target.value; render(); };
  }

  // ---- hooks into the existing app ------------------------------
  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (source === "data") { openSettings(); return; }   // old tab name: open the panel instead
    var r = origRenderTab(source);
    if (source === "shopify" || source === "vendors") renderStatus();
    return r;
  };

  function wireShell() {
    var btn = document.getElementById("data-settings-btn");
    if (btn) btn.onclick = function () { openSettings(); };
    var close = document.getElementById("data-settings-close");
    if (close) close.onclick = closeSettings;
    var m = modal();
    if (m) m.addEventListener("click", function (e) { if (e.target === m) closeSettings(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isSettingsOpen()) closeSettings(); });
    document.querySelectorAll("[data-open-settings]").forEach(function (b) {
      b.addEventListener("click", function () { openSettings(b.getAttribute("data-open-settings") || null); });
    });
    // "Upload Amazon report" buttons open the file picker directly.
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest('[data-upload="amazon"]');
      if (!b) return;
      e.preventDefault();
      var fi = document.getElementById("amazon-file-input");
      if (fi) fi.click();
    });
    var adv = document.getElementById("ds-advanced");
    if (adv) adv.addEventListener("toggle", function () { adv._userToggled = true; });
    var ds = document.getElementById("ds-refresh-now");
    if (ds) ds.onclick = function () { autoLoad(); refresh(); };
    // A report picked by hand stays picked until the person asks for the latest.
    var sel = document.getElementById("shopify-snap-select");
    if (sel) sel.addEventListener("change", function () {
      AUTO.userPicked = true;
      if (window.SBPeriodView) window.SBPeriodView.noteIndividual("shopify");
      renderStatus();
    });
    // A file uploaded by hand becomes the report on screen; the strip says so.
    var origAdd = window.addSnapshot;
    if (typeof origAdd === "function" && !origAdd._dsWrapped) {
      window.addSnapshot = function () { var r = origAdd.apply(this, arguments); AUTO.userPicked = true; renderStatus(); return r; };
      window.addSnapshot._dsWrapped = true;
    }
  }

  function start() {
    wireShell();
    renderStatus();
    autoLoad();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(start, 0); });
  else setTimeout(start, 0);
})();
