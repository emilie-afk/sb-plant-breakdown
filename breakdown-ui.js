// ============================================================
// breakdown-ui.js
// Rendering layer shared by the Shopify and Amazon breakdowns: formatting,
// the percentage-change convention, data-driven tables, pagination and CSV.
//
// Both channels render through this file so a column, a percentage or an
// export cannot mean one thing on one tab and something else on the other.
// ============================================================
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.BUI = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";

  var MONEY_KEYS = { net: 1, total: 1, gross: 1, disc: 1, ret: 1, tax: 1 };

  // ----------------------------------------------------------
  // Formatting
  // ----------------------------------------------------------
  function money(v) {
    if (v == null) return "—";
    var n = Number(v) || 0;
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signedMoney(v) {
    if (v == null) return "—";
    var n = Number(v) || 0;
    return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function count(v) { return v == null ? "—" : Number(v).toLocaleString(); }
  function signedCount(v) { if (v == null) return "—"; var n = Number(v) || 0; return (n > 0 ? "+" : "") + n.toLocaleString(); }
  function pct1(v) { return v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(1) + "%"; }
  function pctPlain(v) { return (Number(v) * 100).toFixed(1) + "%"; }
  function isMoney(measure) { return !!MONEY_KEYS[measure]; }
  function val(v, measure) { return isMoney(measure) ? money(v) : count(v); }
  function signedVal(v, measure) { return isMoney(measure) ? signedMoney(v) : signedCount(v); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ----------------------------------------------------------
  // Percentage change — ONE convention, used everywhere
  // ----------------------------------------------------------
  // percentage change = (current − prior) / |prior| × 100
  //
  // The absolute value in the denominator is deliberate and it is what the
  // Shopify report itself does. It matters whenever a prior figure is
  // negative, which happens here because a period whose only activity was a
  // refund has negative net sales.
  //
  //   prior  100.00 → current  150.00  = +50.0%   (same as current/prior − 1)
  //   prior  100.00 → current    0.00  = -100.0%  (same as current/prior − 1)
  //   prior  -20.00 → current    0.00  = +100.0%  (current/prior − 1 gives -100%)
  //   prior  -20.00 → current  -40.00  = -100.0%  (twice as negative = a fall)
  //   prior    0.00 → current   25.91  = no percentage; "New / no prior sales"
  //   prior    0.00 → current    0.00  = no percentage; nothing happened
  //
  // This is the formula behind the percentages Shopify prints in its own
  // export, including rows whose prior is negative (a refund-only prior falling
  // to $0 is reported as +100%). tests/percentage-change.test.mjs checks it
  // cell by cell against the export layout.
  //
  // A dollar (or unit) change is always shown next to the percentage, because
  // a percentage off a tiny or negative base is not meaningful on its own.
  var CHANGE_FORMULA = "(current − prior) ÷ |prior| × 100";
  function changeOf(cur, prior, priorKnown) {
    if (root && typeof root.shopifyChange === "function") return root.shopifyChange(cur, prior, priorKnown);
    throw new Error("shopify-report.js must be loaded first");
  }

  function pctCell(ch) {
    if (!ch) return '<td class="num">—</td>';
    if (ch.state === "unknown") return '<td class="num small">no prior period</td>';
    if (ch.state === "new") return '<td class="num"><span class="badge newprod">New / no prior sales</span></td>';
    if (ch.state === "none") return '<td class="num">—</td>';
    var cls = ch.pct > 0 ? "up" : ch.pct < 0 ? "down" : "flat";
    return '<td class="num ' + cls + '" title="' + CHANGE_FORMULA + '">' + pct1(ch.pct) + "</td>";
  }
  function deltaCell(ch, measure) {
    if (!ch || ch.state === "unknown") return '<td class="num">—</td>';
    var cls = ch.abs > 0 ? "up" : ch.abs < 0 ? "down" : "flat";
    return '<td class="num ' + cls + '">' + signedVal(ch.abs, measure) + "</td>";
  }
  // Both numbers together, for cards and summaries.
  function changeSub(ch, measure) {
    if (!ch || ch.state === "unknown") return "no prior period";
    if (ch.state === "new") return "New / no prior sales";
    if (ch.state === "none") return "—";
    var cls = ch.abs > 0 ? "up" : ch.abs < 0 ? "down" : "flat";
    return '<span class="' + cls + '">' + signedVal(ch.abs, measure) + " (" + pct1(ch.pct) + ")</span> vs prior period";
  }
  // Attributes recorded beside the group (they never change it).
  function attrBadges(r) {
    return (r && r.isPack ? ' <span class="badge type-other" title="Several plants sold together; grouped by genus when they share one">pack</span>' : "") +
           (r && r.subscriptionAddOn ? ' <span class="badge type-other" title="Bought as a subscription add-on; grouped by the item itself">subscription add-on</span>' : "");
  }
  function groupTypeBadge(t) {
    return '<span class="badge ' + (t === "Genus" ? "gt-genus" : "gt-category") + '">' + esc(t) + "</span>";
  }

  // ----------------------------------------------------------
  // Data-driven tables
  // ----------------------------------------------------------
  // A column is { k, label, cls, cell(row, ctx) -> html, sortVal(row, ctx) }.
  function headHtml(cols, sort, attr) {
    return cols.map(function (c) {
      var arrow = sort && sort.col === c.k ? (sort.dir === "desc" ? " ▾" : " ▴") : "";
      var lbl = typeof c.label === "function" ? c.label() : c.label;
      return '<th class="' + (c.cls || "") + '" data-' + attr + '="' + c.k + '"' +
             (c.title ? ' title="' + esc(c.title) + '"' : "") + ">" + esc(lbl) + arrow + "</th>";
    }).join("");
  }
  function sortRows(rows, cols, sort, ctx) {
    if (!sort || !sort.col) return rows.slice();
    var col = cols.filter(function (c) { return c.k === sort.col; })[0];
    if (!col || !col.sortVal) return rows.slice();
    var dir = sort.dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var av = col.sortVal(a, ctx), bv = col.sortVal(b, ctx);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av == null ? "" : av).localeCompare(String(bv == null ? "" : bv)) * dir;
      }
      if (av == null) av = -Infinity;
      if (bv == null) bv = -Infinity;
      return (av - bv) * dir;
    });
  }
  function rowsHtml(rows, cols, ctx) {
    return rows.map(function (r) {
      return "<tr" + (r.excluded ? ' class="excluded-row"' : "") + ">" +
        cols.map(function (c) {
          var out = c.cell(r, ctx);
          return /^\s*<td/i.test(out) ? out : '<td class="' + (c.cls || "") + '">' + out + "</td>";
        }).join("") + "</tr>";
    }).join("");
  }
  function toggleSort(sort, col) {
    if (sort.col === col) sort.dir = sort.dir === "desc" ? "asc" : "desc";
    else { sort.col = col; sort.dir = "desc"; }
  }

  // ----------------------------------------------------------
  // Pagination
  // ----------------------------------------------------------
  // The caller filters and sorts the WHOLE set first; this paints one slice.
  var PAGE_SIZES = [50, 100, 200, 500, "all"];
  function paginationBar(p, idPrefix, totalLabel) {
    if (!p.total) return "";
    var sizes = PAGE_SIZES.map(function (s) {
      var sel = (s === "all" ? p.pageSize >= p.total : p.pageSize === s) ? " selected" : "";
      return '<option value="' + s + '"' + sel + ">" + (s === "all" ? "All" : s) + "</option>";
    }).join("");
    var dis = function (c) { return c ? " disabled" : ""; };
    return '<div class="pager">' +
      '<span class="small">Showing <b>' + count(p.from) + "–" + count(p.to) + "</b> of <b>" +
        count(p.total) + "</b> " + (totalLabel || "products") + "</span>" +
      '<span class="pager-ctl">' +
        '<label class="small">Rows</label> <select id="' + idPrefix + '-pagesize">' + sizes + "</select>" +
        '<button class="tab" id="' + idPrefix + '-first"' + dis(p.page <= 1) + ">« First</button>" +
        '<button class="tab" id="' + idPrefix + '-prev"' + dis(p.page <= 1) + ">‹ Prev</button>" +
        '<span class="small">Page <input id="' + idPrefix + '-page" type="number" min="1" max="' + p.pages +
          '" value="' + p.page + '" style="width:60px"> of ' + count(p.pages) + "</span>" +
        '<button class="tab" id="' + idPrefix + '-next"' + dis(p.page >= p.pages) + ">Next ›</button>" +
        '<button class="tab" id="' + idPrefix + '-last"' + dis(p.page >= p.pages) + ">Last »</button>" +
      "</span></div>";
  }
  // Wires one pagination bar. `stateObj` is {page, pageSize}; `redraw` repaints.
  function wirePagination(idPrefix, stateObj, redraw, pages) {
    function set(p) { stateObj.page = Math.min(Math.max(1, p), Math.max(1, pages)); redraw(); }
    var g = function (s) { return document.getElementById(idPrefix + "-" + s); };
    if (g("first")) g("first").onclick = function () { set(1); };
    if (g("prev")) g("prev").onclick = function () { set(stateObj.page - 1); };
    if (g("next")) g("next").onclick = function () { set(stateObj.page + 1); };
    if (g("last")) g("last").onclick = function () { set(pages); };
    if (g("page")) g("page").onchange = function (e) { set(parseInt(e.target.value, 10) || 1); };
    if (g("pagesize")) g("pagesize").onchange = function (e) {
      var v = e.target.value;
      stateObj.pageSize = v === "all" ? "all" : parseInt(v, 10);
      stateObj.page = 1; redraw();
    };
  }

  // Filter -> sort -> paginate -> paint. Returns the pagination descriptor.
  function renderTable(opts) {
    var cols = opts.cols, ctx = opts.ctx || {};
    var sorted = sortRows(opts.rows, cols, opts.sort, ctx);
    var p = root.paginate(sorted, opts.pageState ? opts.pageState.page : 1,
                          opts.pageState ? opts.pageState.pageSize : null);
    var thead = document.getElementById(opts.theadId);
    var tbody = document.getElementById(opts.tbodyId);
    if (thead) thead.innerHTML = headHtml(cols, opts.sort, opts.sortAttr || "bsort");
    if (tbody) {
      tbody.innerHTML = p.total
        ? rowsHtml(p.rows, cols, ctx)
        : '<tr><td colspan="' + cols.length + '" class="empty">' + (opts.emptyMsg || "Nothing matches the current filters.") + "</td></tr>";
    }
    if (opts.pagerId) {
      var bar = document.getElementById(opts.pagerId);
      if (bar) bar.innerHTML = paginationBar(p, opts.pagerId, opts.totalLabel);
      if (bar && opts.pageState && opts.redraw) wirePagination(opts.pagerId, opts.pageState, opts.redraw, p.pages);
    }
    p.sorted = sorted;
    return p;
  }

  // ----------------------------------------------------------
  // CSV — always the complete filtered set, never the painted page
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
  // Build CSV rows from the same column specs the table uses.
  // Numeric columns are written as plain numbers — a spreadsheet should get
  // -34.5, not "-$34.50" — while an em dash for "nothing to compare" becomes
  // an empty cell rather than a character Excel reads as text.
  function csvValue(col, raw) {
    var s = stripTags(raw);
    if (s === "—" || s === "") return "";
    if (!col.cls || col.cls.indexOf("num") < 0) return s;
    var n = s.replace(/[$,\s]/g, "");
    if (/^[+-]?\d*\.?\d+%$/.test(n)) return n;                 // keep percentages as percentages
    return /^[+-]?\d*\.?\d+$/.test(n) ? Number(n) : s;
  }
  function csvFromCols(rows, cols, ctx) {
    var head = cols.map(function (c) { return typeof c.label === "function" ? c.label() : c.label; });
    var body = rows.map(function (r) {
      return cols.map(function (c) { return c.csv ? c.csv(r, ctx) : csvValue(c, c.cell(r, ctx)); });
    });
    return [head].concat(body);
  }
  function stripTags(html) {
    return String(html == null ? "" : html).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
  }

  function cards(list) {
    return list.map(function (c) {
      return '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + (c.cls || "") + '">' +
             c.value + "</div>" + (c.sub ? '<div class="sub">' + c.sub + "</div>" : "") + "</div>";
    }).join("");
  }

  return {
    CHANGE_FORMULA: CHANGE_FORMULA,
    PAGE_SIZES: PAGE_SIZES,
    money: money, signedMoney: signedMoney, count: count, signedCount: signedCount,
    pct1: pct1, pctPlain: pctPlain, val: val, signedVal: signedVal, isMoney: isMoney, esc: esc,
    changeOf: changeOf, pctCell: pctCell, deltaCell: deltaCell, changeSub: changeSub,
    groupTypeBadge: groupTypeBadge,
    attrBadges: attrBadges,
    headHtml: headHtml, rowsHtml: rowsHtml, sortRows: sortRows, toggleSort: toggleSort,
    paginationBar: paginationBar, wirePagination: wirePagination, renderTable: renderTable,
    download: download, csvFromCols: csvFromCols, stripTags: stripTags, cards: cards
  };
});
