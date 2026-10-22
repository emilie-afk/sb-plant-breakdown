// ============================================================
// shopify-report.js
// Validated, header-based parser + grouping engine for Shopify's
// "Total sales by product" analytics export.
//
// Loaded as a plain <script> in the browser (attaches to window) and
// require()'d by the Node test suite. No DOM, no globals beyond the
// exported names, so every function here is directly testable.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
//   - It does not guess the comparison period. The export states no dates.
//   - It does not infer SKUs, product ids or variant counts. This report
//     has none, so nothing downstream may claim variant-level accuracy.
//   - It does not compute profit.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // ----------------------------------------------------------
  // Schema
  // ----------------------------------------------------------
  // Canonical measure order as Shopify emits it. `key` is the field name
  // used everywhere downstream; `header` is the exact current-period header.
  var MEASURES = [
    { key: "units", header: "Net items sold",  kind: "count" },
    { key: "gross", header: "Gross sales",     kind: "money" },
    { key: "disc",  header: "Discounts",       kind: "money" },
    { key: "ret",   header: "Sales reversals", kind: "money" },
    { key: "net",   header: "Net sales",       kind: "money" },
    { key: "tax",   header: "Taxes",           kind: "money" },
    { key: "total", header: "Total sales",     kind: "money" }
  ];
  var DIMENSIONS = [
    { key: "title",  header: "Product title" },
    { key: "vendor", header: "Product vendor" },
    { key: "ptype",  header: "Product type" },
    // Optional. Present when the report is a saved copy of "Total sales by
    // product" that adds product_id to the GROUP BY. Adding it leaves every
    // total identical and splits same-titled products apart.
    { key: "productId", header: "Product ID", optional: true },
    // Optional. The saved report can also group by sales_channel (totals stay
    // identical). Each product then appears once per channel, which is what
    // lets marketplace orders synced into Shopify (e.g. through Sellbrite) be
    // separated from own-store sales.
    { key: "salesChannel", header: "Sales channel", optional: true }
  ];

  // Amazon orders synced into Shopify by Sellbrite show up there as the
  // "Sellbrite" sales channel. For this store (settings, not measurements):
  //   before March 2026      no Amazon orders in Shopify: no overlap
  //   March 2026             PARTIAL-month overlap; the exact start date is unknown
  //   April 2026 onward      every day overlaps
  // With a Sales channel column the Sellbrite rows are excluded by their actual
  // channel value, which works for March too without knowing the start date.
  // Without it, any period touching March 2026 or later MAY include Amazon
  // orders, and a Shopify + Amazon total can never be called deduplicated.
  var AMAZON_CHANNEL_RE = /\b(sellbrite|amazon)\b/i;
  var AMAZON_VIA_SHOPIFY_SINCE = "2026-03-01";      // first day overlap is possible
  var AMAZON_VIA_SHOPIFY_FULL_FROM = "2026-04-01";  // first day of full-month overlap

  // How a date range (store dates) relates to the Sellbrite sync, assuming the
  // report has NO Sales channel column.
  //   level 'none'    ends before March 2026: Shopify holds no Amazon orders
  //   level 'partial' within March 2026: some days may include Amazon orders
  //   level 'full'    starts April 2026 or later: every day may include them
  //   level 'mixed'   spans more than one of these phases
  function sellbriteOverlap(start, end) {
    start = String(start || ""); end = String(end || start);
    if (!end || end < AMAZON_VIA_SHOPIFY_SINCE) {
      return { level: "none", potential: false, text: "before March 2026: no Amazon orders in Shopify" };
    }
    var level = start >= AMAZON_VIA_SHOPIFY_FULL_FROM ? "full"
      : (start >= AMAZON_VIA_SHOPIFY_SINCE && end < AMAZON_VIA_SHOPIFY_FULL_FROM) ? "partial" : "mixed";
    var text = level === "full" ? "from April 2026 every day may include Amazon orders synced through Sellbrite"
      : level === "partial" ? "March 2026 is a partial-month overlap: Amazon orders reached Shopify through Sellbrite from an unknown day in March"
      : "this period reaches March 2026 or later: Amazon orders synced through Sellbrite are in Shopify for part of March (start date unknown) and all of April 2026 onward";
    return { level: level, potential: true, text: text };
  }
  function channelGroupOf(name) {
    var s = String(name == null ? "" : name).trim();
    if (!s) return "";
    return AMAZON_CHANNEL_RE.test(s) ? "amazon" : "own";
  }
  var MEASURE_KEYS = MEASURES.map(function (m) { return m.key; });

  var UNCLASSIFIED_TYPE = "Unclassified";
  var UNKNOWN_VENDOR = "(no vendor)";

  // Shopify's own label for the comparison columns.
  var PREV_SUFFIX_RE = /\(previous[_\s]?period\)/i;

  // ----------------------------------------------------------
  // Small helpers
  // ----------------------------------------------------------
  function normHeader(h) {
    return String(h == null ? "" : h).replace(/﻿/g, "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function baseName(h) {
    return normHeader(h).replace(PREV_SUFFIX_RE, "").trim();
  }

  // Parse a numeric cell. Returns null for a genuinely empty cell so that
  // "no value" stays distinguishable from a real 0 (Shopify leaves the
  // percentage-change cells blank when the prior value is 0).
  // Signs are preserved: discounts and sales reversals arrive negative and
  // must stay negative.
  function num(x) {
    if (typeof x === "number") return isFinite(x) ? x : null;
    if (x == null) return null;
    var s = String(x).trim();
    if (s === "" || s === "-" || s === "—") return null;
    var neg = /^\(.*\)$/.test(s);           // (123.45) accounting negative
    if (neg) s = s.slice(1, -1);
    s = s.replace(/[$,\s]/g, "").replace(/%$/, "");
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }
  function n0(v) { return v == null ? 0 : v; }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  // ----------------------------------------------------------
  // Header resolution
  // ----------------------------------------------------------
  // The export repeats every "(previous_period)" header twice. The second
  // copy differs only by a trailing space and holds the PERCENTAGE CHANGE,
  // not a second set of prior values. Trimming the headers into a map would
  // silently collapse the two and read percentages as prior sales.
  //
  // So: resolve by OCCURRENCE INDEX, never by trimmed name, and then verify
  // the roles numerically before trusting them (see verifyPrevColumnRoles).
  function resolveColumns(headerRow) {
    var errors = [], warnings = [];
    var raw = (headerRow || []).map(function (h) { return String(h == null ? "" : h); });
    var occ = {}; // baseName -> [column index, ...] in file order

    raw.forEach(function (h, i) {
      var b = baseName(h);
      if (!b) return;
      (occ[b] = occ[b] || []).push(i);
    });

    var cols = { dims: {}, cur: {}, prev: {}, pct: {} };

    DIMENSIONS.forEach(function (d) {
      var list = occ[normHeader(d.header)];
      if (!list || !list.length) {
        if (!d.optional) errors.push("Missing required column: \"" + d.header + "\"");
        return;
      }
      cols.dims[d.key] = list[0];
      if (list.length > 1) warnings.push("Column \"" + d.header + "\" appears " + list.length + " times; using the first.");
    });

    MEASURES.forEach(function (m) {
      var list = occ[normHeader(m.header)] || [];
      // The CURRENT column is the one with no "(previous_period)" suffix.
      // Without this test, deleting the real "Net sales" column would let the
      // previous-period copy silently take its place, because the suffix is
      // stripped when matching.
      var plain = list.filter(function (i) { return !PREV_SUFFIX_RE.test(raw[i]); });
      if (!plain.length) {
        errors.push(list.length
          ? "Missing required column: \"" + m.header + "\" (only previous-period copies of it are present)"
          : "Missing required column: \"" + m.header + "\"");
        return;
      }
      cols.cur[m.key] = plain[0];
      if (plain.length > 1) {
        warnings.push("Column \"" + m.header + "\" appears " + plain.length +
                      " times without a previous-period label; using the first and treating the rest as comparison columns.");
      }
      // Everything else for this measure, in file order, is comparison data.
      var rest = list.filter(function (i) { return i !== plain[0]; });
      if (rest.length >= 1) cols.prev[m.key] = rest[0];
      if (rest.length >= 2) cols.pct[m.key] = rest[1];
      if (rest.length > 2) {
        warnings.push("Column \"" + m.header + "\" has " + rest.length + " comparison copies; only the first two are used " +
                      "(previous period, percentage change).");
      }
    });

    var prevCount = Object.keys(cols.prev).length;
    var pctCount = Object.keys(cols.pct).length;
    if (prevCount && prevCount !== MEASURES.length) {
      warnings.push("Only " + prevCount + " of " + MEASURES.length + " measures carry previous-period values; " +
                    "comparisons will be partial.");
    }
    if (pctCount && pctCount !== prevCount) {
      warnings.push("Previous-period and percentage-change column counts differ (" + prevCount + " vs " + pctCount + ").");
    }
    return { cols: cols, errors: errors, warnings: warnings, headerRaw: raw, hasPrev: prevCount > 0, hasPct: pctCount > 0 };
  }

  // Decide empirically which of the two repeated groups holds absolute prior
  // values and which holds percentage change, instead of trusting a trailing
  // space. For every testable row we check whether group B behaves like
  // (current - A) / |A| * 100. If the file is laid out the other way round,
  // the groups are swapped; if neither fits, we say so and the caller can
  // refuse to publish comparisons.
  function verifyPrevColumnRoles(dataRows, cols) {
    if (!Object.keys(cols.pct).length) {
      return { verified: true, swapped: false, samples: 0, agreement: 1, note: "No percentage-change columns present." };
    }
    var keys = MEASURE_KEYS.filter(function (k) { return cols.prev[k] != null && cols.pct[k] != null; });
    var okForward = 0, okReverse = 0, tested = 0;

    function pctOf(cur, prior) {
      if (prior == null || prior === 0) return null;
      return (cur - prior) / Math.abs(prior) * 100;
    }
    function close(a, b) {
      if (a == null || b == null) return false;
      return Math.abs(a - b) <= Math.max(0.05, Math.abs(a) * 0.01);
    }

    for (var i = 0; i < dataRows.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        var cur = num(dataRows[i][cols.cur[k]]);
        var A = num(dataRows[i][cols.prev[k]]);
        var B = num(dataRows[i][cols.pct[k]]);
        if (cur == null || A == null || B == null) continue;
        if (A === 0 || B === 0) continue;
        tested++;
        if (close(B, pctOf(cur, A))) okForward++;
        if (close(A, pctOf(cur, B))) okReverse++;
      }
      if (tested >= 400) break;
    }
    if (!tested) {
      return { verified: false, swapped: false, samples: 0, agreement: 0,
               note: "Could not verify which repeated column group holds prior values; too few comparable cells." };
    }
    var fwd = okForward / tested, rev = okReverse / tested;
    if (fwd >= 0.9 && fwd > rev) {
      return { verified: true, swapped: false, samples: tested, agreement: fwd,
               note: "Second column group holds prior values, third holds percentage change (verified on " + tested + " cells)." };
    }
    if (rev >= 0.9 && rev > fwd) {
      return { verified: true, swapped: true, samples: tested, agreement: rev,
               note: "Column groups are reversed: the third group holds prior values (verified on " + tested + " cells)." };
    }
    return { verified: false, swapped: false, samples: tested, agreement: Math.max(fwd, rev),
             note: "The repeated previous-period columns do not behave like value + percentage change " +
                   "(best agreement " + Math.round(Math.max(fwd, rev) * 100) + "% over " + tested + " cells). " +
                   "Prior-period figures are not trusted." };
  }

  // ----------------------------------------------------------
  // Detection
  // ----------------------------------------------------------
  function isShopifyProductReport(rows) {
    if (!rows || !rows.length) return false;
    var hdr = (rows[0] || []).map(normHeader);
    return hdr.indexOf("product title") >= 0 &&
           hdr.indexOf("net items sold") >= 0 &&
           hdr.indexOf("net sales") >= 0;
  }

  // ----------------------------------------------------------
  // Parse
  // ----------------------------------------------------------
  // opts:
  //   classify(record) -> {groupType, group, isPlant}   (injected; see classification.js)
  //   strict           -> if true, any error returns ok:false with no records
  //
  // Returns:
  //   { ok, errors, warnings, records, rowCount, aggregatedRows,
  //     totals:{current, prior}, columnReport, prevRoles, capabilities }
  function parseShopifyProductReport(rows, opts) {
    opts = opts || {};
    var out = {
      ok: false, errors: [], warnings: [], records: [],
      rowCount: 0, aggregatedRows: 0,
      totals: { current: blankTotals(), prior: blankTotals() },
      columnReport: null, prevRoles: null,
      capabilities: { hasPrior: false, hasSku: false, hasProductId: false, hasVariantId: false, hasDailyDates: false,
                      hasSalesChannel: false },
      channelTotals: null
    };

    if (!rows || rows.length < 2) {
      out.errors.push("The file has no data rows.");
      return out;
    }
    var res = resolveColumns(rows[0]);
    out.columnReport = res;
    out.errors = out.errors.concat(res.errors);
    out.warnings = out.warnings.concat(res.warnings);
    if (res.errors.length) return out;

    // Drop trailing blank rows and Shopify's own "Total" summary line.
    var body = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var t = String(r[res.cols.dims.title] == null ? "" : r[res.cols.dims.title]).trim();
      var allBlank = true;
      for (var c = 0; c < r.length; c++) { if (String(r[c] == null ? "" : r[c]).trim() !== "") { allBlank = false; break; } }
      if (allBlank) continue;
      if (!t) { out.warnings.push("Row " + (i + 1) + " has no product title and was skipped."); continue; }
      if (t.toLowerCase() === "total" || t === "Product title") continue;
      body.push(r);
    }
    out.rowCount = body.length;
    if (!body.length) { out.errors.push("No product rows found after the header."); return out; }

    var roles = verifyPrevColumnRoles(body, res.cols);
    out.prevRoles = roles;
    var prevCols = res.cols.prev, pctCols = res.cols.pct;
    if (roles.swapped) { prevCols = res.cols.pct; pctCols = res.cols.prev; }
    var trustPrior = res.hasPrev && roles.verified;
    if (res.hasPrev && !roles.verified) out.warnings.push(roles.note);
    out.capabilities.hasPrior = trustPrior;

    // Aggregate on title + vendor + product type.
    // This is a FALLBACK identity, not a product id: the export carries no
    // SKU, product id or variant id. Renaming a product, moving it to another
    // vendor or changing its type breaks the link to prior periods, which is
    // why `identityBasis` travels with every record and why a missing prior is
    // reported as "no prior sales recorded", never as a confirmed new product.
    var byKey = Object.create(null);
    var order = [];
    var dupKeys = Object.create(null);

    for (var b = 0; b < body.length; b++) {
      var row = body[b];
      var title = String(row[res.cols.dims.title] == null ? "" : row[res.cols.dims.title]).trim();
      var vendor = String(row[res.cols.dims.vendor] == null ? "" : row[res.cols.dims.vendor]).trim() || UNKNOWN_VENDOR;
      var ptypeRaw = String(row[res.cols.dims.ptype] == null ? "" : row[res.cols.dims.ptype]).trim();
      var ptype = ptypeRaw || UNCLASSIFIED_TYPE;
      var pidCell = res.cols.dims.productId != null ? row[res.cols.dims.productId] : null;
      var productId = pidCell == null ? "" : String(pidCell).trim();
      if (productId && !/^\d+$/.test(productId)) {
        out.warnings.push("Row " + (b + 2) + " has a non-numeric Product ID and is keyed by title instead.");
        productId = "";
      }
      // With a Shopify product id the id IS the identity: renames, vendor moves
      // and type changes no longer break the link to prior periods. Without
      // one, title + vendor + type is the fallback, and is labelled as such.
      var productKey = productId ? "pid:" + productId : title + "\u241F" + vendor + "\u241F" + ptype;
      // With a channel column each product appears once per channel. The
      // channel is part of the row identity, so channels are never summed by
      // accident here; views merge them explicitly when a scope spans several.
      var salesChannel = res.cols.dims.salesChannel != null
        ? String(row[res.cols.dims.salesChannel] == null ? "" : row[res.cols.dims.salesChannel]).trim() : "";
      if (res.cols.dims.salesChannel != null && !salesChannel) salesChannel = "(no channel)";
      var key = salesChannel ? productKey + "\u241Fch:" + salesChannel : productKey;

      var rec = byKey[key];
      if (!rec) {
        rec = byKey[key] = {
          key: key, productKey: productKey, title: title, vendor: vendor,
          ptype: ptype, ptypeBlank: !ptypeRaw,
          identityBasis: productId ? "product_id" : "title+vendor+type",
          productId: productId || null,
          salesChannel: salesChannel || null,
          channelGroup: salesChannel ? channelGroupOf(salesChannel) : "",
          sourceRows: 0,
          cur: blankTotals(), prior: blankTotals(),
          reportedPct: {}, hasPrior: false
        };
        order.push(key);
      } else {
        dupKeys[key] = (dupKeys[key] || 1) + 1;
        out.aggregatedRows++;
      }
      rec.sourceRows++;

      for (var mi = 0; mi < MEASURES.length; mi++) {
        var k = MEASURES[mi].key;
        var cv = num(row[res.cols.cur[k]]);
        rec.cur[k] = n0(rec.cur[k]) + n0(cv);
        if (trustPrior && prevCols[k] != null) {
          var pv = num(row[prevCols[k]]);
          rec.prior[k] = n0(rec.prior[k]) + n0(pv);
          if (pv != null) rec.hasPrior = true;
        }
        if (pctCols && pctCols[k] != null && rec.sourceRows === 1) {
          rec.reportedPct[k] = num(row[pctCols[k]]); // kept for audit only, never used as a value
        }
      }
    }

    Object.keys(dupKeys).forEach(function (k) {
      out.warnings.push("Aggregated " + dupKeys[k] + " rows sharing title + vendor + product type: \"" +
                        byKey[k].title + "\" / " + byKey[k].vendor + " / " + byKey[k].ptype + ".");
    });

    // Finalise records
    out.capabilities.hasProductId = order.some(function (k) { return !!byKey[k].productId; });
    out.capabilities.hasSalesChannel = res.cols.dims.salesChannel != null;
    if (res.cols.dims.productId != null && !out.capabilities.hasProductId) {
      out.warnings.push("A Product ID column is present but empty on every row.");
    }
    var classify = typeof opts.classify === "function" ? opts.classify : null;
    for (var o = 0; o < order.length; o++) {
      var r2 = byKey[order[o]];
      MEASURE_KEYS.forEach(function (k) {
        r2.cur[k] = round2(n0(r2.cur[k]));
        r2.prior[k] = round2(n0(r2.prior[k]));
      });
      r2.cur.units = Math.round(r2.cur.units);
      r2.prior.units = Math.round(r2.prior.units);
      r2.priorKnown = trustPrior;
      r2.channel = "shopify";
      if (classify) {
        var cl = classify(r2) || {};
        r2.groupType = cl.groupType || "Product category";
        r2.group = cl.group || UNCLASSIFIED_TYPE;
        r2.isPlant = !!cl.isPlant;
        r2.genus = cl.genus || "";
        r2.category = cl.category || "";
        r2.classificationBasis = cl.basis;
        // An override changes the analytics group only. `ptype` above is the
        // product type exactly as the export stated it and is never rewritten.
        r2.overridden = !!cl.overridden;
        r2.overrideNote = cl.overrideNote || "";
        r2.naturalGroup = cl.natural ? cl.natural.group : r2.group;
        r2.naturalGroupType = cl.natural ? cl.natural.groupType : r2.groupType;
      }
      r2.suspicion = opts.suspicion ? (opts.suspicion(r2) || null) : null;
      out.records.push(r2);
      addTotals(out.totals.current, r2.cur);
      if (trustPrior) addTotals(out.totals.prior, r2.prior);
    }
    roundTotals(out.totals.current);
    roundTotals(out.totals.prior);
    if (out.capabilities.hasSalesChannel) out.channelTotals = channelTotals(out.records);

    // Internal consistency: gross + discounts + reversals should equal net,
    // and net + taxes should equal total. A mismatch means the export is not
    // what we think it is, so it is surfaced rather than quietly absorbed.
    var t = out.totals.current;
    var derivedNet = round2(t.gross + t.disc + t.ret);
    if (Math.abs(derivedNet - t.net) > 0.05) {
      out.warnings.push("Gross + discounts + sales reversals (" + derivedNet.toFixed(2) +
                        ") does not equal net sales (" + t.net.toFixed(2) + ").");
    }
    var derivedTotal = round2(t.net + t.tax);
    if (Math.abs(derivedTotal - t.total) > 0.05) {
      out.warnings.push("Net sales + taxes (" + derivedTotal.toFixed(2) +
                        ") does not equal total sales (" + t.total.toFixed(2) + ").");
    }

    out.ok = out.errors.length === 0;
    if (opts.strict && out.warnings.length && !out.ok) out.records = [];
    return out;
  }

  function blankTotals() {
    var o = {};
    MEASURE_KEYS.forEach(function (k) { o[k] = 0; });
    return o;
  }
  function addTotals(dst, src) {
    MEASURE_KEYS.forEach(function (k) { dst[k] += n0(src[k]); });
    return dst;
  }
  function roundTotals(t) {
    MEASURE_KEYS.forEach(function (k) { t[k] = round2(t[k]); });
    t.units = Math.round(t.units);
    return t;
  }

  // Reconcile a parse against figures read off the source report.
  // Used by the import step as a control, never as a hardcoded dashboard value.
  function reconcile(totals, expected, tolerance) {
    var tol = tolerance == null ? 0.01 : tolerance;
    var checks = [];
    Object.keys(expected || {}).forEach(function (k) {
      var got = totals[k], want = expected[k];
      var delta = round2(n0(got) - n0(want));
      checks.push({ measure: k, expected: want, got: got, delta: delta, ok: Math.abs(delta) <= tol });
    });
    return { ok: checks.every(function (c) { return c.ok; }), checks: checks };
  }

  // ----------------------------------------------------------
  // Change calculation
  // ----------------------------------------------------------
  // Always computed from verified current and prior values. The percentage
  // columns in the export are never used as a source of truth.
  //   state: "new"      prior is 0 (or absent) and current is non-zero
  //          "lapsed"   prior non-zero, current 0
  //          "none"     both 0
  //          "ok"       a percentage is meaningful
  //          "unknown"  no prior period captured for this snapshot
  function change(cur, prior, priorKnown) {
    cur = n0(cur);
    if (priorKnown === false) return { abs: null, pct: null, state: "unknown" };
    prior = n0(prior);
    var abs = round2(cur - prior);
    if (prior === 0 && cur === 0) return { abs: 0, pct: null, state: "none" };
    if (prior === 0) return { abs: abs, pct: null, state: "new" };
    // One formula for every non-zero prior, including a negative one. A prior
    // of -20.00 falling to 0 is +100%, not -100%: the shortcut would invert it.
    var pct = round2((cur - prior) / Math.abs(prior) * 100);
    if (cur === 0) return { abs: abs, pct: pct, state: "lapsed" };
    return { abs: abs, pct: pct, state: "ok" };
  }
  function changeLabel(ch) {
    if (!ch) return "—";
    if (ch.state === "unknown") return "no prior period";
    if (ch.state === "new") return "New / no prior sales";
    if (ch.state === "none") return "—";
    return (ch.pct > 0 ? "+" : "") + ch.pct.toFixed(1) + "%";
  }

  // ----------------------------------------------------------
  // Snapshot shape + stored-report housekeeping
  // ----------------------------------------------------------
  // The stored product keeps the legacy field names the Amazon, Cross-channel,
  // Owned-vs-Market and Opportunity Map views already read (title / units /
  // rev / net / genus) alongside the new vendor, type, group and prior fields,
  // so those views keep working untouched.
  // Same rule as product-grouping.js legacyGenusOf: plant genera and the
  // shared plant-bearing categories; everything else "(no genus)".
  function legacyGenusField(r) {
    if (r.groupType === "Genus" && r.group && r.group !== "Unidentified plant") return r.group;
    if (r.group === "Mixed variety pack" || r.group === "Gifts" || r.group === "Subscriptions") return r.group;
    return "(no genus)";
  }
  function toSnapshotProduct(r) {
    return {
      asin: "", sku: "",
      title: r.title, vendor: r.vendor, ptype: r.ptype, ptypeBlank: !!r.ptypeBlank,
      identityBasis: r.identityBasis, sourceRows: r.sourceRows,
      productId: r.productId || null,
      productKey: r.productKey || null,
      salesChannel: r.salesChannel || null, channelGroup: r.channelGroup || "",
      units: r.cur.units, gross: r.cur.gross, disc: r.cur.disc, ret: r.cur.ret,
      net: r.cur.net, tax: r.cur.tax, rev: r.cur.total,
      avg: r.cur.units ? round2(r.cur.net / r.cur.units) : 0,
      glance: 0, conv: 0, inv: 0,
      genus: legacyGenusField(r),              // legacy semantics, for the other tabs
      genusName: r.genus || "",
      category: r.category || "",
      group: r.group, groupType: r.groupType, isPlant: !!r.isPlant,
      classificationBasis: r.classificationBasis || "",
      overridden: !!r.overridden, overrideNote: r.overrideNote || "",
      naturalGroup: r.naturalGroup || r.group, naturalGroupType: r.naturalGroupType || r.groupType,
      suspicion: r.suspicion || null,
      channel: "shopify",
      cur: r.cur, prior: r.prior, priorKnown: !!r.priorKnown,
      reportedPct: r.reportedPct || {}
    };
  }

  // ----------------------------------------------------------
  // Sales channels
  // ----------------------------------------------------------
  // Per-channel totals, plus the own-store / Amazon-via-Sellbrite split.
  function channelTotals(records) {
    var by = {}, groups = { own: blankTotals(), amazon: blankTotals() };
    (records || []).forEach(function (r) {
      var ch = r.salesChannel || "(no channel)";
      if (!by[ch]) by[ch] = { channel: ch, group: channelGroupOf(ch) || "own", cur: blankTotals(), prior: blankTotals(), rows: 0 };
      by[ch].rows++;
      addTotals(by[ch].cur, r.cur);
      if (r.prior) addTotals(by[ch].prior, r.prior);
      var g = r.channelGroup === "amazon" ? "amazon" : "own";
      addTotals(groups[g], r.cur);
    });
    var list = Object.keys(by).map(function (k) { roundTotals(by[k].cur); roundTotals(by[k].prior); return by[k]; })
      .sort(function (a, b) { return b.cur.net - a.cur.net; });
    roundTotals(groups.own); roundTotals(groups.amazon);
    return { channels: list, own: groups.own, amazon: groups.amazon };
  }

  // What a snapshot says about Amazon orders inside it.
  //   hasChannel        every part of the report carries the Sales channel column,
  //                     so Sellbrite rows can be excluded by their channel value
  //   anyChannel        at least one part carries it (the channel filter applies there)
  //   mayIncludeAmazon  some part has NO channel column and touches March 2026
  //                     or later: Amazon orders may be mixed in and cannot be
  //                     separated, so Shopify + Amazon is not deduplicated
  //   uncovered         those parts ({start, end, level, text})
  //   dedupSafe         Shopify (own store) + Seller Central Amazon may be added
  // A combined period snapshot lists its months in meta.channelCoverage.
  function channelStatus(snap) {
    var recs = (snap && snap.products) || [];
    var meta = (snap && snap.meta) || {};
    var parts;
    if (Array.isArray(meta.channelCoverage) && meta.channelCoverage.length) {
      parts = meta.channelCoverage;
    } else {
      var has = !!(meta.capabilities && meta.capabilities.hasSalesChannel) || recs.some(function (r) { return !!r.salesChannel; });
      parts = [{ start: (snap && (snap.startDate || (meta.current && meta.current.start))) || "",
                 end: (snap && (snap.endDate || (meta.current && meta.current.end))) || "", hasChannel: has }];
    }
    var uncovered = parts.filter(function (p) { return !p.hasChannel; }).map(function (p) {
      var o = sellbriteOverlap(p.start, p.end);
      return { start: p.start, end: p.end, level: o.level, potential: o.potential, text: o.text };
    }).filter(function (p) { return p.potential; });
    var hasChannel = parts.every(function (p) { return p.hasChannel; });
    var anyChannel = parts.some(function (p) { return p.hasChannel; });
    var out = { hasChannel: hasChannel, anyChannel: anyChannel, mayIncludeAmazon: uncovered.length > 0, uncovered: uncovered,
                dedupSafe: uncovered.length === 0, amazonSince: AMAZON_VIA_SHOPIFY_SINCE,
                amazonFullFrom: AMAZON_VIA_SHOPIFY_FULL_FROM, totals: null };
    if (anyChannel) out.totals = channelTotals(recs.filter(function (r) { return r.cur && r.salesChannel; }));
    return out;
  }
  // One plain sentence for a status from channelStatus(), or "".
  function overlapNote(st) {
    if (!st || !st.mayIncludeAmazon) return "";
    var u = st.uncovered.map(function (p) { return p.start + " → " + p.end; }).join(", ");
    var level = st.uncovered.length === 1 ? st.uncovered[0].level : "mixed";
    var why = level === "partial" ? "March 2026 is a partial-month overlap (Amazon orders reached Shopify through Sellbrite from an unknown day in March)"
      : level === "full" ? "from April 2026 Amazon orders reach Shopify through Sellbrite every day"
      : "Amazon orders reached Shopify through Sellbrite from an unknown day in March 2026 and every day from April 2026";
    return "Without a Sales channel column (" + u + "), these Shopify figures may include Amazon orders: " + why +
      ". Shopify and Amazon totals are kept separate and are not deduplicated.";
  }

  function isNewFormatSnapshot(snap) {
    return !!(snap && snap.products && snap.products.length && snap.products[0].cur && snap.products[0].group);
  }

  // Bring a snapshot imported before this release into the new shape so it
  // still renders. Vendor and prior-period figures genuinely are not in it;
  // they are marked unknown rather than invented.
  function liftLegacySnapshot(snap, classify) {
    return (snap.products || []).map(function (p) {
      var cur = {
        units: p.units || 0, gross: p.gross || 0, disc: p.disc || 0, ret: p.ret || 0,
        net: p.net || 0, tax: round2((p.rev || 0) - (p.net || 0)), total: p.rev || 0
      };
      var rec = {
        title: p.title, vendor: p.vendor || UNKNOWN_VENDOR,
        ptype: p.ptype || UNCLASSIFIED_TYPE, ptypeBlank: !p.ptype,
        cur: cur, prior: blankTotals(), priorKnown: false,
        identityBasis: "title (legacy snapshot)", sourceRows: 1, reportedPct: {}
      };
      var c = (classify && classify(rec)) || {};
      rec.group = c.group || UNCLASSIFIED_TYPE;
      rec.groupType = c.groupType || "Product category";
      rec.isPlant = !!c.isPlant;
      rec.genus = c.genus || "";
      rec.category = c.category || "";
      rec.classificationBasis = c.basis || "";
      rec.overridden = !!c.overridden;
      rec.naturalGroup = c.natural ? c.natural.group : rec.group;
      rec.naturalGroupType = c.natural ? c.natural.groupType : rec.groupType;
      rec.channel = "shopify";
      rec.suspicion = null;
      var out = toSnapshotProduct(rec);
      out.legacy = true;
      return out;
    });
  }

  // Re-importing the same scope and period must REVISE that report, never add
  // its totals again. Identity is source + report scope + the two period dates.
  function reportKey(snap) {
    var scope = (snap.meta && snap.meta.reportScope) || "default";
    return [snap.source || "shopify", scope, snap.startDate, snap.endDate].join("␟");
  }
  function upsertReport(list, snap) {
    var key = reportKey(snap);
    var replaced = 0;
    var next = (list || []).filter(function (s) {
      if (s.source !== snap.source || s.isCatalog) return true;
      if (reportKey(s) === key || s.id === snap.id) { replaced++; return false; }
      return true;
    });
    next.push(snap);
    return { list: next, replaced: replaced };
  }
  function periodsOverlap(a, b) {
    if (!a || !b || !a.startDate || !b.startDate) return false;
    return a.startDate <= b.endDate && b.startDate <= a.endDate;
  }
  // Reports that overlap in time are snapshots of the same sales, so they must
  // never be added together.
  function overlappingReports(list, source) {
    var rs = (list || []).filter(function (s) { return s.source === source && !s.isCatalog; });
    var out = [];
    for (var i = 0; i < rs.length; i++) {
      for (var j = i + 1; j < rs.length; j++) {
        if (periodsOverlap(rs[i], rs[j])) out.push([rs[i].id, rs[j].id]);
      }
    }
    return out;
  }

  return {
    SHOPIFY_MEASURES: MEASURES,
    SHOPIFY_MEASURE_KEYS: MEASURE_KEYS,
    SHOPIFY_UNCLASSIFIED_TYPE: UNCLASSIFIED_TYPE,
    SHOPIFY_UNKNOWN_VENDOR: UNKNOWN_VENDOR,
    shopifyNum: num,
    shopifyResolveColumns: resolveColumns,
    verifyPrevColumnRoles: verifyPrevColumnRoles,
    isShopifyProductReport: isShopifyProductReport,
    parseShopifyProductReport: parseShopifyProductReport,
    shopifyReconcile: reconcile,
    shopifyChange: change,
    shopifyChangeLabel: changeLabel,
    shopifyBlankTotals: blankTotals,
    shopifyAddTotals: addTotals,
    shopifyRoundTotals: roundTotals,
    shopifyToSnapshotProduct: toSnapshotProduct,
    shopifyIsNewFormatSnapshot: isNewFormatSnapshot,
    shopifyLiftLegacySnapshot: liftLegacySnapshot,
    shopifyReportKey: reportKey,
    shopifyUpsertReport: upsertReport,
    shopifyPeriodsOverlap: periodsOverlap,
    shopifyOverlappingReports: overlappingReports,
    shopifyChannelGroupOf: channelGroupOf,
    shopifyChannelTotals: channelTotals,
    shopifyChannelStatus: channelStatus,
    SHOPIFY_AMAZON_VIA_SHOPIFY_SINCE: AMAZON_VIA_SHOPIFY_SINCE,
    SHOPIFY_AMAZON_VIA_SHOPIFY_FULL_FROM: AMAZON_VIA_SHOPIFY_FULL_FROM,
    shopifySellbriteOverlap: sellbriteOverlap,
    shopifyOverlapNote: overlapNote
  };
});
