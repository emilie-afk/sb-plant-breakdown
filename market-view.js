// ============================================================
// market-view.js
// Keeps the market comparisons (Opportunity Map, Owned vs Market, External
// Stores) and Cross-channel on ONE period: the Shopify period on screen.
//
//   - Market data is the ShipStation "Product Sales" report collected
//     automatically for the same months (source "market" in shared storage),
//     combined month by month with the same rules as sales (period-engine).
//   - Amazon is used only when a report for exactly the same dates exists;
//     otherwise the Amazon side is left empty and the page says so.
//   - When a person picks reports by hand and their dates differ, the page
//     says the comparison is not like for like.
// Nothing is uploaded; nothing here writes to shared storage.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab */
  var MV = { builtFor: null, busy: false, manual: { oppmap: false, ovm: false, cross: false, external: false }, lastShopify: null, note: {} };
  window.SBMarketView = MV;
  var TABS = ["oppmap", "ovm", "cross", "external"];

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function range(a, b) { return window.periodRangeText ? window.periodRangeText(a, b) : a + " – " + b; }
  function shopifySnap() { return snapshots.filter(function (s) { return s.id === state.shopify.snapshotId; })[0] || null; }
  function storeToday() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function reports() { return (window.SBAutoLoad && window.SBAutoLoad.reports) || []; }

  // The market snapshot for exactly the Shopify snapshot's period, or a reason.
  async function marketFor(shop) {
    var reps = reports();
    var auth = window.periodAuthoritativeMonths(reps, { source: "market", scope: window.MARKET_SCOPE });
    var used = [];
    var p = shop.meta && shop.meta.period;
    if (p) {
      var plan = window.periodPlan(p.kind, p.year, p.index, auth, { today: storeToday() });
      var want = p.revisionsUsed.map(function (u) { return u.start + ".." + u.end; }).join(",");
      var have = plan.revisionsUsed.map(function (u) { return u.start + ".." + u.end; }).join(",");
      if (want !== have) return { snap: null, reason: "Market data (ShipStation) does not cover the same months: needed " + (want.split(",").map(function (x) { var d = x.split(".."); return range(d[0], d[1]); }).join(", ")) + "." };
      used = plan.revisionsUsed.map(function (u) { return reps.filter(function (r) { return r.id === u.reportId; })[0]; });
    } else {
      var exact = reps.filter(function (r) { return r.source === "market" && r.status !== "superseded" && r.period_start === shop.startDate && r.period_end === shop.endDate; })[0];
      if (!exact) return { snap: null, reason: "No ShipStation market data for exactly " + range(shop.startDate, shop.endDate) + "." };
      used = [exact];
    }
    var id = "external_market_" + shop.startDate + "_" + shop.endDate;
    var existing = snapshots.filter(function (s) { return s.id === id; })[0];
    var sig = used.map(function (r) { return r.id; }).join("|");
    if (existing && existing.meta && existing.meta.sig === sig) return { snap: existing };
    var by = Object.create(null), order = [];
    for (var i = 0; i < used.length; i++) {
      var rows = await window.SBShared.fetchRows(used[i]);
      var part = window.marketExternalSnapshotFromShared(used[i], rows, { legacyGenus: window.legacyGenus, detectGenus: window.detectGenus });
      part.products.forEach(function (x) {
        var k = x.rawStore + "␟" + (x.sku || x.title);
        if (!by[k]) { by[k] = Object.assign({}, x, { units: 0, qty: 0, estRev: 0 }); order.push(k); }
        by[k].units += x.units; by[k].qty += x.units; by[k].estRev = Math.round((by[k].estRev + x.estRev) * 100) / 100;
        by[k].title = x.title;
      });
    }
    var snap = {
      id: id, source: "external",
      label: (shop.meta && shop.meta.period ? shop.meta.period.name : range(shop.startDate, shop.endDate)) + " · ShipStation market (automatic)",
      startDate: shop.startDate, endDate: shop.endDate, fileName: "(ShipStation Product Sales, shared storage)",
      uploadedAt: used.map(function (r) { return r.activated_at || r.imported_at; }).sort().pop(),
      products: order.map(function (k) { return by[k]; }),
      meta: { auto: true, ephemeral: true, market: true, sig: sig, revenueIsActual: true, ownStoresExcluded: true,
              current: { start: shop.startDate, end: shop.endDate },
              monthsUsed: used.map(function (r) { return { start: r.period_start, end: r.period_end, revision: r.revision }; }) }
    };
    snapshots = snapshots.filter(function (s) { return s.id !== id; });
    snapshots.push(snap);
    return { snap: snap };
  }

  function amazonFor(shop) {
    return snapshots.filter(function (s) { return s.source === "amazon" && !s.isCatalog && s.startDate === shop.startDate && s.endDate === shop.endDate; })[0] || null;
  }

  // Point the four tabs at the Shopify period, unless a person picked by hand.
  async function sync() {
    var shop = shopifySnap();
    if (!shop || !window.SBShared) return;
    if (MV.lastShopify !== shop.id) { MV.lastShopify = shop.id; TABS.forEach(function (t) { MV.manual[t] = false; }); }
    if (MV.busy) return;
    MV.busy = true;
    try {
      var m = await marketFor(shop);
      var az = amazonFor(shop);
      MV.note = { shop: shop, market: m.snap, marketReason: m.reason || null, amazon: az };
      if (!MV.manual.oppmap) { state.oppmap.shopifyId = shop.id; state.oppmap.externalId = m.snap ? m.snap.id : null; state.oppmap.amazonId = az ? az.id : null; }
      if (!MV.manual.ovm) { state.ovm.shopifyId = shop.id; state.ovm.externalId = m.snap ? m.snap.id : null; state.ovm.amazonId = az ? az.id : null; }
      if (!MV.manual.cross) { state.cross.shopifyId = shop.id; state.cross.amazonId = az ? az.id : null; }
      if (!MV.manual.external && m.snap) state.external.snapshotId = m.snap.id;
    } catch (e) {
      MV.note = { shop: shop, marketReason: "Could not load market data: " + e.message };
    }
    MV.busy = false;
  }

  function noteHtml(tab) {
    var n = MV.note || {};
    var sel = tab === "external" ? { ex: state.external.snapshotId }
      : tab === "cross" ? { am: state.cross.amazonId, sh: state.cross.shopifyId }
      : { am: state[tab].amazonId, sh: state[tab].shopifyId, ex: state[tab].externalId };
    var get = function (id) { return id ? snapshots.filter(function (s) { return s.id === id; })[0] : null; };
    var picked = [get(sel.sh), get(sel.am), get(sel.ex)].filter(Boolean);
    var dates = {};
    picked.forEach(function (s) { dates[s.startDate + ".." + s.endDate] = 1; });
    var parts = [];
    if (Object.keys(dates).length > 1) {
      parts.push('<b style="color:#b71c1c">⚠ Periods differ:</b> ' + picked.map(function (s) {
        return esc(s.source === "external" ? "market" : s.source) + " " + esc(range(s.startDate, s.endDate)); }).join(" · ") +
        ". This comparison is not like for like. Pick reports with the same dates, or re-select the Shopify period to line them up again.");
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
    return parts.join("<br>");
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
    var html = noteHtml(tab);
    el.style.display = html ? "block" : "none";
    el.innerHTML = html;
  }

  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (TABS.indexOf(source) < 0) return origRenderTab(source);
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
     ["cross", ["cross-amazon-select", "cross-shopify-select"]],
     ["external", ["external-snap-select"]]].forEach(function (pair) {
      pair[1].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener("change", function () { MV.manual[pair[0]] = true; setTimeout(function () { placeNote(pair[0]); }, 0); });
      });
    });
  });
})();
