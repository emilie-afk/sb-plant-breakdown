// ============================================================
// worker/src/validate.js
// Payload validation for the ingest route. Pure — no Worker runtime, no DB —
// so the rules are testable on their own and the collector can run the exact
// same checks locally before it uploads anything.
//
// Nothing here trusts the caller. A report is stored only if its headers,
// numbers, periods and completeness all check out, and if its row sums
// reconcile to the totals it claims.
// ============================================================

export const MEASURES = ["units", "gross", "disc", "ret", "net", "tax", "total"];
export const AMAZON_EXTRA = ["glance", "inv"];
export const MAX_ROWS = 20000;

// A product sales report has no business carrying customer data. Any field
// that looks like it does rejects the whole payload, rather than being
// quietly dropped, so a collector bug cannot leak data into shared storage.
const CUSTOMER_FIELD_RE =
  /(^|_)(customer|buyer|email|phone|address|addr|ship[_-]?(city|state|postal|zip|country|name)|postal|zip|billing|recipient|ip[_-]?address|cpf|tax[_-]?id)($|_)/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = new Set(["shopify", "amazon"]);
const IMPORTERS = new Set(["collector", "manual"]);

function isPlainObject(v) { return v != null && typeof v === "object" && !Array.isArray(v); }
function r2(v) { return Math.round(((+v || 0) + Number.EPSILON) * 100) / 100; }

function scanCustomerFields(obj, path, found) {
  if (!isPlainObject(obj)) return;
  for (const k of Object.keys(obj)) {
    if (CUSTOMER_FIELD_RE.test(k)) found.push(path ? path + "." + k : k);
    if (isPlainObject(obj[k])) scanCustomerFields(obj[k], path ? path + "." + k : k, found);
  }
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

/**
 * @returns {{ok:boolean, errors:Array<{code:string,message:string}>, warnings:string[], normalized:object|null}}
 * `errors` never contains a field VALUE — only the rule that was broken — so
 * the error can be logged and shown without leaking data.
 */
export function validateProductReport(payload) {
  const errors = [];
  const warnings = [];
  const err = (code, message) => errors.push({ code, message });

  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ code: "bad_payload", message: "Body must be a JSON object." }], warnings, normalized: null };
  }

  // ---- customer data guard, before anything else ----
  const leaked = [];
  scanCustomerFields(payload, "", leaked);
  if (Array.isArray(payload.rows) && payload.rows.length) scanCustomerFields(payload.rows[0], "rows[]", leaked);
  if (leaked.length) {
    err("customer_data_present",
        "Payload carries customer-looking fields and was refused: " + leaked.slice(0, 8).join(", "));
  }

  // ---- identity ----
  const source = String(payload.source || "").trim();
  if (!SOURCES.has(source)) err("bad_source", 'source must be "shopify" or "amazon".');
  const scope = String(payload.reportScope || "").trim();
  if (!scope) err("bad_scope", "reportScope is required.");
  if (scope.length > 120) err("bad_scope", "reportScope is too long.");
  const importedBy = String(payload.importedBy || "").trim();
  if (!IMPORTERS.has(importedBy)) err("bad_importer", 'importedBy must be "collector" or "manual".');

  // ---- period ----
  const p = isPlainObject(payload.period) ? payload.period : {};
  const start = String(p.start || "");
  const end = String(p.end || "");
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    err("bad_period", "period.start and period.end must be YYYY-MM-DD.");
  } else if (start > end) {
    err("bad_period", "period.start is after period.end.");
  } else if (daysBetween(start, end) > 400) {
    err("bad_period", "Reporting period is longer than 400 days.");
  }

  // The comparison period must be stated, never inferred, and must not
  // overlap the reporting period.
  let comparison = null;
  if (payload.comparison != null) {
    if (!isPlainObject(payload.comparison)) {
      err("bad_comparison", "comparison must be an object or null.");
    } else {
      const cs = String(payload.comparison.start || "");
      const ce = String(payload.comparison.end || "");
      if (!DATE_RE.test(cs) || !DATE_RE.test(ce)) err("bad_comparison", "comparison dates must be YYYY-MM-DD.");
      else if (cs > ce) err("bad_comparison", "comparison.start is after comparison.end.");
      else if (DATE_RE.test(start) && DATE_RE.test(end) && cs <= end && start <= ce) {
        err("comparison_overlaps", "The comparison period overlaps the reporting period.");
      } else {
        comparison = { start: cs, end: ce, source: String(payload.comparison.source || "stated at import").slice(0, 200) };
      }
    }
  }

  // ---- provenance ----
  const timezone = String(payload.timezone || "").trim();
  if (!timezone) err("bad_timezone", "timezone is required (the store's reporting timezone).");
  const currency = String(payload.currency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) err("bad_currency", "currency must be a 3-letter code.");

  // ---- rows ----
  const rows = Array.isArray(payload.rows) ? payload.rows : null;
  if (!rows) err("no_rows", "rows must be an array.");
  else if (!rows.length) err("empty_report", "A report with no rows is never stored.");
  else if (rows.length > MAX_ROWS) err("too_many_rows", "Report exceeds " + MAX_ROWS + " rows.");

  // A report that came back exactly at its source's row cap is probably
  // truncated. Shopify's report carries LIMIT 1000.
  if (rows && payload.sourceRowLimit && rows.length >= Number(payload.sourceRowLimit)) {
    err("possibly_truncated",
        "Row count reached the source's row limit (" + payload.sourceRowLimit +
        "); the export is probably truncated and was refused.");
  }

  const normRows = [];
  const sums = {}; MEASURES.forEach(k => { sums[k] = 0; });
  let hasProductId = false;
  let hasSalesChannel = false;
  let hasPrior = false;

  if (rows && rows.length && rows.length <= MAX_ROWS) {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!isPlainObject(r)) { err("bad_row", "Row " + (i + 1) + " is not an object."); break; }
      const title = String(r.title == null ? "" : r.title).trim();
      if (!title) { err("bad_row", "Row " + (i + 1) + " has no product title."); break; }

      const out = {
        seq: i,
        productId: r.productId == null || r.productId === "" ? null : String(r.productId).trim(),
        title,
        vendor: String(r.vendor == null ? "" : r.vendor).trim() || "(no vendor)",
        productType: String(r.productType == null ? "" : r.productType).trim() || "Unclassified",
        asin: r.asin == null || r.asin === "" ? null : String(r.asin).trim(),
        // Shopify sales channel (e.g. "Online Store", "Sellbrite"). Part of the
        // row identity when present: one product can appear once per channel.
        salesChannel: r.salesChannel == null || r.salesChannel === "" ? null : String(r.salesChannel).trim().slice(0, 100),
        extra: null,
        cur: {}, prior: null
      };
      if (out.asin && !/^[A-Z0-9]{10}$/.test(out.asin)) { err("bad_asin", "Row " + (i + 1) + " has an ASIN that is not 10 characters."); break; }
      // Amazon-only measures that do not fit the shared columns.
      if (isPlainObject(r.extra)) {
        out.extra = {};
        for (const k of ["shipped", "shippedRev", "orderItems"]) {
          if (r.extra[k] == null) continue;
          const n = Number(r.extra[k]);
          if (!Number.isFinite(n)) { err("non_numeric", "Row " + (i + 1) + " has a non-numeric " + k + "."); out.extra = false; break; }
          out.extra[k] = k === "shippedRev" ? r2(n) : Math.round(n);
        }
        if (out.extra === false) break;
      }
      if (out.productId) hasProductId = true;
      if (out.salesChannel) hasSalesChannel = true;

      let bad = false;
      for (const k of MEASURES.concat(AMAZON_EXTRA)) {
        const v = r.cur ? r.cur[k] : undefined;
        if (v == null) { out.cur[k] = 0; continue; }
        const n = Number(v);
        if (!Number.isFinite(n)) { err("non_numeric", "Row " + (i + 1) + " has a non-numeric " + k + "."); bad = true; break; }
        out.cur[k] = k === "units" || k === "glance" || k === "inv" ? Math.round(n) : r2(n);
      }
      if (bad) break;

      if (isPlainObject(r.prior)) {
        out.prior = {};
        for (const k of MEASURES) {
          const n = Number(r.prior[k] == null ? 0 : r.prior[k]);
          if (!Number.isFinite(n)) { err("non_numeric", "Row " + (i + 1) + " has a non-numeric prior " + k + "."); bad = true; break; }
          out.prior[k] = k === "units" ? Math.round(n) : r2(n);
        }
        if (bad) break;
        hasPrior = true;
      }
      MEASURES.forEach(k => { sums[k] += out.cur[k]; });
      normRows.push(out);
    }
  }

  // ---- totals reconciliation ----
  // The caller states the totals printed on the source report. They must equal
  // the sum of the rows it sent, or the upload is refused: a mismatch means
  // rows were lost, duplicated or filtered on the way here.
  const claimed = isPlainObject(payload.totals) ? payload.totals : null;
  if (!claimed) err("no_totals", "totals are required and are checked against the rows.");
  else if (normRows.length) {
    for (const k of MEASURES) {
      if (claimed[k] == null) continue;
      const want = Number(claimed[k]);
      if (!Number.isFinite(want)) { err("bad_totals", "totals." + k + " is not a number."); continue; }
      const got = r2(sums[k]);
      const tol = k === "units" ? 0 : 0.02;
      if (Math.abs(got - r2(want)) > tol) {
        err("totals_mismatch",
            "Rows sum to " + got + " for " + k + " but the report states " + r2(want) + ".");
      }
    }
    // Internal arithmetic of the source.
    if (Math.abs(r2(sums.gross + sums.disc + sums.ret) - r2(sums.net)) > 0.05) {
      warnings.push("Gross + discounts + reversals does not equal net sales.");
    }
    if (Math.abs(r2(sums.net + sums.tax) - r2(sums.total)) > 0.05) {
      warnings.push("Net sales + taxes does not equal total sales.");
    }
  }

  if (errors.length) return { ok: false, errors, warnings, normalized: null };

  const reportKey = [source, scope, start, end].join(":");
  return {
    ok: true,
    errors: [],
    warnings,
    normalized: {
      reportKey,
      source, reportScope: scope,
      period: { start, end },
      comparison,
      timezone, currency,
      sourceFilename: payload.sourceFilename ? String(payload.sourceFilename).slice(0, 300) : null,
      importedBy,
      client: payload.client ? String(payload.client).slice(0, 120) : null,
      rows: normRows,
      rowCount: normRows.length,
      totals: Object.fromEntries(MEASURES.map(k => [k, r2(sums[k])])),
      priorTotals: hasPrior
        ? Object.fromEntries(MEASURES.map(k => [k, r2(normRows.reduce((s, r) => s + (r.prior ? r.prior[k] : 0), 0))]))
        : null,
      // Descriptive facts the parser established about the source file
      // (which Amazon format, which traffic metric, whether revenue exists)
      // are kept from a fixed whitelist. The facts the Worker verifies itself
      // are applied last and always win.
      capabilities: Object.assign(sourceCaps(payload.sourceCapabilities), {
        hasProductId,
        hasSalesChannel,
        hasPrior,
        hasSku: false,
        hasVariantId: false,
        hasDailyDates: false
      })
    }
  };
}

const SOURCE_CAP_KEYS = {
  reportVersion: "string", formatSignature: "string", glanceBasis: "string", revenueBasis: "string",
  revenueLabel: "string", mappingConfirmedAt: "string",
  hasRevenue: "boolean", hasInventory: "boolean", inventoryColumnPresent: "boolean", hasGlance: "boolean",
  hasConversion: "boolean", hasUnits: "boolean", hasShipped: "boolean", hasShippedRevenue: "boolean",
  hasOrderItems: "boolean", hasBuyBox: "boolean", hasAsin: "boolean"
};
function sourceCaps(c) {
  const out = {};
  if (!isPlainObject(c)) return out;
  for (const k of Object.keys(SOURCE_CAP_KEYS)) {
    if (typeof c[k] === SOURCE_CAP_KEYS[k]) out[k] = typeof c[k] === "string" ? c[k].slice(0, 400) : c[k];
  }
  return out;
}

// Content hash over the normalized rows. Two uploads of the same report
// produce the same hash, which is how a repeat upload is recognised as
// "unchanged" and written nowhere.
export async function contentHash(normalized) {
  const canonical = JSON.stringify({
    k: normalized.reportKey,
    c: normalized.comparison,
    // salesChannel is appended only when present, so reports stored before
    // the channel column existed keep the same hash.
    r: normalized.rows.map(r => [r.productId, r.asin, r.title, r.vendor, r.productType, r.extra,
      MEASURES.map(k => r.cur[k]), r.prior ? MEASURES.map(k => r.prior[k]) : null].concat(r.salesChannel ? [r.salesChannel] : []))
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Periods that overlap describe the same sales twice, so they must never be
// summed. Returns the active reports that clash with a candidate period.
export function overlapping(existing, candidate) {
  return (existing || []).filter(e =>
    e.source === candidate.source &&
    e.report_scope === candidate.reportScope &&
    e.status === "active" &&
    !(e.period_start === candidate.period.start && e.period_end === candidate.period.end) &&
    e.period_start <= candidate.period.end && candidate.period.start <= e.period_end);
}
