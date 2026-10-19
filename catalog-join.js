// ============================================================
// catalog-join.js
// Joins product-level SALES records to the store CATALOG
// (/products.json, see tools/fetch-catalog.mjs).
//
// The catalog supplies catalogue facts — handle, current title, vendor, type,
// variants. It never supplies sales, and sales are never moved, split or
// allocated by this file.
//
// Match order, strictest first:
//   1. product_id          The sales row carries a Shopify product id (the
//                          saved "+ ID" report does). Exact. Authoritative.
//   2. approved mapping    A human approved this sales identity -> product
//                          earlier. Reused; never re-guessed.
//   3. exact title+vendor  Only when exactly ONE catalog product has that
//                          title and vendor (case/space-insensitive).
//   4. ambiguous           Two or more catalog products share the title and
//                          vendor. Candidates are listed; nothing is chosen.
//   5. not_in_catalog      Nothing matches. Often a product not published to
//                          the Online Store (Route, subscriptions, drafts) —
//                          which is why this never reads as "does not exist".
//
// Fuzzy similarity is computed ONLY as review suggestions. It never produces
// a match; a person must approve it, and the approval is then stored.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SEP = "␟";
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
  function tvKey(title, vendor) { return "tv:" + norm(title) + SEP + norm(vendor); }
  function pidKey(id) { return "pid:" + String(id); }

  function indexCatalog(catalog) {
    var products = (catalog && catalog.products) || catalog || [];
    var byId = Object.create(null), byTV = Object.create(null);
    var skuCount = Object.create(null);
    products.forEach(function (p) {
      byId[String(p.id)] = p;
      var k = tvKey(p.title, p.vendor);
      (byTV[k] = byTV[k] || []).push(p);
      (p.variants || []).forEach(function (v) { if (v.sku) skuCount[v.sku] = (skuCount[v.sku] || 0) + 1; });
    });
    return { products: products, byId: byId, byTV: byTV, skuCount: skuCount };
  }

  // Token overlap, for review suggestions only.
  function tokens(s) {
    return norm(s).replace(/[^a-z0-9 ]+/g, " ").split(" ").filter(function (t) { return t.length > 1; });
  }
  function similarity(a, b) {
    var A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return 0;
    var setB = Object.create(null); B.forEach(function (t) { setB[t] = 1; });
    var inter = A.filter(function (t) { return setB[t]; }).length;
    return inter / (A.length + B.length - inter);
  }
  function suggestionsFor(rec, idx, limit) {
    var scored = [];
    var vendor = norm(rec.vendor);
    idx.products.forEach(function (p) {
      var s = similarity(rec.title, p.title);
      if (norm(p.vendor) === vendor) s += 0.1;     // same vendor is a mild hint, never proof
      if (s >= 0.45) scored.push({ productId: String(p.id), handle: p.handle, title: p.title, vendor: p.vendor, score: Math.round(s * 100) / 100 });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3);
  }

  function summarize(p) {
    if (!p) return null;
    return { productId: String(p.id), handle: p.handle || "", title: p.title, vendor: p.vendor,
             productType: p.productType || "", variantCount: (p.variants || []).length };
  }

  /**
   * @param records   sales records (shopify-report shape: title, vendor, productId?)
   * @param catalog   {products:[...]} from fetch-catalog.mjs, or a bare array
   * @param approved  { [matchKey]: { productId, approvedBy, approvedAt, note } }
   * @returns records, each with a `catalog` field, plus a summary
   */
  function joinSalesToCatalog(records, catalog, approved, opts) {
    opts = opts || {};
    approved = approved || {};
    var idx = indexCatalog(catalog);
    var summary = { product_id: 0, approved: 0, exact_title_vendor: 0, ambiguous: 0, not_in_catalog: 0,
                    conflicts: 0, net: { product_id: 0, approved: 0, exact_title_vendor: 0, ambiguous: 0, not_in_catalog: 0 } };

    records.forEach(function (r) {
      var m = null;
      var net = (r.cur && r.cur.net) || r.net || 0;

      if (r.productId) {
        var hit = idx.byId[String(r.productId)];
        m = hit
          ? { status: "product_id", basis: "Shopify product id", product: summarize(hit) }
          : { status: "not_in_catalog", basis: "Shopify product id not in the Online Store catalog",
              productId: String(r.productId) };
        // A sales row whose id matches but whose vendor differs is reported,
        // never rewritten: the vendor recorded at the time of sale stays.
        if (hit && norm(hit.vendor) !== norm(r.vendor)) {
          m.vendorConflict = { sales: r.vendor, catalog: hit.vendor };
          summary.conflicts++;
        }
      } else {
        var appr = approved[tvKey(r.title, r.vendor)];
        if (appr && idx.byId[String(appr.productId)]) {
          m = { status: "approved", basis: "approved mapping", product: summarize(idx.byId[String(appr.productId)]),
                approvedBy: appr.approvedBy || null, approvedAt: appr.approvedAt || null };
        } else {
          var cands = idx.byTV[tvKey(r.title, r.vendor)] || [];
          if (cands.length === 1) {
            m = { status: "exact_title_vendor", basis: "unique exact title + vendor", product: summarize(cands[0]) };
          } else if (cands.length > 1) {
            m = { status: "ambiguous", basis: cands.length + " catalog products share this title and vendor",
                  candidates: cands.map(summarize), requiresReview: true };
          } else {
            m = { status: "not_in_catalog", basis: "no product with this title and vendor in the Online Store catalog",
                  suggestions: opts.suggest === false ? [] : suggestionsFor(r, idx, 3), requiresReview: true };
          }
        }
      }
      r.catalog = m;
      summary[m.status]++;
      summary.net[m.status] = Math.round((summary.net[m.status] + net) * 100) / 100;
    });

    // Catalog products that appear in no sales row. The report lists products
    // with activity in the period, so these had no recorded sales in it. That
    // says nothing about stock or performance, and the label says only that.
    var seen = Object.create(null);
    records.forEach(function (r) { if (r.catalog && r.catalog.product) seen[r.catalog.product.productId] = 1; });
    var noRecordedSales = idx.products.filter(function (p) { return !seen[String(p.id)]; }).map(summarize);

    return { records: records, summary: summary, noRecordedSales: noRecordedSales,
             catalogCount: idx.products.length };
  }

  // Store a human approval. Keyed on the sales identity (title+vendor), so it
  // applies to every later report carrying that identity. Returns a new map.
  function approveMapping(approved, rec, productId, by, note) {
    if (!productId) throw new Error("approveMapping needs a productId");
    var out = Object.assign({}, approved || {});
    out[tvKey(rec.title, rec.vendor)] = {
      productId: String(productId), approvedBy: by || null,
      approvedAt: new Date().toISOString(), note: note || ""
    };
    return out;
  }
  function revokeMapping(approved, rec) {
    var out = Object.assign({}, approved || {});
    delete out[tvKey(rec.title, rec.vendor)];
    return out;
  }

  // Supplementary data (e.g. the Products Master workbook) may enrich a
  // catalog VARIANT only through a verified identifier: a SKU that occurs on
  // exactly one variant in the catalog. Duplicate SKUs are refused, and a
  // workbook row without a unique SKU enriches nothing.
  function enrichBySku(catalog, rows, skuField) {
    var idx = indexCatalog(catalog);
    var field = skuField || "sku";
    var bySku = Object.create(null);
    idx.products.forEach(function (p) {
      (p.variants || []).forEach(function (v) { if (v.sku) bySku[v.sku] = { product: p, variant: v }; });
    });
    var applied = [], refused = [];
    (rows || []).forEach(function (row) {
      var sku = String(row[field] == null ? "" : row[field]).trim();
      if (!sku) { refused.push({ row: row, reason: "no SKU" }); return; }
      if ((idx.skuCount[sku] || 0) > 1) { refused.push({ row: row, reason: "SKU is on more than one catalog variant" }); return; }
      var hit = bySku[sku];
      if (!hit) { refused.push({ row: row, reason: "SKU not in catalog" }); return; }
      applied.push({ productId: String(hit.product.id), variantId: String(hit.variant.id), sku: sku, row: row });
    });
    return { applied: applied, refused: refused };
  }

  return {
    catalogTvKey: tvKey,
    catalogPidKey: pidKey,
    indexCatalog: indexCatalog,
    catalogSimilarity: similarity,
    joinSalesToCatalog: joinSalesToCatalog,
    approveMapping: approveMapping,
    revokeMapping: revokeMapping,
    enrichBySku: enrichBySku
  };
});
