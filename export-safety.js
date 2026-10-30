// ============================================================
// export-safety.js — imported text is untrusted.
//   sbSafeCell(v)  a text cell for CSV/XLSX that a spreadsheet will not run
//                  as a formula: text starting with = + - @ TAB or CR gets a
//                  leading apostrophe. Real numbers ("-12.5") are untouched.
//   sbHtml(v)      text made safe to place inside HTML.
//   sbCsvCell(v)   ONE CSV field: sbSafeCell, then quoted when it holds a
//                  comma, quote, CR or LF (or edge whitespace), quotes doubled.
//   sbCsv(rows)    rows (arrays) -> CSV text, CRLF between records.
//   sbDownloadCsv(name, rows)  the only way the dashboard saves a CSV.
// XLSX.utils.json_to_sheet / aoa_to_sheet are wrapped so every export built
// with SheetJS gets the same treatment.
// ============================================================
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) for (var k in api) if (Object.prototype.hasOwnProperty.call(api, k)) root[k] = api[k];
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  var NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%?$/;
  function sbSafeCell(v) {
    if (typeof v !== "string") return v;
    // also after leading whitespace / line breaks, which some spreadsheets skip
    if (/^[\s]*[=+\-@]/.test(v) && !NUMERIC.test(v.trim())) return "'" + v;
    if (/^[\t\r\n]/.test(v)) return "'" + v;
    return v;
  }
  function sbCsvCell(v) {
    if (v == null) return "";
    var s = typeof v === "string" ? sbSafeCell(v) : (typeof v === "number" && !isFinite(v) ? "" : String(v));
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function sbCsv(rows) {
    return (rows || []).map(function (r) { return (r || []).map(sbCsvCell).join(","); }).join("\r\n");
  }
  function sbDownloadCsv(name, rows) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + sbCsv(rows) + "\r\n"], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function sbHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function sanitizeRow(r) {
    if (Array.isArray(r)) return r.map(sbSafeCell);
    if (r && typeof r === "object") { var o = {}; for (var k in r) o[k] = sbSafeCell(r[k]); return o; }
    return sbSafeCell(r);
  }
  function wrapXlsx(X) {
    if (!X || !X.utils || X.utils._sbSafe) return;
    var j = X.utils.json_to_sheet, a = X.utils.aoa_to_sheet;
    X.utils.json_to_sheet = function (rows, o) { return j.call(this, (rows || []).map(sanitizeRow), o); };
    X.utils.aoa_to_sheet = function (rows, o) { return a.call(this, (rows || []).map(sanitizeRow), o); };
    X.utils._sbSafe = true;
  }
  if (typeof window !== "undefined" && window.XLSX) wrapXlsx(window.XLSX);
  return { sbSafeCell: sbSafeCell, sbHtml: sbHtml, sbCsvCell: sbCsvCell, sbCsv: sbCsv, sbDownloadCsv: sbDownloadCsv, sbWrapXlsx: wrapXlsx };
});
