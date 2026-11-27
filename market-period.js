// ============================================================
// market-period.js
// Which saved market (ShipStation Product Sales) reports External Stores
// shows, chosen independently of the Shopify period. Pure functions (no DOM,
// no fetch); market-view.js does the fetching and drawing.
//
//   Week          Saturday–Friday, the store's calendar. Only a report saved
//                 for exactly that week is shown.
//   Month         the month's own report (full month, or its newest
//                 month-to-date report, labelled partial).
//   Quarter/Year  combined from complete, non-overlapping monthly reports
//                 (period-engine.js). Weekly and other custom reports are never
//                 added to monthly figures; a short month that is not the
//                 running month is left out and named, never estimated.
//   Saved report  any one saved report, exactly as collected.
//   Match Shopify the market report(s) with exactly the Shopify period's dates.
//
// Rules: a period without a report is MISSING (never zero); a report that
// exists with no product sales is a REPORTED ZERO; nothing is prorated or
// estimated into another period; overlapping reports are never added.
// ============================================================
(function (root, factory) {
  var PE = root && root.periodAuthoritativeMonths ? root
    : (typeof require === "function" ? require("./period-engine.js") : null);
  var api = factory(PE);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function (PE) {
  "use strict";

  var SCOPE = "shipstation_product_sales";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }
  function toDate(ymd) { return new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))); }
  function fromDate(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(ymd, n) { var d = toDate(ymd); d.setUTCDate(d.getUTCDate() + n); return fromDate(d); }
  function days(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000) + 1; }
  function lastDay(ymd) { var y = +ymd.slice(0, 4), m = +ymd.slice(5, 7); return ymd.slice(0, 8) + pad(new Date(Date.UTC(y, m, 0)).getUTCDate()); }
  function md(ymd) { return MONTHS[+ymd.slice(5, 7) - 1] + " " + (+ymd.slice(8, 10)); }
  function rangeText(a, b) {
    if (PE && PE.periodRangeText) return PE.periodRangeText(a, b);
    return a === b ? md(a) + ", " + b.slice(0, 4) : md(a) + " – " + md(b) + ", " + b.slice(0, 4);
  }
  function overlap(a1, b1, a2, b2) { var s = a1 > a2 ? a1 : a2, e = b1 < b2 ? b1 : b2; return s <= e ? days(s, e) : 0; }

  // ---- weeks (Saturday–Friday) --------------------------------
  function weekOf(ymd) {
    var dow = toDate(ymd).getUTCDay();          // 0 Sun … 6 Sat
    var start = addDays(ymd, -((dow + 1) % 7)); // back to Saturday
    return { start: start, end: addDays(start, 6) };
  }
  function isWeek(start, end) { return toDate(start).getUTCDay() === 6 && end === addDays(start, 6); }

  function reportKind(start, end) {
    if (isWeek(start, end)) return "week";
    if (start.slice(8, 10) === "01" && start.slice(0, 7) === end.slice(0, 7)) return end === lastDay(start) ? "full_month" : "month_to_date";
    return "custom";
  }
  var KIND_LABEL = { week: "week (Sat–Fri)", full_month: "full month", month_to_date: "month to date (partial)", custom: "custom dates" };

  // ---- the saved reports ----------------------------------------
  function activeReports(reports) {
    return (reports || []).filter(function (r) {
      return r.source === "market" && (!r.report_scope || r.report_scope === SCOPE) && (!r.status || r.status === "active");
    });
  }
  // What a report says about sales: product sales only (adjustment rows are
  // stored as excluded rows and never counted as products).
  function reported(r) {
    var t = r.includedTotals || r.totals || null;
    if (!t) return { known: false, units: null, net: null };
    return { known: true, units: Math.round(+t.units || 0), net: r2(t.net) };
  }
  function entry(r) {
    var kind = reportKind(r.period_start, r.period_end);
    var rep = reported(r);
    return {
      id: r.id, start: r.period_start, end: r.period_end, kind: kind, kindLabel: KIND_LABEL[kind],
      range: rangeText(r.period_start, r.period_end),
      label: rangeText(r.period_start, r.period_end) + " · " + KIND_LABEL[kind],
      collectedAt: r.collected_at || r.activated_at || r.imported_at || null,
      revision: r.revision || 1, rowCount: r.row_count == null ? null : +r.row_count,
      units: rep.units, net: rep.net, totalsKnown: rep.known,
      // A saved report with no product sales is a reported zero, not missing data.
      zeroSales: rep.known && rep.units === 0 && rep.net === 0
    };
  }
  // Newest first: latest end date, then the shorter period, then the newest collection.
  function catalog(reports) {
    return activeReports(reports).map(entry).sort(function (a, b) {
      return b.end.localeCompare(a.end) || b.start.localeCompare(a.start) || String(b.collectedAt || "").localeCompare(String(a.collectedAt || ""));
    });
  }
  function defaultSelection(reports) {
    var c = catalog(reports);
    return c.length ? { kind: "saved", reportId: c[0].id } : null;
  }

  // Weeks to offer: every week with a saved report, plus the last `recent`
  // finished weeks (shown as "no report" when nothing was saved for them).
  function weekOptions(reports, opts) {
    opts = opts || {};
    var today = opts.today || fromDate(new Date());
    var recent = opts.recent == null ? 8 : opts.recent;
    var byStart = {};
    catalog(reports).forEach(function (e) { if (e.kind === "week" && !byStart[e.start]) byStart[e.start] = e; });
    var lastFinished = weekOf(addDays(weekOf(today).start, -1)).start;
    var starts = {};
    for (var i = 0, s = lastFinished; i < recent; i++, s = addDays(s, -7)) starts[s] = 1;
    Object.keys(byStart).forEach(function (s) { starts[s] = 1; });
    return Object.keys(starts).sort().reverse().map(function (s) {
      var e = byStart[s] || null;
      return { start: s, end: addDays(s, 6), report: e, label: rangeText(s, addDays(s, 6)) + (e ? "" : " — no report") };
    });
  }

  // Other saved reports to offer when the chosen period has none: those that
  // overlap it first (largest overlap), then the newest.
  function alternatives(reports, start, end, max) {
    var c = catalog(reports);
    var scored = c.map(function (e) { return { e: e, o: start ? overlap(start, end, e.start, e.end) : 0 }; });
    var over = scored.filter(function (x) { return x.o > 0; }).sort(function (a, b) { return b.o - a.o || b.e.end.localeCompare(a.e.end); }).map(function (x) { return x.e; });
    var out = over.slice();
    c.forEach(function (e) { if (out.indexOf(e) < 0) out.push(e); });
    return out.slice(0, max || 6);
  }

  function used(e, r) {
    return { reportId: e.id, start: e.start, end: e.end, kind: e.kind, revision: e.revision, collectedAt: e.collectedAt,
             units: e.units, net: e.net, zeroSales: e.zeroSales, report: r };
  }
  function finish(plan, reports) {
    var u = plan.used || [];
    plan.used = u;
    plan.reported = u.length && u.every(function (x) { return x.net != null; })
      ? { units: u.reduce(function (t, x) { return t + x.units; }, 0), net: r2(u.reduce(function (t, x) { return t + x.net; }, 0)) } : null;
    plan.zeroSales = !!(u.length && u.every(function (x) { return x.zeroSales; }));
    plan.collectedAt = u.map(function (x) { return x.collectedAt; }).filter(Boolean).sort().pop() || null;
    plan.sig = u.map(function (x) { return x.reportId; }).join("|");
    if (!u.length) plan.alternatives = alternatives(reports, plan.start, plan.end);
    return plan;
  }
  function missingPlan(base, reason, reports) {
    return finish(Object.assign({ status: "missing", used: [], missing: [], excluded: [], reason: reason }, base), reports);
  }

  // ---- one selection -> which reports are shown ------------------------
  // sel: { kind: 'saved', reportId } | { kind: 'week', start } |
  //      { kind: 'month'|'quarter'|'year', year, index } | { kind: 'match' }
  // opts: { today, shopify: { start, end, period?: {kind, year, index, name, revisionsUsed} } }
  function plan(sel, reports, opts) {
    opts = opts || {};
    var today = opts.today || fromDate(new Date());
    var act = activeReports(reports);
    var byId = {}; act.forEach(function (r) { byId[r.id] = r; });
    if (!sel) return missingPlan({ kind: "none", name: "No market report" }, "No market report has been saved yet.", reports);

    if (sel.kind === "saved") {
      var r = byId[sel.reportId];
      if (!r) return missingPlan({ kind: "saved", name: "Saved report" }, "That saved report is no longer in shared storage.", reports);
      var e = entry(r);
      return finish({ kind: "saved", status: "exact", name: e.range, start: e.start, end: e.end,
        label: e.range + " · " + e.kindLabel, used: [used(e, r)], missing: [], excluded: [] }, reports);
    }

    if (sel.kind === "week") {
      var wk = weekOf(sel.start);
      var name = rangeText(wk.start, wk.end);
      var hit = act.filter(function (x) { return x.period_start === wk.start && x.period_end === wk.end; })
        .sort(function (a, b) { return (b.revision || 0) - (a.revision || 0); })[0];
      var base = { kind: "week", name: name, start: wk.start, end: wk.end, label: name + " · week (Sat–Fri)" };
      if (!hit) {
        return missingPlan(Object.assign(base, { missing: [{ start: wk.start, end: wk.end }] }),
          "No market report was saved for exactly " + name + " (Saturday–Friday). Reports for other dates are never cut down or prorated to fit a week.", reports);
      }
      return finish(Object.assign(base, { status: "exact", used: [used(entry(hit), hit)], missing: [], excluded: [] }), reports);
    }

    if (sel.kind === "month" || sel.kind === "quarter" || sel.kind === "year") {
      if (!PE) throw new Error("period-engine.js is required.");
      var auth = PE.periodAuthoritativeMonths(act, { source: "market", scope: SCOPE });
      var p = PE.periodPlan(sel.kind, sel.year, sel.kind === "year" ? null : sel.index, auth, { today: today });
      var excluded = [];
      // Weekly and custom reports inside the period: shown on their own, never added.
      auth.ignored.forEach(function (ig) {
        var x = ig.report;
        if (overlap(p.start, p.end, x.period_start, x.period_end) <= 0) return;
        var k = reportKind(x.period_start, x.period_end);
        excluded.push({ reportId: x.id, start: x.period_start, end: x.period_end, kind: k,
          reason: k === "week" ? "Weekly report: shown on its own, never added to monthly figures."
            : k === "custom" ? "Custom dates: shown on its own, never combined."
            : "Overlaps a newer report for the same month: never added." });
      });
      var keep = p.revisionsUsed.slice(), missing = p.missing.map(function (m) { return { start: m + "-01", end: lastDay(m + "-01") }; });
      if (sel.kind !== "month") {
        // Only complete months are combined; the running month's month-to-date
        // report is the exception (a to-date total, labelled as such).
        keep = keep.filter(function (u) {
          if (p.shortMonths.indexOf(u.month) < 0) return true;
          excluded.push({ reportId: u.reportId, start: u.start, end: u.end, kind: "month_to_date",
            reason: "Covers only " + rangeText(u.start, u.end) + ", not the whole month: left out of the total (never estimated)." });
          missing.push({ start: u.month + "-01", end: lastDay(u.month + "-01") });
          return false;
        });
      }
      missing.sort(function (a, b) { return a.start.localeCompare(b.start); });
      var status = !keep.length ? "missing"
        : sel.kind === "month" ? (p.status === "complete" ? "complete" : p.status === "to_date" ? "to_date" : "incomplete")
        : missing.length ? "incomplete" : p.status === "complete" ? "complete" : "to_date";
      var cov = keep.length ? { start: keep[0].start, end: keep[keep.length - 1].end } : null;
      var label = p.name + (status === "complete" ? " (complete)"
        : status === "to_date" ? " — " + sel.kind + " to date (partial) · " + rangeText(cov.start, cov.end)
        : status === "incomplete" ? " — partial: " + (sel.kind === "month"
            ? "covers only " + rangeText(cov.start, cov.end)
            : "no complete market report for " + missing.map(function (m) { return MONTHS[+m.start.slice(5, 7) - 1] + " " + m.start.slice(0, 4); }).join(", ") +
              " · covers " + keep.map(function (u) { return rangeText(u.start, u.end); }).join(", "))
        : " — no saved market report");
      var out = {
        kind: sel.kind, name: p.name, start: p.start, end: p.end, status: status, label: label, coverage: cov,
        used: keep.map(function (u) { return used(entry(byId[u.reportId]), byId[u.reportId]); }),
        missing: missing, excluded: excluded
      };
      if (status === "missing") {
        out.reason = "No " + (sel.kind === "month" ? "" : "complete ") + "monthly market report for " + p.name + "." +
          (excluded.length ? " Saved reports in this period are shown on their own only (see below)." : "");
      }
      return finish(out, reports);
    }

    if (sel.kind === "match") {
      var sh = opts.shopify;
      if (!sh || !sh.start) return missingPlan({ kind: "match", name: "Shopify period" }, "No Shopify period is on screen.", reports);
      var shName = rangeText(sh.start, sh.end);
      var mbase = { kind: "match", name: shName, start: sh.start, end: sh.end };
      if (sh.period && sh.period.revisionsUsed && sh.period.kind) {
        // A combined Shopify month / quarter / year: the market side needs a
        // report for exactly the same dates, month by month.
        var mp = plan({ kind: sh.period.kind, year: sh.period.year, index: sh.period.index }, reports, { today: today });
        var want = sh.period.revisionsUsed.map(function (u) { return u.start + ".." + u.end; });
        var have = mp.used.map(function (u) { return u.start + ".." + u.end; });
        var lacking = want.filter(function (w) { return have.indexOf(w) < 0; });
        var extra = have.filter(function (h) { return want.indexOf(h) < 0; });
        if (lacking.length || extra.length) {
          return missingPlan(Object.assign(mbase, { name: sh.period.name || shName, missing: lacking.map(function (w) { var d = w.split(".."); return { start: d[0], end: d[1] }; }) }),
            "The Shopify period " + (sh.period.name || shName) + " uses " + want.map(function (w) { var d = w.split(".."); return rangeText(d[0], d[1]); }).join(", ") +
            ". No saved market report has exactly " + (lacking.length ? lacking : extra).map(function (w) { var d = w.split(".."); return rangeText(d[0], d[1]); }).join(", ") +
            (lacking.length ? "" : " to match") + ", so the market side is left empty rather than compared against other dates.", reports);
        }
        return finish(Object.assign(mp, { kind: "match", label: mp.label + " · matches the Shopify period" }), reports);
      }
      var ex = act.filter(function (x) { return x.period_start === sh.start && x.period_end === sh.end; })
        .sort(function (a, b) { return (b.revision || 0) - (a.revision || 0); })[0];
      if (!ex) {
        return missingPlan(Object.assign(mbase, { missing: [{ start: sh.start, end: sh.end }] }),
          "No saved market report for exactly " + shName + " (the Shopify period on screen). Other dates are never cut down or prorated to fit.", reports);
      }
      var ee = entry(ex);
      return finish(Object.assign(mbase, { status: "exact", label: shName + " · " + ee.kindLabel + " · matches the Shopify period",
        used: [used(ee, ex)], missing: [], excluded: [] }), reports);
    }
    return missingPlan({ kind: String(sel.kind), name: "?" }, "Unknown period kind.", reports);
  }

  // ---- combining the chosen reports' rows ------------------------------
  // parts: arrays of External Stores products (marketExternalSnapshotFromShared),
  // one per report in plan.used, which never overlap. Same product in the same
  // store adds up; a $0 line stays a reported $0.
  function mergeProducts(parts) {
    var by = Object.create(null), order = [];
    (parts || []).forEach(function (list) {
      (list || []).forEach(function (x) {
        var k = x.rawStore + "␟" + (x.sku || x.title);
        if (!by[k]) { by[k] = Object.assign({}, x, { units: 0, qty: 0, estRev: 0 }); order.push(k); }
        by[k].units += x.units; by[k].qty += x.units; by[k].estRev = r2(by[k].estRev + x.estRev);
        by[k].title = x.title;
      });
    });
    return order.map(function (k) { return by[k]; });
  }

  // Per-store totals. ShipStation Product Sales carries real item revenue but
  // no order count: orders are null (not reported), never zero.
  function storeTotals(products, groupByParent) {
    var map = Object.create(null), order = [];
    (products || []).forEach(function (p) {
      var key = groupByParent ? p.store : p.rawStore;
      if (!map[key]) { map[key] = { store: key, units: 0, rev: 0, orders: null, aov: null, products: [], ordersKnown: false }; order.push(key); }
      map[key].units += p.units || 0;
      map[key].rev = r2(map[key].rev + (p.estRev || 0));
      map[key].products.push(p);
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.rev - a.rev; });
  }

  // ---- failed collections ------------------------------------------------
  // A failed market collection stays outstanding until a later successful run
  // stored the same dates (or a longer report from the same start date). The
  // picker shows these whatever period is chosen.
  function outstandingFailures(runs) {
    var mk = (runs || []).filter(function (r) { return r.source === "market"; })
      .slice().sort(function (a, b) { return String(a.started_at).localeCompare(String(b.started_at)); });
    var out = [];
    mk.forEach(function (r, i) {
      if (r.outcome !== "failed" && r.outcome !== "rejected") return;
      var s = r.period_start, e = r.period_end;
      var fixed = mk.slice(i + 1).some(function (x) {
        return (x.outcome === "succeeded" || x.outcome === "unchanged") && (!s || (x.period_start === s && x.period_end >= e));
      });
      if (fixed) return;
      var key = (s || "") + ".." + (e || "");
      out = out.filter(function (o) { return o.key !== key && !(s && o.start === s && o.end <= e); });
      out.push({ key: key, start: s || null, end: e || null, at: r.finished_at || r.started_at, code: r.error_code || r.outcome,
                 message: r.error_message || null });
    });
    return out.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  }

  // ---- cross-channel guard --------------------------------------------
  // items: [{ source, start, end }] for the reports picked on a comparison tab.
  // Combined comparisons are shown only when every picked report has the same dates.
  function sameDates(items) {
    var list = (items || []).filter(function (x) { return x && x.start && x.end; });
    var keys = {};
    list.forEach(function (x) { keys[x.start + ".." + x.end] = 1; });
    return { same: Object.keys(keys).length <= 1, ranges: list.map(function (x) { return { source: x.source, start: x.start, end: x.end, range: rangeText(x.start, x.end) }; }) };
  }

  // ---- loading a plan's rows, without automatic retries -------------------
  // load(plan) -> Promise<snapshot>. One attempt per selection: a failure is
  // kept (with its message) and NOT retried by later renders; a new attempt
  // happens only through retry() or when a different plan is asked for.
  function loader(load) {
    var st = { sig: null, status: "idle", error: null, result: null, attempts: 0 };
    function start(plan, done) {
      var sig = plan.sig;
      st = { sig: sig, status: "loading", error: null, result: null, attempts: st.sig === sig ? st.attempts + 1 : 1 };
      var mine = st;
      Promise.resolve().then(function () { return load(plan); }).then(function (res) {
        if (st !== mine) return;                       // a newer selection replaced this one
        mine.status = "ready"; mine.result = res;
        if (done) done(mine);
      }, function (e) {
        if (st !== mine) return;
        mine.status = "failed"; mine.error = (e && e.message) || String(e);
        if (done) done(mine);
      });
      return mine;
    }
    return {
      state: function () { return st; },
      // Called on every render: starts loading only for a plan not yet attempted.
      ensure: function (plan, done) {
        if (!plan || !plan.sig) return st;
        if (st.sig === plan.sig && st.status !== "idle") return st;
        return start(plan, done);
      },
      // The person pressed Retry: one new attempt for the same plan.
      retry: function (plan, done) {
        if (!plan || !plan.sig || st.status === "loading") return st;
        return start(plan, done);
      },
      // The person picked a period: the next ensure() may try again.
      reset: function () { st = { sig: null, status: "idle", error: null, result: null, attempts: 0 }; }
    };
  }

  return {
    MARKET_PERIOD_SCOPE: SCOPE,
    marketLoader: loader,
    marketWeekOf: weekOf,
    marketIsWeek: isWeek,
    marketReportKind: reportKind,
    marketCatalog: catalog,
    marketDefaultSelection: defaultSelection,
    marketWeekOptions: weekOptions,
    marketAlternatives: alternatives,
    marketPlan: plan,
    marketMergeProducts: mergeProducts,
    marketStoreTotals: storeTotals,
    marketOutstandingFailures: outstandingFailures,
    marketSameDates: sameDates
  };
});
