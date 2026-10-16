// ============================================================
// period-engine.js
// Months, quarters and years built from ONE authoritative, non-overlapping
// set of monthly reports. Pure functions (no DOM, no fetch).
//
//   - Each calendar month is represented by at most one report: the latest
//     successful revision of its full-month report, otherwise its newest
//     month-to-date report. Every other report for that month (older
//     month-to-date copies, superseded revisions) is left out, never added.
//   - Quarters (Q1 Jan–Mar … Q4 Oct–Dec) and years combine those monthly
//     reports. A report that is not a single calendar month (a quarter, a
//     custom range) is never combined with anything.
//   - Embedded previous-period columns are never summed. Comparisons are
//     built from stored reports of the equivalent period, and only when every
//     month has a counterpart with the same coverage.
//   - A month without a report is MISSING, never zero. Missing or partial
//     coverage makes the period partial, and says which months.
//   - Totals are summed first; averages, conversion and percentage changes are
//     derived from the combined totals. Inventory is point-in-time: the latest
//     month's figure, with its date, never a sum.
//
// Dates are the store's calendar dates (America/Los_Angeles) exactly as the
// reports state them.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SHOPIFY_SCOPE = "total_sales_by_product";
  var MEASURES = ["units", "gross", "disc", "ret", "net", "tax", "total"];
  var SUMMED_EXTRA = ["glance"];                 // flows: summed
  var POINT_IN_TIME = ["inv"];                   // stocks: latest snapshot only
  var AMAZON_SUMMED = ["units", "rev", "glance", "shipped", "shippedRev", "orderItems"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function monthKey(ymd) { return String(ymd).slice(0, 7); }
  function monthStart(key) { return key + "-01"; }
  function monthEnd(key) { var y = +key.slice(0, 4), m = +key.slice(5, 7); return key + "-" + pad(lastDay(y, m)); }
  function addMonths(key, n) {
    var y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + pad(m + 1);
  }
  function md(ymd) { return MONTHS[+ymd.slice(5, 7) - 1] + " " + (+ymd.slice(8, 10)); }
  function rangeText(a, b) {
    if (!a || !b) return "";
    var ya = a.slice(0, 4), yb = b.slice(0, 4);
    if (a === b) return md(a) + ", " + yb;
    if (a.slice(0, 7) === b.slice(0, 7)) return md(a) + " – " + (+b.slice(8, 10)) + ", " + yb;
    return (ya === yb ? md(a) : md(a) + ", " + ya) + " – " + md(b) + ", " + yb;
  }
  function monthName(key) { return MONTHS[+key.slice(5, 7) - 1] + " " + key.slice(0, 4); }

  // ---- the authoritative monthly set ------------------------------
  // `reports` are the Worker's ACTIVE reports (one per period: the latest
  // successful revision). Returns { months: {YYYY-MM: entry}, ignored: [...] }.
  function authoritativeMonths(reports, opts) {
    opts = opts || {};
    var source = opts.source || "shopify";
    var scope = opts.scope || (source === "shopify" ? SHOPIFY_SCOPE : null);
    var months = {}, ignored = [], candidates = {};
    (reports || []).forEach(function (r) {
      if (r.source !== source || (r.status && r.status !== "active")) return;
      if (scope && r.report_scope !== scope) return;
      var s = r.period_start, e = r.period_end;
      if (s.slice(8, 10) !== "01" || monthKey(s) !== monthKey(e)) {
        ignored.push({ report: r, reason: "Not a single calendar month (" + rangeText(s, e) + "). Shown on its own, never combined." });
        return;
      }
      (candidates[monthKey(s)] = candidates[monthKey(s)] || []).push(r);
    });
    Object.keys(candidates).forEach(function (key) {
      var list = candidates[key].slice().sort(function (a, b) {
        return b.period_end.localeCompare(a.period_end) || (b.revision || 0) - (a.revision || 0);
      });
      var best = list[0];
      var full = best.period_end === monthEnd(key);
      months[key] = {
        month: key, report: best, start: best.period_start, end: best.period_end,
        status: full && best.completeness !== "partial" ? "complete" : "partial",
        fullMonthReport: full
      };
      list.slice(1).forEach(function (r) {
        ignored.push({ report: r, reason: "Overlaps the " + (full ? "full-month" : "newer month-to-date") + " report for " +
          monthName(key) + " (" + rangeText(best.period_start, best.period_end) + "); never summed." });
      });
    });
    return { months: months, ignored: ignored };
  }

  // ---- periods ----------------------------------------------------
  // kind: 'month' (index 1–12) | 'quarter' (1–4) | 'year'
  function periodRange(kind, year, index) {
    var first, n;
    if (kind === "month") { first = year + "-" + pad(index); n = 1; }
    else if (kind === "quarter") { first = year + "-" + pad((index - 1) * 3 + 1); n = 3; }
    else { first = year + "-01"; n = 12; }
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(addMonths(first, i));
    var name = kind === "month" ? monthName(first) : kind === "quarter" ? "Q" + index + " " + year : String(year);
    return { kind: kind, year: year, index: kind === "year" ? null : index, months: keys,
             start: monthStart(keys[0]), end: monthEnd(keys[keys.length - 1]), name: name };
  }
  var TO_DATE = { month: "month to date", quarter: "quarter to date", year: "year to date" };

  // Which month report each part of a period uses, what is missing, and how
  // the period should be labelled.
  //   status: 'complete'   every month complete
  //           'to_date'    the period is still running; every month so far present
  //           'incomplete' a month that has started has no report, or ends short
  //           'empty'      no month has a report
  function periodPlan(kind, year, index, auth, opts) {
    opts = opts || {};
    var today = opts.today || new Date().toISOString().slice(0, 10);
    var rng = periodRange(kind, year, index);
    var parts = rng.months.map(function (key) {
      if (monthStart(key) > today) return { month: key, status: "future" };
      var e = auth.months[key];
      if (!e) return { month: key, status: "missing" };
      return { month: key, status: e.status, start: e.start, end: e.end, report: e.report };
    });
    var withData = parts.filter(function (p) { return p.report; });
    var missing = parts.filter(function (p) { return p.status === "missing"; }).map(function (p) { return p.month; });
    var running = rng.start <= today && today <= rng.end;
    // A partial month is acceptable only as the LAST month of a running
    // period whose coverage reaches close to today (a month-to-date report).
    var shortMonths = withData.filter(function (p, i) {
      if (p.status !== "partial") return false;
      var isCurrentMonth = monthStart(p.month) <= today && today <= monthEnd(p.month);
      return !(running && isCurrentMonth && i === withData.length - 1);
    }).map(function (p) { return p.month; });
    var status = !withData.length ? "empty"
      : missing.length || shortMonths.length ? "incomplete"
      : withData.every(function (p) { return p.status === "complete"; }) && !parts.some(function (p) { return p.status === "future"; })
        ? "complete" : running ? "to_date" : "incomplete";
    var coverage = withData.length ? { start: withData[0].start, end: withData[withData.length - 1].end } : null;
    var label = rng.name;
    if (status === "complete") label += " (complete)";
    else if (status === "to_date") label += " — " + TO_DATE[kind] + " (partial) · " + rangeText(coverage.start, coverage.end);
    else if (status === "incomplete") {
      label += " — partial: " + (missing.length ? "no report for " + missing.map(monthName).join(", ") : "") +
        (missing.length && shortMonths.length ? "; " : "") +
        (shortMonths.length ? shortMonths.map(function (k) {
          var p = withData.filter(function (x) { return x.month === k; })[0];
          return monthName(k) + " covers only " + rangeText(p.start, p.end);
        }).join(", ") : "") + (coverage ? " · covers " + rangeText(coverage.start, coverage.end) : "");
    } else label += " — no saved report";
    return {
      kind: kind, year: year, index: rng.index, name: rng.name, start: rng.start, end: rng.end,
      parts: parts, status: status, partial: status !== "complete", running: running,
      missing: missing, shortMonths: shortMonths, coverage: coverage, label: label,
      revisionsUsed: withData.map(function (p) {
        return { month: p.month, reportId: p.report.id, revision: p.report.revision, start: p.start, end: p.end, status: p.status };
      })
    };
  }

  // ---- comparison --------------------------------------------------
  // mode 'previous': the previous equivalent period (previous month, quarter
  // or year); 'yoy': the same period last year. Each month with data needs a
  // counterpart covering the same days: a complete month needs a complete
  // month; a month-to-date part (say Oct 1–15) needs a stored report for
  // exactly the shifted dates (Sep 1–15, or Oct 1–15 last year).
  function shiftFor(kind, mode) {
    if (mode === "yoy") return -12;
    return kind === "month" ? -1 : kind === "quarter" ? -3 : -12;
  }
  function periodComparison(plan, mode, auth, allReports, opts) {
    opts = opts || {};
    if (!mode || mode === "none") return { available: false, mode: "none", reason: "No comparison selected." };
    var shift = shiftFor(plan.kind, mode);
    var source = opts.source || "shopify";
    var pool = (allReports || []).filter(function (r) { return r.source === source && (!r.status || r.status === "active"); });
    var parts = [], missing = [];
    plan.parts.forEach(function (p) {
      if (!p.report) return;
      var tk = addMonths(p.month, shift);
      var want;
      if (p.status === "complete") {
        var e = auth.months[tk];
        if (e && e.status === "complete") { parts.push({ month: p.month, counterpart: tk, start: e.start, end: e.end, report: e.report }); return; }
        missing.push({ month: p.month, counterpart: tk, start: monthStart(tk), end: monthEnd(tk) });
        return;
      }
      var d1 = +p.start.slice(8, 10), d2 = +p.end.slice(8, 10);
      var ty = +tk.slice(0, 4), tm = +tk.slice(5, 7);
      want = { start: tk + "-" + pad(Math.min(d1, lastDay(ty, tm))), end: tk + "-" + pad(Math.min(d2, lastDay(ty, tm))) };
      var hit = pool.filter(function (r) { return r.period_start === want.start && r.period_end === want.end; })
        .sort(function (a, b) { return (b.revision || 0) - (a.revision || 0); })[0];
      if (hit) parts.push({ month: p.month, counterpart: tk, start: want.start, end: want.end, report: hit });
      else missing.push({ month: p.month, counterpart: tk, start: want.start, end: want.end });
    });
    var label = mode === "yoy" ? "same period last year" : "previous " + plan.kind;
    if (!parts.length && !missing.length) return { available: false, mode: mode, label: label, reason: "Nothing to compare." };
    if (missing.length) {
      return { available: false, mode: mode, label: label, missing: missing,
        reason: "No stored report for " + missing.map(function (m) { return rangeText(m.start, m.end); }).join(", ") +
                ", so the " + label + " cannot be compared like for like." };
    }
    return { available: true, mode: mode, label: label, parts: parts,
      start: parts[0].start, end: parts[parts.length - 1].end,
      revisionsUsed: parts.map(function (x) { return { month: x.counterpart, reportId: x.report.id, revision: x.report.revision, start: x.start, end: x.end }; }) };
  }

  // ---- aggregation ---------------------------------------------------
  function identity(r) {
    if (r.productKey) return r.productKey;
    if (r.productId) return "pid:" + r.productId;
    if (r.asin) return "asin:" + r.asin;
    return [r.title, r.vendor || "", r.ptype || ""].join("␟");
  }
  function keyOf(r) { return identity(r) + "␟" + (r.salesChannel || ""); }
  function zeros(keys) { var o = {}; keys.forEach(function (k) { o[k] = 0; }); return o; }
  function isShopifyRecord(r) { return !!r.cur; }

  // parts: [{ end: 'YYYY-MM-DD', records: [...] }] in any order. Records are
  // the dashboard's snapshot products. Returns merged records (one per
  // product per sales channel), with point-in-time fields from the latest
  // part that lists the product.
  function aggregate(parts) {
    var ordered = (parts || []).slice().sort(function (a, b) { return String(a.end).localeCompare(String(b.end)); });
    var by = Object.create(null), order = [];
    ordered.forEach(function (part) {
      (part.records || []).forEach(function (r) {
        var k = keyOf(r), m = by[k];
        if (!m) {
          m = by[k] = Object.assign({}, r);
          if (isShopifyRecord(r)) { m.cur = zeros(MEASURES.concat(SUMMED_EXTRA, POINT_IN_TIME)); }
          else AMAZON_SUMMED.forEach(function (f) { m[f] = 0; });
          m.monthsWithSales = 0; m.sourceRows = 0;
          order.push(k);
        } else {
          // Descriptive fields follow the latest month (a renamed product
          // keeps its id but shows its current title).
          ["title", "vendor", "ptype", "ptypeBlank", "group", "groupType", "isPlant", "genus", "genusName"].forEach(function (f) {
            if (r[f] != null && r[f] !== "") m[f] = r[f];
          });
        }
        if (isShopifyRecord(r)) {
          MEASURES.concat(SUMMED_EXTRA).forEach(function (f) { m.cur[f] += (r.cur && r.cur[f]) || 0; });
          POINT_IN_TIME.forEach(function (f) { m.cur[f] = (r.cur && r.cur[f]) || 0; });
        } else {
          AMAZON_SUMMED.forEach(function (f) { m[f] += +r[f] || 0; });
          m.inv = +r.inv || 0;
        }
        m.invAsOf = part.end;
        m.sourceRows += r.sourceRows || 1;
        m.monthsWithSales += 1;
      });
    });
    // Inventory is a stock, not a flow: it is read from the LATEST part only.
    // A product missing from the latest report has no current inventory figure.
    var latestEnd = ordered.length ? ordered[ordered.length - 1].end : null;
    order.forEach(function (k) {
      var m = by[k];
      if (m.invAsOf !== latestEnd) {
        if (m.cur) POINT_IN_TIME.forEach(function (f) { m.cur[f] = 0; }); else m.inv = 0;
        m.invAsOf = latestEnd; m.invKnown = false;
      } else m.invKnown = true;
    });
    return order.map(function (k) { return finish(by[k]); });
  }
  function finish(m) {
    if (m.cur) {
      MEASURES.concat(SUMMED_EXTRA, POINT_IN_TIME).forEach(function (f) {
        m.cur[f] = f === "units" || f === "glance" || f === "inv" ? Math.round(m.cur[f]) : r2(m.cur[f]);
      });
      // legacy flat fields the older tabs read, derived from the totals
      m.units = m.cur.units; m.gross = m.cur.gross; m.disc = m.cur.disc; m.ret = m.cur.ret;
      m.net = m.cur.net; m.tax = m.cur.tax; m.rev = m.cur.total; m.inv = m.cur.inv; m.glance = m.cur.glance;
      m.avg = m.cur.units ? r2(m.cur.net / m.cur.units) : 0;
      m.conv = m.cur.glance ? m.cur.units / m.cur.glance : 0;
      m.prior = zeros(MEASURES); m.priorKnown = false; m.reportedPct = {};
    } else {
      m.units = Math.round(m.units); m.glance = Math.round(m.glance); m.rev = r2(m.rev);
      m.shipped = Math.round(m.shipped); m.shippedRev = r2(m.shippedRev); m.orderItems = Math.round(m.orderItems);
      m.avg = m.units ? r2(m.rev / m.units) : 0;
      m.conv = m.glance ? m.units / m.glance : 0;
    }
    return m;
  }

  // Attaches the comparison aggregate as each record's prior. Products sold
  // only in the comparison period are added with zero current figures, so the
  // prior total is complete. Shopify records only.
  function attachComparison(curRecords, priorRecords) {
    var by = Object.create(null);
    (priorRecords || []).forEach(function (p) { by[keyOf(p)] = p; });
    var seen = Object.create(null);
    var out = curRecords.map(function (r) {
      var k = keyOf(r), p = by[k];
      seen[k] = 1;
      var x = Object.assign({}, r);
      x.prior = zeros(MEASURES);
      if (p) MEASURES.forEach(function (f) { x.prior[f] = p.cur[f] || 0; });
      x.priorKnown = true;
      return x;
    });
    (priorRecords || []).forEach(function (p) {
      var k = keyOf(p);
      if (seen[k]) return;
      var x = Object.assign({}, p);
      x.prior = zeros(MEASURES); MEASURES.forEach(function (f) { x.prior[f] = p.cur[f] || 0; });
      x.cur = zeros(MEASURES.concat(SUMMED_EXTRA, POINT_IN_TIME));
      ["units", "gross", "disc", "ret", "net", "tax", "rev", "avg", "glance", "conv", "inv"].forEach(function (f) { x[f] = 0; });
      x.priorKnown = true; x.onlyInComparison = true;
      out.push(x);
    });
    return out;
  }

  // Distinct products across the whole period (not a sum of monthly counts),
  // ignoring the channel split.
  function distinctProducts(records) {
    var s = Object.create(null);
    (records || []).forEach(function (r) { s[identity(r)] = 1; });
    return Object.keys(s).length;
  }
  function totals(records) {
    var t = zeros(MEASURES.concat(SUMMED_EXTRA));
    (records || []).forEach(function (r) {
      if (r.cur) MEASURES.concat(SUMMED_EXTRA).forEach(function (f) { t[f] += r.cur[f] || 0; });
    });
    Object.keys(t).forEach(function (f) { t[f] = f === "units" || f === "glance" ? Math.round(t[f]) : r2(t[f]); });
    t.avgPerUnit = t.units ? r2(t.net / t.units) : 0;
    t.conversion = t.glance ? t.units / t.glance : null;
    return t;
  }

  // ---- what can be selected -----------------------------------------------
  // Months from the earliest stored month to the current one, with gaps.
  function availability(auth, opts) {
    opts = opts || {};
    var today = opts.today || new Date().toISOString().slice(0, 10);
    var keys = Object.keys(auth.months).sort();
    if (!keys.length) return { earliest: null, latest: null, months: [], gaps: [], quarters: [], years: [] };
    var cur = monthKey(today), list = [], gaps = [];
    for (var k = keys[0]; k <= cur; k = addMonths(k, 1)) {
      var e = auth.months[k];
      list.push({ month: k, name: monthName(k), status: e ? e.status : "missing", start: e && e.start, end: e && e.end });
      if (!e && k !== cur) gaps.push(k);
    }
    var quarters = [], years = [];
    list.forEach(function (m) {
      var y = +m.month.slice(0, 4), q = Math.floor((+m.month.slice(5, 7) - 1) / 3) + 1;
      var qk = y + "-Q" + q;
      if (!quarters.length || quarters[quarters.length - 1].key !== qk) quarters.push({ key: qk, year: y, index: q, name: "Q" + q + " " + y });
      if (!years.length || years[years.length - 1].year !== y) years.push({ year: y, name: String(y) });
    });
    return { earliest: keys[0], latest: keys[keys.length - 1], months: list, gaps: gaps, quarters: quarters, years: years };
  }
  function defaultSelection(auth) {
    var keys = Object.keys(auth.months).sort();
    if (!keys.length) return null;
    var k = keys[keys.length - 1];
    return { kind: "month", year: +k.slice(0, 4), index: +k.slice(5, 7) };
  }

  // ---- the period as a dashboard snapshot ------------------------------
  // Same shape the importers create, so every existing view (vendors,
  // genus/category breakdowns, channel filter, exports) works unchanged.
  // Ephemeral: rebuilt from shared storage, never saved in the browser.
  function buildSnapshot(source, plan, cmp, records, info) {
    info = info || {};
    var caps = info.capabilities || {};
    var cov = plan.coverage || { start: plan.start, end: plan.end };
    var latestPart = plan.revisionsUsed[plan.revisionsUsed.length - 1] || null;
    return {
      id: source + "_period_" + plan.kind + "_" + plan.year + (plan.index ? "_" + plan.index : ""),
      source: source,
      label: plan.label,
      startDate: cov.start, endDate: cov.end,
      fileName: "(combined from shared storage)",
      uploadedAt: info.builtAt || new Date().toISOString(),
      products: records,
      meta: {
        schema: source === "shopify" ? "shopify-total-sales-by-product/v1" : "amazon-metric-data",
        ephemeral: true, auto: true,
        reportScope: "Combined " + plan.kind + " from monthly reports",
        timezone: info.timezone || "America/Los_Angeles", currency: info.currency || "USD",
        importedAt: info.lastActivatedAt || null,
        current: { start: cov.start, end: cov.end },
        comparison: cmp && cmp.available ? { start: cmp.start, end: cmp.end, source: "stored reports, " + cmp.label } : null,
        capabilities: Object.assign({}, caps, { hasPrior: !!(cmp && cmp.available) }),
        periodKind: plan.status === "complete" ? "full_" + plan.kind : plan.kind + "_to_date",
        partial: plan.partial,
        period: { kind: plan.kind, year: plan.year, index: plan.index, name: plan.name, status: plan.status,
                  missing: plan.missing, shortMonths: plan.shortMonths, label: plan.label,
                  revisionsUsed: plan.revisionsUsed },
        comparisonInfo: cmp || null,
        inventoryAsOf: latestPart ? latestPart.end : null,
        distinctProducts: distinctProducts(records.filter(function (r) { return !r.onlyInComparison; })),
        // Which months carry a Sales channel column: decides whether Amazon
        // orders synced through Sellbrite can be excluded (shopify-report.js).
        channelCoverage: info.channelCoverage || null
      }
    };
  }

  return {
    PERIOD_SHOPIFY_SCOPE: SHOPIFY_SCOPE,
    periodMonthKey: monthKey,
    periodAddMonths: addMonths,
    periodMonthEnd: monthEnd,
    periodRangeText: rangeText,
    periodAuthoritativeMonths: authoritativeMonths,
    periodRange: periodRange,
    periodPlan: periodPlan,
    periodComparison: periodComparison,
    periodAggregate: aggregate,
    periodAttachComparison: attachComparison,
    periodDistinctProducts: distinctProducts,
    periodTotals: totals,
    periodAvailability: availability,
    periodDefaultSelection: defaultSelection,
    periodBuildSnapshot: buildSnapshot
  };
});
