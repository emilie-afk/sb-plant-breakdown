// ============================================================
// market-view.js
// Market data on the comparison tabs.
//
//   External Stores has its OWN period picker (market-period.js): Saved
//   reports · Week (Sat–Fri) · Month · Quarter · Year · Match Shopify period.
//   It opens on the latest saved market report and states its exact dates and
//   collection time. A period without a report says what is missing and offers
//   the saved reports instead; nothing is prorated or estimated. Market
//   collections that failed and were not redone stay listed whatever is picked.
//
//   Opportunity Map and Owned vs Market follow the Shopify period on screen
//   (market data for exactly the same dates). Cross-channel, Opportunity Map
//   and Owned vs Market show a combined comparison only when every report
//   picked has the same dates; otherwise each report's dates are shown and
//   the comparison is withheld.
// Nothing is uploaded; nothing here writes to shared storage.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab */
  var MV = { builtFor: null, busy: false, manual: { oppmap: false, ovm: false, cross: false }, lastShopify: null, note: {},
             ext: { sel: null, plan: null, loader: null, lastSet: null, manualSnapshot: false } };
  window.SBMarketView = MV;
  var TABS = ["oppmap", "ovm", "cross", "external"];
  var KINDS = [["saved", "Saved reports"], ["week", "Week (Sat–Fri)"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"], ["match", "Match Shopify period"]];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function range(a, b) { return window.periodRangeText ? window.periodRangeText(a, b) : a + " – " + b; }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : "—"; }
  function money(v) { return "$" + (+v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function shopifySnap() { return snapshots.filter(function (s) { return s.id === state.shopify.snapshotId; })[0] || null; }
  function storeToday() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function reports() { return (window.SBAutoLoad && window.SBAutoLoad.reports) || []; }
  function failures() { return (window.SBAutoLoad && window.SBAutoLoad.marketFailures) || []; }
  function shopInfo(shop) {
    if (!shop) return null;
    var p = shop.meta && shop.meta.period;
    return { start: shop.startDate, end: shop.endDate, period: p && p.revisionsUsed ? p : null };
  }

  // ---- building a market snapshot from a plan --------------------------
  // Same shape as an uploaded External Stores snapshot, rebuilt from shared
  // storage (never saved in the browser).
  async function snapshotFor(plan, idPrefix) {
    var id = idPrefix + plan.sig.replace(/[^A-Za-z0-9:_-]/g, "_");
    var existing = snapshots.filter(function (s) { return s.id === id; })[0];
    if (existing && existing.meta && existing.meta.sig === plan.sig) return existing;
    var parts = [];
    for (var i = 0; i < plan.used.length; i++) {
      var rows = await window.SBShared.fetchRows(plan.used[i].report);
      parts.push(window.marketExternalSnapshotFromShared(plan.used[i].report, rows, { legacyGenus: window.legacyGenus, detectGenus: window.detectGenus }).products);
    }
    var cov = plan.coverage || { start: plan.used[0].start, end: plan.used[plan.used.length - 1].end };
    var snap = {
      id: id, source: "external",
      label: plan.label + " · ShipStation market (automatic)",
      startDate: cov.start, endDate: cov.end, fileName: "(ShipStation Product Sales, shared storage)",
      uploadedAt: plan.collectedAt,
      products: window.marketMergeProducts(parts),
      meta: { auto: true, ephemeral: true, market: true, sig: plan.sig, revenueIsActual: true, ownStoresExcluded: true,
              collectedAt: plan.collectedAt, current: { start: cov.start, end: cov.end }, zeroSales: plan.zeroSales,
              monthsUsed: plan.used.map(function (u) { return { start: u.start, end: u.end, revision: u.revision }; }) }
    };
    snapshots = snapshots.filter(function (s) { return s.id !== id; });
    snapshots.push(snap);
    return snap;
  }

  // ---- Opportunity Map / Owned vs Market follow the Shopify period --------
  async function marketFor(shop) {
    var plan = window.marketPlan({ kind: "match" }, reports(), { today: storeToday(), shopify: shopInfo(shop) });
    if (!plan.used.length) return { snap: null, reason: plan.reason };
    return { snap: await snapshotFor(plan, "external_market_") };
  }
  function amazonFor(shop) {
    return snapshots.filter(function (s) { return s.source === "amazon" && !s.isCatalog && s.startDate === shop.startDate && s.endDate === shop.endDate; })[0] || null;
  }
  async function sync() {
    var shop = shopifySnap();
    if (!shop || !window.SBShared) return;
    if (MV.lastShopify !== shop.id) { MV.lastShopify = shop.id; ["oppmap", "ovm", "cross"].forEach(function (t) { MV.manual[t] = false; }); }
    if (MV.busy) return;
    MV.busy = true;
    try {
      var m = await marketFor(shop);
      var az = amazonFor(shop);
      MV.note = { shop: shop, market: m.snap, marketReason: m.reason || null, amazon: az };
      if (!MV.manual.oppmap) { state.oppmap.shopifyId = shop.id; state.oppmap.externalId = m.snap ? m.snap.id : null; state.oppmap.amazonId = az ? az.id : null; }
      if (!MV.manual.ovm) { state.ovm.shopifyId = shop.id; state.ovm.externalId = m.snap ? m.snap.id : null; state.ovm.amazonId = az ? az.id : null; }
      if (!MV.manual.cross) { state.cross.shopifyId = shop.id; state.cross.amazonId = az ? az.id : null; }
    } catch (e) {
      MV.note = { shop: shop, marketReason: "Could not load market data: " + e.message };
    }
    MV.busy = false;
  }

  // The reports picked on a comparison tab, and whether their dates line up.
  function picked(tab) {
    var sel = tab === "cross" ? { sh: state.cross.shopifyId, am: state.cross.amazonId }
      : { sh: state[tab].shopifyId, am: state[tab].amazonId, ex: state[tab].externalId };
    var get = function (id) { return id ? snapshots.filter(function (s) { return s.id === id; })[0] : null; };
    return [["Shopify", get(sel.sh)], ["Amazon", get(sel.am)], ["Market", get(sel.ex)]]
      .filter(function (x) { return x[1]; })
      .map(function (x) { return { source: x[0], start: x[1].startDate, end: x[1].endDate }; });
  }
  function noteHtml(tab) {
    var n = MV.note || {};
    var chk = window.marketSameDates(picked(tab));
    var parts = [];
    if (!chk.same) {
      parts.push('<b style="color:#b71c1c">⚠ Dates differ — combined comparison withheld.</b>');
      chk.ranges.forEach(function (r) { parts.push(esc(r.source) + ": " + esc(r.range)); });
      parts.push("Pick reports with the same dates, or re-select the Shopify period to line them up again. Nothing is compared across different dates.");
    } else if (n.shop) {
      var shp = n.shop;
      parts.push("<b>Period:</b> " + esc(range(shp.startDate, shp.endDate)) + " (the Shopify period on screen)");
      if (tab !== "cross") {
        parts.push(n.market ? "Market: ShipStation Product Sales for the same dates · actual item revenue · Succulents Box's own stores left out"
          : '<span style="color:#8a5a00">Market: ' + esc(n.marketReason || "no market data for this period") + " Nothing is compared against a different period.</span>");
      }
      parts.push(n.amazon ? "Amazon: report for the same dates"
        : '<span style="color:#8a5a00">Amazon: no Amazon report for exactly these dates, so the Amazon side is left empty (not zero sales).</span>');
    }
    return { html: parts.join("<br>"), withheld: !chk.same };
  }
  function placeNote(tab) {
    var panel = document.getElementById("tab-" + tab);
    if (!panel) return;
    var el = document.getElementById("period-note-" + tab);
    if (!el) {
      el = document.createElement("div");
      el.id = "period-note-" + tab;
      el.className = "panel small";
      el.style.cssText = "padding:10px 14px;margin-bottom:12px";
      panel.insertBefore(el, panel.firstChild);
    }
    var r = noteHtml(tab);
    el.style.display = r.html ? "block" : "none";
    el.innerHTML = r.html;
    // Different dates: hide the combined figures rather than show a mismatched comparison.
    if (r.withheld) {
      ["content", "empty", "banner"].forEach(function (k) { var x = document.getElementById(tab + "-" + k); if (x) x.style.display = "none"; });
    } else {
      var b = document.getElementById(tab + "-banner"); if (b) b.style.display = "";   // content/empty are set by each render
    }
  }

  // ---- External Stores: its own period ----------------------------------
  // Until a person picks, External Stores follows the latest saved market report.
  function extSel() {
    if (!MV.ext.userPicked || !MV.ext.sel) MV.ext.sel = window.marketDefaultSelection(reports());
    return MV.ext.sel;
  }
  function extPlan() {
    return window.marketPlan(extSel(), reports(), { today: storeToday(), shopify: shopInfo(shopifySnap()) });
  }
  function monthsSpan() {
    var c = window.marketCatalog(reports());
    var today = storeToday();
    var first = c.length ? c.map(function (e) { return e.start; }).sort()[0].slice(0, 7) : today.slice(0, 7);
    var out = [];
    for (var k = today.slice(0, 7); k >= first; k = window.periodAddMonths(k, -1)) out.push(k);
    return out;
  }
  function optionsFor(kind, sel) {
    var reps = reports();
    if (kind === "saved") {
      return window.marketCatalog(reps).map(function (e) {
        return [e.id, e.range + " · " + e.kindLabel + " · collected " + when(e.collectedAt), sel.kind === "saved" && sel.reportId === e.id];
      });
    }
    if (kind === "week") {
      return window.marketWeekOptions(reps, { today: storeToday() }).map(function (w) {
        return [w.start, w.label, sel.kind === "week" && window.marketWeekOf(sel.start).start === w.start];
      });
    }
    var months = monthsSpan();
    if (kind === "month") {
      return months.map(function (k) {
        var y = +k.slice(0, 4), i = +k.slice(5, 7);
        var p = window.marketPlan({ kind: "month", year: y, index: i }, reps, { today: storeToday() });
        var note = p.status === "missing" ? " — no monthly report" : p.status === "complete" ? "" : p.status === "to_date" ? " — month to date" : " — partial";
        return [y + "-" + i, MONTHS[i - 1] + " " + y + note, sel.kind === "month" && sel.year === y && sel.index === i];
      });
    }
    if (kind === "quarter") {
      var qs = [];
      months.forEach(function (k) { var q = k.slice(0, 4) + "-" + (Math.floor((+k.slice(5, 7) - 1) / 3) + 1); if (qs.indexOf(q) < 0) qs.push(q); });
      return qs.map(function (q) {
        var y = +q.slice(0, 4), i = +q.slice(5);
        var p = window.marketPlan({ kind: "quarter", year: y, index: i }, reps, { today: storeToday() });
        var note = p.status === "complete" ? "" : p.status === "to_date" ? " — quarter to date" : p.status === "missing" ? " — no complete month" : " — partial";
        return [y + "-" + i, "Q" + i + " " + y + " (" + ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][i - 1] + ")" + note, sel.kind === "quarter" && sel.year === y && sel.index === i];
      });
    }
    if (kind === "year") {
      var ys = [];
      months.forEach(function (k) { var y = +k.slice(0, 4); if (ys.indexOf(y) < 0) ys.push(y); });
      return ys.map(function (y) {
        var p = window.marketPlan({ kind: "year", year: y }, reps, { today: storeToday() });
        var note = p.status === "complete" ? "" : p.status === "to_date" ? " — year to date" : p.status === "missing" ? " — no complete month" : " — partial";
        return [String(y), y + note, sel.kind === "year" && sel.year === y];
      });
    }
    return [];
  }
  // The first choice when a person switches kind: the latest one that has data.
  function defaultFor(kind) {
    var reps = reports(), today = storeToday();
    if (kind === "saved") return window.marketDefaultSelection(reps);
    if (kind === "match") return { kind: "match" };
    if (kind === "week") {
      var w = window.marketWeekOptions(reps, { today: today });
      var hit = w.filter(function (x) { return x.report; })[0] || w[0];
      return { kind: "week", start: hit.start };
    }
    var opts = optionsFor(kind, {});
    var best = opts.filter(function (o) { return !/no monthly report|no complete month/.test(o[1]); })[0] || opts[0];
    var v = best[0].split("-");
    return kind === "year" ? { kind: "year", year: +v[0] } : { kind: kind, year: +v[0], index: +v[1] };
  }

  function barHtml(plan) {
    var sel = extSel() || { kind: "saved" };
    var reps = reports();
    if (!window.marketCatalog(reps).length) {
      var f0 = failures();
      return '<span class="small">No market (ShipStation) report has been saved in shared storage yet.</span>' + failureHtml(f0);
    }
    var h = '<label>Market period</label><select data-mk-kind>' +
      KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (sel.kind === k[0] ? " selected" : "") + ">" + esc(k[1]) + "</option>"; }).join("") + "</select>";
    if (sel.kind !== "match") {
      h += '<select data-mk-which style="max-width:100%">' + optionsFor(sel.kind, sel).map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (o[2] ? " selected" : "") + ">" + esc(o[1]) + "</option>";
      }).join("") + "</select>";
    }
    var ls = extLoader().state();
    if (ls.status === "loading" && ls.sig === plan.sig) h += ' <span class="small">Loading…</span>';
    if (MV.ext.manualSnapshot) {
      h += ' <button class="tab" data-mk-apply>Show this market period</button> <span class="small">(a report picked in the Snapshot list is on screen)</span>';
    }
    var notes = [];
    if (ls.status === "failed" && ls.sig === plan.sig && !MV.ext.manualSnapshot) {
      // Not retried automatically: the error stays until Retry or another period is picked.
      notes.push('<span id="external-load-error" style="color:#b71c1c">⛔ Could not load market data for this period: ' + esc(String(ls.error).replace(/\.+$/, "")) +
        (ls.attempts > 1 ? " (attempt " + ls.attempts + ")" : "") + '. Nothing is shown in its place; it is not retried automatically.</span> <button class="tab" data-mk-retry>Retry</button>');
    }
    if (plan.used.length) {
      notes.push("<b>" + (state.external.snapshotId ? "Showing" : "Selected") + ":</b> " + esc(plan.label));
      notes.push("<b>Exact dates:</b> " + plan.used.map(function (u) {
        return esc(range(u.start, u.end)) + " (" + esc(window.marketReportKind(u.start, u.end).replace(/_/g, " ")) + ", rev. " + esc(u.revision) + ", collected " + esc(when(u.collectedAt)) + ")";
      }).join(" · "));
      if (plan.reported) {
        notes.push(plan.zeroSales
          ? '<b>Reported zero:</b> ShipStation reported no product sales for these dates (the report exists; this is not missing data).'
          : "<b>Reported:</b> " + money(plan.reported.net) + " product sales · " + plan.reported.units.toLocaleString("en-US") + " units · Succulents Box's own stores and discount adjustments left out");
      }
      if (plan.missing && plan.missing.length) {
        notes.push('<span style="color:#8a5a00"><b>Not covered:</b> ' + plan.missing.map(function (m) { return esc(range(m.start, m.end)); }).join(", ") +
          " — no complete report, so left out (not zero, not estimated).</span>");
      }
    }
    if (plan.excluded && plan.excluded.length) {
      notes.push('<span class="small"><b>Saved but not added:</b><br>' + plan.excluded.map(function (x) {
        return '<a href="#" data-mk-open="' + esc(x.reportId) + '">' + esc(range(x.start, x.end)) + "</a> — " + esc(x.reason);
      }).join("<br>") + "</span>");
    }
    if (sel.kind === "match") {
      var shop = shopifySnap();
      notes.push('<span class="small">Follows the Shopify period on screen' + (shop ? " (" + esc(range(shop.startDate, shop.endDate)) + ")" : "") + ".</span>");
    }
    return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%">' + h + "</div>" +
      '<div class="small" style="width:100%;display:flex;flex-direction:column;gap:3px;margin-top:6px">' +
      notes.map(function (n) { return "<div>" + n + "</div>"; }).join("") + "</div>" +
      failureHtml(failures()) + (plan.used.length ? "" : missingHtml(plan));
  }
  function failureHtml(list) {
    if (!list || !list.length) return "";
    return '<div class="small" id="external-collection-failures" style="margin-top:6px;color:#b71c1c">' + list.map(function (f) {
      var signIn = /sign[\s_-]?in|login|captcha/i.test((f.code || "") + " " + (f.message || ""));
      return "⛔ <b>Market collection failed</b> for " + esc(f.start ? range(f.start, f.end) : "a period") + " (" + esc(when(f.at)) + "): " +
        esc(signIn ? "ShipStation sign-in needed on the collector PC" : (f.code || "error").replace(/_/g, " ")) +
        ". Not collected since — these dates are missing, not zero.";
    }).join("<br>") + "</div>";
  }
  function missingHtml(plan) {
    var alts = plan.alternatives || [];
    return '<div id="external-period-missing" style="margin-top:10px;padding:12px 14px;border:1px dashed #e0a060;border-radius:8px;background:#fffaf2">' +
      '<div style="font-weight:600;color:#8a5a00;margin-bottom:4px">No market data shown for ' + esc(plan.name || "this period") + "</div>" +
      '<div class="small">' + esc(plan.reason || "No saved market report covers these dates.") + "</div>" +
      (alts.length ? '<div class="small" style="margin-top:8px"><b>Saved market reports you can open:</b></div><div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">' +
        alts.map(function (a) { return '<button class="tab" data-mk-open="' + esc(a.id) + '">' + esc(a.range + " · " + a.kindLabel) + "</button>"; }).join("") + "</div>" : "") +
      "</div>";
  }
  function placeBar(plan) {
    var panel = document.getElementById("tab-external");
    if (!panel) return;
    var el = document.getElementById("external-period");
    if (!el) {
      el = document.createElement("div");
      el.id = "external-period";
      el.className = "panel small";
      el.style.cssText = "padding:10px 14px;margin-bottom:12px";
      panel.insertBefore(el, panel.firstChild);
    }
    el.innerHTML = barHtml(plan);
    var k = el.querySelector("[data-mk-kind]");
    if (k) k.onchange = function () { choose(defaultFor(k.value)); };
    var w = el.querySelector("[data-mk-which]");
    if (w) w.onchange = function () {
      var kind = (extSel() || {}).kind, v = w.value;
      if (kind === "saved") choose({ kind: "saved", reportId: v });
      else if (kind === "week") choose({ kind: "week", start: v });
      else if (kind === "year") choose({ kind: "year", year: +v });
      else { var p = v.split("-"); choose({ kind: kind, year: +p[0], index: +p[1] }); }
    };
    el.querySelectorAll("[data-mk-open]").forEach(function (b) {
      b.onclick = function (e) { e.preventDefault(); choose({ kind: "saved", reportId: b.getAttribute("data-mk-open") }); };
    });
    var rt = el.querySelector("[data-mk-retry]");
    if (rt) rt.onclick = function () { extLoader().retry(MV.ext.plan, loaded); window.renderTab("external"); };
    var a = el.querySelector("[data-mk-apply]");
    if (a) a.onclick = function () { choose(extSel()); };
  }
  function choose(sel) {
    MV.ext.sel = sel; MV.ext.userPicked = true; MV.ext.manualSnapshot = false;
    extLoader().reset();                                   // a new selection may try again
    state.external.drillGenus = null; state.external.storeFilter = "all"; state.external.compareId = null;
    window.renderTab("external");
  }

  // Puts the chosen market period on screen (async when rows must be fetched).
  function applyExternal() {
    var cur = state.external.snapshotId;
    if (cur && cur !== MV.ext.lastSet) MV.ext.manualSnapshot = true;     // picked in the Snapshot list, or a file just uploaded
    var plan = extPlan();
    MV.ext.plan = plan;
    if (MV.ext.manualSnapshot) return plan;
    if (!plan.used.length) { state.external.snapshotId = null; MV.ext.lastSet = null; return plan; }
    var have = snapshots.filter(function (s) { return s.meta && s.meta.market && s.meta.sig === plan.sig && /^external_mk_/.test(s.id); })[0];
    if (have) { state.external.snapshotId = have.id; MV.ext.lastSet = have.id; return plan; }
    state.external.snapshotId = null; MV.ext.lastSet = null;
    // One attempt per selection; a failure is kept, never retried by a re-render.
    var ls = extLoader().state();
    if (ls.sig === plan.sig && ls.status === "ready") extLoader().reset();   // loaded before, since cleared (e.g. sign-out)
    if (window.SBShared) extLoader().ensure(plan, loaded);
    return plan;
  }
  function extLoader() {
    if (!MV.ext.loader) MV.ext.loader = window.marketLoader(function (plan) { return snapshotFor(plan, "external_mk_"); });
    return MV.ext.loader;
  }
  function loaded(st) {
    if (st.status === "ready" && MV.ext.plan && MV.ext.plan.sig === st.sig && !MV.ext.manualSnapshot) {
      state.external.snapshotId = st.result.id; MV.ext.lastSet = st.result.id;
    }
    if (activeTab === "external") window.renderTab("external");
  }

  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (TABS.indexOf(source) < 0) return origRenderTab(source);
    if (source === "external") {
      var plan = applyExternal();
      var r0 = origRenderTab(source);
      placeBar(plan);
      if (!MV.ext.manualSnapshot && (!plan.used.length || !state.external.snapshotId)) {
        // Missing data is said plainly above; the upload prompt is not shown as if nothing existed.
        var em = document.getElementById("external-empty"); if (em) em.style.display = "none";
      }
      return r0;
    }
    var shop = shopifySnap();
    var needs = shop && (MV.builtFor !== shop.id + "|" + reports().length);
    if (needs) {
      MV.builtFor = shop.id + "|" + reports().length;
      sync().then(function () { if (activeTab === source) { origRenderTab(source); placeNote(source); } });
    }
    var r = origRenderTab(source);
    placeNote(source);
    return r;
  };

  // A selection made by hand stays until the Shopify period changes.
  document.addEventListener("DOMContentLoaded", function () {
    [["oppmap", ["oppmap-amazon-select", "oppmap-shopify-select", "oppmap-external-select"]],
     ["ovm", ["ovm-amazon-select", "ovm-shopify-select", "ovm-external-select"]],
     ["cross", ["cross-amazon-select", "cross-shopify-select"]]].forEach(function (pair) {
      pair[1].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener("change", function () { MV.manual[pair[0]] = true; setTimeout(function () { placeNote(pair[0]); }, 0); });
      });
    });
    var ex = document.getElementById("external-snap-select");
    if (ex) ex.addEventListener("change", function () {
      if (!ex.value) { MV.ext.manualSnapshot = false; MV.ext.lastSet = null; }
      setTimeout(function () { if (activeTab === "external") window.renderTab("external"); }, 0);
    });
  });
})();
