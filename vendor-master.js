// ============================================================
// vendor-master.js
// Which supplier a Shopify product really comes from, read from the vendor
// tabs of the Products Master Google Sheet.
//
// Why: products from several suppliers are being moved into one Shopify
// inventory location, after which Shopify's "Product vendor" no longer tells
// the suppliers apart. The Products Master vendor tabs list each supplier's
// products (SKUs, Shopify names, product links), so they become the source of
// truth for the vendor. Suppliers that are NOT moving (configured in
// keepShopifyVendors, e.g. House Plant Dropship and Lively Root) keep the
// vendor Shopify states.
//
// The collector builds a vendor map once per run (storefront catalog +
// Products Master tabs) and stores it in shared storage; the dashboard applies
// it. The imported Shopify vendor is never overwritten: it stays on the record
// as `vendorImported`, beside the resolved `vendor` and how it was resolved.
//
// Match order for one product:
//   1. keep      Shopify vendor is in keepShopifyVendors -> that vendor
//   2. pid       a Products Master link names the Shopify product id
//   3. handle    a Products Master storefront link names the product handle
//   4. sku       the product's variant SKUs appear in exactly one vendor's tab
//   5. title     the product title equals a "Shopify name" in exactly one tab
//   6. prefix    every variant SKU starts with a prefix configured for exactly
//                one vendor (e.g. "XY-" for a supplier): a supplier's own
//                SKU convention, for products not yet listed in its tab.
//                Reported separately so they can be added to the sheet.
//   7. type      a product type assigned to one supplier by configuration
//                (typeVendors, e.g. a product type one supplier fulfils)
//   otherwise    unresolved (the Shopify vendor is used, and listed for review)
// Two different vendors matching at the same step is a conflict: nothing is
// chosen, the Shopify vendor is used, and the product is listed for review.
// Pure functions (no DOM, no network); used by the collector, the Worker
// payload check and the dashboard.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SCHEMA = "sb-vendor-map/v1";
  function txt(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function low(s) { return txt(s).toLowerCase(); }
  function skuKey(s) { return txt(s).toUpperCase(); }
  // Product names compared without case, punctuation or curly quotes, so
  // "Bird’s Nest Fern" in a sales report matches "Bird's Nest Fern" in a tab.
  function nameKey(s) { return String(s == null ? "" : s).toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim(); }

  // RFC4180 CSV -> array of arrays (quoted fields may hold commas and newlines).
  function parseCsv(text) {
    var rows = [], row = [], f = "", q = false, s = String(text || "").replace(/^﻿/, "");
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(f); rows.push(row); row = []; f = "";
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    return rows;
  }

  // A column spec is a header name ("SKU"), optionally with "#n" for its n-th
  // occurrence ("SKU#1" = the first SKU column), matched case-insensitively
  // against the header text up to its first line break.
  function headKey(h) { return low(String(h == null ? "" : h).split(/\r?\n/)[0]); }
  function findColumns(header, specs) {
    var out = [];
    (specs || []).forEach(function (spec) {
      var m = /^(.*?)(?:#(\d+))?$/.exec(String(spec)), want = low(m[1]), nth = m[2] ? +m[2] : 0, seen = 0;
      header.forEach(function (h, j) {
        if (headKey(h) === want) { seen++; if (!nth || seen === nth) out.push(j); }
      });
    });
    return out;
  }
  function findHeaderRow(rows, specs, maxScan) {
    for (var i = 0; i < Math.min(rows.length, maxScan || 5); i++) {
      if (findColumns(rows[i], specs).length) return i;
    }
    return -1;
  }

  // tabs: [{ vendor, rows: [[...]], sku: ["SKU"], name: ["Shopify Name"], link: ["Shopify Link"] }]
  // -> { index, tabs: [{vendor, rows, skus, problems}] }
  function buildIndex(tabs) {
    var index = { sku: Object.create(null), pid: Object.create(null), handle: Object.create(null), title: Object.create(null), prefix: [] };
    var add = function (map, key, vendor) { if (!key) return; (map[key] = map[key] || {})[vendor] = 1; };
    var report = [];
    (tabs || []).forEach(function (t) {
      var vendor = txt(t.vendor), rows = t.rows || [], specs = (t.sku || []).concat(t.name || [], t.link || []);
      (t.skuPrefix || []).forEach(function (px) { if (txt(px).length >= 2) index.prefix.push({ prefix: skuKey(px), vendor: vendor }); });
      var hr = findHeaderRow(rows, specs, 5);
      var info = { vendor: vendor, label: t.label || vendor, rows: 0, skus: 0, links: 0, names: 0, problems: [] };
      if (!vendor) info.problems.push("no vendor name configured");
      if (hr < 0) { info.problems.push("none of the configured columns was found"); report.push(info); return; }
      var head = rows[hr];
      var skuC = findColumns(head, t.sku), nameC = findColumns(head, t.name), linkC = findColumns(head, t.link);
      if ((t.sku || []).length && !skuC.length) info.problems.push("SKU column not found");
      for (var i = hr + 1; i < rows.length; i++) {
        var r = rows[i]; if (!r || !r.some(function (c) { return txt(c); })) continue;
        info.rows++;
        skuC.forEach(function (j) {
          String(r[j] == null ? "" : r[j]).split(/[\n,;]+/).forEach(function (s) {
            var k = skuKey(s); if (k.length > 2) { add(index.sku, k, vendor); info.skus++; }
          });
        });
        nameC.forEach(function (j) {
          String(r[j] == null ? "" : r[j]).split(/\n+/).forEach(function (s) { var k = nameKey(s); if (k.length > 3) { add(index.title, k, vendor); info.names++; } });
        });
        linkC.forEach(function (j) {
          var v = String(r[j] == null ? "" : r[j]);
          var m = /\/products\/(\d{4,20})(?=[\/?#\s]|$)/.exec(v), h = /\/products\/([a-z0-9][a-z0-9-]*)/i.exec(v);
          if (m) { add(index.pid, m[1], vendor); info.links++; }
          else if (h) { add(index.handle, h[1].toLowerCase(), vendor); info.links++; }
        });
      }
      report.push(info);
    });
    return { index: index, tabs: report };
  }

  // Several Shopify vendor names for one supplier (e.g. "Supplier Wholesale"
  // and "Supplier Shop") are shown as one vendor.
  function alias(v, aliases) {
    if (!aliases) return v;
    for (var k in aliases) if (low(k) === low(v)) return txt(aliases[k]);
    return v;
  }
  function one(set) { var k = set ? Object.keys(set) : []; return k.length === 1 ? { vendor: k[0] } : k.length > 1 ? { conflict: k.sort() } : null; }

  // catalogProducts: [{id, handle, title, vendor, variants:[{sku}]}] (tools/fetch-catalog.mjs slim shape)
  function resolveProduct(p, built, opts) {
    opts = opts || {};
    var keep = (opts.keepShopifyVendors || []).map(low);
    var sv = txt(p.vendor);
    if (sv && keep.indexOf(low(sv)) >= 0) return { vendor: alias(sv, opts.vendorAliases), basis: "keep", shopifyVendor: sv };
    var ix = built.index, steps = [
      ["pid", one(ix.pid[String(p.id)])],
      ["handle", one(ix.handle[low(p.handle)])],
      ["sku", (function () {
        var vs = {};
        (p.variants || []).forEach(function (v) { var s = ix.sku[skuKey(v.sku)]; if (s) for (var k in s) vs[k] = 1; });
        return one(vs);
      })()],
      ["title", one(ix.title[nameKey(p.title)])],
      ["prefix", (function () {
        var skus = (p.variants || []).map(function (v) { return skuKey(v.sku); }).filter(Boolean);
        if (!skus.length || !ix.prefix.length) return null;
        var vs = {};
        for (var i = 0; i < skus.length; i++) {
          var hit = ix.prefix.filter(function (x) { return skus[i].indexOf(x.prefix) === 0; });
          if (!hit.length) return null;                       // every SKU must carry a vendor prefix
          hit.forEach(function (x) { vs[x.vendor] = 1; });
        }
        return one(vs);
      })()],
      ["type", (function () {
        var tv = opts.typeVendors || {};
        for (var k in tv) if (low(k) === low(p.productType)) return { vendor: txt(tv[k]) };
        return null;
      })()]
    ];
    for (var i = 0; i < steps.length; i++) {
      var r = steps[i][1];
      if (!r) continue;
      if (r.vendor) return { vendor: r.vendor, basis: steps[i][0], shopifyVendor: sv };
      return { vendor: null, basis: "conflict", at: steps[i][0], candidates: r.conflict, shopifyVendor: sv };
    }
    return { vendor: null, basis: "unresolved", shopifyVendor: sv };
  }

  // -> the shared vendor map:
  //   { schema, generatedAt, keepShopifyVendors, tabs:[...], catalogProducts,
  //     entries: { "<product id>": { v: vendor, b: basis, s: shopify vendor } },
  //     review:  [{ id, title, shopifyVendor, basis, candidates? }]  (conflicts and unresolved)
  //     counts:  { resolved, kept, conflicts, unresolved } }
  function buildVendorMap(catalogProducts, tabs, opts) {
    opts = opts || {};
    var built = buildIndex(tabs);
    var entries = {}, review = [], counts = { resolved: 0, kept: 0, byPrefix: 0, conflicts: 0, unresolved: 0 };
    (catalogProducts || []).forEach(function (p) {
      if (!p || !p.id) return;
      var r = resolveProduct(p, built, opts);
      if (r.vendor) {
        entries[String(p.id)] = { v: r.vendor, b: r.basis, s: r.shopifyVendor };
        counts[r.basis === "keep" ? "kept" : "resolved"]++;
        if (r.basis === "prefix") {
          counts.byPrefix++;
          review.push({ id: String(p.id), title: txt(p.title), shopifyVendor: r.shopifyVendor, basis: "prefix", vendor: r.vendor });
        }
      } else {
        counts[r.basis === "conflict" ? "conflicts" : "unresolved"]++;
        review.push({ id: String(p.id), title: txt(p.title), shopifyVendor: r.shopifyVendor, basis: r.basis,
                      candidates: r.candidates || undefined });
      }
    });
    // Names listed in exactly one vendor's tab, for products the storefront
    // catalog does not show (unpublished, drafts): matched by the sales row's
    // product title in the dashboard.
    var titles = {};
    for (var tk in built.index.title) { var o = one(built.index.title[tk]); if (o && o.vendor) titles[tk] = o.vendor; }
    return { schema: SCHEMA, generatedAt: opts.now || new Date().toISOString(),
             keepShopifyVendors: opts.keepShopifyVendors || [], vendorAliases: opts.vendorAliases || {},
             typeVendors: opts.typeVendors || {}, titles: titles, tabs: built.tabs,
             catalogProducts: (catalogProducts || []).length, entries: entries, review: review, counts: counts };
  }

  // A new map must not silently replace a good one with a broken read (a tab
  // renamed, a column moved, the sheet unreachable). -> list of problems.
  function checkVendorMap(map, previous, opts) {
    opts = opts || {};
    var problems = [];
    if (!map || map.schema !== SCHEMA) return ["not a vendor map"];
    var n = Object.keys(map.entries || {}).length;
    if (!n) problems.push("no product could be given a vendor");
    (map.tabs || []).forEach(function (t) { if (t.problems && t.problems.length) problems.push(t.label + ": " + t.problems.join(", ")); });
    if (previous && previous.entries) {
      var before = Object.keys(previous.entries).filter(function (k) { return previous.entries[k].b !== "keep"; }).length;
      var after = Object.keys(map.entries).filter(function (k) { return map.entries[k].b !== "keep"; }).length;
      var minShare = opts.minShareOfPrevious == null ? 0.8 : opts.minShareOfPrevious;
      if (before > 20 && after < before * minShare) {
        problems.push("only " + after + " products resolved from Products Master, down from " + before + " (a tab or column may have changed)");
      }
    }
    return problems;
  }

  // Dashboard side: the vendor for one sales record. The imported vendor is
  // kept; products the map does not know keep their Shopify vendor.
  //   1. the product id is in the map (built from the storefront catalog)
  //   2. a supplier that is not moving keeps its Shopify vendor (aliased)
  //   3. the product is not in the catalog (unpublished): its title is a name
  //      listed in exactly one vendor's tab
  //   4. its product type is assigned to a supplier (typeVendors)
  //   5. otherwise the Shopify vendor
  function applyVendor(rec, map) {
    var imported = rec.vendorImported != null ? rec.vendorImported : rec.vendor;
    if (!map) return { vendor: imported, vendorImported: imported, vendorBasis: "shopify" };
    var e = map.entries && rec.productId ? map.entries[String(rec.productId)] : null;
    if (e && e.v) return { vendor: e.v, vendorImported: imported, vendorBasis: e.b === "keep" ? "shopify_kept" : e.b === "type" ? "type_rule" : "products_master_" + e.b };
    var keep = (map.keepShopifyVendors || []).map(low);
    if (imported && keep.indexOf(low(imported)) >= 0) {
      return { vendor: alias(imported, map.vendorAliases), vendorImported: imported, vendorBasis: "shopify_kept" };
    }
    var t = map.titles ? map.titles[nameKey(rec.title)] : null;
    if (t) return { vendor: t, vendorImported: imported, vendorBasis: "products_master_name" };
    var tv = map.typeVendors || {};
    for (var k in tv) if (low(k) === low(rec.ptype)) return { vendor: txt(tv[k]), vendorImported: imported, vendorBasis: "type_rule" };
    return { vendor: alias(imported, map.vendorAliases), vendorImported: imported, vendorBasis: "shopify_not_in_master" };
  }

  return {
    VENDOR_MAP_SCHEMA: SCHEMA,
    vendorParseCsv: parseCsv,
    vendorBuildIndex: buildIndex,
    vendorResolveProduct: resolveProduct,
    buildVendorMap: buildVendorMap,
    checkVendorMap: checkVendorMap,
    applyVendor: applyVendor,
    vendorNameKey: nameKey
  };
});
