// ============================================================
// worker/src/store.js
// D1 access for the shared report store. Every write path is built so that a
// failure part-way through cannot disturb the last successful report:
//
//   1. the new report is inserted with status 'staging'
//   2. its rows are inserted in small batches
//   3. ONE final batch supersedes the old active report and activates the
//      new one (D1 batches are atomic)
//
// If anything fails before step 3, the staging report is marked 'abandoned'
// and nothing that reads 'active' reports ever sees it.
// ============================================================
import { MEASURES } from "./validate.js";

// D1 caps bound parameters per statement at 100. A row has 26 columns, so
// three rows per INSERT keeps every statement well under the cap.
const ROW_COLS = ["report_id", "seq", "product_id", "asin", "title", "vendor", "product_type",
  "units", "gross", "disc", "ret", "net", "tax", "total", "glance", "inv",
  "p_units", "p_gross", "p_disc", "p_ret", "p_net", "p_tax", "p_total", "extra_json", "sales_channel", "sku"];
const ROWS_PER_STMT = 3;
const STMTS_PER_BATCH = 25;

export function nowIso() { return new Date().toISOString(); }
export function newId(prefix) {
  const b = new Uint8Array(9); crypto.getRandomValues(b);
  return prefix + "_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

// ---- import runs (history) ---------------------------------
export async function startRun(db, meta) {
  const id = newId("run");
  await db.prepare(
    `INSERT INTO import_runs (id, started_at, source, report_scope, period_start, period_end, outcome, imported_by, client)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`
  ).bind(id, nowIso(), meta.source || "unknown", meta.reportScope || null,
         meta.periodStart || null, meta.periodEnd || null,
         meta.importedBy || "unknown", meta.client || null).run();
  return id;
}
export async function finishRun(db, id, f) {
  await db.prepare(
    `UPDATE import_runs SET finished_at = ?, outcome = ?, error_code = ?, error_message = ?,
       row_count = ?, content_hash = ?, report_id = ?, revision = ? WHERE id = ?`
  ).bind(nowIso(), f.outcome, f.errorCode || null, f.errorMessage ? String(f.errorMessage).slice(0, 2000) : null,
         f.rowCount == null ? null : f.rowCount, f.contentHash || null, f.reportId || null,
         f.revision == null ? null : f.revision, id).run();
}
export async function listRuns(db, { source, limit } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const q = source
    ? db.prepare(`SELECT * FROM import_runs WHERE source = ? ORDER BY started_at DESC LIMIT ?`).bind(source, n)
    : db.prepare(`SELECT * FROM import_runs ORDER BY started_at DESC LIMIT ?`).bind(n);
  return (await q.all()).results || [];
}

// ---- reports ------------------------------------------------
export async function activeReport(db, reportKey) {
  return db.prepare(`SELECT * FROM reports WHERE report_key = ? AND status = 'active'`).bind(reportKey).first();
}
export async function activeReportsFor(db, source, scope) {
  return (await db.prepare(
    `SELECT id, report_key, source, report_scope, period_start, period_end, status, revision
       FROM reports WHERE source = ? AND report_scope = ? AND status = 'active'`
  ).bind(source, scope).all()).results || [];
}
// Active reports by default. With `history`, every stored revision of every
// period (active and superseded), newest revision first, so earlier revisions
// stay available for inspection and download. Staging and abandoned attempts
// never appear: they were never a successful import.
export async function listReports(db, { source, history } = {}) {
  const statuses = history ? "status IN ('active', 'superseded')" : "status = 'active'";
  const sql = `SELECT id, report_key, source, report_scope, period_start, period_end,
                 comparison_start, comparison_end, comparison_source, timezone, currency,
                 source_filename, content_hash, row_count, has_product_id, totals_json,
                 prior_totals_json, capabilities_json, revision, status, superseded_by,
                 imported_at, imported_by, collected_at, activated_at, confirmed_at, completeness,
                 included_totals_json, excluded_totals_json, exclusion_labels_json
               FROM reports WHERE ${statuses} ${source ? "AND source = ?" : ""}
               ORDER BY period_end DESC, period_start DESC, revision DESC`;
  const q = source ? db.prepare(sql).bind(source) : db.prepare(sql);
  const parse = (v) => v ? JSON.parse(v) : null;
  return ((await q.all()).results || []).map(r => ({
    ...r,
    totals: JSON.parse(r.totals_json),
    priorTotals: parse(r.prior_totals_json),
    capabilities: JSON.parse(r.capabilities_json),
    includedTotals: parse(r.included_totals_json),
    excludedTotals: parse(r.excluded_totals_json),
    exclusionLabels: parse(r.exclusion_labels_json),
    totals_json: undefined, prior_totals_json: undefined, capabilities_json: undefined,
    included_totals_json: undefined, excluded_totals_json: undefined, exclusion_labels_json: undefined
  }));
}
// What periods are stored, without any row data. The collector may read this
// (to find months to backfill); it reveals dates and revision numbers only.
export async function coverage(db, { source, scope }) {
  return (await db.prepare(
    `SELECT period_start, period_end, revision, completeness, collected_at
       FROM reports WHERE status = 'active' AND source = ? AND report_scope = ?
       ORDER BY period_start`
  ).bind(source, scope).all()).results || [];
}
export async function reportRows(db, reportId, { offset = 0, limit = 5000 } = {}) {
  const rep = await db.prepare(`SELECT id, status FROM reports WHERE id = ?`).bind(reportId).first();
  if (!rep) return null;
  const n = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 20000);
  const o = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = (await db.prepare(
    `SELECT * FROM report_rows WHERE report_id = ? ORDER BY seq LIMIT ? OFFSET ?`
  ).bind(reportId, n, o).all()).results || [];
  return { status: rep.status, rows: rows.map(fromRow) };
}
function fromRow(r) {
  const cur = {}, prior = {};
  let hasPrior = false;
  for (const k of MEASURES) {
    cur[k] = r[k];
    const pv = r["p_" + k];
    if (pv != null) hasPrior = true;
    prior[k] = pv == null ? 0 : pv;
  }
  cur.glance = r.glance; cur.inv = r.inv;
  return {
    seq: r.seq, productId: r.product_id, asin: r.asin, title: r.title, vendor: r.vendor,
    productType: r.product_type, salesChannel: r.sales_channel || null, sku: r.sku || null, cur, prior: hasPrior ? prior : null,
    extra: r.extra_json ? JSON.parse(r.extra_json) : null
  };
}

function rowValues(reportId, r) {
  const p = r.prior || {};
  return [reportId, r.seq, r.productId, r.asin || null, r.title, r.vendor, r.productType,
    r.cur.units, r.cur.gross, r.cur.disc, r.cur.ret, r.cur.net, r.cur.tax, r.cur.total,
    r.cur.glance || 0, r.cur.inv || 0,
    r.prior ? p.units : null, r.prior ? p.gross : null, r.prior ? p.disc : null, r.prior ? p.ret : null,
    r.prior ? p.net : null, r.prior ? p.tax : null, r.prior ? p.total : null,
    r.extra ? JSON.stringify(r.extra) : null, r.salesChannel || null, r.sku || null];
}

/**
 * Store a validated, normalised report. Returns
 *   { outcome: 'unchanged' | 'succeeded', reportId, revision, overlaps }
 * Throws on a storage failure — the caller records the failure; the previous
 * active report is untouched either way.
 */
export async function storeReport(db, n, hash) {
  const current = await activeReport(db, n.reportKey);
  if (current && current.content_hash === hash) {
    // An identical retry writes no new revision. It only records that the
    // data was confirmed, and if the period has since ended, that the same
    // figures are now known to be the complete period.
    const upgrade = current.completeness !== "complete" && n.completeness === "complete";
    await db.prepare(
      `UPDATE reports SET confirmed_at = ?${upgrade ? ", completeness = 'complete', collected_at = ?" : ""} WHERE id = ?`
    ).bind(...(upgrade ? [nowIso(), n.collectedAt || nowIso(), current.id] : [nowIso(), current.id])).run();
    return { outcome: "unchanged", reportId: current.id, revision: current.revision, overlaps: [], markedComplete: upgrade };
  }
  // The next revision number counts abandoned attempts too, so a retry after a
  // failure never collides with the id of the attempt that failed.
  const maxRev = await db.prepare(`SELECT MAX(revision) AS m FROM reports WHERE report_key = ?`).bind(n.reportKey).first();
  const revision = (maxRev && maxRev.m ? maxRev.m : 0) + 1;
  const id = n.reportKey + ":r" + revision;
  const stamp = nowIso();

  // Overlapping periods are allowed to EXIST (a month and a year-to-date can
  // both be stored) but are reported, because they must never be summed.
  const siblings = await activeReportsFor(db, n.source, n.reportScope);
  const overlaps = siblings.filter(e =>
    !(e.period_start === n.period.start && e.period_end === n.period.end) &&
    e.period_start <= n.period.end && n.period.start <= e.period_end
  ).map(e => ({ id: e.id, periodStart: e.period_start, periodEnd: e.period_end }));

  // 1. staging report
  await db.prepare(
    `INSERT INTO reports (id, report_key, source, report_scope, period_start, period_end,
       comparison_start, comparison_end, comparison_source, timezone, currency, source_filename,
       content_hash, row_count, has_product_id, totals_json, prior_totals_json, capabilities_json,
       revision, status, imported_at, imported_by, collected_at, completeness,
       included_totals_json, excluded_totals_json, exclusion_labels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, n.reportKey, n.source, n.reportScope, n.period.start, n.period.end,
         n.comparison ? n.comparison.start : null, n.comparison ? n.comparison.end : null,
         n.comparison ? n.comparison.source : null, n.timezone, n.currency, n.sourceFilename,
         hash, n.rowCount, n.capabilities.hasProductId ? 1 : 0, JSON.stringify(n.totals),
         n.priorTotals ? JSON.stringify(n.priorTotals) : null, JSON.stringify(n.capabilities),
         revision, stamp, n.importedBy, n.collectedAt || stamp, n.completeness || "partial",
         n.split ? JSON.stringify(n.split.included) : null, n.split ? JSON.stringify(n.split.excluded) : null,
         n.split ? JSON.stringify(n.split.labels) : null).run();

  try {
    // 2. rows, in small batches
    const placeholders = "(" + ROW_COLS.map(() => "?").join(",") + ")";
    const stmts = [];
    for (let i = 0; i < n.rows.length; i += ROWS_PER_STMT) {
      const chunk = n.rows.slice(i, i + ROWS_PER_STMT);
      const sql = `INSERT INTO report_rows (${ROW_COLS.join(",")}) VALUES ${chunk.map(() => placeholders).join(",")}`;
      stmts.push(db.prepare(sql).bind(...chunk.flatMap(r => rowValues(id, r))));
    }
    for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
      await db.batch(stmts.slice(i, i + STMTS_PER_BATCH));
    }
    // Every row must be there before activation.
    const cnt = await db.prepare(`SELECT COUNT(*) AS c FROM report_rows WHERE report_id = ?`).bind(id).first();
    if (!cnt || cnt.c !== n.rowCount) {
      throw Object.assign(new Error(`Stored ${cnt ? cnt.c : 0} rows of ${n.rowCount}`), { code: "row_count_mismatch" });
    }

    // 3. atomic switch: supersede the old active report, activate the new one
    const flip = [];
    if (current) {
      flip.push(db.prepare(`UPDATE reports SET status = 'superseded', superseded_by = ? WHERE id = ?`).bind(id, current.id));
    }
    flip.push(db.prepare(`UPDATE reports SET status = 'active', activated_at = ? WHERE id = ?`).bind(nowIso(), id));
    await db.batch(flip);
  } catch (e) {
    try {
      await db.prepare(`UPDATE reports SET status = 'abandoned' WHERE id = ? AND status = 'staging'`).bind(id).run();
    } catch (_) { /* the original error matters more */ }
    throw e;
  }
  return { outcome: "succeeded", reportId: id, revision, overlaps };
}

// ---- settings ----------------------------------------------
export const SETTING_KEYS = new Set([
  "classification_overrides", "catalog_mappings", "amazon_column_mappings", "vendor_map",
  // private business configuration kept out of the public repository
  "restricted_items", "market_config"
]);
export const MAX_SETTING_BYTES = 2 * 1024 * 1024;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const short = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n;
// Store names are short, but a nested quantifier such as (a+)+ can still stall a
// browser: those patterns are refused.
function regexOk(src) { if (!short(src, 200) || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(src)) return false; try { new RegExp(src, "i"); return true; } catch (e) { return false; } }
// -> null when the value may be stored, else a short reason.
export function checkSettingValue(key, value) {
  let size = 0;
  try { size = JSON.stringify(value).length; } catch (e) { return "not JSON"; }
  if (size > MAX_SETTING_BYTES) return "too large";
  if (key === "restricted_items") {
    if (!isObj(value) || !Array.isArray(value.items) || value.items.length > 20000) return "expected {items:[{sku,name}]}";
    for (const it of value.items) {
      if (!isObj(it) || (it.sku != null && !short(String(it.sku), 60)) || (it.name != null && typeof it.name !== "string") || (!it.sku && !it.name)) return "bad item";
    }
  }
  if (key === "market_config") {
    if (!isObj(value)) return "expected an object";
    const groups = value.storeGroups || [];
    if (!Array.isArray(groups) || groups.length > 100 || groups.some(g => !isObj(g) || !regexOk(g.match) || !short(g.group, 80))) return "bad storeGroups";
    const fn = value.filenameStores || [];
    if (!Array.isArray(fn) || fn.length > 50 || fn.some(g => !isObj(g) || !regexOk(g.match) || !short(g.store, 80))) return "bad filenameStores";
    for (const k of ["focusStores"]) if (value[k] != null && (!Array.isArray(value[k]) || value[k].length > 50 || value[k].some(x => !short(x, 80)))) return "bad " + k;
    for (const k of ["marketplaceStore", "marketplaceBreakdownLabel", "marketplaceOrderStore", "unknownFileStore"]) if (value[k] != null && !short(value[k], 80)) return "bad " + k;
  }
  return null;
}
export async function getSetting(db, key) {
  const r = await db.prepare(`SELECT * FROM settings WHERE key = ?`).bind(key).first();
  return r ? { key, value: JSON.parse(r.value_json), version: r.version, updatedAt: r.updated_at, updatedBy: r.updated_by } : null;
}
// Optimistic concurrency: a write must name the version it was based on, so
// two browsers editing at once cannot silently overwrite each other.
export async function putSetting(db, key, value, baseVersion, by) {
  const cur = await db.prepare(`SELECT version FROM settings WHERE key = ?`).bind(key).first();
  const curV = cur ? cur.version : 0;
  if ((baseVersion || 0) !== curV) {
    return { ok: false, conflict: true, currentVersion: curV };
  }
  const v = curV + 1;
  await db.prepare(
    `INSERT INTO settings (key, value_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, JSON.stringify(value), v, nowIso(), by || null).run();
  return { ok: true, version: v };
}

// ---- sign-in attempt counters (route /v1/auth/*, gateway only) ----------
// Reserve-before-verify: the gateway counts an attempt BEFORE it checks the
// password and refuses when the count exceeds its limit. Each bucket changes
// in one atomic statement (SQLite/D1 serialise writes), so N concurrent
// attempts always produce counts 1..N and at most `limit` of them pass.
const BUMP_SQL = `INSERT INTO auth_attempts (bucket, window_start, n) VALUES (?1, ?2, 1)
  ON CONFLICT(bucket) DO UPDATE SET
    n = CASE WHEN auth_attempts.window_start <= ?2 - ?3 THEN 1 ELSE auth_attempts.n + 1 END,
    window_start = CASE WHEN auth_attempts.window_start <= ?2 - ?3 THEN ?2 ELSE auth_attempts.window_start END
  RETURNING n, window_start`;
export async function reserveAttempt(db, { client, windowSec, now }) {
  const t = Math.floor(now / 1000);
  const c = await db.prepare(BUMP_SQL).bind("client:" + client, t, windowSec).first();
  const g = await db.prepare(BUMP_SQL).bind("global", t, windowSec).first();
  const left = (r) => Math.max(1, r.window_start + windowSec - t);
  return { client: { n: c.n, retryAfter: left(c) }, global: { n: g.n, retryAfter: left(g) } };
}
// A successful sign-in clears its client's count and gives back its global slot.
export async function releaseAttempt(db, { client, windowSec, now }) {
  const t = Math.floor(now / 1000);
  await db.prepare(`DELETE FROM auth_attempts WHERE bucket = ?1`).bind("client:" + client).run();
  await db.prepare(`UPDATE auth_attempts SET n = MAX(n - 1, 0) WHERE bucket = 'global' AND window_start > ?1 - ?2`).bind(t, windowSec).run();
  return { ok: true };
}
