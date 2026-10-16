// ============================================================
// shopify-views.js
// Shopify import + Product breakdown + Vendor analytics.
//
// Loaded AFTER app.js. It replaces three globals (parseShopify, handleFile
// and renderTab) rather than editing app.js in place, so the Amazon,
// External Stores, Cross-channel, Owned vs Market and Opportunity Map views
// keep running against exactly the code they were written for.
//
// One scope object (SBS.scope) drives every card, chart, table, comparison
// and download on both tabs, so a vendor filter cannot mean one thing in the
// chart and another in the CSV.
// ============================================================
(function () {
  "use strict";

  // app.js declares `state`, `snapshots` and `activeTab` with `let`. Top-level
  // let/const in a classic script live in the shared global lexical scope, not
  // on `window`, so they are referenced here as bare identifiers.
  /* global state, snapshots, activeTab */
  var SR = window, PG = window;   // shopify-report.js / product-grouping.js export onto window
  var MEASURE_LABELS = {
    units: "Net items sold", gross: "Gross sales", disc: "Discounts",
    ret: "Sales reversals", net: "Net sales", tax: "Taxes", total: "Total sales"
  };
  var MONEY = { net: 1, total: 1, gross: 1, disc: 1, ret: 1, tax: 1 };
  var STORE_TZ = "America/Los_Angeles";

  // ----------------------------------------------------------
  // Formatting
  // ----------------------------------------------------------
  var money = function (v) { return BUI.money(v); };
  var count = function (v) { return BUI.count(v); };
  var val = function (v, measure) { return BUI.val(v, measure); };
  var esc = function (v) { return BUI.esc(v); };
  var pctCell = function (ch) { return BUI.pctCell(ch); };
  var deltaCell = function (ch, measure) { return BUI.deltaCell(ch, measure); };
  var groupTypeBadge = function (t) { return BUI.groupTypeBadge(t); };

  // ----------------------------------------------------------
  // Shared state
  // ----------------------------------------------------------
  var SBS = {
    scope: { vendor: "All", ptype: "All", group: "All", plantScope: "all", search: "", measure: "net", flagged: false,
             channel: "own" },
    perfPage: { page: 1, pageSize: 100 },
    drillPage: { page: 1, pageSize: 100 },
    vendorPage: { page: 1, pageSize: 100 },
    drillGroup: null,
    drillVendor: null,
    groupSort: { col: "cur", dir: "desc" },
    perfSort: { col: "cur", dir: "desc" },
    vendorSort: { col: "cur", dir: "desc" },
    charts: {}
  };
  window.SBShopify = SBS;

  function detectorOpts() {
    return { detectGenus: window.detectGenus, detectNonPlantType: window.detectNonPlantType };
  }
  function classify(rec) {
    return PG.classifyRecord(rec, Object.assign(detectorOpts(), {
      // An override changes only the analytics group; the imported product
      // type on the record is never rewritten.
      override: PG.makeOverrideLookup(window.SBOverrides.load())
    }));
  }
  function suspicion(rec) { return PG.classifySuspicion(rec, detectorOpts()); }

  // ----------------------------------------------------------
  // IMPORT
  // ----------------------------------------------------------
  // Replaces the old positional parser. Kept on window so anything that
  // still calls parseShopify() gets the validated path.
  window.parseShopify = function (rows) {
    var res = SR.parseShopifyProductReport(rows, { classify: classify, suspicion: suspicion });
    if (!res.ok) throw new Error(res.errors.join(" "));
    return res.records.map(toLegacyProduct);
  };

  var toLegacyProduct = SR.shopifyToSnapshotProduct;
  var isNewFormat = SR.shopifyIsNewFormatSnapshot;
  function liftLegacy(snap) { return SR.shopifyLiftLegacySnapshot(snap, classify); }

  function recordsOf(snap) {
    if (!snap) return [];
    if (snap._recCache && snap._recCacheFor === snap.id) return snap._recCache;
    var recs = isNewFormat(snap) ? snap.products : liftLegacy(snap);
    snap._recCache = recs; snap._recCacheFor = snap.id;
    return recs;
  }

  // Split into included / excluded once per snapshot.
  // Classification is re-applied on every render rather than frozen at import
  // time, so setting or clearing an override takes effect immediately instead
  // of waiting for the next import. Only the derived grouping fields are
  // touched; title, vendor, imported product type and every figure are the
  // values the source stated.
  function reclassify(recs) {
    var ov = PG.makeOverrideLookup(window.SBOverrides.load());
    var opts = Object.assign(detectorOpts(), { override: ov });
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      var c = PG.classifyRecord(r, opts);
      r.group = c.group;
      r.groupType = c.groupType;
      r.isPlant = !!c.isPlant;
      r.genusName = c.genus || "";
      r.genus = c.genus || "(no genus)";       // legacy field the other tabs read
      r.classificationBasis = c.basis;
      r.overridden = !!c.overridden;
      r.naturalGroup = c.natural ? c.natural.group : c.group;
      r.naturalGroupType = c.natural ? c.natural.groupType : c.groupType;
      r.suspicion = suspicion(r);
    }
    return recs;
  }

  // Reports with a Sales channel column are narrowed to the chosen channel
  // first (own store by default, so Amazon orders that reached Shopify
  // through Sellbrite are not counted as Shopify sales), and a product's
  // channel rows are merged. Every card, table, chart and export reads from
  // here, so they all share the same channel scope.
  function partition(snap) {
    var recs = reclassify(PG.filterChannel(recordsOf(snap), SBS.scope.channel));
    return PG.splitExclusions(recs, (snap.meta && snap.meta.exclusionRules) || PG.DEFAULT_EXCLUSIONS);
  }

  var origHandleFile = window.handleFile;

  window.handleFile = async function (source, file) {
    if (source !== "shopify") return origHandleFile(source, file);
    if (!file) return;
    var dz = document.getElementById("shopify-dropzone");
    dz.classList.add("loading"); dz.querySelector(".dz-msg").textContent = "Processing…";
    try {
      var wb = await window.readFile(file);
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });

      // The products.csv catalog path is unchanged.
      if (window.isShopifyCatalog(rows)) { dz.classList.remove("loading"); return origHandleFile(source, file); }

      if (!SR.isShopifyProductReport(rows)) {
        alert("This does not look like a Shopify \"Total sales by product\" report.\n\n" +
              "Expected columns including: Product title, Product vendor, Product type, Net items sold, Net sales.");
        return;
      }
      var res = SR.parseShopifyProductReport(rows, { classify: classify, suspicion: suspicion });
      var decision = await importReview(file.name, res);
      if (!decision) return;

      var products = res.records.map(toLegacyProduct);
      var label = window.labelFromDates(decision.start, decision.end);
      var snap = {
        id: "shopify_" + decision.start + "_" + decision.end,
        source: "shopify", label: label,
        startDate: decision.start, endDate: decision.end,
        fileName: file.name,
        uploadedAt: new Date().toISOString(),
        products: products,
        meta: {
          schema: "shopify-total-sales-by-product/v1",
          reportScope: "Total sales by product (all channels in this Shopify store)",
          timezone: STORE_TZ,
          currency: decision.currency,
          sourceFilename: file.name,
          importedAt: new Date().toISOString(),
          current: { start: decision.start, end: decision.end },
          comparison: decision.cmpStart
            ? { start: decision.cmpStart, end: decision.cmpEnd, source: decision.cmpSource }
            : null,
          totalsAsImported: res.totals.current,
          priorTotalsAsImported: res.capabilities.hasPrior ? res.totals.prior : null,
          capabilities: res.capabilities,
          columnRoles: res.prevRoles,
          warnings: res.warnings,
          rowCount: res.rowCount,
          aggregatedRows: res.aggregatedRows,
          reconciliation: decision.reconciliation
        }
      };
      // Re-importing the same scope and period REVISES that report rather
      // than adding its totals again.
      var up = SR.shopifyUpsertReport(snapshots, snap);
      snapshots = up.list;
      window.saveSnapshots();
      var overlaps = SR.shopifyOverlappingReports(snapshots, "shopify")
        .filter(function (pair) { return pair.indexOf(snap.id) >= 0; });
      if (overlaps.length) {
        alert("Imported, but this report's period overlaps " + overlaps.length +
              " saved report(s). Overlapping snapshots are never summed; pick one at a time.");
      }
      state.shopify.snapshotId = snap.id;
      state.shopify.mode = "single";
      SBS.drillGroup = null; SBS.drillVendor = null;
      resetScope();
      window.renderTab("shopify");
    } catch (e) {
      console.error(e);
      alert("Couldn't import this file: " + (e.message || e));
    } finally {
      dz.classList.remove("loading");
      dz.querySelector(".dz-msg").textContent = "📂 Drop file here, or click to browse";
    }
  };

  // Import review: shows what was validated, asks for the periods (the export
  // states none) and lets the operator reconcile against the source report.
  function importReview(filename, res) {
    var guess = window.parseDates(filename || "");
    var start = guess[0] || "", end = guess[1] || "";
    var t = res.totals.current;
    var warn = res.warnings.slice(0, 8);

    return new Promise(function (resolve) {
      var m = document.createElement("div");
      m.className = "modal"; m.style.display = "flex";
      m.innerHTML =
        '<div class="modal-box" style="max-width:720px">' +
        '<h2>Import Shopify product report</h2>' +
        '<div class="small" style="margin-bottom:10px">' + esc(filename) + " · " + res.rowCount +
          " source rows · " + res.records.length + (res.capabilities.hasSalesChannel ? " product × channel rows" : " products") +
          (res.aggregatedRows ? " · " + res.aggregatedRows + " duplicate rows aggregated" : "") + "</div>" +

        '<div class="panel" style="margin:0 0 12px 0;padding:12px">' +
          "<b>Validation</b>" +
          '<div class="small" style="margin-top:6px">' +
            "Columns: resolved by position. " + esc(res.prevRoles ? res.prevRoles.note : "") + "<br>" +
            "Prior period captured: <b>" + (res.capabilities.hasPrior ? "yes" : "no") + "</b> · " +
            "Product id: <b>" + (res.capabilities.hasProductId ? "yes" : "not present") + "</b> · SKU / variant id: <b>not present</b> · " +
            "Daily dates: <b>not present</b> · Sales channel: <b>" + (res.capabilities.hasSalesChannel ? "yes" : "not present") + "</b>" +
            (res.channelTotals ? "<br>Own store " + money(res.channelTotals.own.net) + " net / " + count(res.channelTotals.own.units) +
              " units · Amazon via Sellbrite " + money(res.channelTotals.amazon.net) + " net / " + count(res.channelTotals.amazon.units) + " units" : "") +
          "</div>" +
          (warn.length ? '<div class="small warn" style="margin-top:8px;color:#b26a00">' +
             warn.map(function (w) { return "⚠ " + esc(w); }).join("<br>") +
             (res.warnings.length > warn.length ? "<br>…and " + (res.warnings.length - warn.length) + " more" : "") +
             "</div>" : "") +
        "</div>" +

        '<div class="panel" style="margin:0 0 12px 0;padding:12px">' +
          "<b>Reconciliation against the source report</b>" +
          '<div class="small">Type in the totals printed on the Shopify report. They are a control for this import, not a dashboard value.</div>' +
          '<table style="margin-top:8px"><thead><tr><th>Measure</th><th class="num">Imported</th><th class="num">On the report</th></tr></thead><tbody>' +
          ["units", "net", "tax", "total"].map(function (k) {
            return "<tr><td>" + esc(MEASURE_LABELS[k] || k) + '</td><td class="num">' +
              (k === "units" ? count(t[k]) : money(t[k])) +
              '</td><td class="num"><input data-rec="' + k + '" value="' + t[k] +
              '" style="width:120px;text-align:right;padding:4px 6px;border:1px solid var(--border);border-radius:4px"></td></tr>';
          }).join("") +
          "</tbody></table>" +
          '<div class="small" id="rec-msg" style="margin-top:6px"></div>' +
        "</div>" +

        '<div class="panel" style="margin:0 0 12px 0;padding:12px">' +
          "<b>Reporting period</b>" +
          '<div class="small">The export carries no dates. The filename is only a suggestion — confirm it.</div>' +
          '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">' +
            '<div><label class="small">Start</label><br><input type="date" id="imp-start" value="' + start + '"></div>' +
            '<div><label class="small">End</label><br><input type="date" id="imp-end" value="' + end + '"></div>' +
            '<div><label class="small">Currency</label><br><input id="imp-cur" value="USD" style="width:80px;padding:6px;border:1px solid var(--border);border-radius:4px"></div>' +
          "</div>" +
          '<div class="small" style="margin-top:6px">Reporting boundaries follow the store timezone, ' + STORE_TZ + ".</div>" +
        "</div>" +

        '<div class="panel" style="margin:0 0 12px 0;padding:12px" id="imp-cmp-box">' +
          "<b>Comparison period</b>" +
          '<div class="small">These are the "(previous_period)" columns. Shopify does not say which dates they cover, so state them. ' +
            "Nothing is assumed from the filename.</div>" +
          '<div style="margin-top:8px"><label><input type="radio" name="cmpmode" value="prev" checked> Immediately preceding period of equal length</label>' +
          ' <a href="#" id="imp-fill" class="small">fill</a></div>' +
          '<div style="margin-top:4px"><label><input type="radio" name="cmpmode" value="custom"> Other dates</label></div>' +
          '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">' +
            '<div><label class="small">Comparison start</label><br><input type="date" id="imp-cmp-start"></div>' +
            '<div><label class="small">Comparison end</label><br><input type="date" id="imp-cmp-end"></div>' +
          "</div>" +
          '<div class="small" style="margin-top:6px">Leave both blank to import without a comparison; period-over-period columns will then read "no prior period".</div>' +
        "</div>" +

        '<div class="right"><button class="tab" id="imp-cancel">Cancel</button>' +
        '<button id="imp-ok" style="margin-left:6px">Import report</button></div>' +
        "</div>";

      document.body.appendChild(m);
      var q = function (s) { return m.querySelector(s); };
      var done = function (v) { m.remove(); resolve(v); };

      function fillPrev() {
        var s = q("#imp-start").value, e = q("#imp-end").value;
        if (!s || !e) return;
        var sd = new Date(s + "T00:00:00"), ed = new Date(e + "T00:00:00");
        var days = Math.round((ed - sd) / 86400000) + 1;
        var ce = new Date(sd.getTime() - 86400000);
        var cs = new Date(ce.getTime() - (days - 1) * 86400000);
        q("#imp-cmp-start").value = window.toLocalYMD(cs);
        q("#imp-cmp-end").value = window.toLocalYMD(ce);
      }
      q("#imp-fill").onclick = function (ev) { ev.preventDefault(); fillPrev(); };
      if (start && end && res.capabilities.hasPrior) fillPrev();
      if (!res.capabilities.hasPrior) {
        q("#imp-cmp-box").style.opacity = ".55";
        q("#imp-cmp-box").insertAdjacentHTML("beforeend",
          '<div class="small" style="color:#b26a00;margin-top:6px">⚠ This file has no usable previous-period columns.</div>');
      }

      q("#imp-cancel").onclick = function () { done(null); };
      m.addEventListener("click", function (ev) { if (ev.target === m) done(null); });

      q("#imp-ok").onclick = function () {
        var s = q("#imp-start").value, e = q("#imp-end").value;
        if (!s || !e) { alert("Set the reporting period this file covers."); return; }
        if (s > e) { alert("The start date must not be after the end date."); return; }
        var expected = {};
        m.querySelectorAll("[data-rec]").forEach(function (inp) {
          var v = parseFloat(String(inp.value).replace(/[$,\s]/g, ""));
          if (!isNaN(v)) expected[inp.dataset.rec] = v;
        });
        var rec = SR.shopifyReconcile(res.totals.current, expected, 0.02);
        if (!rec.ok) {
          var bad = rec.checks.filter(function (c) { return !c.ok; })
            .map(function (c) { return (MEASURE_LABELS[c.measure] || c.measure) + ": imported " + c.got + ", you entered " + c.expected; });
          if (!confirm("This import does not reconcile to the figures you entered:\n\n" + bad.join("\n") +
                       "\n\nImport anyway and flag it?")) return;
        }
        var cs = q("#imp-cmp-start").value, ce = q("#imp-cmp-end").value;
        if ((cs && !ce) || (!cs && ce)) { alert("Give both comparison dates, or neither."); return; }
        if (cs && ce && cs > ce) { alert("The comparison start must not be after its end."); return; }
        if (cs && ce && !(ce < s)) {
          if (!confirm("The comparison period overlaps the reporting period. Overlapping snapshots must never be summed.\n\nUse these dates anyway?")) return;
        }
        var mode = m.querySelector('input[name="cmpmode"]:checked').value;
        done({
          start: s, end: e,
          cmpStart: cs || null, cmpEnd: ce || null,
          cmpSource: cs ? (mode === "prev" ? "preceding period of equal length (confirmed at import)" : "stated at import") : null,
          currency: q("#imp-cur").value.trim().toUpperCase() || "USD",
          reconciliation: rec
        });
      };
    });
  }

  // ----------------------------------------------------------
  // SCOPE
  // ----------------------------------------------------------
  function resetScope() {
    SBS.scope = { vendor: "All", ptype: "All", group: "All", plantScope: "all", search: "",
                  measure: SBS.scope.measure || "net", flagged: false, channel: SBS.scope.channel || "own" };
    SBS.drillGroup = null; SBS.drillVendor = null;
    SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.vendorPage.page = 1;
  }

  function currentSnap() {
    var id = state.shopify.snapshotId;
    return snapshots.find(function (s) { return s.id === id; }) || null;
  }
  function compareSnap() {
    var id = state.shopify.compareId;
    if (!id || state.shopify.mode !== "compare") return null;
    return snapshots.find(function (s) { return s.id === id; }) || null;
  }

  // A channel report lists a product once per channel; count products.
  function productCount(snap) {
    var seen = {};
    (snap.products || []).forEach(function (p) { seen[p.productKey || p.productId || p.title + "\u241F" + p.vendor + "\u241F" + p.ptype] = 1; });
    return Object.keys(seen).length;
  }

  function fillSelect(el, values, selected, allLabel) {
    if (!el) return;
    el.innerHTML = '<option value="All">' + allLabel + "</option>" +
      values.map(function (v) { return '<option value="' + esc(v) + '"' + (v === selected ? " selected" : "") + ">" + esc(v) + "</option>"; }).join("");
    if (values.indexOf(selected) < 0) el.value = "All";
  }

  function uniqueSorted(recs, key) {
    var s = {};
    recs.forEach(function (r) { if (r[key]) s[r[key]] = 1; });
    return Object.keys(s).sort(function (a, b) { return a.localeCompare(b); });
  }

  // ----------------------------------------------------------
  // SHOPIFY TAB
  // ----------------------------------------------------------
  function renderShopify() {
    var snaps = snapshotsFor("shopify");
    // app.js's picker labels every row "SKUs". This report has no SKUs, so the
    // Shopify picker counts products instead.
    document.getElementById("shopify-snap-select").innerHTML =
      '<option value="">\u2014 Pick a report \u2014</option>' + snaps.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === state.shopify.snapshotId ? " selected" : "") + ">" +
               esc(x.label) + " (" + productCount(x) + " products)</option>";
      }).join("");
    document.getElementById("shopify-compare-select").innerHTML =
      '<option value="">\u2014 None \u2014</option>' + snaps.filter(function (x) {
        return x.id !== state.shopify.snapshotId;
      }).map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === state.shopify.compareId ? " selected" : "") + ">" + esc(x.label) + "</option>";
      }).join("");
    var snap = currentSnap();
    var bar = document.getElementById("shopify-scopebar");
    if (!snap) {
      document.getElementById("shopify-content").style.display = "none";
      document.getElementById("shopify-empty").style.display = "block";
      if (bar) bar.style.display = "none";
      return;
    }
    document.getElementById("shopify-content").style.display = "block";
    document.getElementById("shopify-empty").style.display = "none";
    if (bar) bar.style.display = "flex";

    var part = partition(snap);
    var all = part.included, excluded = part.excluded;

    // filter options come from the un-narrowed set so the operator can always
    // widen again
    fillSelect(document.getElementById("sb-vendor"), uniqueSorted(all, "vendor"), SBS.scope.vendor, "All vendors");
    fillSelect(document.getElementById("sb-ptype"), uniqueSorted(all, "ptype"), SBS.scope.ptype, "All product types");
    fillSelect(document.getElementById("sb-group"), uniqueSorted(all, "group"), SBS.scope.group, "All groups");
    var msel = document.getElementById("sb-measure"); if (msel) msel.value = SBS.scope.measure;
    var psel = document.getElementById("sb-plantscope"); if (psel) psel.value = SBS.scope.plantScope;
    var ssel = document.getElementById("sb-search"); if (ssel && ssel.value !== SBS.scope.search) ssel.value = SBS.scope.search;
    var fsel = document.getElementById("sb-flagged"); if (fsel) fsel.checked = !!SBS.scope.flagged;
    syncChannelSelect("sb", snap);

    var scoped = PG.applyScope(all, SBS.scope);
    var measure = SBS.scope.measure;

    document.getElementById("shopify-mode-banner").innerHTML = bannerFor(snap, scoped, all);
    renderProvenance("sb-provenance", snap, all, excluded, scoped);
    renderSbCards(snap, scoped, all, excluded, measure);
    renderGroupChart(scoped, measure);
    renderGroupTable(scoped, measure);
    renderHighRevenue(scoped, measure);
    renderPerfTable(scoped, measure);
    renderFlagged(all);
    if (SBS.drillGroup) renderGroupDrill(scoped, measure); else document.getElementById("shopify-drill").style.display = "none";
  }

  function bannerFor(snap, scoped, all) {
    var m = snap.meta || {};
    var bits = ["<strong>" + esc(snap.label) + "</strong>"];
    if (m.current) bits.push(m.current.start + " → " + m.current.end);
    bits.push(scoped.length === all.length
      ? all.length + " products"
      : scoped.length + " of " + all.length + " products in scope");
    return bits.join(" · ");
  }

  var CHANNEL_LABELS = { own: "own store (Amazon orders via Sellbrite excluded)", amazon: "Amazon via Sellbrite only", all: "all channels" };
  function syncChannelSelect(prefix, snap) {
    var st = SR.shopifyChannelStatus(snap);
    var sel = document.getElementById(prefix + "-channel");
    var lab = document.querySelector("." + prefix + "-chan-l");
    if (sel) { sel.style.display = st.hasChannel ? "" : "none"; sel.value = SBS.scope.channel; }
    if (lab) lab.style.display = st.hasChannel ? "" : "none";
  }
  function channelNote(snap) {
    var st = SR.shopifyChannelStatus(snap);
    if (st.hasChannel) {
      var t = st.totals, ch = SBS.scope.channel;
      var amz = t.amazon, own = t.own;
      return "<b>Sales channel:</b> " + CHANNEL_LABELS[ch] + ". Own store " + money(own.net) + " net / " + count(own.units) +
        " units · Amazon via Sellbrite " + money(amz.net) + " net / " + count(amz.units) + " units · all channels " +
        money(round2(own.net + amz.net)) + ". Channels: " + t.channels.map(function (c) {
          return esc(c.channel) + " " + money(c.cur.net); }).join(", ") + ".";
    }
    if (st.mayIncludeAmazon) {
      return "⚠ <b>Includes Amazon orders.</b> From " + st.amazonSince.slice(0, 7) + " Amazon orders reach Shopify through Sellbrite, " +
        "and this report has no Sales channel column to separate them, so these figures are own store + Amazon. " +
        "Re-export the saved report “Total sales by product + ID (sb-plant-breakdown)”, which now includes Sales channel.";
    }
    return "";
  }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  function renderProvenance(id, snap, all, excluded, scoped) {
    var el = document.getElementById(id);
    if (!el) return;
    var m = snap.meta || {};
    var legacy = !isNewFormat(snap);
    var exclNet = excluded.reduce(function (s, r) { return s + r.cur.net; }, 0);
    var parts = [];
    parts.push("<b>Reporting period</b> " + (m.current ? m.current.start + " → " + m.current.end : snap.startDate + " → " + snap.endDate));
    parts.push("<b>Comparison</b> " + (m.comparison ? m.comparison.start + " → " + m.comparison.end : "not recorded"));
    parts.push("<b>Last import</b> " + new Date(m.importedAt || snap.uploadedAt).toLocaleString());
    parts.push("<b>Source</b> " + esc(m.sourceFilename || snap.fileName || "manual upload"));
    parts.push("<b>Timezone</b> " + (m.timezone || STORE_TZ));
    parts.push("<b>Currency</b> " + (m.currency || "—"));
    parts.push("<b>Product Master</b> not loaded");
    var html = '<div class="prov">' + parts.join("<span>·</span>") + "</div>";

    var notes = [];
    var cn = channelNote(snap); if (cn) notes.push(cn);
    if (excluded.length) {
      notes.push("Excluded from rankings: " + excluded.map(function (r) { return esc(r.exclusionLabel); }).join(", ") +
                 " — " + money(exclNet) + " net sales. Included " + money(all.reduce(function (s, r) { return s + r.cur.net; }, 0)) +
                 " + excluded " + money(exclNet) + " = " + money(all.reduce(function (s, r) { return s + r.cur.net; }, 0) + exclNet) +
                 " on the source report.");
    }
    if (legacy) {
      notes.push("⚠ This snapshot was imported before vendor and previous-period capture existed. " +
                 "Vendor analytics and period comparison are unavailable for it; re-import the report to enable them.");
    }
    if (m.reconciliation && m.reconciliation.ok === false) {
      notes.push("⚠ This import did not reconcile to the figures entered at import time.");
    }
    if (m.period) {
      notes.push("<b>" + esc(m.period.label) + "</b>. Combined from the latest successful revision of each month: " +
        m.period.revisionsUsed.map(function (u) { return esc(u.month) + " rev. " + u.revision + (u.status === "partial" ? " (partial)" : ""); }).join(", ") +
        ". Units, sales, discounts and returns are summed; products are counted once across the period; averages and changes are " +
        "worked out from the combined totals. Overlapping reports and embedded previous-period columns are never added.");
      if (m.period.missing && m.period.missing.length) {
        notes.push("⚠ No report for " + m.period.missing.map(esc).join(", ") + ". Those months are missing, not zero, so these totals are partial.");
      }
      if (!(m.capabilities && m.capabilities.hasPrior)) {
        notes.push("No comparison period is shown: " + esc((m.comparisonInfo && m.comparisonInfo.reason) || "none selected") + "");
      }
    } else if (m.capabilities && m.capabilities.hasPrior === false && !legacy) {
      notes.push("This report has no previous-period columns, so period-over-period columns read \"no prior period\".");
    }
    var hasPid = !!(m.capabilities && m.capabilities.hasProductId);
    notes.push("This export has " + (hasPid ? "Shopify product ids but no SKU" : "no SKU, product id") + ", variant id or daily dates. " +
               "Rows are products, not variants, and only periods covered by a saved report can be selected.");
    if (notes.length) html += '<div class="small" style="margin-top:8px">' + notes.map(function (n) { return "• " + n; }).join("<br>") + "</div>";
    el.innerHTML = html;
  }

  function renderSbCards(snap, scoped, all, excluded, measure) {
    var t = PG.groupTotals(scoped);
    var cmp = compareSnap();
    var cards = [];
    var ch = SR.shopifyChange(t.cur[measure], t.prior[measure], t.priorKnown);

    cards.push({ label: MEASURE_LABELS[measure] + " (in scope)", value: val(t.cur[measure], measure),
                 sub: t.priorKnown ? changeSub(ch, measure) : "no prior period recorded" });
    cards.push({ label: "Net items sold", value: count(t.cur.units),
                 sub: t.priorKnown ? changeSub(SR.shopifyChange(t.cur.units, t.prior.units, true), "units") : "" });
    cards.push({ label: "Products in scope", value: count(scoped.length),
                 sub: count(scoped.filter(function (r) { return r.cur.units !== 0 || r.cur.net !== 0; }).length) + " with recorded sales" });
    cards.push({ label: "Groups", value: count(PG.aggregateByGroup(scoped).length),
                 sub: count(scoped.filter(function (r) { return r.isPlant; }).length) + " plant products" });
    cards.push({ label: "Avg net sales / unit", value: money(PG.avgPerUnit(t.cur)) });
    if (excluded.length) {
      cards.push({ label: "Excluded (shown separately)", value: money(excluded.reduce(function (s, r) { return s + r.cur.net; }, 0)),
                   sub: excluded.map(function (r) { return esc(r.exclusionLabel); }).join(", ") });
    }
    if (cmp) cards.push({ label: "Compared snapshot", value: esc(cmp.label), sub: "separate report, not summed" });

    document.getElementById("shopify-cards").innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + "</div>" +
             (c.sub ? '<div class="sub">' + c.sub + "</div>" : "") + "</div>";
    }).join("");
  }
  var changeSub = function (ch, measure) { return BUI.changeSub(ch, measure); };

  function renderGroupChart(scoped, measure) {
    var buckets = PG.aggregateByGroup(scoped).sort(function (a, b) { return b.cur[measure] - a.cur[measure]; }).slice(0, 25);
    var cvs = document.getElementById("shopify-chart");
    if (!cvs) return;
    if (SBS.charts.group) SBS.charts.group.destroy();
    document.getElementById("sb-chart-note").textContent =
      "Plants by genus, everything else by product category — " + MEASURE_LABELS[measure];
    SBS.charts.group = new Chart(cvs.getContext("2d"), {
      type: "bar",
      data: {
        labels: buckets.map(function (b) { return b.group; }),
        datasets: [{
          data: buckets.map(function (b) { return b.cur[measure]; }),
          backgroundColor: buckets.map(function (b) { return b.groupType === PG.GROUP_TYPE_GENUS ? "#2e7d32" : "#5e35b1"; })
        }]
      },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (c) {
            var b = buckets[c.dataIndex];
            return b.groupType + " · " + val(c.parsed.x, measure) + " · " + b.products + " products";
          } } }
        },
        scales: { x: { ticks: { callback: window.fmtAxis } } }
      }
    });
  }

  var GROUP_COLS = [
    { k: "group", label: "Group", cls: "" },
    { k: "groupType", label: "Group type", cls: "" },
    { k: "withSales", label: "Products w/ sales", cls: "num" },
    { k: "products", label: "Products", cls: "num" },
    { k: "units", label: "Units", cls: "num" },
    { k: "cur", label: "", cls: "num" },
    { k: "avg", label: "Avg / unit", cls: "num" },
    { k: "share", label: "Share", cls: "num" },
    { k: "prior", label: "Prior", cls: "num" },
    { k: "delta", label: "Δ", cls: "num" },
    { k: "pct", label: "Δ %", cls: "num" }
  ];

  function sortBuckets(buckets, sort, measure) {
    var dir = sort.dir === "asc" ? 1 : -1;
    return buckets.slice().sort(function (a, b) {
      var av, bv;
      switch (sort.col) {
        case "group": case "groupType": av = a[sort.col] || ""; bv = b[sort.col] || ""; return av.localeCompare(bv) * dir;
        case "withSales": case "products": av = a[sort.col]; bv = b[sort.col]; break;
        case "units": av = a.cur.units; bv = b.cur.units; break;
        case "avg": av = PG.avgPerUnit(a.cur); bv = PG.avgPerUnit(b.cur); break;
        case "share": av = a.share || 0; bv = b.share || 0; break;
        case "prior": av = a.prior[measure]; bv = b.prior[measure]; break;
        case "delta": av = a.cur[measure] - a.prior[measure]; bv = b.cur[measure] - b.prior[measure]; break;
        case "pct":
          av = a.prior[measure] ? (a.cur[measure] - a.prior[measure]) / Math.abs(a.prior[measure]) : -Infinity;
          bv = b.prior[measure] ? (b.cur[measure] - b.prior[measure]) / Math.abs(b.prior[measure]) : -Infinity;
          break;
        default: av = a.cur[measure]; bv = b.cur[measure];
      }
      return (av - bv) * dir;
    });
  }

  function renderGroupTable(scoped, measure) {
    var q = (document.getElementById("shopify-genus-search").value || "").toLowerCase();
    var buckets = PG.withShare(PG.aggregateByGroup(scoped), measure);
    var shown = buckets.filter(function (b) { return !q || b.group.toLowerCase().indexOf(q) >= 0; });
    shown = sortBuckets(shown, SBS.groupSort, measure);

    document.getElementById("shopify-genus-count").textContent = shown.length + " groups";
    document.getElementById("shopify-genus-thead").innerHTML = GROUP_COLS.map(function (c) {
      var lbl = c.k === "cur" ? MEASURE_LABELS[measure] : c.label;
      var arrow = SBS.groupSort.col === c.k ? (SBS.groupSort.dir === "desc" ? " ▾" : " ▴") : "";
      return "<th class=\"" + c.cls + "\" data-gsort=\"" + c.k + "\">" + esc(lbl) + arrow + "</th>";
    }).join("");

    document.getElementById("shopify-genus-tbody").innerHTML = shown.map(function (b) {
      var ch = SR.shopifyChange(b.cur[measure], b.prior[measure], b.priorKnown);
      return '<tr class="clickable" data-group="' + esc(b.group) + '">' +
        "<td><b>" + esc(b.group) + "</b></td>" +
        "<td>" + groupTypeBadge(b.groupType) + "</td>" +
        '<td class="num">' + count(b.withSales) + "</td>" +
        '<td class="num">' + count(b.products) + "</td>" +
        '<td class="num">' + count(b.cur.units) + "</td>" +
        '<td class="num"><b>' + val(b.cur[measure], measure) + "</b></td>" +
        '<td class="num">' + money(PG.avgPerUnit(b.cur)) + "</td>" +
        '<td class="num">' + (b.share * 100).toFixed(1) + "%</td>" +
        '<td class="num">' + (b.priorKnown ? val(b.prior[measure], measure) : "—") + "</td>" +
        deltaCell(ch, measure) + pctCell(ch) +
        "</tr>";
    }).join("") || '<tr><td colspan="11" class="empty">No products match the current filters.</td></tr>';
  }

  // Column specs. The same specs drive the painted table and the CSV, so an
  // export can never disagree with what is on screen.
  //
  // "Imported product type" and "Analytics group" are deliberately two
  // separate columns: the first is exactly what the source stated, the second
  // is the normalized grouping, which an override may change.
  function m() { return SBS.scope.measure; }
  function chg(r) { return BUI.changeOf(r.cur[m()], r.prior[m()], r.priorKnown); }

  var PROD_COLS = [
    { k: "title", label: "Product", sortVal: function (r) { return r.title; },
      csv: function (r) { return r.title; },
      cell: function (r) {
        return "<td>" + esc(r.title) +
          (r.overridden ? ' <span class="badge ovr" title="Analytics group set by hand; imported values unchanged">override</span>' : "") +
          (r.suspicion && r.suspicion.severity === "review" && !r.overridden
            ? ' <span class="badge flagq" title="' + esc(r.suspicion.message) + '">check</span>' : "") +
          "</td>";
      } },
    { k: "vendor", label: "Vendor", sortVal: function (r) { return r.vendor; },
      cell: function (r) { return "<td>" + esc(r.vendor) + "</td>"; } },
    { k: "ptype", label: "Imported product type",
      title: "Exactly as the Shopify export stated it. An override never rewrites this.",
      sortVal: function (r) { return r.ptype; },
      cell: function (r) {
        return '<td class="small">' + esc(r.ptype) +
          (r.ptypeBlank ? ' <span class="badge type-other">blank in export</span>' : "") + "</td>";
      },
      csv: function (r) { return r.ptypeBlank ? "" : r.ptype; } },
    { k: "group", label: "Analytics group", sortVal: function (r) { return r.group; },
      csv: function (r) { return r.group; },
      cell: function (r) { return "<td>" + esc(r.group) + " " + BUI.groupTypeBadge(r.groupType) + "</td>"; } },
    { k: "groupType", label: "Group type", sortVal: function (r) { return r.groupType; },
      cell: function (r) { return '<td class="small">' + esc(r.groupType) + "</td>"; } },
    { k: "units", label: "Net items sold", cls: "num", sortVal: function (r) { return r.cur.units; },
      cell: function (r) { return '<td class="num">' + count(r.cur.units) + "</td>"; } },
    { k: "gross", label: "Gross sales", cls: "num", sortVal: function (r) { return r.cur.gross; },
      cell: function (r) { return '<td class="num">' + money(r.cur.gross) + "</td>"; } },
    { k: "disc", label: "Discounts", cls: "num", sortVal: function (r) { return r.cur.disc; },
      cell: function (r) { return '<td class="num">' + money(r.cur.disc) + "</td>"; } },
    { k: "ret", label: "Sales reversals", cls: "num", sortVal: function (r) { return r.cur.ret; },
      cell: function (r) { return '<td class="num">' + money(r.cur.ret) + "</td>"; } },
    { k: "net", label: "Net sales", cls: "num", sortVal: function (r) { return r.cur.net; },
      cell: function (r) { return '<td class="num"><b>' + money(r.cur.net) + "</b></td>"; } },
    { k: "tax", label: "Taxes", cls: "num", sortVal: function (r) { return r.cur.tax; },
      cell: function (r) { return '<td class="num">' + money(r.cur.tax) + "</td>"; } },
    { k: "total", label: "Total sales", cls: "num", sortVal: function (r) { return r.cur.total; },
      cell: function (r) { return '<td class="num">' + money(r.cur.total) + "</td>"; } },
    { k: "prior", label: function () { return "Prior " + MEASURE_LABELS[SBS.scope.measure].toLowerCase(); }, cls: "num",
      sortVal: function (r) { return r.priorKnown ? r.prior[m()] : null; },
      cell: function (r) { return '<td class="num">' + (r.priorKnown ? val(r.prior[m()], m()) : "—") + "</td>"; } },
    { k: "delta", label: "Δ", cls: "num", title: "Absolute change, always shown beside the percentage",
      sortVal: function (r) { return chg(r).abs; },
      cell: function (r) { return BUI.deltaCell(chg(r), m()); } },
    { k: "pct", label: "Δ %", cls: "num", title: "percentage change = (current − prior) ÷ |prior| × 100",
      sortVal: function (r) { var c = chg(r); return c.pct == null ? null : c.pct; },
      cell: function (r) { return BUI.pctCell(chg(r)); } }
  ];

  function renderPerfTable(scoped, measure) {
    var q = (document.getElementById("sb-perf-search").value || "").toLowerCase();
    var recs = scoped.filter(function (r) {
      return !q || (r.title + " " + r.vendor + " " + r.group).toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById("sb-perf-count").textContent = recs.length + " products";
    BUI.renderTable({
      rows: recs, cols: PROD_COLS, sort: SBS.perfSort, sortAttr: "psort",
      theadId: "sb-perf-thead", tbodyId: "sb-perf-tbody",
      pagerId: "sb-perf-pager", pageState: SBS.perfPage,
      redraw: function () { renderPerfTable(scoped, measure); },
      emptyMsg: "No products match the current filters."
    });
  }

  // Rankings stay a top-N list by design; the complete table above is the
  // place to browse everything.
  var RANK_CAP = 200;
  function renderHighRevenue(scoped, measure) {
    var th = state.topPlants.shopify.threshold;
    var recs = scoped.filter(function (r) { return Math.abs(r.cur[measure]) >= th; });
    document.getElementById("shopify-tp-heading").textContent =
      "High-revenue products (" + MEASURE_LABELS[measure] + " ≥ " + val(th, measure) + ")";
    document.getElementById("shopify-tp-count").textContent =
      recs.length + " products" + (recs.length > RANK_CAP ? " · top " + RANK_CAP + " shown" : "");
    BUI.renderTable({
      rows: recs.slice().sort(function (a, b) { return b.cur[measure] - a.cur[measure]; }).slice(0, RANK_CAP),
      cols: PROD_COLS, sort: { col: "cur", dir: "desc" }, sortAttr: "nosort",
      theadId: "shopify-tp-thead", tbodyId: "shopify-tp-tbody",
      emptyMsg: "No products reach this threshold in the current scope."
    });
  }

  function renderGroupDrill(scoped, measure) {
    var box = document.getElementById("shopify-drill");
    var bucket = PG.aggregateByGroup(scoped).filter(function (b) { return b.group === SBS.drillGroup; })[0];
    if (!bucket) { box.style.display = "none"; SBS.drillGroup = null; return; }
    box.style.display = "block";
    var filter = state.shopify.drillFilter;
    var q = (document.getElementById("shopify-prod-search").value || "").toLowerCase();
    var recs = bucket.records.filter(function (r) {
      if (filter === "ge100" && Math.abs(r.cur[measure]) < 100) return false;
      return !q || r.title.toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById("shopify-drill-title").innerHTML =
      esc(bucket.group) + " " + BUI.groupTypeBadge(bucket.groupType) +
      ' <span class="small">' + val(bucket.cur[measure], measure) + " · " + bucket.products + " products</span>";
    document.getElementById("shopify-drill-count").textContent = recs.length + " in this group";
    BUI.renderTable({
      rows: recs, cols: PROD_COLS, sort: SBS.perfSort, sortAttr: "psort",
      theadId: "shopify-prod-thead", tbodyId: "shopify-prod-tbody",
      pagerId: "sb-drill-pager", pageState: SBS.drillPage,
      redraw: function () { renderGroupDrill(scoped, measure); },
      emptyMsg: "Nothing matches."
    });
  }

  function renderFlagged(all) {
    var panel = document.getElementById("sb-flag-panel");
    if (!panel) return;
    var flagged = PG.flaggedRecords(all, "review");
    var overrides = window.SBFlagUI.activeOverrides();
    document.getElementById("sb-flag-count").textContent =
      flagged.length + " to review" + (overrides.length ? " · " + overrides.length + " overridden" : "");
    var body = panel.querySelector(".flag-body");
    var undo = overrides.length
      ? '<div class="small" style="margin-top:6px">' + overrides.length +
        ' classification(s) set by hand. <a href="#" id="sb-clear-ov">Clear all overrides</a></div>' : "";
    if (!flagged.length) {
      body.innerHTML = '<div class="small">No disagreement between any imported product type and its product title.</div>' + undo;
    } else {
      body.innerHTML = window.SBFlagUI.render(flagged, "sb") + undo;
      window.SBFlagUI.wire(panel, "sb", function () { SBS.drillGroup = null; renderShopify(); });
    }
    var clr = document.getElementById("sb-clear-ov");
    if (clr) clr.onclick = function (ev) {
      ev.preventDefault();
      if (confirm("Remove every hand-set classification override? Imported values are not affected.")) {
        window.SBFlagUI.clearAll(); renderShopify();
      }
    };
  }

  // ----------------------------------------------------------
  // VENDORS TAB
  // ----------------------------------------------------------
  function renderVendors() {
    var snaps = snapshotsFor("shopify");
    var sel = document.getElementById("vendors-snap-select");
    sel.innerHTML = '<option value="">— Pick a report —</option>' + snaps.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === state.shopify.snapshotId ? " selected" : "") + ">" +
             esc(s.label) + " (" + s.products.length + " products)</option>";
    }).join("");
    var csel = document.getElementById("vendors-compare-select");
    csel.innerHTML = '<option value="">— None —</option>' + snaps.filter(function (s) {
      return s.id !== state.shopify.snapshotId;
    }).map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === state.shopify.compareId ? " selected" : "") + ">" + esc(s.label) + "</option>";
    }).join("");

    var snap = currentSnap();
    var bar = document.getElementById("vendors-scopebar");
    if (!snap) {
      document.getElementById("vendors-content").style.display = "none";
      document.getElementById("vendors-empty").style.display = "block";
      bar.style.display = "none";
      return;
    }
    document.getElementById("vendors-content").style.display = "block";
    document.getElementById("vendors-empty").style.display = "none";
    bar.style.display = "flex";

    var part = partition(snap);
    var all = part.included, excluded = part.excluded;
    fillSelect(document.getElementById("vn-ptype"), uniqueSorted(all, "ptype"), SBS.scope.ptype, "All product types");
    document.getElementById("vn-measure").value = SBS.scope.measure;
    document.getElementById("vn-plantscope").value = SBS.scope.plantScope;
    syncChannelSelect("vn", snap);
    var vs = document.getElementById("vn-search"); if (vs.value !== SBS.scope.search) vs.value = SBS.scope.search;

    // Vendor analytics ignores the vendor filter (that is what the table is for)
    var scope = Object.assign({}, SBS.scope, { vendor: "All", group: "All" });
    var scoped = PG.applyScope(all, scope);
    var measure = SBS.scope.measure;

    renderProvenance("vn-provenance", snap, all, excluded, scoped);

    var t = PG.groupTotals(scoped);
    var vendors = PG.withShare(PG.aggregateByVendor(scoped), measure);
    var cards = [
      { label: "Vendors", value: count(vendors.length) },
      { label: MEASURE_LABELS[measure] + " (all vendors)", value: val(t.cur[measure], measure),
        sub: t.priorKnown ? changeSub(SR.shopifyChange(t.cur[measure], t.prior[measure], true), measure) : "no prior period" },
      { label: "Net items sold", value: count(t.cur.units) },
      { label: "Products with recorded sales", value: count(scoped.filter(function (r) { return r.cur.units !== 0 || r.cur.net !== 0; }).length),
        sub: "of " + count(scoped.length) + " in scope" }
    ];
    if (excluded.length) {
      cards.push({ label: "Excluded (shown separately)", value: money(excluded.reduce(function (s, r) { return s + r.cur.net; }, 0)),
                   sub: excluded.map(function (r) { return esc(r.exclusionLabel); }).join(", ") });
    }
    document.getElementById("vn-cards").innerHTML = cards.map(function (c) {
      return '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + "</div>" +
             (c.sub ? '<div class="sub">' + c.sub + "</div>" : "") + "</div>";
    }).join("");

    var cols = [
      { k: "vendor", label: "Vendor" },
      { k: "cur", label: MEASURE_LABELS[measure], cls: "num" },
      { k: "units", label: "Net units sold", cls: "num" },
      { k: "withSales", label: "Products w/ sales", cls: "num" },
      { k: "products", label: "Products in report", cls: "num" },
      { k: "share", label: "Share of scope", cls: "num" },
      { k: "prior", label: "Prior " + MEASURE_LABELS[measure].toLowerCase(), cls: "num" },
      { k: "priorUnits", label: "Prior units", cls: "num" },
      { k: "delta", label: "Δ", cls: "num" },
      { k: "pct", label: "Δ %", cls: "num" }
    ];
    var sorted = sortBuckets(vendors, SBS.vendorSort, measure);
    document.getElementById("vn-count").textContent = sorted.length + " vendors";
    document.getElementById("vn-thead").innerHTML = cols.map(function (c) {
      var arrow = SBS.vendorSort.col === c.k ? (SBS.vendorSort.dir === "desc" ? " ▾" : " ▴") : "";
      return '<th class="' + (c.cls || "") + '" data-vsort="' + c.k + '">' + esc(c.label) + arrow + "</th>";
    }).join("");
    document.getElementById("vn-tbody").innerHTML = sorted.map(function (v) {
      var ch = SR.shopifyChange(v.cur[measure], v.prior[measure], v.priorKnown);
      return '<tr class="clickable" data-vendor="' + esc(v.vendor) + '">' +
        "<td><b>" + esc(v.vendor) + "</b></td>" +
        '<td class="num"><b>' + val(v.cur[measure], measure) + "</b></td>" +
        '<td class="num">' + count(v.cur.units) + "</td>" +
        '<td class="num">' + count(v.withSales) + "</td>" +
        '<td class="num">' + count(v.products) + "</td>" +
        '<td class="num">' + (v.share * 100).toFixed(1) + "%</td>" +
        '<td class="num">' + (v.priorKnown ? val(v.prior[measure], measure) : "—") + "</td>" +
        '<td class="num">' + (v.priorKnown ? count(v.prior.units) : "—") + "</td>" +
        deltaCell(ch, measure) + pctCell(ch) +
        "</tr>";
    }).join("") || '<tr><td colspan="10" class="empty">No vendors in scope.</td></tr>';

    if (SBS.drillVendor) renderVendorDrill(scoped, measure);
    else document.getElementById("vn-drill").style.display = "none";
  }

  function renderVendorDrill(scoped, measure) {
    var name = SBS.drillVendor;
    var recs = scoped.filter(function (r) { return r.vendor === name; });
    var box = document.getElementById("vn-drill");
    if (!recs.length) { box.style.display = "none"; SBS.drillVendor = null; return; }
    box.style.display = "block";
    document.getElementById("vn-drill-title").innerHTML = esc(name);

    var t = PG.groupTotals(recs);
    var ch = SR.shopifyChange(t.cur[measure], t.prior[measure], t.priorKnown);
    var byType = PG.withShare(PG.aggregateByProductType(recs), measure);
    var byGenus = PG.withShare(PG.aggregateByGroup(recs.filter(function (r) { return r.isPlant; })), measure);
    var movers = recs.filter(function (r) { return r.priorKnown && r.prior[measure] !== 0; })
      .map(function (r) { return { r: r, d: r.cur[measure] - r.prior[measure] }; })
      .sort(function (a, b) { return b.d - a.d; });
    var up = movers.slice(0, 10), down = movers.slice(-10).reverse().filter(function (x) { return x.d < 0; });
    var top = recs.slice().sort(function (a, b) { return b.cur[measure] - a.cur[measure]; }).slice(0, 15);
    var vendorSorted = recs.slice().sort(function (a, b) { return b.cur[measure] - a.cur[measure]; });
    var vendorPage = PG.paginate(vendorSorted, SBS.vendorPage.page, SBS.vendorPage.pageSize);

    function miniTable(title, head, rows, note) {
      return '<div class="panel" style="margin:0 0 12px 0">' +
        '<div class="panel-h"><h2 style="font-size:14px">' + title + "</h2></div>" +
        '<div class="scroll" style="max-height:360px"><table><thead><tr>' + head + "</tr></thead><tbody>" +
        (rows || '<tr><td class="empty">Nothing to show.</td></tr>') + "</tbody></table></div>" +
        (note ? '<div class="small" style="margin-top:6px">' + note + "</div>" : "") + "</div>";
    }

    var summary = '<div class="grid cards" style="margin-bottom:12px">' + [
      { label: MEASURE_LABELS[measure], value: val(t.cur[measure], measure), sub: t.priorKnown ? changeSub(ch, measure) : "no prior period" },
      { label: "Net units sold", value: count(t.cur.units), sub: t.priorKnown ? "prior " + count(t.prior.units) : "" },
      { label: "Products with recorded sales", value: count(recs.filter(function (r) { return r.cur.units !== 0 || r.cur.net !== 0; }).length), sub: "of " + count(recs.length) },
      { label: "Avg net sales / unit", value: money(PG.avgPerUnit(t.cur)) }
    ].map(function (c) {
      return '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + "</div>" +
             (c.sub ? '<div class="sub">' + c.sub + "</div>" : "") + "</div>";
    }).join("") + "</div>";

    var typeHead = '<th>Product type / category</th><th class="num">Products w/ sales</th><th class="num">Units</th><th class="num">' +
                   esc(MEASURE_LABELS[measure]) + '</th><th class="num">Share</th><th class="num">Prior</th><th class="num">Δ</th><th class="num">Δ %</th>';
    var typeRows = sortBuckets(byType, { col: "cur", dir: "desc" }, measure).map(function (b) {
      var c = SR.shopifyChange(b.cur[measure], b.prior[measure], b.priorKnown);
      return "<tr><td><b>" + esc(b.ptype) + "</b></td>" +
        '<td class="num">' + count(b.withSales) + '</td><td class="num">' + count(b.cur.units) + "</td>" +
        '<td class="num"><b>' + val(b.cur[measure], measure) + '</b></td><td class="num">' + (b.share * 100).toFixed(1) + "%</td>" +
        '<td class="num">' + (b.priorKnown ? val(b.prior[measure], measure) : "—") + "</td>" +
        deltaCell(c, measure) + pctCell(c) + "</tr>";
    }).join("");

    var genusHead = '<th>Genus</th><th class="num">Products w/ sales</th><th class="num">Units</th><th class="num">' +
                    esc(MEASURE_LABELS[measure]) + '</th><th class="num">Prior</th><th class="num">Δ %</th>';
    var genusRows = sortBuckets(byGenus, { col: "cur", dir: "desc" }, measure).map(function (b) {
      var c = SR.shopifyChange(b.cur[measure], b.prior[measure], b.priorKnown);
      return "<tr><td><b>" + esc(b.group) + "</b></td>" +
        '<td class="num">' + count(b.withSales) + '</td><td class="num">' + count(b.cur.units) + "</td>" +
        '<td class="num">' + val(b.cur[measure], measure) + "</td>" +
        '<td class="num">' + (b.priorKnown ? val(b.prior[measure], measure) : "—") + "</td>" + pctCell(c) + "</tr>";
    }).join("");

    function moverRows(list) {
      return list.map(function (x) {
        var c = SR.shopifyChange(x.r.cur[measure], x.r.prior[measure], true);
        return "<tr><td>" + esc(x.r.title) + "</td><td>" + esc(x.r.group) + "</td>" +
          '<td class="num">' + val(x.r.cur[measure], measure) + '</td><td class="num">' + val(x.r.prior[measure], measure) + "</td>" +
          deltaCell(c, measure) + pctCell(c) + "</tr>";
      }).join("");
    }
    var moverHead = '<th>Product</th><th>Group</th><th class="num">Current</th><th class="num">Prior</th><th class="num">Δ</th><th class="num">Δ %</th>';

    document.getElementById("vn-drill-body").innerHTML =
      summary +
      miniTable("Breakdown by product type / category", typeHead, typeRows,
                "Primary drill-down: vendor → product type/category → product. Every product type is included.") +
      miniTable("Top products (all categories)", BUI.headHtml(PROD_COLS, null, "nosort"),
                BUI.rowsHtml(top, PROD_COLS, {})) +
      miniTable("Biggest increases", moverHead, moverRows(up)) +
      miniTable("Biggest declines", moverHead, moverRows(down)) +
      miniTable("Plants by genus (additional view)", genusHead, genusRows,
                "A plant-specific view inside this vendor. It does not decide which products appear above.") +
      miniTable("Complete product table", BUI.headHtml(PROD_COLS, null, "nosort"),
                BUI.rowsHtml(vendorPage.rows, PROD_COLS, {}),
                "" ) +
      '<div id="vn-drill-pager"></div>' +
      '<div class="panel" style="margin:0"><div class="panel-h"><h2 style="font-size:14px">Catalog products with no recorded sales</h2></div>' +
      '<div class="small">Needs a Product Master. Without one, this report alone cannot tell a product that did not sell ' +
      "from a product that is not in the catalog, so nothing is listed here. " +
      count(recs.filter(function (r) { return r.cur.units === 0 && r.cur.net === 0; }).length) +
      " products in this vendor appear in the report with zero sales this period.</div></div>";

    // The complete product table for a vendor is browsable in full.
    var bar = document.getElementById("vn-drill-pager");
    if (bar) {
      bar.innerHTML = BUI.paginationBar(vendorPage, "vn-drill-pager");
      BUI.wirePagination("vn-drill-pager", SBS.vendorPage, function () { renderVendors(); }, vendorPage.pages);
    }
  }

  // ----------------------------------------------------------
  // DOWNLOADS — always the current scope
  // ----------------------------------------------------------
  function csvEscape(v) {
    var s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, rows) {
    var csv = rows.map(function (r) { return r.map(csvEscape).join(","); }).join("\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function scopeNote(snap) {
    var m = snap.meta || {};
    return [
      ["# Source", m.sourceFilename || snap.fileName || ""],
      ["# Reporting period", (m.current ? m.current.start + " to " + m.current.end : snap.startDate + " to " + snap.endDate)],
      ["# Comparison period", m.comparison ? m.comparison.start + " to " + m.comparison.end : "not recorded"],
      ["# Timezone", m.timezone || STORE_TZ],
      ["# Currency", m.currency || ""],
      ["# Filters", "vendor=" + SBS.scope.vendor + "; type=" + SBS.scope.ptype + "; group=" + SBS.scope.group +
                    "; scope=" + SBS.scope.plantScope + "; search=" + (SBS.scope.search || "-") + "; measure=" + SBS.scope.measure + "; flaggedOnly=" + !!SBS.scope.flagged +
                    (SR.shopifyChannelStatus(snap).hasChannel ? "; channel=" + SBS.scope.channel : (SR.shopifyChannelStatus(snap).mayIncludeAmazon ? "; channel=not in report (includes Amazon via Sellbrite)" : ""))],
      ["# Exclusions", "Route (shipping protection) excluded from rankings"],
      ["# Percentage change formula", "(current - prior) / abs(prior) * 100"],
      [""]
    ];
  }
  // The export uses the table's own column specs, so a download can never
  // disagree with the screen, and it always contains the complete filtered
  // scope rather than the page being displayed.
  function productCsvRows(recs, measure) {
    var sorted = recs.slice().sort(function (a, b) { return b.cur[measure] - a.cur[measure]; });
    var rows = BUI.csvFromCols(sorted, PROD_COLS, {});
    rows[0] = rows[0].concat(["Comparison state", "Classification basis", "Overridden", "Group before override"]);
    sorted.forEach(function (r, i) {
      var ch = BUI.changeOf(r.cur[measure], r.prior[measure], r.priorKnown);
      rows[i + 1] = rows[i + 1].concat([
        ch.state === "new" ? "New / no prior sales" : ch.state,
        r.classificationBasis || "", r.overridden ? "yes" : "no", r.naturalGroup || r.group]);
    });
    return rows;
  }

  function scopedNow() {
    var snap = currentSnap();
    if (!snap) return null;
    var part = partition(snap);
    return { snap: snap, all: part.included, excluded: part.excluded, scoped: PG.applyScope(part.included, SBS.scope) };
  }

  function dlProducts(filename, recs) {
    var s = scopedNow(); if (!s) return;
    download(filename, scopeNote(s.snap).concat(productCsvRows(recs, SBS.scope.measure)));
  }

  // ----------------------------------------------------------
  // WIRING
  // ----------------------------------------------------------
  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    if (source === "shopify") return renderShopify();
    if (source === "vendors") return renderVendors();
    return origRenderTab(source);
  };

  function on(id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
  function rerender() { window.renderTab(activeTab === "vendors" ? "vendors" : "shopify"); }

  function wire() {
    // app.js defaults drillFilter to "ge100", but the markup marks
    // "All products" as the active button. Make the state match the button
    // rather than silently hiding rows under $100.
    state.shopify.drillFilter = "all";

    // app.js already attached its own handlers to these three buttons for the
    // Shopify tab. Replacing the nodes drops those listeners so a click does
    // not produce two different CSVs from two different scopes.
    ["shopify-download", "shopify-download-breakdown", "shopify-tp-download"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.replaceChild(el.cloneNode(true), el);
    });

    // scope bar — Shopify
    on("sb-measure", "change", function (e) { SBS.scope.measure = e.target.value; rerender(); });
    on("sb-vendor", "change", function (e) { SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.scope.vendor = e.target.value; SBS.drillGroup = null; rerender(); });
    on("sb-ptype", "change", function (e) { SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.scope.ptype = e.target.value; SBS.drillGroup = null; rerender(); });
    on("sb-group", "change", function (e) { SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.scope.group = e.target.value; SBS.drillGroup = null; rerender(); });
    on("sb-plantscope", "change", function (e) { SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.scope.plantScope = e.target.value; SBS.drillGroup = null; rerender(); });
    on("sb-search", "input", function (e) { SBS.scope.search = e.target.value; SBS.perfPage.page = 1; rerender(); });
    on("sb-flagged", "change", function (e) { SBS.scope.flagged = e.target.checked; SBS.perfPage.page = 1; rerender(); });
    on("sb-channel", "change", function (e) { SBS.scope.channel = e.target.value; SBS.perfPage.page = 1; SBS.drillPage.page = 1; SBS.drillGroup = null; rerender(); });
    on("vn-channel", "change", function (e) { SBS.scope.channel = e.target.value; SBS.drillVendor = null; rerender(); });
    on("sb-reset", "click", function () { resetScope(); rerender(); });
    on("sb-perf-search", "input", function () { SBS.perfPage.page = 1; renderShopify(); });

    // scope bar — Vendors
    on("vn-measure", "change", function (e) { SBS.scope.measure = e.target.value; rerender(); });
    on("vn-ptype", "change", function (e) { SBS.scope.ptype = e.target.value; rerender(); });
    on("vn-plantscope", "change", function (e) { SBS.scope.plantScope = e.target.value; rerender(); });
    on("vn-search", "input", function (e) { SBS.scope.search = e.target.value; rerender(); });
    on("vn-reset", "click", function () { resetScope(); rerender(); });
    on("vendors-snap-select", "change", function (e) {
      state.shopify.snapshotId = e.target.value || null; SBS.drillVendor = null; SBS.drillGroup = null; rerender();
    });
    on("vendors-compare-select", "change", function (e) {
      state.shopify.compareId = e.target.value || null;
      state.shopify.mode = state.shopify.compareId ? "compare" : "single";
      rerender();
    });
    on("vn-drill-close", "click", function () { SBS.drillVendor = null; renderVendors(); });

    // table interactions
    document.addEventListener("click", function (e) {
      var th = e.target.closest ? e.target.closest("th[data-gsort]") : null;
      if (th) { toggleSort(SBS.groupSort, th.dataset.gsort); return renderShopify(); }
      var tp = e.target.closest ? e.target.closest("th[data-psort]") : null;
      if (tp) { toggleSort(SBS.perfSort, tp.dataset.psort); SBS.perfPage.page = 1; SBS.drillPage.page = 1; return renderShopify(); }
      var tv = e.target.closest ? e.target.closest("th[data-vsort]") : null;
      if (tv) { toggleSort(SBS.vendorSort, tv.dataset.vsort); return renderVendors(); }
      var gr = e.target.closest ? e.target.closest("tr[data-group]") : null;
      if (gr) { SBS.drillGroup = gr.dataset.group; renderShopify();
                document.getElementById("shopify-drill").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      var vr = e.target.closest ? e.target.closest("tr[data-vendor]") : null;
      if (vr) { SBS.drillVendor = vr.dataset.vendor; renderVendors();
                document.getElementById("vn-drill").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    });
    on("shopify-close-drill", "click", function () { SBS.drillGroup = null; renderShopify(); });

    // downloads
    on("sb-group-download", "click", function () {
      var s = scopedNow(); if (!s) return;
      var m = SBS.scope.measure;
      var buckets = PG.withShare(PG.aggregateByGroup(s.scoped), m);
      var head = ["Group", "Group type", "Products with recorded sales", "Products", "Units",
                  MEASURE_LABELS[m], "Avg net sales per unit", "Share of scope",
                  "Prior " + MEASURE_LABELS[m], "Prior units", "Change", "Change %", "Comparison state"];
      var rows = sortBuckets(buckets, SBS.groupSort, m).map(function (b) {
        var ch = SR.shopifyChange(b.cur[m], b.prior[m], b.priorKnown);
        return [b.group, b.groupType, b.withSales, b.products, b.cur.units, b.cur[m], PG.avgPerUnit(b.cur),
                (b.share * 100).toFixed(2) + "%", b.priorKnown ? b.prior[m] : "", b.priorKnown ? b.prior.units : "",
                ch.abs == null ? "" : ch.abs, ch.pct == null ? "" : ch.pct,
                ch.state === "new" ? "New / no prior sales" : ch.state];
      });
      var extra = s.excluded.length
        ? [[""], ["# Excluded from the figures above"], ["Product", "Vendor", "Reason", "Net sales", "Total sales"]]
            .concat(s.excluded.map(function (r) { return [r.title, r.vendor, r.exclusionLabel, r.cur.net, r.cur.total]; }))
        : [];
      download("shopify-product-breakdown.csv", scopeNote(s.snap).concat([head]).concat(rows).concat(extra));
    });
    on("sb-perf-download", "click", function () {
      var s = scopedNow(); if (!s) return;
      var q = (document.getElementById("sb-perf-search").value || "").toLowerCase();
      dlProducts("shopify-product-performance.csv", s.scoped.filter(function (r) {
        return !q || (r.title + " " + r.vendor + " " + r.group).toLowerCase().indexOf(q) >= 0;
      }));
    });
    on("sb-drill-download", "click", function () {
      var s = scopedNow(); if (!s || !SBS.drillGroup) return;
      var b = PG.aggregateByGroup(s.scoped).find(function (x) { return x.group === SBS.drillGroup; });
      if (b) dlProducts("shopify-" + SBS.drillGroup.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".csv", b.records);
    });
    on("shopify-tp-download", "click", function () {
      var s = scopedNow(); if (!s) return;
      var th = state.topPlants.shopify.threshold;
      dlProducts("shopify-high-revenue-products.csv",
        s.scoped.filter(function (r) { return Math.abs(r.cur[SBS.scope.measure]) >= th; }));
    });
    on("shopify-download", "click", function () {
      var s = scopedNow(); if (!s) return;
      dlProducts("shopify-clean-data.csv", s.scoped);
    });
    on("shopify-download-breakdown", "click", function () { document.getElementById("sb-group-download").click(); });
    on("vendors-download", "click", function () {
      var s = scopedNow(); if (!s) return;
      var m = SBS.scope.measure;
      var scope = Object.assign({}, SBS.scope, { vendor: "All", group: "All" });
      var vendors = PG.withShare(PG.aggregateByVendor(PG.applyScope(s.all, scope)), m);
      var head = ["Vendor", MEASURE_LABELS[m], "Net units sold", "Products with recorded sales", "Products in report",
                  "Share of scope", "Prior " + MEASURE_LABELS[m], "Prior units", "Change", "Change %", "Comparison state"];
      var rows = sortBuckets(vendors, SBS.vendorSort, m).map(function (v) {
        var ch = SR.shopifyChange(v.cur[m], v.prior[m], v.priorKnown);
        return [v.vendor, v.cur[m], v.cur.units, v.withSales, v.products, (v.share * 100).toFixed(2) + "%",
                v.priorKnown ? v.prior[m] : "", v.priorKnown ? v.prior.units : "",
                ch.abs == null ? "" : ch.abs, ch.pct == null ? "" : ch.pct,
                ch.state === "new" ? "New / no prior sales" : ch.state];
      });
      download("shopify-vendor-summary.csv", scopeNote(s.snap).concat([head]).concat(rows));
    });
    on("vn-drill-download", "click", function () {
      var s = scopedNow(); if (!s || !SBS.drillVendor) return;
      var scope = Object.assign({}, SBS.scope, { vendor: SBS.drillVendor, group: "All" });
      dlProducts("shopify-vendor-" + SBS.drillVendor.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".csv",
        PG.applyScope(s.all, scope));
    });
  }
  function toggleSort(sort, col) {
    if (sort.col === col) sort.dir = sort.dir === "desc" ? "asc" : "desc";
    else { sort.col = col; sort.dir = "desc"; }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { wire(); boot(); });
  else { wire(); boot(); }

  function boot() {
    // app.js's own DOMContentLoaded handler ends by switching to Amazon.
    // Shopify is now the default view.
    setTimeout(function () {
      if (typeof window.switchTab === "function") window.switchTab("shopify");
    }, 0);
  }
})();
