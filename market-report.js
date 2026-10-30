// ============================================================
// market-report.js
// Market data from ShipStation's Insights → Reports → "Product Sales" export:
//
//   Store,SKU,Description,Category,QtySold,TotalSales
//
// One row per product per store for the chosen date range, with real item
// revenue. No order numbers and no customer data are in this export, and
// nothing here would keep them if they were.
//
//   - Succulents Box's own stores (any store named "Succulents Box …") are
//     "you", not the market: they are left out of the market figures (their
//     sales are already in the Shopify / Amazon reports).
//   - Rows with no SKU and a negative total are discounts or adjustments
//     (coupon codes and similar adjustments): kept as a separate,
//     excluded total per store, never treated as a product.
// Pure functions (no DOM); used by the collector, the Worker payload and the
// dashboard.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SCOPE = "shipstation_product_sales";
  var HEADER = ["store", "sku", "description", "category", "qtysold", "totalsales"];
  var OWN_STORE_RE = /\bsucculents?\s*box\b/i;
  var CUSTOMER_RE = /(customer|buyer|recipient|e-?mail|phone|address|ship\s*to|bill\s*to|order\s*(#|number|id))/i;

  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }
  function num(v) {
    var s = String(v == null ? "" : v).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
    var n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  function isOwnStore(name) { return OWN_STORE_RE.test(String(name || "")); }
  // Parent-brand grouping of market stores. Which stores belong together is
  // private business configuration: rules = [{match: "<regex>", group: "<name>"}]
  // come from the collector's local config or the dashboard's shared setting
  // "market_config" (window.SBMarketConfig). Without rules a store is its own group.
  function defaultRules() {
    var w = typeof window !== "undefined" ? window : null;
    return w && w.SBMarketConfig && Array.isArray(w.SBMarketConfig.storeGroups) ? w.SBMarketConfig.storeGroups : [];
  }
  function storeGroup(raw, rules) {
    var s = String(raw || "").trim();
    if (!s) return "Unknown";
    var list = rules || defaultRules();
    for (var i = 0; i < list.length; i++) {
      var re = null;
      try { re = new RegExp(String(list[i].match || ""), "i"); } catch (e) { re = null; }
      if (re && list[i].match && re.test(s)) return String(list[i].group || s);
    }
    return s;
  }

  function isProductSalesExport(rows) {
    if (!rows || !rows.length) return false;
    var h = rows[0].map(function (x) { return String(x || "").trim().toLowerCase().replace(/\s+/g, ""); });
    return HEADER.every(function (c) { return h.indexOf(c) >= 0; });
  }

  // rows: array of arrays (first row = header). Returns
  //   { ok, errors, records (market products), own (own-store products),
  //     adjustments [{store, units, net}], stores [{store, group, own, products, units, net, adjustments}],
  //     totals {market, own, adjustments, all} }
  function parseProductSales(rows, opts) {
    var rules = opts && opts.storeGroups;
    var errors = [];
    if (!rows || rows.length < 1) return { ok: false, errors: ["The export is empty."] };
    var h = rows[0].map(function (x) { return String(x || "").trim(); });
    var idx = {};
    h.forEach(function (c, i) { idx[c.toLowerCase().replace(/\s+/g, "")] = i; });
    var missing = HEADER.filter(function (c) { return !(c in idx); });
    if (missing.length) return { ok: false, errors: ["Not a ShipStation Product Sales export: missing " + missing.join(", ") + "."] };
    var leaked = h.filter(function (c) { return CUSTOMER_RE.test(c); });
    if (leaked.length) return { ok: false, errors: ["The export carries customer or order columns (" + leaked.join(", ") + "); refused."] };

    var records = [], own = [], adjustments = [], byStore = {};
    function storeOf(name) {
      return byStore[name] = byStore[name] || { store: name, group: storeGroup(name, rules), own: isOwnStore(name),
        products: 0, units: 0, net: 0, adjustments: 0 };
    }
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.some(function (x) { return String(x || "").trim() !== ""; })) continue;
      var store = String(row[idx.store] || "").trim();
      var sku = String(row[idx.sku] || "").trim();
      var title = String(row[idx.description] || "").trim();
      var qty = num(row[idx.qtysold]), net = num(row[idx.totalsales]);
      if (!store) { errors.push("Row " + (i + 1) + " has no store."); continue; }
      if (!Number.isFinite(qty) || !Number.isFinite(net)) { errors.push("Row " + (i + 1) + " has a non-numeric quantity or total."); continue; }
      var st = storeOf(store);
      if (!sku && net < 0) {
        adjustments.push({ store: store, label: title || "(adjustment)", units: Math.round(qty), net: r2(net) });
        st.adjustments = r2(st.adjustments + net);
        continue;
      }
      var rec = { store: store, storeGroup: st.group, ownStore: st.own, sku: sku, title: title || sku || "(no description)",
                  category: String(row[idx.category] || "").trim(), units: Math.round(qty), net: r2(net) };
      (st.own ? own : records).push(rec);
      st.products++; st.units += rec.units; st.net = r2(st.net + rec.net);
    }
    var sum = function (list, f) { return list.reduce(function (t, r) { return t + r[f]; }, 0); };
    var totals = {
      market: { units: Math.round(sum(records, "units")), net: r2(sum(records, "net")) },
      own: { units: Math.round(sum(own, "units")), net: r2(sum(own, "net")) },
      adjustments: { units: Math.round(sum(adjustments, "units")), net: r2(sum(adjustments, "net")) }
    };
    totals.all = { units: totals.market.units + totals.own.units + totals.adjustments.units,
                   net: r2(totals.market.net + totals.own.net + totals.adjustments.net) };
    var stores = Object.keys(byStore).sort().map(function (k) { return byStore[k]; });
    return { ok: errors.length === 0, errors: errors, records: records, own: own, adjustments: adjustments, stores: stores, totals: totals };
  }

  // Ingest payload for the Worker (source "market"). Only market stores'
  // products are stored; adjustments are stored as excluded rows so the
  // totals reconcile. Own-store rows are not stored at all.
  function payloadFromParse(res, period, opts) {
    opts = opts || {};
    var rows = res.records.map(function (r) {
      return { productId: null, title: r.title, vendor: r.store, productType: r.category || "(none)", asin: null,
               salesChannel: r.storeGroup, extra: null, sku: r.sku,
               cur: { units: r.units, gross: r.net, disc: 0, ret: 0, net: r.net, tax: 0, total: r.net } };
    }).concat(res.adjustments.filter(function (a) { return !isOwnStore(a.store); }).map(function (a) {
      return { productId: null, title: a.label, vendor: a.store, productType: "(adjustment)", asin: null,
               salesChannel: storeGroup(a.store, opts.storeGroups), extra: null,
               cur: { units: a.units, gross: 0, disc: a.net, ret: 0, net: a.net, tax: 0, total: a.net } };
    }));
    var M = ["units", "gross", "disc", "ret", "net", "tax", "total"];
    var tot = function (list) { var o = {}; M.forEach(function (k) { var v = list.reduce(function (t, r) { return t + r.cur[k]; }, 0); o[k] = k === "units" ? Math.round(v) : r2(v); }); return o; };
    var inc = rows.filter(function (r) { return r.productType !== "(adjustment)"; });
    var exc = rows.filter(function (r) { return r.productType === "(adjustment)"; });
    return {
      source: "market", reportScope: SCOPE, importedBy: opts.importedBy || "collector",
      period: { start: period.start, end: period.end }, comparison: null,
      timezone: opts.timeZone || "America/Los_Angeles", currency: opts.currency || "USD",
      sourceFilename: "ShipStation Product Sales " + period.start + " - " + period.end + ".csv",
      client: opts.client || null, collectedAt: opts.collectedAt || new Date().toISOString(),
      sourceCapabilities: { reportVersion: "shipstation-product-sales/v1", hasRevenue: true, hasUnits: true },
      totals: tot(rows), includedTotals: tot(inc), excludedTotals: tot(exc),
      exclusionLabels: exc.length ? ["Discounts and adjustments (no SKU)"] : [],
      rows: rows
    };
  }

  // Stored market rows -> the External Stores snapshot shape app.js reads.
  // Revenue is ShipStation's actual item revenue, not an estimate from order
  // totals. ShipStation's Product Sales report carries no order count.
  function externalSnapshotFromShared(report, rows, helpers) {
    helpers = helpers || {};
    var products = rows.filter(function (r) { return r.productType !== "(adjustment)"; }).map(function (r) {
      return { orderId: "", orderDate: "", rawStore: r.vendor, store: storeGroup(r.vendor, helpers.storeGroups), sku: r.sku || "", title: r.title,
               qty: r.cur.units, units: r.cur.units, estRev: r.cur.net, revenueIsActual: true,
               ptype: r.productType || "",
               // the same classifier and overrides as Shopify and Amazon
               genus: helpers.legacyGenus
                 ? helpers.legacyGenus({ title: r.title, ptype: r.productType || "", vendor: r.vendor, sku: r.sku || "", channel: "market" })
                 : ((helpers.detectGenus && helpers.detectGenus(r.title)) || "(no genus)") };
    });
    return {
      id: "external_market_" + report.period_start + "_" + report.period_end,
      source: "external", label: (helpers.label || (report.period_start + " – " + report.period_end)) + " · ShipStation (automatic)",
      startDate: report.period_start, endDate: report.period_end,
      fileName: "(ShipStation Product Sales, shared storage)", uploadedAt: report.imported_at,
      products: products,
      meta: { auto: true, market: true, ephemeral: true, shared: { reportId: report.id, revision: report.revision },
              current: { start: report.period_start, end: report.period_end }, revenueIsActual: true,
              ownStoresExcluded: true }
    };
  }

  return {
    MARKET_SCOPE: SCOPE,
    marketIsOwnStore: isOwnStore,
    marketStoreGroup: storeGroup,
    marketIsProductSalesExport: isProductSalesExport,
    marketParseProductSales: parseProductSales,
    marketPayloadFromParse: payloadFromParse,
    marketExternalSnapshotFromShared: externalSnapshotFromShared
  };
});
