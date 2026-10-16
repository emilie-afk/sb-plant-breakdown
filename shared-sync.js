// ============================================================
// shared-sync.js
// Converts between the dashboard's browser snapshots and the Worker's
// shared report store. Pure functions (no DOM, no fetch) so every conversion
// is tested; data-imports-view.js does the clicking and the network.
//
// Nothing here uploads anything by itself. Moving a browser snapshot into
// shared storage is always an explicit action by a person.
// ============================================================
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  var MEASURES = ["units", "gross", "disc", "ret", "net", "tax", "total"];
  var DEFAULT_TZ = "America/Los_Angeles";
  var SHOPIFY_SCOPE = "total_sales_by_product";
  // Snapshots saved before vendor / prior capture existed are uploaded under
  // their own scope, so they can never revise a properly imported report.
  var SHOPIFY_LEGACY_SCOPE = "total_sales_by_product:legacy-browser-snapshot";

  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }
  function sumRows(rows) {
    var t = {}; MEASURES.forEach(function (k) { t[k] = 0; });
    rows.forEach(function (r) { MEASURES.forEach(function (k) { t[k] += (r.cur && r.cur[k]) || 0; }); });
    MEASURES.forEach(function (k) { t[k] = k === "units" ? Math.round(t[k]) : r2(t[k]); });
    return t;
  }

  function isNewShopify(snap) {
    return !!(snap && snap.products && snap.products.length && snap.products[0].cur && snap.products[0].group);
  }

  // ---- browser snapshot -> ingest payload ---------------------
  function payloadFromSnapshot(snap, opts) {
    opts = opts || {};
    if (!snap || !Array.isArray(snap.products) || !snap.products.length) {
      return { ok: false, reason: "This snapshot has no products." };
    }
    if (snap.isCatalog) return { ok: false, reason: "Catalog snapshots are not sales reports and are not uploaded." };
    var meta = snap.meta || {};
    var base = {
      period: { start: snap.startDate, end: snap.endDate },
      timezone: meta.timezone || DEFAULT_TZ,
      currency: meta.currency || "USD",
      sourceFilename: meta.sourceFilename || snap.fileName || null,
      client: opts.client || "dashboard migration",
      importedBy: "manual"
    };

    if (snap.source === "shopify") {
      var rich = isNewShopify(snap);
      var rows = snap.products.map(function (p) {
        var cur = rich ? p.cur : {
          units: p.units || 0, gross: p.gross || 0, disc: p.disc || 0, ret: p.ret || 0,
          net: p.net || 0, tax: r2((p.rev || 0) - (p.net || 0)), total: p.rev || 0
        };
        var row = {
          productId: p.productId || null,
          title: p.title,
          vendor: rich ? p.vendor : "",
          productType: rich && !p.ptypeBlank ? p.ptype : "",
          cur: pick(cur),
          prior: rich && p.priorKnown ? pick(p.prior) : null
        };
        if (rich && p.salesChannel) row.salesChannel = p.salesChannel;
        return row;
      });
      return { ok: true, payload: Object.assign(base, {
        source: "shopify",
        reportScope: rich ? SHOPIFY_SCOPE : SHOPIFY_LEGACY_SCOPE,
        comparison: rich && meta.comparison ? meta.comparison : null,
        sourceCapabilities: meta.capabilities || null,
        totals: sumRows(rows),
        rows: rows
      }), legacy: !rich };
    }

    if (snap.source === "amazon") {
      var caps = meta.capabilities || {};
      var arows = snap.products.map(function (p) {
        var asin = String(p.asin || "").trim();
        return {
          asin: /^[A-Z0-9]{10}$/.test(asin) ? asin : null,
          title: p.title,
          vendor: "(not in Amazon export)",
          productType: "(not in Amazon export)",
          cur: { units: p.units || 0, net: caps.hasRevenue === false ? 0 : (p.rev || 0),
                 total: caps.hasRevenue === false ? 0 : (p.rev || 0),
                 glance: p.glance || 0, inv: caps.hasInventory ? (p.inv || 0) : 0,
                 gross: 0, disc: 0, ret: 0, tax: 0 },
          extra: (p.shipped || p.shippedRev || p.orderItems)
            ? { shipped: p.shipped || 0, shippedRev: p.shippedRev || 0, orderItems: p.orderItems || 0 } : null
        };
      });
      return { ok: true, payload: Object.assign(base, {
        source: "amazon",
        reportScope: meta.reportScope || caps.reportVersion || "amazon (legacy browser snapshot)",
        comparison: null,
        sourceCapabilities: caps,
        totals: sumRows(arows),
        rows: arows
      }), legacy: !meta.capabilities };
    }
    return { ok: false, reason: "Only Shopify and Amazon reports are stored in shared storage." };
  }
  function pick(m) {
    var o = {}; MEASURES.forEach(function (k) { o[k] = m && m[k] != null ? m[k] : 0; }); return o;
  }

  // ---- shared report -> browser snapshot ----------------------
  // Rebuilds a snapshot in the same shape the importers create, so every view
  // renders a shared report exactly like a locally imported one.
  function snapshotFromShared(report, rows, helpers) {
    helpers = helpers || {};
    var caps = report.capabilities || {};
    var meta = {
      schema: report.source === "shopify" ? "shopify-total-sales-by-product/v1" : "amazon-metric-data",
      reportScope: report.report_scope,
      timezone: report.timezone, currency: report.currency,
      sourceFilename: report.source_filename,
      importedAt: report.imported_at,
      current: { start: report.period_start, end: report.period_end },
      comparison: report.comparison_start
        ? { start: report.comparison_start, end: report.comparison_end, source: report.comparison_source } : null,
      totalsAsImported: report.totals,
      capabilities: caps,
      shared: { reportId: report.id, revision: report.revision, contentHash: report.content_hash, importedBy: report.imported_by }
    };
    var label = (helpers.labelFromDates ? helpers.labelFromDates(report.period_start, report.period_end)
                                        : report.period_start + " – " + report.period_end);
    var snap = {
      source: report.source,
      startDate: report.period_start, endDate: report.period_end,
      fileName: report.source_filename || "(shared storage)",
      uploadedAt: report.imported_at,
      meta: meta
    };
    if (report.source === "shopify") {
      var legacy = report.report_scope === SHOPIFY_LEGACY_SCOPE;
      snap.id = "shopify_" + report.period_start + "_" + report.period_end + (legacy ? "_legacy" : "");
      snap.label = label + (legacy ? " · legacy" : "");
      snap.products = rows.map(function (r) {
        var ptypeRaw = r.productType === "Unclassified" ? "" : r.productType;
        var rec = {
          title: r.title, vendor: r.vendor, ptype: r.productType || "Unclassified", ptypeBlank: !ptypeRaw,
          productId: r.productId || null,
          identityBasis: r.productId ? "product_id" : "title+vendor+type", sourceRows: 1,
          productKey: r.productId ? "pid:" + r.productId : [r.title, r.vendor, r.productType || "Unclassified"].join("\u241F"),
          salesChannel: r.salesChannel || null,
          channelGroup: r.salesChannel ? (/\b(sellbrite|amazon)\b/i.test(r.salesChannel) ? "amazon" : "own") : "",
          cur: pick(r.cur), prior: r.prior ? pick(r.prior) : zeros(), priorKnown: !!r.prior, reportedPct: {}, channel: "shopify"
        };
        if (helpers.classify) {
          var c = helpers.classify(rec) || {};
          rec.group = c.group; rec.groupType = c.groupType; rec.isPlant = !!c.isPlant; rec.genus = c.genus || "";
        }
        return helpers.toSnapshotProduct ? helpers.toSnapshotProduct(rec) : rec;
      });
    } else {
      var ident = helpers.amazonSnapshotIdentity
        ? helpers.amazonSnapshotIdentity(report.period_start, report.period_end, caps)
        : { id: "amazon_" + report.period_start + "_" + report.period_end, labelSuffix: "" };
      snap.id = ident.id;
      snap.label = label + ident.labelSuffix;
      snap.products = rows.map(function (r) {
        var x = r.extra || {};
        return {
          asin: r.asin || "", sku: "", title: r.title,
          glance: r.cur.glance || 0, units: r.cur.units || 0,
          conv: r.cur.glance ? r.cur.units / r.cur.glance : 0,
          rev: r.cur.net || 0, avg: r.cur.units ? r2((r.cur.net || 0) / r.cur.units) : 0,
          inv: r.cur.inv || 0, shipped: x.shipped || 0, shippedRev: x.shippedRev || 0, orderItems: x.orderItems || 0,
          revenueKnown: caps.hasRevenue !== false, inventoryKnown: !!caps.hasInventory,
          genus: "(no genus)"
        };
      });
    }
    return snap;
  }
  function zeros() { var o = {}; MEASURES.forEach(function (k) { o[k] = 0; }); return o; }

  // ---- status ------------------------------------------------
  // Turns the report list and import history into the plain-language status
  // the Data & imports view shows: what is covered, what is stale, what failed.
  function importStatus(reports, runs, opts) {
    opts = opts || {};
    var today = opts.today || new Date().toISOString().slice(0, 10);
    var staleDays = opts.staleDays == null ? 10 : opts.staleDays;
    var out = { sources: {}, alerts: [] };
    ["shopify", "amazon"].forEach(function (src) {
      var reps = (reports || []).filter(function (r) { return r.source === src; });
      var latest = reps.slice().sort(function (a, b) { return b.period_end.localeCompare(a.period_end); })[0] || null;
      var srcRuns = (runs || []).filter(function (r) { return r.source === src; });
      var lastOk = srcRuns.filter(function (r) { return r.outcome === "succeeded" || r.outcome === "unchanged"; })[0] || null;
      var lastRun = srcRuns[0] || null;
      // Failures are judged per importer: a manual upload of an older month
      // must not hide that the collector's latest run failed.
      var failingRuns = [];
      var seenBy = {};
      srcRuns.forEach(function (r) {
        var by = r.imported_by || "unknown";
        if (seenBy[by]) return;
        seenBy[by] = true;
        if (r.outcome === "failed" || r.outcome === "rejected") failingRuns.push(r);
      });
      var age = latest ? Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(latest.period_end + "T00:00:00Z")) / 86400000) : null;
      var s = {
        reports: reps.length,
        latestPeriod: latest ? { start: latest.period_start, end: latest.period_end } : null,
        daysSinceLatestPeriodEnd: age,
        lastSuccessfulImport: lastOk ? lastOk.finished_at || lastOk.started_at : null,
        lastRun: lastRun ? { outcome: lastRun.outcome, at: lastRun.finished_at || lastRun.started_at,
                             message: lastRun.error_message || null } : null,
        stale: latest ? age > staleDays : null,
        failing: failingRuns.length > 0
      };
      out.sources[src] = s;
      failingRuns.forEach(function (fr) {
        var who = fr.imported_by === "collector" ? "automatic (collector)" : (fr.imported_by || "");
        out.alerts.push({ level: "error", source: src,
          message: "The last " + src + " import" + (who ? " by " + who : "") + " " +
                   (fr.outcome === "rejected" ? "was rejected" : "failed") +
                   (fr.period_start ? " (" + fr.period_start + " → " + fr.period_end + ")" : "") +
                   ". The previous report is still the one shown." + (fr.error_message ? " " + fr.error_message : "") });
      });
      if (s.stale) {
        out.alerts.push({ level: "warn", source: src,
          message: "The newest " + src + " report ends " + latest.period_end + ", " + age + " days ago." });
      }
      if (!latest && opts.expect && opts.expect.indexOf(src) >= 0) {
        out.alerts.push({ level: "warn", source: src, message: "No " + src + " report is in shared storage yet." });
      }
    });
    return out;
  }

  return {
    SHARED_SHOPIFY_SCOPE: SHOPIFY_SCOPE,
    SHARED_SHOPIFY_LEGACY_SCOPE: SHOPIFY_LEGACY_SCOPE,
    sharedPayloadFromSnapshot: payloadFromSnapshot,
    sharedSnapshotFromReport: snapshotFromShared,
    sharedImportStatus: importStatus
  };
});
