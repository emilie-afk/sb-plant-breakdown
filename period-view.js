// ============================================================
// period-view.js
// The period selector above the Shopify, Vendors and Amazon analysis:
//   Month · Quarter (Q1 Jan–Mar … Q4 Oct–Dec) · Year
//   Compare with: previous equivalent period · same period last year · none
//
// A chosen period is built by period-engine.js from the latest successful
// revision of each month in shared storage and shown as an ordinary snapshot,
// so every existing view (vendors, genus / category breakdowns, channel and
// vendor filters, exports) works on it unchanged. Combined periods are never
// saved in the browser; they are rebuilt from shared storage when opened.
// ============================================================
(function () {
  "use strict";
  /* global state, snapshots, activeTab */

  var PV = {
    reports: null, offline: null, active: { shopify: false, amazon: false },
    sel: { shopify: null, amazon: null }, compare: { shopify: "previous", amazon: "previous" },
    plan: {}, cmp: {}, busy: {}, error: {}, recCache: {}
  };
  window.SBPeriodView = {
    onReports: onReports, onOffline: onOffline, isActive: function () { return !!PV.active.shopify; },
    noteIndividual: function (src) { PV.active[src] = false; renderBars(); }, _state: PV
  };

  function esc(s) { return window.BUI ? window.BUI.esc(s) : String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function storeToday() {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function authFor(src) { return window.periodAuthoritativeMonths(PV.reports || [], { source: src }); }

  // ---- data ------------------------------------------------------
  async function onReports(reports, opts) {
    opts = opts || {};
    PV.reports = reports; PV.offline = null;
    ["shopify", "amazon"].forEach(function (src) {
      var auth = authFor(src);
      var sel = PV.sel[src];
      var stillThere = sel && window.periodPlan(sel.kind, sel.year, sel.index, auth, { today: storeToday() }).status !== "empty";
      if (!stillThere) PV.sel[src] = window.periodDefaultSelection(auth);
    });
    // Shopify opens on the latest month automatically, unless a person has
    // picked a report by hand in this session.
    if (PV.sel.shopify && !opts.keepSelection) await apply("shopify", { quiet: true });
    renderBars();
  }
  function onOffline(msg) { PV.offline = msg; renderBars(); }

  // Records of one stored report: a copy already in this browser, otherwise
  // fetched (held in memory for this session only).
  async function recordsOf(reportId) {
    if (PV.recCache[reportId]) return PV.recCache[reportId];
    var have = snapshots.filter(function (x) { return x.meta && x.meta.shared && x.meta.shared.reportId === reportId; })[0];
    var snap = have;
    if (!snap) {
      var rep = (PV.reports || []).filter(function (r) { return r.id === reportId; })[0];
      if (!rep) throw new Error("Report " + reportId + " is no longer in shared storage.");
      snap = window.SBShared.buildSnapshot(rep, await window.SBShared.fetchRows(rep));
    }
    PV.recCache[reportId] = { snap: snap, records: snap.products };
    return PV.recCache[reportId];
  }
  function reportById(id) { return (PV.reports || []).filter(function (r) { return r.id === id; })[0] || null; }

  // Builds the chosen period and puts it on screen.
  async function apply(src, opts) {
    opts = opts || {};
    var sel = PV.sel[src];
    if (!sel || !PV.reports) return;
    PV.busy[src] = true; PV.error[src] = null; renderBars();
    try {
      var auth = authFor(src);
      var plan = window.periodPlan(sel.kind, sel.year, sel.index, auth, { today: storeToday() });
      var cmp = window.periodComparison(plan, PV.compare[src], auth, PV.reports, { source: src });
      PV.plan[src] = plan; PV.cmp[src] = cmp;
      if (plan.status === "empty") throw new Error("No saved report covers " + plan.name + ".");
      var snap;
      var single = plan.revisionsUsed.length === 1 && plan.kind === "month";
      if (single && !cmp.available && PV.compare[src] === "previous") {
        // One month, no stored counterpart: show the report itself. A Shopify
        // report carries its own previous-period columns (equal length, dates
        // stated), which is a comparison inside ONE report, never a sum.
        var one = await recordsOf(plan.revisionsUsed[0].reportId);
        snap = one.snap;
        if (snapshots.indexOf(snap) < 0) {
          snap = Object.assign({}, snap, { meta: Object.assign({}, snap.meta, { ephemeral: true }) });
          snap.id += "_view";
          snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
          snapshots.push(snap);
        }
        PV.cmp[src] = Object.assign({}, cmp, { embedded: PV.compare[src] === "previous" && snap.meta && snap.meta.comparison ? snap.meta.comparison : null });
      } else {
        var parts = await Promise.all(plan.revisionsUsed.map(async function (u) {
          return { end: u.end, records: (await recordsOf(u.reportId)).records };
        }));
        var recs = window.periodAggregate(parts);
        if (cmp.available && src === "shopify") {
          var pparts = await Promise.all(cmp.parts.map(async function (x) {
            return { end: x.end, records: (await recordsOf(x.report.id)).records };
          }));
          recs = window.periodAttachComparison(recs, window.periodAggregate(pparts));
        }
        var used = plan.revisionsUsed.map(function (u) { return reportById(u.reportId); }).filter(Boolean);
        var caps = {};
        ["hasProductId", "hasSalesChannel", "hasRevenue", "hasInventory", "hasGlance"].forEach(function (k) {
          var vals = used.map(function (r) { return r.capabilities ? r.capabilities[k] : undefined; });
          if (vals.some(function (v) { return v !== undefined; })) caps[k] = vals.every(function (v) { return v === true || (v === undefined && k === "hasRevenue"); });
        });
        var coverage = plan.revisionsUsed.map(function (u) {
          var r = reportById(u.reportId);
          return { month: u.month, start: u.start, end: u.end, hasChannel: !!(r && r.capabilities && r.capabilities.hasSalesChannel) };
        });
        snap = window.periodBuildSnapshot(src, plan, src === "shopify" ? cmp : null, recs, {
          capabilities: caps, channelCoverage: src === "shopify" ? coverage : null,
          timezone: used[0] && used[0].timezone, currency: used[0] && used[0].currency,
          lastActivatedAt: used.map(function (r) { return r.activated_at || r.imported_at; }).sort().pop()
        });
        snapshots = snapshots.filter(function (x) { return x.id !== snap.id; });
        snapshots.push(snap);
      }
      state[src].snapshotId = snap.id; state[src].mode = "single"; state[src].compareId = null;
      PV.active[src] = true;
      if (src === "shopify" && window.SBAutoLoad) window.SBAutoLoad.userPicked = false;
    } catch (e) {
      PV.error[src] = e.message;
    }
    PV.busy[src] = false;
    if (!opts.quiet) {
      var tab = src === "shopify" ? (activeTab === "vendors" ? "vendors" : "shopify") : "amazon";
      if (activeTab === tab) window.renderTab(tab);
    }
    renderBars();
  }

  // ---- the bar -------------------------------------------------------
  function optionList(src, kind, av) {
    var sel = PV.sel[src] || {};
    if (kind === "month") {
      return av.months.slice().reverse().map(function (m) {
        var y = +m.month.slice(0, 4), i = +m.month.slice(5, 7);
        var on = sel.kind === "month" && sel.year === y && sel.index === i;
        var note = m.status === "missing" ? " — no report" : m.status === "partial" ? " — month to date (" + window.periodRangeText(m.start, m.end) + ")" : "";
        return '<option value="' + y + "-" + i + '"' + (on ? " selected" : "") + (m.status === "missing" ? " disabled" : "") + ">" + esc(m.name + note) + "</option>";
      }).join("");
    }
    if (kind === "quarter") {
      return av.quarters.slice().reverse().map(function (q) {
        var on = sel.kind === "quarter" && sel.year === q.year && sel.index === q.index;
        var p = window.periodPlan("quarter", q.year, q.index, authFor(src), { today: storeToday() });
        var note = p.status === "complete" ? "" : p.status === "to_date" ? " — quarter to date" : p.status === "empty" ? " — no report" : " — partial";
        return '<option value="' + q.year + "-" + q.index + '"' + (on ? " selected" : "") + (p.status === "empty" ? " disabled" : "") + ">" +
               esc(q.name + " (" + ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][q.index - 1] + ")" + note) + "</option>";
      }).join("");
    }
    return av.years.slice().reverse().map(function (y) {
      var on = sel.kind === "year" && sel.year === y.year;
      var p = window.periodPlan("year", y.year, null, authFor(src), { today: storeToday() });
      var note = p.status === "complete" ? "" : p.status === "to_date" ? " — year to date" : " — partial";
      return '<option value="' + y.year + '"' + (on ? " selected" : "") + ">" + esc(y.name + note) + "</option>";
    }).join("");
  }

  function barHtml(src) {
    if (!PV.reports) {
      return PV.offline ? '<span class="small">Period selector unavailable: shared storage could not be reached.</span>' : "";
    }
    var auth = authFor(src);
    var av = window.periodAvailability(auth, { today: storeToday() });
    if (!av.earliest) {
      return src === "amazon" ? '<span class="small">No monthly Amazon reports in shared storage yet. Upload them under ⚙ Data settings to compare months, quarters and years.</span>' : "";
    }
    var sel = PV.sel[src] || { kind: "month" };
    var plan = PV.plan[src], cmp = PV.cmp[src];
    var h = '<label>Period</label><select data-pv-kind="' + src + '">' +
      ["month", "quarter", "year"].map(function (k) { return '<option value="' + k + '"' + (sel.kind === k ? " selected" : "") + ">" + k[0].toUpperCase() + k.slice(1) + "</option>"; }).join("") +
      '</select><select data-pv-which="' + src + '">' + optionList(src, sel.kind, av) + "</select>";
    if (src === "shopify") {
      h += '<label>Compare with</label><select data-pv-cmp="' + src + '">' +
        [["previous", "Previous " + sel.kind], ["yoy", "Same period last year"], ["none", "No comparison"]].filter(function (o) {
          return !(sel.kind === "year" && o[0] === "yoy");       // for a year, the previous year IS last year
        }).map(function (o) {
          return '<option value="' + o[0] + '"' + (PV.compare[src] === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select>";
    }
    h += PV.busy[src] ? ' <span class="small">Building…</span>' : "";
    if (!PV.active[src]) {
      h += ' <button class="tab" data-pv-apply="' + src + '">Show this period</button> <span class="small">(an individual report is on screen)</span>';
    }
    var notes = [];
    if (PV.error[src]) notes.push('<span style="color:#b71c1c">' + esc(PV.error[src]) + "</span>");
    if (plan && PV.active[src]) {
      notes.push("<b>" + esc(plan.label) + "</b>");
      notes.push("Uses " + plan.revisionsUsed.map(function (u) {
        return esc(window.periodRangeText(u.start, u.end)) + " (rev. " + u.revision + ")";
      }).join(", "));
      if (cmp && src === "shopify") {
        if (cmp.available) notes.push("Compared with " + esc(window.periodRangeText(cmp.start, cmp.end)) + " — " + esc(cmp.label) + ", from stored monthly reports" +
          (plan.missing.length ? " (only the counterparts of months that have a report: " + cmp.parts.map(function (x) { return esc(x.counterpart); }).join(", ") + ")" : "") + ".");
        else if (cmp.embedded) notes.push("Compared with " + esc(window.periodRangeText(cmp.embedded.start, cmp.embedded.end)) +
          " — Shopify's previous period of equal length, inside the same report (no stored report for the previous month covers the same days).");
        else if (PV.compare[src] !== "none") notes.push('<span style="color:#8a5a00">No comparison: ' + esc(cmp.reason || "") + "</span>");
      }
      var shown = snapshots.filter(function (x) { return x.id === state[src].snapshotId; })[0];
      if (src === "amazon" && shown && shown.meta && shown.meta.inventoryAsOf) {
        notes.push("Inventory is point-in-time: the latest report's figure, as of " + esc(shown.meta.inventoryAsOf) + " (never added across months).");
      }
      if (src === "shopify" && shown && window.shopifyChannelStatus) {
        var ov = window.shopifyOverlapNote(window.shopifyChannelStatus(shown));
        if (ov) notes.push('<span style="color:#8a5a00">⚠ ' + esc(ov) + "</span>");
      }
    }
    notes.push('<span class="small">History from ' + esc(av.earliest) + (av.gaps.length ? ' · <span style="color:#8a5a00">no report for ' + av.gaps.map(esc).join(", ") + "</span>" : " · no gaps") +
      ' · <a href="#" data-pv-history>report history</a></span>');
    return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%">' + h + "</div>" +
      '<div class="small" style="width:100%;display:flex;flex-direction:column;gap:2px;margin-top:4px">' +
      notes.map(function (n) { return "<div>" + n + "</div>"; }).join("") + "</div>";
  }

  function renderBars() {
    [["sb-period", "shopify"], ["vn-period", "shopify"], ["az-period", "amazon"]].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (!el) return;
      el.innerHTML = barHtml(pair[1]);
      el.style.flexWrap = "wrap";
    });
    document.querySelectorAll("[data-pv-kind]").forEach(function (s) {
      s.onchange = function () {
        var src = s.getAttribute("data-pv-kind"), kind = s.value;
        var auth = authFor(src), av = window.periodAvailability(auth, { today: storeToday() });
        var latest = av.latest;
        var y = +latest.slice(0, 4), m = +latest.slice(5, 7);
        PV.sel[src] = kind === "month" ? { kind: kind, year: y, index: m }
          : kind === "quarter" ? { kind: kind, year: y, index: Math.floor((m - 1) / 3) + 1 } : { kind: kind, year: y, index: null };
        apply(src);
      };
    });
    document.querySelectorAll("[data-pv-which]").forEach(function (s) {
      s.onchange = function () {
        var src = s.getAttribute("data-pv-which"), cur = PV.sel[src] || { kind: "month" }, v = s.value.split("-");
        PV.sel[src] = { kind: cur.kind, year: +v[0], index: cur.kind === "year" ? null : +v[1] };
        apply(src);
      };
    });
    document.querySelectorAll("[data-pv-cmp]").forEach(function (s) {
      s.onchange = function () { PV.compare[s.getAttribute("data-pv-cmp")] = s.value; apply(s.getAttribute("data-pv-cmp")); };
    });
    document.querySelectorAll("[data-pv-apply]").forEach(function (b) {
      b.onclick = function () { apply(b.getAttribute("data-pv-apply")); };
    });
    document.querySelectorAll("[data-pv-history]").forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); if (window.SBShared) window.SBShared.openSettings("ds-history-panel"); };
    });
  }

  // Keep the bar in step with every render of the three tabs.
  var origRenderTab = window.renderTab;
  window.renderTab = function (source) {
    var r = origRenderTab(source);
    if (source === "shopify" || source === "vendors" || source === "amazon") renderBars();
    return r;
  };
  // A report picked by hand in the Amazon picker is an individual report.
  document.addEventListener("DOMContentLoaded", function () {
    var a = document.getElementById("amazon-snap-select");
    if (a) a.addEventListener("change", function () { PV.active.amazon = false; renderBars(); });
    var v = document.getElementById("vendors-snap-select");
    if (v) v.addEventListener("change", function () { PV.active.shopify = false; renderBars(); });
  });
})();
