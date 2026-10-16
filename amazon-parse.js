// ============================================================
// amazon-parse.js
// Header-based, validated parser for Amazon Seller Central exports, with the
// same discipline as the Shopify parser: resolve columns by HEADER, declare
// what the file does and does not carry, and never let a measure land in the
// wrong field because a column moved.
//
// WHY THIS EXISTS
// app.js's parseAmazon reads the "metric data" export POSITIONALLY, assuming
//   A=ASIN B=title C=glance D=conversion E=units F=avg price G=revenue H=inventory
// Seller Central's actual metric-data export is
//   A=ASIN B=Item name C=Conversion rate (%) D=Featured Offer glance views
//   E=Featured Offer rate F=Ordered units G=Shipped units
// so the positional reader puts conversion into glance views, glance views
// into conversion (then divides by 100), Featured Offer rate into units and
// shipped units into revenue. It also invents a revenue and an inventory
// column that this export does not have at all.
//
// Nothing here guesses. A measure the file does not contain is reported as
// absent, and the dashboard hides it rather than showing a fabricated $0.00.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // Amazon renames columns between report versions and sometimes appends a
  // unit, e.g. "Ordered revenue ($)". The unit suffix is stripped for MATCHING
  // only; the raw header is kept for labels and for the column report.
  function norm(h) {
    return String(h == null ? "" : h).replace(/﻿/g, "").trim().toLowerCase().replace(/\s+/g, " ")
      .replace(/\s*\(\$\)$/, "").replace(/\s*\(usd\)$/, "");
  }
  function num(x) {
    if (typeof x === "number") return isFinite(x) ? x : null;
    if (x == null) return null;
    var s = String(x).trim();
    if (s === "" || s === "-" || s === "—") return null;
    var pct = /%$/.test(s);
    var neg = /^\(.*\)$/.test(s);
    if (neg) s = s.slice(1, -1);
    s = s.replace(/[$,\s]/g, "").replace(/%$/, "");
    var n = parseFloat(s);
    if (!isFinite(n)) return null;
    if (neg) n = -n;
    return pct ? n / 100 : n;
  }
  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }

  // Canonical fields -> the header spellings Amazon has used for them.
  // Order matters only within a field: the first match wins.
  //
  // Known layouts of the metric-data export:
  //   v1:             ASIN | Item name | Conversion rate (%) |
  //       Featured Offer glance views | Featured Offer rate | Ordered units | Shipped units
  //   v2:             ASIN | Item name | Glance views | Conversion rate (%) | Shipped units |
  //       Average selling price ($) | Shipped revenue ($) | Available Inventory Units |
  //       Ordered revenue ($) | Total order items | Units per Order Item | Ordered units
  //
  // REVENUE is deliberately ORDERED revenue, because the units measure is
  // ordered units. Shipped revenue is kept in its own field and never paired
  // with ordered units.
  var FIELDS = {
    asin:     ["asin", "(child) asin", "child asin", "(parent) asin", "parent asin"],
    title:    ["item name", "title", "product name"],
    sku:      ["sku", "merchant sku", "seller sku"],
    glance:   ["glance views", "featured offer glance views", "sessions - total", "sessions",
               "page views - total", "page views"],
    conv:     ["conversion rate (%)", "conversion rate", "unit session percentage", "unit session percentage - b2b"],
    units:    ["ordered units", "units ordered", "units ordered - b2b", "quantity ordered"],
    shipped:  ["shipped units", "units shipped"],
    revenue:  ["ordered revenue", "ordered product sales", "ordered product sales - b2b", "product sales"],
    shippedRevenue: ["shipped revenue", "shipped product sales"],
    asp:      ["average selling price", "average sales price", "avg sales price", "average price"],
    inv:      ["available inventory units", "available inventory", "sellable on hand inventory", "inventory"],
    orderItems: ["total order items", "order items"],
    unitsPerItem: ["units per order item"],          // derived by Amazon; recognised, not used
    buybox:   ["featured offer rate", "featured offer (buy box) percentage", "buy box percentage"]
  };

  // Fields a person can map a column to, with the label shown in the mapper.
  var MAPPABLE = {
    asin: "ASIN", title: "Product title", sku: "SKU",
    units: "Ordered units", shipped: "Shipped units",
    revenue: "Ordered revenue / sales", shippedRevenue: "Shipped revenue",
    glance: "Traffic (glance views / sessions / page views)", conv: "Conversion rate",
    asp: "Average selling price (reference only)", inv: "Available inventory",
    orderItems: "Order items", unitsPerItem: "Units per order item (ignored)",
    buybox: "Featured Offer / buy-box rate", ignore: "Ignore this column"
  };

  // resolveColumns(header, mapping)
  //   mapping: { "<normalised header>": "<field>" | "ignore" } confirmed by a
  //   person for this report format. Confirmed mappings are applied FIRST;
  //   the built-in spellings fill in the rest.
  function resolveColumns(headerRow, mapping) {
    var raw = (headerRow || []).map(function (h) { return String(h == null ? "" : h); });
    var seen = raw.map(norm);
    var cols = {}, matched = {}, ignored = {};
    var m = mapping || {};
    seen.forEach(function (h, i) {
      var f = m[h];
      if (!f) return;
      if (f === "ignore") { ignored[i] = true; return; }
      if (cols[f] == null && FIELDS[f]) { cols[f] = i; matched[i] = f; }
    });
    Object.keys(FIELDS).forEach(function (field) {
      if (cols[field] != null) return;
      var names = FIELDS[field];
      for (var n = 0; n < names.length; n++) {
        var i = seen.indexOf(names[n]);
        if (i >= 0 && matched[i] == null && !ignored[i]) { cols[field] = i; matched[i] = field; return; }
      }
    });
    var unknown = [];
    seen.forEach(function (h, i) { if (h && matched[i] == null && !ignored[i]) unknown.push(raw[i]); });
    return { cols: cols, unknown: unknown, headerRaw: raw };
  }

  // Formats seen in this store's own exports, by exact header fingerprint.
  var KNOWN_FORMATS = {
    "asin | item name | conversion rate (%) | featured offer glance views | featured offer rate | ordered units | shipped units":
      "metric-data v1",
    "asin | item name | glance views | conversion rate (%) | shipped units | average selling price | shipped revenue | available inventory units | ordered revenue | total order items | units per order item | ordered units":
      "metric-data v2"
  };
  function shortHash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return ("000000" + h.toString(16)).slice(-6);
  }

  // A stable fingerprint of a report format: the normalised headers, in order.
  // When Amazon changes the export, the signature changes, and the change is
  // shown to a person instead of being absorbed silently.
  function headerSignature(headerRow) {
    return (headerRow || []).map(norm).filter(Boolean).join(" | ");
  }

  // Keyword suggestions for headers the parser does not recognise. These are
  // SUGGESTIONS for the mapping dialog only — nothing is ever mapped from them
  // without a person confirming.
  var SUGGEST_RULES = [
    ["asin", /\basin\b/],
    ["sku", /\bsku\b/],
    ["title", /\b(title|item name|product name)\b/],
    ["unitsPerItem", /\bper\b.*\border item\b|\bunits per\b/],
    ["shippedRevenue", /\bship(ped)?\b.*\b(revenue|sales)\b|\b(revenue|sales)\b.*\bship(ped)?\b/],
    ["shipped", /\bship(ped)?\b.*\bunits?\b|\bunits?\b.*\bship(ped)?\b/],
    ["revenue", /\b(ordered|order)\b.*\b(revenue|sales)\b|\b(revenue|sales)\b.*\bordered\b|^(revenue|sales|product sales|total sales)$/],
    ["units", /\b(ordered|order)\b.*\bunits?\b|\bunits?\b.*\bordered\b|^units( sold)?$/],
    ["orderItems", /\border items?\b|\bitems ordered\b/],
    ["conv", /\bconversion\b|\bunit session\b/],
    ["buybox", /\bfeatured offer (rate|%|percentage)\b|\bbuy ?box\b/],
    ["glance", /\bglance\b|\bpage ?views?\b|\bsessions?\b|\bimpressions?\b/],
    ["asp", /\b(average|avg)\b.*\bprice\b/],
    ["inv", /\binventory\b|\bon hand\b|\bin stock\b/]
  ];
  function suggestField(header) {
    var h = norm(header);
    var hits = SUGGEST_RULES.filter(function (r) { return r[1].test(h); }).map(function (r) { return r[0]; });
    if (!hits.length) return { field: "ignore", confidence: "none", alternatives: [] };
    return { field: hits[0], confidence: hits.length === 1 ? "high" : "low", alternatives: hits.slice(1) };
  }

  // Everything the importer needs to decide whether a person must look at the
  // columns before the file is accepted.
  //   knownSignatures: signatures already confirmed (or built in)
  function assessFormat(headerRow, mapping, knownSignatures) {
    var res = resolveColumns(headerRow, mapping);
    var sig = headerSignature(headerRow);
    var known = (knownSignatures || []).indexOf(sig) >= 0;
    var missingCore = [];
    if (res.cols.title == null) missingCore.push("title");
    if (res.cols.asin == null && res.cols.sku == null) missingCore.push("asin");
    if (res.cols.units == null && res.cols.glance == null) missingCore.push("units or traffic");
    var suggestions = res.unknown.map(function (h) {
      return Object.assign({ header: h, normalised: norm(h) }, suggestField(h));
    });
    // A mapping is needed when the format is new AND something is unresolved:
    // a core field is missing, or a column the parser does not know looks like
    // a measure we would otherwise lose.
    var losesMeasure = suggestions.some(function (x) { return x.field !== "ignore" && x.field !== "unitsPerItem" && res.cols[x.field] == null; });
    return {
      signature: sig,
      known: known,
      resolved: res.cols,
      unknown: res.unknown,
      missingCore: missingCore,
      suggestions: suggestions,
      needsMapping: !known && (missingCore.length > 0 || losesMeasure)
    };
  }

  // A confirmed mapping must not send two columns to one field, and must
  // still give the parser something to report.
  function validateMapping(headerRow, mapping) {
    var errors = [];
    var res = resolveColumns(headerRow, mapping);
    var seenField = {};
    Object.keys(mapping || {}).forEach(function (h) {
      var f = mapping[h];
      if (!f || f === "ignore") return;
      if (!FIELDS[f]) { errors.push('"' + h + '" is mapped to an unknown field "' + f + '".'); return; }
      if (seenField[f]) errors.push(MAPPABLE[f] + " is chosen for two columns: \"" + seenField[f] + "\" and \"" + h + "\".");
      seenField[f] = h;
    });
    if (res.cols.title == null) errors.push("No column is mapped to the product title.");
    if (res.cols.asin == null && res.cols.sku == null) errors.push("No column is mapped to ASIN or SKU.");
    if (res.cols.units == null && res.cols.glance == null) errors.push("No column is mapped to ordered units or traffic.");
    return { ok: errors.length === 0, errors: errors };
  }

  // Lenient on purpose: anything with an ASIN-like and a title-like column is
  // routed to THIS parser (which then asks for a mapping if it must), never to
  // app.js's positional reader, which mis-reads any re-ordered export.
  function looksLikeAmazonMetricData(rows) {
    if (!rows || !rows.length) return false;
    var hdr = rows[0] || [];
    var hasAsin = hdr.some(function (h) { var s = suggestField(h).field; return s === "asin" || norm(h) === "asin"; });
    var hasTitle = hdr.some(function (h) { return suggestField(h).field === "title"; });
    return hasAsin && hasTitle;
  }

  // Pull an ASIN out of a =HYPERLINK("https://amazon.com/dp/B0XXXXXXXX","B0XXXXXXXX")
  // formula. The xlsx export puts the ASIN in a formula, not a plain value.
  // Amazon ASINs are exactly 10 characters; the LAST 10-char token is the ASIN
  // (the first is inside the URL).
  function asinFromCellRef(ws, rowIdx, colIdx, XLSXlib) {
    if (!ws || !XLSXlib) return "";
    try {
      var ref = XLSXlib.utils.encode_cell({ c: colIdx, r: rowIdx });
      var c = ws[ref];
      if (!c) return "";
      if (c.f) {
        var m = String(c.f).match(/\b[A-Z0-9]{10}\b/g);
        if (m && m.length) return m[m.length - 1];
      }
      for (var i = 0; i < 3; i++) {
        var k = ["v", "w", "h"][i];
        if (c[k] && typeof c[k] === "string") {
          var mm = c[k].match(/\b[A-Z0-9]{10}\b/);
          if (mm) return mm[0];
        }
      }
    } catch (e) { /* fall through */ }
    return "";
  }

  // opts: { ws, XLSX }  (optional, only needed to read ASIN hyperlink formulas)
  function parseAmazonMetricData(rows, opts) {
    opts = opts || {};
    var out = {
      ok: false, errors: [], warnings: [], products: [], rowCount: 0,
      columnReport: null, totalsRow: null, reconciliation: null,
      capabilities: {
        hasAsin: false, hasSku: false, hasGlance: false, hasConversion: false,
        hasUnits: false, hasShipped: false, hasRevenue: false, hasShippedRevenue: false,
        hasInventory: false, inventoryColumnPresent: false, hasOrderItems: false,
        hasBuyBox: false, hasPrior: false, hasDailyDates: false,
        // Which column each measure came from. Two exports can both have
        // "traffic" yet measure different things, so the basis travels with
        // the snapshot and comparisons can say when they mix bases.
        glanceBasis: null, revenueBasis: null, revenueLabel: null, reportVersion: null
      }
    };
    if (!rows || rows.length < 2) { out.errors.push("The file has no data rows."); return out; }

    var res = resolveColumns(rows[0], opts.mapping);
    out.columnReport = res;
    out.signature = headerSignature(rows[0]);
    var c = res.cols, raw = res.headerRaw;
    if (c.title == null) { out.errors.push('Missing required column: a product title ("Item name").'); return out; }
    if (c.asin == null && c.sku == null) { out.errors.push("Missing required column: ASIN or SKU."); return out; }
    if (c.units == null && c.glance == null) {
      out.errors.push("This file carries neither ordered units nor glance views; there is nothing to report.");
      return out;
    }

    var cap = out.capabilities;
    cap.hasAsin = c.asin != null; cap.hasSku = c.sku != null;
    cap.hasGlance = c.glance != null; cap.hasConversion = c.conv != null;
    cap.hasUnits = c.units != null; cap.hasShipped = c.shipped != null;
    cap.hasShippedRevenue = c.shippedRevenue != null;
    cap.inventoryColumnPresent = c.inv != null;
    cap.hasOrderItems = c.orderItems != null;
    cap.hasBuyBox = c.buybox != null;
    cap.glanceBasis = c.glance != null ? raw[c.glance].trim() : null;

    // Revenue must pair with the units measure. Units are ORDERED units, so
    // the preferred revenue is ORDERED revenue. Only when a file has no ordered
    // revenue at all do we fall back to shipped revenue — and then the label
    // says so and the average is shipped revenue / shipped units.
    var revCol = null;
    if (c.revenue != null) { revCol = c.revenue; cap.revenueBasis = "ordered"; }
    else if (c.shippedRevenue != null) { revCol = c.shippedRevenue; cap.revenueBasis = "shipped"; }
    cap.hasRevenue = revCol != null;
    cap.revenueLabel = revCol != null ? raw[revCol].trim() : null;
    // The version is the exact header fingerprint, not a guess from which
    // measures exist: a renamed format with the same measures may still count
    // traffic differently, and must not share an identity with v1 or v2.
    var sigNow = headerSignature(rows[0]);
    cap.formatSignature = sigNow;
    cap.reportVersion = KNOWN_FORMATS[sigNow] || ("metric-data new format " + shortHash(sigNow));

    if (!cap.hasRevenue) {
      out.warnings.push("This export carries no sales figure. Amazon totals are reported in units and " +
                        "traffic only; no revenue is shown, and none is inferred.");
    } else if (cap.revenueBasis === "shipped") {
      out.warnings.push("This export has shipped revenue but no ordered revenue. Sales are shown as shipped " +
                        "revenue and labelled that way; they are not comparable to ordered revenue.");
    }
    var known = {};
    Object.keys(c).forEach(function (k) { known[c[k]] = true; });
    if (res.unknown.length) {
      out.warnings.push("Unrecognised columns were ignored: " + res.unknown.slice(0, 6).join(", ") + ".");
    }

    var invSum = 0, invNonZero = 0;

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      var firstIdx = c.asin != null ? c.asin : 0;
      var first = String(r[firstIdx] == null ? "" : r[firstIdx]).trim();
      var title = String(r[c.title] == null ? "" : r[c.title]).trim();

      // Amazon puts a Total line at the top. Keep it for reconciliation
      // instead of silently discarding it.
      if (first.toLowerCase() === "total") {
        var g = function (k) { return c[k] != null ? num(r[c[k]]) : null; };
        out.totalsRow = {
          glance: g("glance"), conv: g("conv"), units: g("units"), shipped: g("shipped"),
          revenue: revCol != null ? num(r[revCol]) : null,
          shippedRevenue: g("shippedRevenue"), inv: g("inv"), orderItems: g("orderItems"), asp: g("asp")
        };
        continue;
      }
      if (!title) continue;

      var asin = "";
      if (c.asin != null) {
        asin = asinFromCellRef(opts.ws, i, c.asin, opts.XLSX) || "";
        if (!asin) {
          var m = first.match(/\b[A-Z0-9]{10}\b/);
          asin = m ? m[0] : (/^[A-Z0-9]{10}$/.test(first) ? first : "");
        }
      }

      var conv = c.conv != null ? num(r[c.conv]) : null;
      // "Conversion rate (%)" arrives as a fraction in these exports (0.0309)
      // but as a percentage in others (3.09). Anything above 1 is a percent.
      if (conv != null && conv > 1) conv = conv / 100;

      var units = c.units != null ? num(r[c.units]) : null;
      var shipped = c.shipped != null ? num(r[c.shipped]) : null;
      var glance = c.glance != null ? num(r[c.glance]) : null;
      var revenue = revCol != null ? num(r[revCol]) : null;
      var shippedRevenue = c.shippedRevenue != null ? num(r[c.shippedRevenue]) : null;
      var asp = c.asp != null ? num(r[c.asp]) : null;
      var inv = c.inv != null ? num(r[c.inv]) : null;
      if (inv) { invNonZero++; invSum += inv; }

      // Average per unit is OUR figure: revenue / the units it pairs with.
      // Amazon's own "Average selling price" is kept separately for reference
      // and never mixed into the dashboard's averages.
      var pairUnits = cap.revenueBasis === "shipped" ? shipped : units;
      var avg = revenue != null && pairUnits ? r2(revenue / pairUnits) : 0;

      out.products.push({
        asin: asin,
        sku: c.sku != null ? String(r[c.sku] == null ? "" : r[c.sku]).trim() : "",
        title: title,
        glance: Math.round(glance || 0),
        conv: conv || 0,
        units: Math.round(units || 0),
        shipped: Math.round(shipped || 0),
        avg: avg,
        rev: revenue != null ? r2(revenue) : 0,
        shippedRev: shippedRevenue != null ? r2(shippedRevenue) : 0,
        amazonAsp: asp != null ? r2(asp) : null,
        orderItems: c.orderItems != null ? Math.round(num(r[c.orderItems]) || 0) : 0,
        inv: inv != null ? Math.round(inv) : 0,
        revenueKnown: cap.hasRevenue,
        inventoryKnown: false            // settled below, once every row is seen
      });
    }

    out.rowCount = out.products.length;
    if (!out.rowCount) { out.errors.push("No product rows found after the header."); return out; }

    // An inventory column that is zero on EVERY row is not evidence that
    // everything is out of stock. Taken literally it would flag every product
    // with traffic as out of stock, so it is treated as not reported.
    if (c.inv != null && invNonZero === 0) {
      cap.hasInventory = false;
      out.warnings.push("The inventory column (\"" + raw[c.inv].trim() + "\") is present but zero on all " +
                        out.rowCount + " products. It is treated as not reported, so products are not " +
                        "flagged as out of stock on the strength of it.");
    } else if (c.inv != null) {
      cap.hasInventory = true;
    } else {
      out.warnings.push("This export carries no inventory column, so out-of-stock alerts are unavailable for it.");
    }
    out.products.forEach(function (p) { p.inventoryKnown = cap.hasInventory; });

    // Reconcile against Amazon's own Total line where it gave us one.
    if (out.totalsRow) {
      var checks = [];
      var sum = function (f) { return out.products.reduce(function (s, p) { return s + (p[f] || 0); }, 0); };
      var intCheck = function (measure, field, want) {
        if (want == null) return;
        var got = sum(field);
        checks.push({ measure: measure, got: got, want: Math.round(want), ok: got === Math.round(want) });
      };
      var moneyCheck = function (measure, field, want) {
        if (want == null) return;
        var got = r2(sum(field));
        checks.push({ measure: measure, got: got, want: r2(want), ok: Math.abs(got - r2(want)) <= 0.02 });
      };
      intCheck("units", "units", out.totalsRow.units);
      intCheck("shipped", "shipped", out.totalsRow.shipped);
      intCheck("glance", "glance", out.totalsRow.glance);
      intCheck("orderItems", "orderItems", out.totalsRow.orderItems);
      if (cap.hasRevenue) moneyCheck("revenue", "rev", out.totalsRow.revenue);
      moneyCheck("shippedRevenue", "shippedRev", out.totalsRow.shippedRevenue);
      out.reconciliation = { checks: checks, ok: checks.every(function (x) { return x.ok; }) };
      checks.filter(function (x) { return !x.ok; }).forEach(function (x) {
        out.warnings.push("Rows sum to " + x.got + " for " + x.measure +
                          " but Amazon's Total line says " + x.want + ".");
      });
    }

    out.ok = out.errors.length === 0;
    return out;
  }

  return {
    AMAZON_FIELDS: FIELDS,
    amazonNorm: norm,
    amazonNum: num,
    amazonResolveColumns: resolveColumns,
    looksLikeAmazonMetricData: looksLikeAmazonMetricData,
    parseAmazonMetricData: parseAmazonMetricData,
    AMAZON_MAPPABLE: MAPPABLE,
    amazonHeaderSignature: headerSignature,
    amazonSuggestField: suggestField,
    amazonAssessFormat: assessFormat,
    amazonValidateMapping: validateMapping,
    AMAZON_KNOWN_FORMATS: KNOWN_FORMATS
  };
});
