// ============================================================
// amazon-report.js
// Normalizes Amazon snapshots (produced by app.js's parseAmazon) into the
// same record shape the Shopify path uses, so product-grouping.js drives the
// Amazon charts, tables, drill-downs, comparisons and exports too.
//
// What the Amazon export does and does not carry
//   HAS:  ASIN, title, glance views / sessions, units ordered, conversion,
//         ordered product sales, available inventory.
//   HAS NOT: product vendor, product type, previous-period columns, tax,
//         discounts, sales reversals, SKU-level variant structure.
//
// So: Amazon grouping comes from the title, its sales figure is Ordered
// product sales (a pre-tax figure, never presented as tax-exclusive revenue
// alongside Shopify's Total sales), and a comparison is between two saved
// snapshots rather than columns inside one file.
// ============================================================
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  var AMAZON_NO_VENDOR = "(not in Amazon export)";
  var AMAZON_NO_TYPE = "(not in Amazon export)";

  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }
  function normTitle(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function blank() {
    return { units: 0, gross: 0, disc: 0, ret: 0, net: 0, tax: 0, total: 0, glance: 0, inv: 0 };
  }

  // One stored Amazon product -> one shared record.
  function toRecord(p) {
    var sales = r2(p.rev);
    return {
      channel: "amazon",
      asin: String(p.asin || "").trim(),
      sku: String(p.sku || "").trim(),
      title: String(p.title || "").trim(),
      // Stated explicitly rather than left blank, so the UI never implies the
      // export had a vendor or a product type and we lost it.
      vendor: AMAZON_NO_VENDOR,
      ptype: AMAZON_NO_TYPE,
      ptypeBlank: true,
      importedType: "",
      identityBasis: p.asin ? "ASIN" : "title",
      sourceRows: 1,
      cur: {
        units: Math.round(+p.units || 0),
        gross: 0, disc: 0, ret: 0,
        net: sales,          // Ordered product sales
        tax: 0,
        total: sales,        // identical: the export states no tax
        glance: Math.round(+p.glance || 0),
        inv: Math.round(+p.inv || 0)
      },
      prior: blank(),
      priorKnown: false,
      reportedPct: {}
    };
  }

  // Match the current period to a prior snapshot. ASIN first, because it is a
  // real identifier; title only as a fallback, and the basis is recorded so
  // the UI never presents a title match as an identifier match.
  function attachPrior(records, priorRecords) {
    var byAsin = Object.create(null), byTitle = Object.create(null);
    (priorRecords || []).forEach(function (p) {
      if (p.asin) byAsin[p.asin] = p;
      var t = normTitle(p.title);
      if (t && !byTitle[t]) byTitle[t] = p;
    });
    records.forEach(function (r) {
      var hit = (r.asin && byAsin[r.asin]) || byTitle[normTitle(r.title)] || null;
      r.priorKnown = true;                       // a prior period IS selected
      r.priorMatch = hit ? (r.asin && byAsin[r.asin] ? "asin" : "title") : "none";
      r.prior = hit ? Object.assign({}, hit.cur) : blank();
    });
    return records;
  }

  // opts: { classify(rec), suspicion(rec) }
  function normalizeSnapshot(snap, opts) {
    opts = opts || {};
    var recs = (snap && snap.products ? snap.products : []).map(toRecord);
    recs.forEach(function (r) {
      var c = opts.classify ? opts.classify(r) : null;
      if (c) {
        r.group = c.group; r.groupType = c.groupType; r.isPlant = !!c.isPlant;
        r.genus = c.genus || "";
        r.category = c.category || "";
        r.ptypeLabel = c.ptypeCanonical || r.ptype || "";
        r.isPack = !!c.pack; r.subscriptionAddOn = !!c.subscriptionAddOn;
        r.classificationBasis = c.basis;
        r.overridden = !!c.overridden;
        r.naturalGroup = c.natural ? c.natural.group : c.group;
        r.naturalGroupType = c.natural ? c.natural.groupType : c.groupType;
      }
      // The Amazon export has no product type at all, so "no product type"
      // is a property of the source, not something to flag on 1,000 rows.
      var s = opts.suspicion ? opts.suspicion(r) : null;
      r.suspicion = s && s.kind !== "missing_type" ? s : null;
      // Legacy fields the Cross-channel / Owned-vs-Market views still read.
      r.units = r.cur.units; r.rev = r.cur.total; r.net = r.cur.net;
      r.glance = r.cur.glance; r.inv = r.cur.inv;
      r.conv = r.cur.glance ? r.cur.units / r.cur.glance : 0;
      r.avg = r.cur.units ? r2(r.cur.net / r.cur.units) : 0;
    });
    return recs;
  }

  // Totals straight off the stored snapshot, used as an import control so the
  // grouped figures can be reconciled back to the source.
  function snapshotTotals(snap) {
    var t = blank();
    (snap && snap.products ? snap.products : []).forEach(function (p) {
      t.units += Math.round(+p.units || 0);
      t.net += (+p.rev || 0);
      t.total += (+p.rev || 0);
      t.glance += Math.round(+p.glance || 0);
      t.inv += Math.round(+p.inv || 0);
    });
    t.net = r2(t.net); t.total = r2(t.total);
    return t;
  }

  // A stored Amazon report is identified by its period AND its report type.
  //
  // Amazon's Custom Analytics widgets export different column sets under the
  // same "metric-data" name: one with "Featured Offer glance views" and no
  // revenue, another with "Glance views" and ordered revenue. They measure
  // traffic differently, so one must never silently replace the other, even
  // for the same period. (A same-period re-import of the SAME type revises it.)
  function snapshotIdentity(start, end, caps) {
    var version = caps && caps.reportVersion ? caps.reportVersion : "";
    var slug = version ? version.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() : "";
    return {
      id: "amazon_" + start + "_" + end + (slug ? "_" + slug : ""),
      labelSuffix: version ? " · " + version : "",
      scope: version || "amazon (unversioned)"
    };
  }

  // Whether two snapshots came from the same Amazon export type. Informational:
  // comparability itself is decided per measure from each file's capabilities.
  function sameReportType(capsA, capsB) {
    var a = capsA && capsA.reportVersion, b = capsB && capsB.reportVersion;
    if (!a || !b) return true;                // legacy snapshots carry no version
    return a === b;
  }

  return {
    amazonSnapshotIdentity: snapshotIdentity,
    amazonSameReportType: sameReportType,
    AMAZON_NO_VENDOR: AMAZON_NO_VENDOR,
    AMAZON_NO_TYPE: AMAZON_NO_TYPE,
    amazonToRecord: toRecord,
    amazonAttachPrior: attachPrior,
    amazonNormalizeSnapshot: normalizeSnapshot,
    amazonSnapshotTotals: snapshotTotals,
    amazonNormTitle: normTitle
  };
});
