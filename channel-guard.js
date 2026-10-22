// ============================================================
// channel-guard.js
// When marketplace orders are synced into Shopify (here through Sellbrite),
// a Shopify report already contains them. The older cross-channel tabs
// (Cross-channel, Opportunity Map, Owned vs Market) add a Shopify report to
// an Amazon report, which would count those orders twice.
//
// This module makes those tabs read Shopify as OWN STORE ONLY whenever the
// Shopify report carries a Sales channel column: Sellbrite rows are left out
// by their channel value, so Amazon is counted once (from the Amazon report),
// including in March 2026 when the sync started on an unknown day.
// Without the column, a report ending before March 2026 holds no Amazon
// orders; one touching March 2026 or later MAY hold them, and the tab says the
// totals are kept separate and are not deduplicated (shopifyOverlapNote).
// app.js is not edited: its data functions are wrapped, and the wrapped call
// sees a view of the snapshot list in which those Shopify reports hold only
// their own-store rows. Stored data is never changed.
//
// It also shows, on the Amazon tab, the Sellbrite rows of a Shopify report
// for the same period beside the Seller Central figures, as a cross-check
// that is never summed.
// ============================================================
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  var PG = window, SR = window;

  var cache = Object.create(null);
  function ownStoreView(snap) {
    var k = snap.id + "|" + snap.products.length + "|" + (snap.uploadedAt || "");
    if (!cache[k]) {
      cache[k] = Object.assign({}, snap, { products: PG.filterChannel(snap.products, "own"), _ownStoreView: true });
    }
    return cache[k];
  }
  // The cross-source tabs aggregate on p.genus. Every source's products are
  // re-grouped here with the ONE shared classifier (and the saved overrides),
  // so Shopify, Amazon and market rows land in the same canonical groups
  // (a Shopify "Gift" and a market gift box are both "Gifts"; a Shopify
  // variety pack and a market bulk pack are both "Mixed variety pack").
  // Figures are never touched; only the grouping field of the view changes.
  var gcache = Object.create(null);
  function overrideSig() {
    try { return localStorage.getItem((window.SBOverrides && window.SBOverrides.STORAGE_KEY) || "") || ""; } catch (e) { return ""; }
  }
  function canonicalView(snap) {
    if (!snap || !Array.isArray(snap.products) || typeof window.legacyGenus !== "function" || typeof window.sbGenusRec !== "function") return snap;
    var k = snap.id + "|" + snap.products.length + "|" + (snap.uploadedAt || "") + "|" + (snap._ownStoreView ? 1 : 0) + "|" + overrideSig();
    if (!gcache[k]) {
      gcache[k] = Object.assign({}, snap, { products: snap.products.map(function (p) {
        return Object.assign({}, p, { genus: window.legacyGenus(window.sbGenusRec(p, snap.source)) });
      }) });
    }
    return gcache[k];
  }
  function viewList(list) {
    return list.map(function (s) {
      var v = s && s.source === "shopify" && !s.isCatalog && SR.shopifyChannelStatus(s).anyChannel ? ownStoreView(s) : s;
      return canonicalView(v);
    });
  }

  // Wrap a global function so that, for the duration of the call, the global
  // `snapshots` binding is the own-store view. Nested wrapped calls reuse the
  // outer swap.
  var depth = 0;
  function guard(name) {
    var fn = window[name];
    if (typeof fn !== "function" || fn._channelGuarded) return;
    var wrapped = function () {
      if (depth > 0) return fn.apply(this, arguments);
      var real = snapshots;
      depth++;
      snapshots = viewList(real);
      try { return fn.apply(this, arguments); }
      finally {
        // keep anything the call added or removed, but never persist a view
        if (snapshots !== real) {
          var viewIds = {};
          snapshots.forEach(function (s) { if (s) viewIds[s.id] = true; });
          snapshots = real.filter(function (s) { return viewIds[s.id]; });
        }
        depth--;
      }
    };
    wrapped._channelGuarded = true;
    window[name] = wrapped;
  }
  ["downloadCross", "renderCross", "computeOpportunityMap", "computeOwnedVsMarket", "buildOwnedTitleIndex",
   "computeOvmPlantRows", "computeCrossPlantRows", "renderOppMap", "renderOwnedVsMarket",
   "renderOvmPlantPanel", "renderCrossPlantPanel", "renderExternal"].forEach(guard);

  // ---- notes on the cross-channel tabs ---------------------------------
  var TAB_STATE = { cross: function () { return state.cross && state.cross.shopifyId; },
                    oppmap: function () { return state.oppmap && state.oppmap.shopifyId; },
                    ovm: function () { return state.ovm && state.ovm.shopifyId; } };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function money(v) { return window.BUI ? BUI.money(v) : "$" + (+v || 0).toFixed(2); }
  function count(v) { return window.BUI ? BUI.count(v) : String(v); }

  function crossNote(tab) {
    var id = TAB_STATE[tab] && TAB_STATE[tab]();
    var snap = id ? snapshots.find(function (s) { return s.id === id; }) : null;
    if (!snap) return "";
    var st = SR.shopifyChannelStatus(snap);
    var out = [];
    if (st.anyChannel) {
      var a = st.totals.amazon;
      out.push("Shopify figures on this tab are <b>own store only</b>. Amazon orders that reached Shopify through Sellbrite (" +
        money(a.net) + " net, " + count(a.units) + " units in “" + esc(snap.label) + "”) are left out by their Sales channel value, " +
        "so Amazon is counted once, from the Amazon report.");
    }
    if (st.mayIncludeAmazon) {
      out.push("⚠ “" + esc(snap.label) + "”: " + esc(SR.shopifyOverlapNote(st)) +
        " Any Shopify + Amazon figure on this tab is <b>not deduplicated</b>.");
    }
    return out.join("<br>");
  }
  function placeNote(tab) {
    var panel = document.getElementById("tab-" + tab);
    if (!panel) return;
    var el = document.getElementById("chan-note-" + tab);
    var html = crossNote(tab);
    if (!el) {
      el = document.createElement("div");
      el.id = "chan-note-" + tab;
      el.className = "panel small";
      el.style.cssText = "border-color:#ffcc80;background:#fffaf2;padding:10px 14px;margin-bottom:12px";
      panel.insertBefore(el, panel.firstChild);
    }
    el.style.display = html ? "block" : "none";
    el.innerHTML = html;
  }

  // ---- Amazon tab: Sellbrite cross-check ---------------------------------
  function amazonCrossCheck() {
    var box = document.getElementById("az-provenance");
    if (!box) return;
    var old = document.getElementById("az-sellbrite-check");
    if (old) old.remove();
    var az = state.amazon && snapshots.find(function (s) { return s.id === state.amazon.snapshotId; });
    if (!az) return;
    var match = snapshots.filter(function (s) {
      return s.source === "shopify" && s.startDate === az.startDate && s.endDate === az.endDate && SR.shopifyChannelStatus(s).hasChannel;
    })[0];
    var azUnits = (az.products || []).reduce(function (t, p) { return t + (p.units || 0); }, 0);
    var html;
    if (match) {
      var a = SR.shopifyChannelStatus(match).totals.amazon;
      var diff = a.units - azUnits;
      html = "<b>Cross-check with Shopify (same period):</b> Sellbrite rows in “" + esc(match.label) + "” show " +
        count(a.units) + " units / " + money(a.net) + " net; this Amazon report shows " + count(azUnits) + " units" +
        (!diff ? "" : Math.abs(diff) <= Math.max(5, azUnits * 0.05)
          ? " (" + (diff > 0 ? "+" : "") + count(diff) + " — small gaps come from order timing, cancellations and time zones)"
          : " (" + (diff > 0 ? "+" : "") + count(diff) + " — ⚠ a large gap: check both reports cover the same dates and that Sellbrite carries only Amazon orders)") +
        ". These are the same Amazon orders seen from two systems and are never added together.";
    } else if (SR.shopifySellbriteOverlap(az.startDate, az.endDate).potential) {
      html = "Amazon orders also appear in Shopify (Sellbrite channel) from an unknown day in March 2026 and every day from April 2026. " +
        "Import a Shopify report with a Sales channel column for exactly " + esc(az.startDate) + " → " + esc(az.endDate) + " to cross-check them here.";
    }
    if (!html) return;
    var div = document.createElement("div");
    div.id = "az-sellbrite-check";
    div.className = "small";
    div.style.cssText = "margin-top:6px";
    div.innerHTML = html;
    box.appendChild(div);
  }

  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    var r = origRenderTab.apply(this, arguments);
    try {
      if (TAB_STATE[source]) placeNote(source);
      if (source === "amazon") amazonCrossCheck();
    } catch (e) { console.warn("channel note failed", e); }
    return r;
  };
  // The cross tabs also re-render themselves directly (select changes), so
  // refresh the note after those calls too.
  [["renderCross", "cross"], ["renderOppMap", "oppmap"], ["renderOwnedVsMarket", "ovm"]].forEach(function (p) {
    var fn = window[p[0]];
    if (typeof fn !== "function") return;
    window[p[0]] = function () {
      var r = fn.apply(this, arguments);
      try { placeNote(p[1]); } catch (e) { /* note is advisory */ }
      return r;
    };
    window[p[0]]._channelGuarded = true;
  });

  window.SBChannelGuard = { ownStoreView: ownStoreView, viewList: viewList, crossNote: crossNote };
})();
