// ============================================================
// amazon-views.js
// Amazon Product breakdown, rendered through product-grouping.js and
// breakdown-ui.js — the same classification, scope, comparison and export
// machinery the Shopify tab uses.
//
// Amazon keeps its own measures (glance views, conversion, inventory) and its
// alerts panel, because the Amazon export supplies them. Nothing equivalent
// is invented for Shopify, and Amazon's Ordered product sales is never
// relabelled as Shopify's Net or Total sales.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab, BUI */

  var PG = window, AR = window, SR = window;

  var ALL_MEASURES = {
    net: "Ordered product sales",
    units: "Units ordered",
    glance: "Glance views",
    inv: "Available inventory"
  };
  // Only measures the imported file actually carries are offered. The real
  // metric-data export has no revenue and no inventory column, and a measure
  // that does not exist is never shown as $0.00.
  var MEASURES = ALL_MEASURES;
  function capsOf(snap) {
    return (snap && snap.meta && snap.meta.capabilities) || {
      hasRevenue: true, hasInventory: true, hasGlance: true, hasConversion: true, hasUnits: true
    };
  }
  // Labels follow the file's own column names, so "Ordered revenue" is never
  // shown as "Ordered product sales" and the two glance-view metrics Amazon has
  // used are never shown under the same name.
  function cleanLabel(h) { return String(h || "").replace(/\s*\(\$\)$/, "").trim(); }
  function availableMeasures(caps) {
    var m = {};
    if (caps.hasRevenue) m.net = cleanLabel(caps.revenueLabel) || ALL_MEASURES.net;
    if (caps.hasUnits !== false) m.units = ALL_MEASURES.units;
    if (caps.hasGlance) m.glance = cleanLabel(caps.glanceBasis) || ALL_MEASURES.glance;
    if (caps.hasInventory) m.inv = ALL_MEASURES.inv;
    if (!Object.keys(m).length) m.units = ALL_MEASURES.units;
    return m;
  }

  var AZ = {
    scope: { vendor: "All", ptype: "All", group: "All", plantScope: "all", search: "", measure: "net", flagged: false },
    drillGroup: null,
    groupSort: { col: "cur", dir: "desc" },
    perfSort: { col: "cur", dir: "desc" },
    drillSort: { col: "cur", dir: "desc" },
    perfPage: { page: 1, pageSize: 100 },
    drillPage: { page: 1, pageSize: 100 },
    chart: null
  };
  window.SBAmazon = AZ;

  // The override store lives in classification-review.js and is shared with
  // the Shopify tab, so one ruling applies everywhere.

  function classifierOpts() {
    return {
      detectGenus: window.detectGenus,
      detectNonPlantType: window.detectNonPlantType,
      override: PG.makeOverrideLookup(window.SBOverrides.load())
    };
  }
  function classify(rec) { return PG.classifyRecord(rec, classifierOpts()); }
  function suspicion(rec) {
    return PG.classifySuspicion(rec, { detectGenus: window.detectGenus, detectNonPlantType: window.detectNonPlantType });
  }

  // ----------------------------------------------------------
  // Import — header-based, replacing app.js's positional parseAmazon
  // ----------------------------------------------------------
  var lastParse = null;
  var origParseAmazon = window.parseAmazon;
  window.parseAmazon = function (rows, ws) {
    if (!window.looksLikeAmazonMetricData || !window.looksLikeAmazonMetricData(rows)) {
      return origParseAmazon ? origParseAmazon(rows, ws) : [];
    }
    var sig = window.amazonHeaderSignature(rows[0]);
    var saved = loadMappings()[sig];
    var res = window.parseAmazonMetricData(rows, { ws: ws, XLSX: window.XLSX, mapping: saved ? saved.mapping : null });
    if (saved) res.capabilities.mappingConfirmedAt = saved.confirmedAt;
    lastParse = res;
    if (!res.ok) throw new Error(res.errors.join(" "));
    return res.products;
  };

  // app.js's addSnapshot replaces any snapshot with the same source + LABEL.
  // For Amazon that is wrong: two different report types can cover the same
  // period (a monthly v1 and a year-to-date v2, for example), and importing one
  // would silently delete the other. During an Amazon import, snapshots are
  // keyed on period + report type instead, so a re-import of the SAME type
  // revises it and a different type is kept beside it. They are never summed.
  var origAddSnapshot = window.addSnapshot;
  var importingAmazon = null;
  var pendingHeaders = null;
  window.addSnapshot = function (snap) {
    if (!importingAmazon || !snap || snap.source !== "amazon" || !lastParse) return origAddSnapshot(snap);
    var caps = lastParse.capabilities;
    var ident = AR.amazonSnapshotIdentity(snap.startDate, snap.endDate, caps);
    snap.id = ident.id;
    snap.label = window.labelFromDates(snap.startDate, snap.endDate) + ident.labelSuffix;
    snap.meta = {
      schema: "amazon-metric-data",
      reportScope: ident.scope,
      capabilities: caps,
      warnings: lastParse.warnings,
      totalsRow: lastParse.totalsRow,
      reconciliation: lastParse.reconciliation || null,
      sourceFilename: importingAmazon.name,
      importedAt: new Date().toISOString(),
      rowCount: lastParse.rowCount,
      headers: pendingHeaders,
      formatSignature: lastParse.signature || null,
      mappingConfirmedAt: caps.mappingConfirmedAt || null
    };
    var replaced = snapshots.filter(function (x) { return x.id === snap.id; }).length;
    snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
    snapshots.push(snap);
    window.saveSnapshots();
    snap.meta.revisedExisting = replaced > 0;

    // Another Amazon report type for an overlapping period is a different
    // scope. Say so, with the numbers, rather than letting it pass quietly.
    var clash = snapshots.filter(function (x) {
      return x.source === "amazon" && !x.isCatalog && x.id !== snap.id &&
             x.startDate <= snap.endDate && snap.startDate <= x.endDate;
    });
    if (clash.length) {
      var units = function (x) { return (x.products || []).reduce(function (t, p) { return t + (p.units || 0); }, 0); };
      snap.meta.overlaps = clash.map(function (x) {
        return { id: x.id, label: x.label, units: units(x),
                 version: x.meta && x.meta.capabilities ? x.meta.capabilities.reportVersion : null };
      });
      window.saveSnapshots();
      alert("Imported as a separate report: " + snap.label + " (" + units(snap) + " ordered units).\n\n" +
            "Another Amazon report already covers this period:\n" +
            snap.meta.overlaps.map(function (o) { return "  \u2022 " + o.label + " \u2014 " + o.units + " ordered units"; }).join("\n") +
            "\n\nBoth are kept as separate reports. Overlapping periods are never added together. " +
            "Check the period you entered: this file's own total is shown above.");
    }
  };

  // ----------------------------------------------------------
  // Report format changes
  // ----------------------------------------------------------
  // Amazon renames and reorders this export without notice. Each format is
  // fingerprinted by its headers. A format the parser fully understands is
  // imported directly. A NEW format that would lose a measure, or lacks a
  // core column, stops at a mapping dialog: suggestions are pre-filled, a
  // person confirms, and the mapping is saved for that exact format so the
  // next file in it imports without asking. Nothing is mapped unconfirmed.
  var MAPPING_KEY = "sb-amazon-column-mappings-v1";
  function loadMappings() {
    try { return JSON.parse(localStorage.getItem(MAPPING_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveMapping(sig, mapping, headers) {
    var all = loadMappings();
    all[sig] = { mapping: mapping, headers: headers, confirmedAt: new Date().toISOString() };
    try { localStorage.setItem(MAPPING_KEY, JSON.stringify(all)); } catch (e) { console.warn("mapping save failed", e); }
  }
  window.SBAmazonMappings = { load: loadMappings, STORAGE_KEY: MAPPING_KEY };

  function lastKnownHeaders() {
    var withMeta = snapshots.filter(function (x) { return x.source === "amazon" && x.meta && x.meta.headers; })
      .sort(function (a, b) { return (b.meta.importedAt || "").localeCompare(a.meta.importedAt || ""); });
    return withMeta.length ? withMeta[0].meta.headers : null;
  }

  function mappingDialog(file, rows, assessment) {
    var header = rows[0];
    var samples = rows.slice(1).filter(function (r) {
      return r && String(r[0] || "").toLowerCase() !== "total";
    }).slice(0, 3);
    var prev = lastKnownHeaders();
    var norm = window.amazonNorm;
    var added = prev ? header.filter(function (h) { return prev.map(norm).indexOf(norm(h)) < 0; }) : [];
    var removed = prev ? prev.filter(function (h) { return header.map(norm).indexOf(norm(h)) < 0; }) : [];
    var M = window.AMAZON_MAPPABLE;
    var resolvedBy = {};
    Object.keys(assessment.resolved).forEach(function (f) { resolvedBy[assessment.resolved[f]] = f; });
    var suggestion = {};
    assessment.suggestions.forEach(function (x) { suggestion[x.normalised] = x; });

    return new Promise(function (resolve) {
      var m = document.createElement("div");
      m.className = "modal"; m.style.display = "flex";
      var rowsHtml = header.map(function (h, i) {
        var n = norm(h);
        var auto = resolvedBy[i];
        var sug = suggestion[n];
        var chosen = auto || (sug ? sug.field : "ignore");
        var opts = Object.keys(M).map(function (f) {
          return '<option value="' + f + '"' + (f === chosen ? " selected" : "") + ">" + BUI.esc(M[f]) + "</option>";
        }).join("");
        var tag = auto ? '<span class="badge ok">known name</span>'
          : sug && sug.confidence === "high" ? '<span class="badge flagq">suggested</span>'
          : sug && sug.confidence === "low" ? '<span class="badge flagq">unsure \u2014 check</span>'
          : '<span class="badge type-other">no match</span>';
        return "<tr><td><b>" + BUI.esc(h) + "</b>" + (added.indexOf(h) >= 0 ? ' <span class="badge newprod">new</span>' : "") + "</td>" +
          '<td class="small">' + samples.map(function (r) { return BUI.esc(String(r[i] == null ? "" : r[i]).slice(0, 28)); }).join("<br>") + "</td>" +
          "<td>" + (auto ? BUI.esc(M[auto] || auto) + '<input type="hidden" data-map="' + BUI.esc(n) + '" value="' + auto + '">'
                         : '<select data-map="' + BUI.esc(n) + '" style="font-size:12px;padding:4px;max-width:260px">' + opts + "</select>") +
          "</td><td>" + tag + "</td></tr>";
      }).join("");
      m.innerHTML =
        '<div class="modal-box" style="max-width:920px">' +
        "<h2>Amazon changed this report\u2019s format</h2>" +
        '<div class="small" style="margin-bottom:8px">' + BUI.esc(file.name) +
          ". The columns differ from every format confirmed so far. Check what each column is before importing; " +
          "this is saved for this exact format, so the next file like it imports without asking. Nothing is mapped until you confirm.</div>" +
        (prev ? '<div class="small" style="margin-bottom:8px">Since the last import \u2014 ' +
          (added.length ? "<b>new:</b> " + added.map(BUI.esc).join(", ") : "no new columns") + " \u00B7 " +
          (removed.length ? "<b>gone:</b> " + removed.map(BUI.esc).join(", ") : "none removed") + "</div>" : "") +
        '<div class="scroll" style="max-height:380px"><table><thead><tr><th>Column in file</th><th>Sample values</th><th>Means</th><th></th></tr></thead><tbody>' +
        rowsHtml + "</tbody></table></div>" +
        '<div class="panel" style="margin:12px 0 0 0;padding:10px" id="az-map-check"></div>' +
        '<div class="right"><button class="tab" id="az-map-cancel">Cancel import</button>' +
        '<button id="az-map-ok" style="margin-left:6px">Confirm and import</button></div></div>';
      document.body.appendChild(m);

      function current() {
        var map = {};
        m.querySelectorAll("[data-map]").forEach(function (el) { map[el.getAttribute("data-map")] = el.value; });
        return map;
      }
      // Live check: validate the mapping and reconcile it against Amazon's own
      // Total line. Reconciliation proves the columns were READ correctly; only
      // a person can confirm what each column MEANS, which is why this asks.
      function check() {
        var map = current();
        var v = window.amazonValidateMapping(header, map);
        var box = m.querySelector("#az-map-check");
        if (!v.ok) {
          box.innerHTML = '<b style="color:#b71c1c">Cannot import yet:</b><br>' + v.errors.map(BUI.esc).join("<br>");
          m.querySelector("#az-map-ok").disabled = true;
          return;
        }
        var p = window.parseAmazonMetricData(rows, { mapping: map });
        var chk = p.reconciliation ? p.reconciliation.checks : [];
        var t = function (f) { return p.products.reduce(function (s, x) { return s + (x[f] || 0); }, 0); };
        box.innerHTML = "<b>With this mapping:</b> " + BUI.count(p.rowCount) + " products \u00B7 " +
          BUI.count(t("units")) + " ordered units" +
          (p.capabilities.hasRevenue ? " \u00B7 " + BUI.money(t("rev")) + " " + BUI.esc(p.capabilities.revenueLabel || "sales") : " \u00B7 no sales column") +
          (p.capabilities.hasGlance ? " \u00B7 " + BUI.count(t("glance")) + " traffic" : "") +
          "<br>" + (chk.length
            ? (p.reconciliation.ok ? '<span class="up">\u2713 Every mapped column matches Amazon\u2019s Total line.</span>'
                                   : '<span class="down">\u2717 ' + chk.filter(function (c) { return !c.ok; }).map(function (c) {
                                       return BUI.esc(c.measure) + ": rows " + c.got + " vs Total " + c.want; }).join("; ") + "</span>")
            : '<span class="small">No Total line in this file to check against.</span>');
        m.querySelector("#az-map-ok").disabled = false;
      }
      m.querySelectorAll("select[data-map]").forEach(function (el) { el.onchange = check; });
      check();
      m.querySelector("#az-map-cancel").onclick = function () { m.remove(); resolve(null); };
      m.querySelector("#az-map-ok").onclick = function () {
        var map = current();
        if (!window.amazonValidateMapping(header, map).ok) return;
        m.remove(); resolve(map);
      };
    });
  }

  var origHandleFileAz = window.handleFile;
  window.handleFile = async function (source, file) {
    if (source !== "amazon") return origHandleFileAz(source, file);
    // Look at the columns BEFORE app.js parses anything.
    try {
      var wb = await window.readFile(file);
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
      if (rows.length && window.looksLikeAmazonMetricData(rows)) {
        var sig = window.amazonHeaderSignature(rows[0]);
        var saved = loadMappings()[sig];
        var assessment = window.amazonAssessFormat(rows[0], saved ? saved.mapping : null, saved ? [sig] : []);
        if (assessment.needsMapping) {
          var map = await mappingDialog(file, rows, assessment);
          if (!map) return;                                   // cancelled: nothing imported
          saveMapping(sig, map, rows[0].map(String));
        }
        pendingHeaders = rows[0].map(String);
      }
    } catch (e) {
      console.error(e); alert("Couldn't read this file: " + (e.message || e)); return;
    }
    lastParse = null;
    importingAmazon = file;
    try {
      await origHandleFileAz(source, file);
    } finally {
      importingAmazon = null;
    }
    if (lastParse && lastParse.warnings && lastParse.warnings.length) {
      console.info("Amazon import notes:\n" + lastParse.warnings.join("\n"));
    }
    AZ.drillGroup = null;
    renderAmazon();
  };

  // ----------------------------------------------------------
  // Records
  // ----------------------------------------------------------
  function currentSnap() {
    return snapshots.find(function (s) { return s.id === state.amazon.snapshotId; }) || null;
  }
  function priorSnap() {
    if (state.amazon.mode !== "compare" || !state.amazon.compareId) return null;
    return snapshots.find(function (s) { return s.id === state.amazon.compareId; }) || null;
  }

  function buildRecords() {
    var snap = currentSnap();
    if (!snap) return null;
    var recs = AR.amazonNormalizeSnapshot(snap, { classify: classify, suspicion: suspicion });
    var pri = priorSnap();
    if (pri) AR.amazonAttachPrior(recs, AR.amazonNormalizeSnapshot(pri, { classify: classify, suspicion: suspicion }));
    var split = PG.splitExclusions(recs);
    AZ.cmp = comparability(snap, pri);
    return { snap: snap, prior: pri, all: split.included, excluded: split.excluded,
             scoped: PG.applyScope(split.included, AZ.scope), cmp: AZ.cmp };
  }

  // Two Amazon snapshots can only be compared on a measure BOTH files carry,
  // measured the same way. Amazon changed the report: v1 had no revenue and
  // counted "Featured Offer glance views"; v2 has ordered revenue and counts
  // "Glance views". Comparing across that change would show every product's
  // revenue as "New / no prior sales" and set two different traffic metrics
  // against each other. Instead the change reads "not comparable".
  function comparability(cur, pri) {
    var out = { net: false, units: false, glance: false, inv: false, reasons: {} };
    if (!pri) return out;
    var a = capsOf(cur), b = capsOf(pri);
    // Comparability is decided measure by measure from what each file
    // actually carries. Ordered units mean the same thing in every Amazon
    // export seen so far; traffic does not ("Glance views" vs "Featured Offer
    // glance views"), and revenue exists only in some.
    out.units = a.hasUnits !== false && b.hasUnits !== false;
    if (!(a.hasRevenue && b.hasRevenue)) {
      out.reasons.net = (b.hasRevenue ? "this" : "the comparison") + " file carries no sales figure";
    } else if ((a.revenueBasis || "ordered") !== (b.revenueBasis || "ordered")) {
      out.reasons.net = "one file reports ordered revenue and the other shipped revenue";
    } else out.net = true;
    if (!(a.hasGlance && b.hasGlance)) {
      out.reasons.glance = "one file carries no traffic figure";
    } else if (a.glanceBasis && b.glanceBasis && a.glanceBasis !== b.glanceBasis) {
      out.reasons.glance = "\u201C" + a.glanceBasis + "\u201D and \u201C" + b.glanceBasis + "\u201D are different metrics";
    } else out.glance = true;
    if (!(a.hasInventory && b.hasInventory)) out.reasons.inv = "one file carries no inventory";
    else out.inv = true;
    return out;
  }
  // Prior known AND comparable for this measure.
  function pk(x, measure) {
    var k = measure || AZ.scope.measure;
    return !!(x && x.priorKnown && AZ.cmp && AZ.cmp[k]);
  }

  // ----------------------------------------------------------
  // Columns
  // ----------------------------------------------------------
  function m() { return AZ.scope.measure; }
  function chg(r) { return BUI.changeOf(r.cur[m()], r.prior[m()], pk(r)); }
  var NC = '<td class="num small" title="Both snapshots exist, but they do not measure this the same way">not comparable</td>';
  function pctOut(x, ch) { return x.priorKnown && !pk(x) ? NC : BUI.pctCell(ch); }
  function deltaOut(x, ch) { return x.priorKnown && !pk(x) ? NC : BUI.deltaCell(ch, m()); }

  var PROD_COLS = [
    { k: "title", label: "Product", sortVal: function (r) { return r.title; },
      cell: function (r) {
        return "<td>" + BUI.esc(r.title) +
          (r.overridden ? ' <span class="badge ovr" title="Analytics group set by hand; the imported data is unchanged">override</span>' : "") +
          (r.suspicion && r.suspicion.severity === "review" && !r.overridden
            ? ' <span class="badge flagq" title="' + BUI.esc(r.suspicion.message) + '">check</span>' : "") +
          "</td>";
      },
      csv: function (r) { return r.title; } },
    { k: "asin", label: "ASIN", sortVal: function (r) { return r.asin; },
      cell: function (r) { return "<td>" + BUI.esc(r.asin || "—") + "</td>"; } },
    { k: "importedType", label: "Imported product type",
      title: "Exactly as the source export stated it. Never rewritten by an override.",
      sortVal: function (r) { return r.ptype; },
      cell: function (r) { return '<td class="small">' + BUI.esc(r.ptype) + "</td>"; } },
    { k: "group", label: "Analytics group", sortVal: function (r) { return r.group; },
      cell: function (r) { return "<td>" + BUI.esc(r.group) + " " + BUI.groupTypeBadge(r.groupType) + BUI.attrBadges(r) + "</td>"; },
      csv: function (r) { return r.group; } },
    { k: "groupType", label: "Group type", sortVal: function (r) { return r.groupType; },
      cell: function (r) { return '<td class="small">' + BUI.esc(r.groupType) + "</td>"; } },
    { k: "glance", label: "Glance views", cls: "num", sortVal: function (r) { return r.cur.glance; },
      cell: function (r) { return '<td class="num">' + BUI.count(r.cur.glance) + "</td>"; } },
    { k: "units", label: "Units ordered", cls: "num", sortVal: function (r) { return r.cur.units; },
      cell: function (r) { return '<td class="num">' + BUI.count(r.cur.units) + "</td>"; } },
    { k: "conv", label: "Conversion", cls: "num", sortVal: function (r) { return PG.conversionOf(r.cur); },
      cell: function (r) { return '<td class="num">' + (r.cur.glance ? BUI.pctPlain(PG.conversionOf(r.cur)) : "—") + "</td>"; } },
    { k: "net", label: "Ordered product sales", cls: "num", sortVal: function (r) { return r.cur.net; },
      cell: function (r) { return '<td class="num"><b>' + BUI.money(r.cur.net) + "</b></td>"; } },
    { k: "avg", label: "Avg / unit", cls: "num", sortVal: function (r) { return PG.avgPerUnit(r.cur); },
      cell: function (r) { return '<td class="num">' + BUI.money(PG.avgPerUnit(r.cur)) + "</td>"; } },
    { k: "inv", label: "Inventory", cls: "num", sortVal: function (r) { return r.cur.inv; },
      cell: function (r) {
        return '<td class="num">' + (r.cur.inv === 0 && r.cur.units > 0
          ? '<span class="badge alert">0</span>' : BUI.count(r.cur.inv)) + "</td>";
      },
      csv: function (r) { return r.cur.inv; } },
    { k: "prior", label: function () { return "Prior " + MEASURES[AZ.scope.measure].toLowerCase(); }, cls: "num",
      sortVal: function (r) { return pk(r) ? r.prior[m()] : null; },
      cell: function (r) { return '<td class="num">' + (pk(r) ? BUI.val(r.prior[m()], m()) : (r.priorKnown ? "not comparable" : "—")) + "</td>"; } },
    { k: "delta", label: "Δ", cls: "num", title: "Absolute change, always shown beside the percentage",
      sortVal: function (r) { var c = chg(r); return c.abs; },
      cell: function (r) { return deltaOut(r, chg(r)); } },
    { k: "pct", label: "Δ %", cls: "num",
      title: "percentage change = (current − prior) ÷ |prior| × 100",
      sortVal: function (r) { var c = chg(r); return c.pct == null ? null : c.pct; },
      cell: function (r) { return pctOut(r, chg(r)); } },
    { k: "match", label: "Prior match", cls: "small",
      sortVal: function (r) { return r.priorMatch || ""; },
      cell: function (r) {
        if (!r.priorKnown) return '<td class="small">—</td>';
        var map = { asin: "ASIN", title: "title only", none: "no prior row" };
        return '<td class="small">' + (map[r.priorMatch] || "—") + "</td>";
      } }
  ];

  var GROUP_COLS = [
    { k: "group", label: "Group", sortVal: function (b) { return b.group; },
      cell: function (b) { return "<td><b>" + BUI.esc(b.group) + "</b></td>"; } },
    { k: "groupType", label: "Group type", sortVal: function (b) { return b.groupType; },
      cell: function (b) { return "<td>" + BUI.groupTypeBadge(b.groupType) + "</td>"; } },
    { k: "withSales", label: "Products w/ sales", cls: "num", sortVal: function (b) { return b.withSales; },
      cell: function (b) { return '<td class="num">' + BUI.count(b.withSales) + "</td>"; } },
    { k: "products", label: "Products", cls: "num", sortVal: function (b) { return b.products; },
      cell: function (b) { return '<td class="num">' + BUI.count(b.products) + "</td>"; } },
    { k: "glance", label: "Glance views", cls: "num", sortVal: function (b) { return b.cur.glance; },
      cell: function (b) { return '<td class="num">' + BUI.count(b.cur.glance) + "</td>"; } },
    { k: "units", label: "Units", cls: "num", sortVal: function (b) { return b.cur.units; },
      cell: function (b) { return '<td class="num">' + BUI.count(b.cur.units) + "</td>"; } },
    { k: "conv", label: "Conversion", cls: "num", sortVal: function (b) { return PG.conversionOf(b.cur); },
      cell: function (b) { return '<td class="num">' + (b.cur.glance ? BUI.pctPlain(PG.conversionOf(b.cur)) : "—") + "</td>"; } },
    { k: "cur", label: function () { return MEASURES[AZ.scope.measure]; }, cls: "num",
      sortVal: function (b) { return b.cur[m()]; },
      cell: function (b) { return '<td class="num"><b>' + BUI.val(b.cur[m()], m()) + "</b></td>"; } },
    { k: "avg", label: "Avg / unit", cls: "num", sortVal: function (b) { return PG.avgPerUnit(b.cur); },
      cell: function (b) { return '<td class="num">' + BUI.money(PG.avgPerUnit(b.cur)) + "</td>"; } },
    { k: "inv", label: "Inventory", cls: "num", sortVal: function (b) { return b.cur.inv; },
      cell: function (b) { return '<td class="num">' + BUI.count(b.cur.inv) + "</td>"; } },
    { k: "share", label: "Share", cls: "num", sortVal: function (b) { return b.share; },
      cell: function (b) { return '<td class="num">' + (b.share * 100).toFixed(1) + "%</td>"; } },
    { k: "prior", label: "Prior", cls: "num", sortVal: function (b) { return pk(b) ? b.prior[m()] : null; },
      cell: function (b) { return '<td class="num">' + (pk(b) ? BUI.val(b.prior[m()], m()) : (b.priorKnown ? "not comparable" : "—")) + "</td>"; } },
    { k: "delta", label: "Δ", cls: "num",
      sortVal: function (b) { return BUI.changeOf(b.cur[m()], b.prior[m()], pk(b)).abs; },
      cell: function (b) { return deltaOut(b, BUI.changeOf(b.cur[m()], b.prior[m()], pk(b))); } },
    { k: "pct", label: "Δ %", cls: "num", title: "percentage change = (current − prior) ÷ |prior| × 100",
      sortVal: function (b) { var c = BUI.changeOf(b.cur[m()], b.prior[m()], pk(b)); return c.pct == null ? null : c.pct; },
      cell: function (b) { return pctOut(b, BUI.changeOf(b.cur[m()], b.prior[m()], pk(b))); } }
  ];

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  function fillSelect(el, values, selected, allLabel) {
    if (!el) return;
    el.innerHTML = '<option value="All">' + allLabel + "</option>" +
      values.map(function (v) { return '<option value="' + BUI.esc(v) + '"' + (v === selected ? " selected" : "") + ">" + BUI.esc(v) + "</option>"; }).join("");
    if (values.indexOf(selected) < 0) el.value = "All";
  }
  function uniqueSorted(recs, key) {
    var s = {};
    recs.forEach(function (r) { if (r[key]) s[r[key]] = 1; });
    return Object.keys(s).sort(function (a, b) { return a.localeCompare(b); });
  }

  function renderAmazon() {
    var snaps = window.snapshotsFor("amazon");
    window.renderSnapshotPicker("amazon", snaps);
    // app.js labels every row "SKUs"; Amazon rows are products (ASINs).
    document.querySelectorAll("#amazon-snap-select option").forEach(function (o) {
      o.textContent = o.textContent.replace(/\((\d+) SKUs\)$/, "($1 products)");
    });
    var bar = document.getElementById("az-scopebar");
    var ctx = buildRecords();
    if (!ctx) {
      document.getElementById("amazon-content").style.display = "none";
      document.getElementById("amazon-empty").style.display = "block";
      if (bar) bar.style.display = "none";
      return;
    }
    document.getElementById("amazon-content").style.display = "block";
    document.getElementById("amazon-empty").style.display = "none";
    if (bar) bar.style.display = "flex";

    fillSelect(document.getElementById("az-group"), uniqueSorted(ctx.all, "group"), AZ.scope.group, "All groups");
    var caps = capsOf(ctx.snap);
    MEASURES = availableMeasures(caps);
    if (AZ.lastSnapId !== ctx.snap.id) {
      AZ.lastSnapId = ctx.snap.id;
      if (MEASURES.net) AZ.scope.measure = "net";     // open on sales whenever the file has them
    }
    if (!MEASURES[AZ.scope.measure]) AZ.scope.measure = Object.keys(MEASURES)[0];
    var msel = document.getElementById("az-measure");
    msel.innerHTML = Object.keys(MEASURES).map(function (k) {
      return '<option value="' + k + '"' + (k === AZ.scope.measure ? " selected" : "") + ">" + BUI.esc(MEASURES[k]) + "</option>";
    }).join("");
    document.getElementById("az-measure").value = AZ.scope.measure;
    document.getElementById("az-plantscope").value = AZ.scope.plantScope;
    var se = document.getElementById("az-search"); if (se && se.value !== AZ.scope.search) se.value = AZ.scope.search;
    var fl = document.getElementById("az-flagged"); if (fl) fl.checked = !!AZ.scope.flagged;

    document.getElementById("amazon-mode-banner").innerHTML =
      "<strong>" + BUI.esc(ctx.snap.label) + "</strong>" +
      (ctx.prior ? " vs <strong>" + BUI.esc(ctx.prior.label) + "</strong>" : "") +
      " · " + (ctx.scoped.length === ctx.all.length
        ? ctx.all.length + " products"
        : ctx.scoped.length + " of " + ctx.all.length + " products in scope");

    renderProvenance(ctx);
    renderCards(ctx);
    renderChart(ctx);
    renderGroupTable(ctx);
    renderPerf(ctx);
    renderHighRevenue(ctx);
    renderFlagged(ctx);
    if (AZ.drillGroup) renderDrill(ctx); else document.getElementById("amazon-drill").style.display = "none";
    if (!capsOf(ctx.snap).hasInventory) {
      document.getElementById("amazon-alerts-tbody").innerHTML =
        '<tr><td class="empty">This export has no inventory column, so out-of-stock alerts cannot be produced from it.</td></tr>';
      document.getElementById("amazon-alerts-count").textContent = "unavailable";
    } else window.renderAlerts("amazon", ctx.scoped.map(function (r) {
      return { title: r.title, asin: r.asin, glance: r.cur.glance, units: r.cur.units,
               conv: PG.conversionOf(r.cur), rev: r.cur.net, inv: r.cur.inv, genus: PG.legacyGenusOf(r) };
    }));
  }

  function renderProvenance(ctx) {
    var el = document.getElementById("az-provenance");
    if (!el) return;
    var snap = ctx.snap;
    var parts = [
      "<b>Reporting period</b> " + snap.startDate + " → " + snap.endDate,
      "<b>Comparison</b> " + (ctx.prior ? ctx.prior.startDate + " → " + ctx.prior.endDate + " (separate snapshot)" : "none selected"),
      "<b>Last import</b> " + new Date(snap.uploadedAt).toLocaleString(),
      "<b>Source</b> " + BUI.esc(snap.fileName || "manual upload"),
      "<b>Product Master</b> not loaded"
    ];
    var caps = capsOf(snap);
    var missing = [];
    if (!caps.hasRevenue) missing.push("a sales figure");
    if (!caps.hasInventory && !caps.inventoryColumnPresent) missing.push("inventory");
    var notes = [];
    if (caps.reportVersion) {
      notes.push("Report format: <b>" + BUI.esc(caps.reportVersion) + "</b>" +
        (caps.glanceBasis ? " · traffic = \u201C" + BUI.esc(caps.glanceBasis) + "\u201D" : "") +
        (caps.revenueLabel ? " · sales = \u201C" + BUI.esc(caps.revenueLabel) + "\u201D" : "") + ".");
    }
    notes.push(missing.length
      ? "<b>This export carries no " + missing.join(" and no ") + ".</b> Those measures are hidden rather " +
        "than shown as zero, and nothing is inferred for them."
      : "This export carries units, traffic and sales.");
    if (snap.meta && snap.meta.mappingConfirmedAt) {
      notes.push("Columns read with a mapping confirmed on " +
                 BUI.esc(new Date(snap.meta.mappingConfirmedAt).toLocaleDateString()) + " for this report format.");
    }
    var ignoredNote = ((snap.meta && snap.meta.warnings) || []).filter(function (w) { return /^Unrecognised columns/.test(w); });
    if (ignoredNote.length) notes.push(BUI.esc(ignoredNote[0]));
    if (caps.inventoryColumnPresent && !caps.hasInventory) {
      notes.push("<b>Inventory column present but zero on every product.</b> It is treated as not reported, " +
                 "so no product is flagged out of stock because of it.");
    }
    if (snap.meta && snap.meta.overlaps && snap.meta.overlaps.length) {
      notes.push("<b>Another Amazon report covers this period:</b> " + snap.meta.overlaps.map(function (o) {
        return BUI.esc(o.label) + " (" + BUI.count(o.units) + " ordered units)";
      }).join("; ") + ". Overlapping reports are never added together.");
    }
    var reasonVals = ctx.prior ? Object.keys(ctx.cmp.reasons || {}).map(function (k) { return ctx.cmp.reasons[k]; }) : [];
    var allSame = reasonVals.length > 1 && reasonVals.every(function (r) { return r === reasonVals[0]; });
    if (ctx.prior && allSame) {
      notes.push("<b>Not comparable with the selected comparison snapshot on any measure:</b> " +
                 BUI.esc(reasonVals[0]) + ". Every change reads \u201Cnot comparable\u201D instead of a figure.");
    } else if (ctx.prior) {
      var why = Object.keys(ctx.cmp.reasons || {}).map(function (k) {
        return BUI.esc((availableMeasures(capsOf(ctx.snap))[k]) || ALL_MEASURES[k] || k) + " (" + BUI.esc(ctx.cmp.reasons[k]) + ")";
      });
      if (why.length) {
        notes.push("<b>Not comparable with the selected comparison snapshot:</b> " + why.join("; ") +
                   ". Those changes read \u201Cnot comparable\u201D instead of a figure.");
      }
    }
    notes = notes.concat([
      "The Amazon export carries no product vendor and no product type, so grouping comes from the title. " +
      "Imported product type reads “" + AR.AMAZON_NO_TYPE + "” for every row rather than being left blank.",
      "Where Amazon does report sales it is <b>Ordered product sales</b>. It is not relabelled as Shopify's " +
      "Net or Total sales, and the two channels are never added together.",
      "Comparison is between two saved snapshots. Rows are matched on ASIN where both periods have one, " +
      "otherwise on title, and the basis is shown per row."
    ]);
    if (ctx.excluded.length) {
      notes.unshift("Excluded from rankings: " + ctx.excluded.map(function (r) { return BUI.esc(r.exclusionLabel); }).join(", ") +
                    " — " + BUI.money(ctx.excluded.reduce(function (s, r) { return s + r.cur.net; }, 0)) + ".");
    }
    el.innerHTML = '<div class="prov">' + parts.join("<span>·</span>") + "</div>" +
      '<div class="small" style="margin-top:8px">' + notes.map(function (n) { return "• " + n; }).join("<br>") + "</div>";
  }

  function renderCards(ctx) {
    var t = PG.groupTotals(ctx.scoped);
    var ch = BUI.changeOf(t.cur[m()], t.prior[m()], pk(t));
    var caps = capsOf(ctx.snap);
    var list = [
      { label: MEASURES[m()] + " (in scope)", value: BUI.val(t.cur[m()], m()),
        sub: pk(t) ? BUI.changeSub(ch, m()) : (t.priorKnown ? "not comparable: " + (ctx.cmp.reasons[m()] || "different report versions") : "no comparison snapshot selected") },
      { label: "Units ordered", value: BUI.count(t.cur.units),
        sub: pk(t, "units") ? BUI.changeSub(BUI.changeOf(t.cur.units, t.prior.units, true), "units") : "" },
      { label: "Glance views", value: caps.hasGlance ? BUI.count(t.cur.glance) : "not in export" },
      { label: "Conversion", value: t.cur.glance ? BUI.pctPlain(PG.conversionOf(t.cur)) : "—",
        sub: "units ÷ glance views" },
      { label: "Products in scope", value: BUI.count(ctx.scoped.length),
        sub: BUI.count(ctx.scoped.filter(function (r) { return r.cur.units !== 0 || r.cur.net !== 0; }).length) + " with recorded sales" },
      { label: "Groups", value: BUI.count(PG.aggregateByGroup(ctx.scoped).length),
        sub: BUI.count(ctx.scoped.filter(function (r) { return r.isPlant; }).length) + " plant products" }
    ];
    document.getElementById("amazon-cards").innerHTML = BUI.cards(list);
  }

  function renderChart(ctx) {
    var buckets = PG.aggregateByGroup(ctx.scoped).sort(function (a, b) { return b.cur[m()] - a.cur[m()]; }).slice(0, 25);
    var cvs = document.getElementById("amazon-chart");
    if (!cvs) return;
    if (AZ.chart) AZ.chart.destroy();
    document.getElementById("az-chart-note").textContent =
      "Plants by genus, everything else by product category — " + MEASURES[m()];
    AZ.chart = new Chart(cvs.getContext("2d"), {
      type: "bar",
      data: {
        labels: buckets.map(function (b) { return b.group; }),
        datasets: [{
          data: buckets.map(function (b) { return b.cur[m()]; }),
          backgroundColor: buckets.map(function (b) { return b.groupType === PG.GROUP_TYPE_GENUS ? "#ef6c00" : "#5e35b1"; })
        }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) {
          var b = buckets[c.dataIndex];
          return b.groupType + " · " + BUI.val(c.parsed.x, m()) + " · " + b.products + " products";
        } } } },
        scales: { x: { ticks: { callback: window.fmtAxis } } }
      }
    });
  }

  // Columns for measures the file does not carry are removed entirely rather
  // than printed as zeroes.
  function visibleCols(cols, caps) {
    return cols.filter(function (c) {
      if ((c.k === "net" || c.k === "avg") && !caps.hasRevenue) return false;
      if (c.k === "inv" && !caps.hasInventory) return false;
      if (c.k === "glance" && !caps.hasGlance) return false;
      if (c.k === "conv" && !caps.hasConversion) return false;
      return true;
    });
  }

  function renderGroupTable(ctx) {
    var q = (document.getElementById("amazon-genus-search").value || "").toLowerCase();
    var buckets = PG.withShare(PG.aggregateByGroup(ctx.scoped), m())
      .filter(function (b) { return !q || b.group.toLowerCase().indexOf(q) >= 0; });
    document.getElementById("amazon-genus-count").textContent = buckets.length + " groups";
    BUI.renderTable({
      rows: buckets, cols: visibleCols(GROUP_COLS, capsOf(ctx.snap)), sort: AZ.groupSort, sortAttr: "azgsort",
      theadId: "amazon-genus-thead", tbodyId: "amazon-genus-tbody",
      emptyMsg: "No products match the current filters."
    });
    document.querySelectorAll("#amazon-genus-tbody tr").forEach(function (tr, i) {
      var b = BUI.sortRows(buckets, visibleCols(GROUP_COLS, capsOf(ctx.snap)), AZ.groupSort)[i];
      if (!b) return;
      tr.classList.add("clickable");
      tr.onclick = function () {
        AZ.drillGroup = b.group; AZ.drillPage.page = 1; renderAmazon();
        document.getElementById("amazon-drill").scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });
  }

  function renderPerf(ctx) {
    var q = (document.getElementById("az-perf-search").value || "").toLowerCase();
    var recs = ctx.scoped.filter(function (r) {
      return !q || (r.title + " " + r.asin + " " + r.group).toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById("az-perf-count").textContent = recs.length + " products";
    BUI.renderTable({
      rows: recs, cols: visibleCols(PROD_COLS, capsOf(ctx.snap)), sort: AZ.perfSort, sortAttr: "azpsort",
      theadId: "az-perf-thead", tbodyId: "az-perf-tbody",
      pagerId: "az-perf-pager", pageState: AZ.perfPage, redraw: function () { renderPerf(ctx); },
      emptyMsg: "No products match the current filters."
    });
  }

  // Rankings stay a top-N list by design; Product performance below is where
  // every row can be browsed.
  var RANK_CAP = 200;
  function renderHighRevenue(ctx) {
    var th = state.topPlants.amazon.threshold;
    var recs = ctx.scoped.filter(function (r) { return Math.abs(r.cur[m()]) >= th; });
    document.getElementById("amazon-tp-heading").textContent =
      "High-revenue products (" + MEASURES[m()] + " \u2265 " + BUI.val(th, m()) + ")";
    document.getElementById("amazon-tp-count").textContent =
      recs.length + " products" + (recs.length > RANK_CAP ? " \u00B7 top " + RANK_CAP + " shown" : "");
    BUI.renderTable({
      rows: recs.slice().sort(function (a, b) { return b.cur[m()] - a.cur[m()]; }).slice(0, RANK_CAP),
      cols: visibleCols(PROD_COLS, capsOf(ctx.snap)), sort: { col: "cur", dir: "desc" }, sortAttr: "noazsort",
      theadId: "amazon-tp-thead", tbodyId: "amazon-tp-tbody",
      emptyMsg: "No products reach this threshold in the current scope."
    });
  }

  function renderDrill(ctx) {
    var box = document.getElementById("amazon-drill");
    var b = PG.aggregateByGroup(ctx.scoped).filter(function (x) { return x.group === AZ.drillGroup; })[0];
    if (!b) { box.style.display = "none"; AZ.drillGroup = null; return; }
    box.style.display = "block";
    var filter = state.amazon.drillFilter;
    var q = (document.getElementById("amazon-prod-search").value || "").toLowerCase();
    var recs = b.records.filter(function (r) {
      if (filter === "ge100" && Math.abs(r.cur[m()]) < 100) return false;
      return !q || r.title.toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById("amazon-drill-title").innerHTML =
      BUI.esc(b.group) + " " + BUI.groupTypeBadge(b.groupType) +
      ' <span class="small">' + BUI.val(b.cur[m()], m()) + " · " + b.products + " products</span>";
    document.getElementById("amazon-drill-count").textContent = recs.length + " shown";
    BUI.renderTable({
      rows: recs, cols: visibleCols(PROD_COLS, capsOf(ctx.snap)), sort: AZ.drillSort, sortAttr: "azdsort",
      theadId: "amazon-prod-thead", tbodyId: "amazon-prod-tbody",
      pagerId: "az-drill-pager", pageState: AZ.drillPage, redraw: function () { renderDrill(ctx); },
      emptyMsg: "Nothing matches."
    });
  }

  function renderFlagged(ctx) {
    var flagged = PG.flaggedRecords(ctx.all, "review");
    var panel = document.getElementById("az-flag-panel");
    if (!panel) return;
    document.getElementById("az-flag-count").textContent = flagged.length + " to review";
    if (!flagged.length) {
      panel.querySelector(".flag-body").innerHTML =
        '<div class="small">Nothing flagged. Amazon rows are grouped from the title, so a product type cannot disagree with one.</div>';
      return;
    }
    panel.querySelector(".flag-body").innerHTML = window.SBFlagUI.render(flagged, "az");
    window.SBFlagUI.wire(panel, "az", renderAmazon);
  }

  // ----------------------------------------------------------
  // Exports — the complete filtered scope, never the painted page
  // ----------------------------------------------------------
  function scopeNote(ctx) {
    return [
      ["# Channel", "Amazon"],
      ["# Source", ctx.snap.fileName || ""],
      ["# Reporting period", ctx.snap.startDate + " to " + ctx.snap.endDate],
      ["# Comparison snapshot", ctx.prior ? ctx.prior.startDate + " to " + ctx.prior.endDate : "none"],
      ["# Sales measure", "Ordered product sales (pre-tax; not comparable to Shopify Total sales)"],
      ["# Percentage change formula", "(current - prior) / abs(prior) * 100"],
      ["# Filters", "group=" + AZ.scope.group + "; scope=" + AZ.scope.plantScope +
                    "; search=" + (AZ.scope.search || "-") + "; measure=" + AZ.scope.measure +
                    "; flaggedOnly=" + !!AZ.scope.flagged],
      [""]
    ];
  }

  function wire() {
    state.amazon.drillFilter = "all";   // match the active button in the markup

    // app.js attached its own handlers to these; replacing the nodes drops
    // them so one click cannot produce two different CSVs.
    ["amazon-download", "amazon-download-breakdown", "amazon-tp-download"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.replaceChild(el.cloneNode(true), el);
    });

    var on = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on("az-measure", "change", function (e) { AZ.scope.measure = e.target.value; renderAmazon(); });
    on("az-group", "change", function (e) { AZ.scope.group = e.target.value; AZ.drillGroup = null; renderAmazon(); });
    on("az-plantscope", "change", function (e) { AZ.scope.plantScope = e.target.value; AZ.drillGroup = null; AZ.perfPage.page = 1; renderAmazon(); });
    on("az-search", "input", function (e) { AZ.scope.search = e.target.value; AZ.perfPage.page = 1; renderAmazon(); });
    on("az-flagged", "change", function (e) { AZ.scope.flagged = e.target.checked; AZ.perfPage.page = 1; renderAmazon(); });
    on("az-reset", "click", function () {
      AZ.scope = { vendor: "All", ptype: "All", group: "All", plantScope: "all", search: "", measure: AZ.scope.measure, flagged: false };
      AZ.drillGroup = null; AZ.perfPage.page = 1; renderAmazon();
    });
    on("az-perf-search", "input", function () { AZ.perfPage.page = 1; renderAmazon(); });

    document.addEventListener("click", function (e) {
      if (!e.target.closest) return;
      var g = e.target.closest("th[data-azgsort]");
      if (g) { BUI.toggleSort(AZ.groupSort, g.dataset.azgsort); return renderAmazon(); }
      var p = e.target.closest("th[data-azpsort]");
      if (p) { BUI.toggleSort(AZ.perfSort, p.dataset.azpsort); AZ.perfPage.page = 1; return renderAmazon(); }
      var d = e.target.closest("th[data-azdsort]");
      if (d) { BUI.toggleSort(AZ.drillSort, d.dataset.azdsort); AZ.drillPage.page = 1; return renderAmazon(); }
    });

    on("amazon-close-drill", "click", function () { AZ.drillGroup = null; renderAmazon(); });

    function dl(name, rows) {
      var ctx = buildRecords(); if (!ctx) return;
      BUI.download(name, scopeNote(ctx).concat(BUI.csvFromCols(rows(ctx), PROD_COLS, {})));
    }
    on("amazon-download", "click", function () { dl("amazon-products.csv", function (c) { return c.scoped; }); });
    on("az-perf-download", "click", function () {
      var q = (document.getElementById("az-perf-search").value || "").toLowerCase();
      dl("amazon-product-performance.csv", function (c) {
        return c.scoped.filter(function (r) { return !q || (r.title + " " + r.asin + " " + r.group).toLowerCase().indexOf(q) >= 0; });
      });
    });
    on("az-drill-download", "click", function () {
      if (!AZ.drillGroup) return;
      dl("amazon-" + AZ.drillGroup.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".csv", function (c) {
        return c.scoped.filter(function (r) { return r.group === AZ.drillGroup; });
      });
    });
    on("amazon-download-breakdown", "click", function () { document.getElementById("az-group-download").click(); });
    on("az-group-download", "click", function () {
      var ctx = buildRecords(); if (!ctx) return;
      var buckets = PG.withShare(PG.aggregateByGroup(ctx.scoped), m());
      var rows = BUI.csvFromCols(BUI.sortRows(buckets, GROUP_COLS, AZ.groupSort), GROUP_COLS, {});
      var extra = ctx.excluded.length
        ? [[""], ["# Excluded from the figures above"], ["Product", "ASIN", "Reason", "Ordered product sales"]]
            .concat(ctx.excluded.map(function (r) { return [r.title, r.asin, r.exclusionLabel, r.cur.net]; }))
        : [];
      BUI.download("amazon-product-breakdown.csv", scopeNote(ctx).concat(rows).concat(extra));
    });
    on("amazon-tp-download", "click", function () {
      var th = state.topPlants.amazon.threshold;
      dl("amazon-high-revenue-products.csv", function (c) {
        return c.scoped.filter(function (r) { return Math.abs(r.cur[m()]) >= th; });
      });
    });
  }

  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (source === "amazon") return renderAmazon();
    return origRenderTab(source);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
