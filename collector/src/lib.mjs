// collector/src/lib.mjs — pure functions, no browser, no network.
// Everything here is unit-tested (tests/collector.test.mjs).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// The dashboard's own validated parser: the collector refuses exactly what
// the dashboard would refuse.
const SR = require('../../shopify-report.js');
const PG = require('../../product-grouping.js');

export const STORE_TZ = 'America/Los_Angeles';
export const REPORT_SCOPE = 'total_sales_by_product';

// Exit codes (same meanings as the sb-gross-profit Shopify job where they overlap)
export const EXIT = {
  OK: 0,
  LOCKED: 5,
  CONFIG: 10,
  SIGN_IN_NEEDED: 20,    // login / 2FA not completed by a person in time
  CAPTCHA: 21,
  UNKNOWN_PAGE: 22,
  EXPORT_FAILED: 30,     // page or download did not work
  UPLOAD_FAILED: 31,     // Worker unreachable, or refused the report
  VALIDATION_FAILED: 34  // the file was downloaded but did not pass checks; nothing uploaded
};

// ---- dates (always in the store's time zone, whatever the PC's zone) ----
export function ymdInZone(date, tz = STORE_TZ) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// Shopify's "previous_period": the same number of days immediately before.
// Example: Sep 1–30 compares to Aug 2–31 (30 days each).
export function previousPeriod(start, end) {
  const n = daysBetween(start, end) + 1;
  return { start: addDays(start, -n), end: addDays(start, -1) };
}

// Which periods a run collects. `now` is a Date; the store's calendar decides.
//   previous-month : the last full month (collected on any day of the next month)
//   month-to-date  : the 1st of this month through yesterday (skipped on the 1st)
//   last-full-day  : yesterday only
export function planPeriods(kinds, now = new Date(), tz = STORE_TZ) {
  const today = ymdInZone(now, tz);
  const yesterday = addDays(today, -1);
  const out = [];
  for (const k of kinds) {
    if (k === 'previous-month') {
      const firstThis = today.slice(0, 8) + '01';
      const end = addDays(firstThis, -1);
      out.push({ kind: k, start: end.slice(0, 8) + '01', end });
    } else if (k === 'month-to-date') {
      const start = today.slice(0, 8) + '01';
      if (start <= yesterday) out.push({ kind: k, start, end: yesterday });
    } else if (k === 'last-full-day') {
      out.push({ kind: k, start: yesterday, end: yesterday });
    } else throw new Error(`Unknown period kind "${k}".`);
  }
  return out.map(p => Object.assign(p, { comparison: previousPeriod(p.start, p.end) }));
}

// The full calendar month `back` months before the store's current month.
export function closedMonth(back, now = new Date(), tz = STORE_TZ) {
  const today = ymdInZone(now, tz);
  let y = +today.slice(0, 4), m = +today.slice(5, 7) - back;
  while (m < 1) { m += 12; y--; }
  const key = `${y}-${String(m).padStart(2, '0')}`;
  const end = `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  return { kind: back === 1 ? 'previous-month' : 'closed-month', start: key + '-01', end, comparison: previousPeriod(key + '-01', end) };
}

// How closed months are kept current (configurable; nothing here is assumed
// approved). Older configs with `monthlyOnDay` keep their meaning: the
// previous month only, on that day.
export function closedMonthRule(cfg) {
  const s = (cfg && cfg.periods) || {};
  if (s.closedMonths) {
    const lb = Number(s.closedMonths.lookback);
    return { lookback: Number.isInteger(lb) && lb >= 0 && lb <= 12 ? lb : 2,
             onDays: Array.isArray(s.closedMonths.onDays) ? s.closedMonths.onDays.map(Number).filter(d => d >= 1 && d <= 31) : [1, 2] };
  }
  if (s.monthlyOnDay) return { lookback: 1, onDays: [Number(s.monthlyOnDay)] };
  return { lookback: 0, onDays: [] };
}

// Decides what today's scheduled run should collect from the config's rules.
//   periods.daily                  kinds collected every run (month-to-date)
//   periods.closedMonths.lookback  on each of `onDays` (store calendar), also
//   periods.closedMonths.onDays    re-collect the last `lookback` full months,
//                                  so later refunds and corrections are kept.
//                                  An unchanged month writes nothing new.
export function periodsForToday(cfg, now = new Date()) {
  const s = cfg.periods || {};
  const tz = cfg.timeZone || STORE_TZ;
  const kinds = [...(s.daily || ['month-to-date'])].filter(k => k !== 'previous-month');
  const out = planPeriods(kinds, now, tz);
  const rule = closedMonthRule(cfg);
  const dom = Number(ymdInZone(now, tz).slice(8, 10));
  const wantPrev = (s.daily || []).includes('previous-month');
  const lookback = rule.onDays.includes(dom) ? rule.lookback : (wantPrev ? 1 : 0);
  for (let b = 1; b <= Math.max(lookback, wantPrev ? 1 : 0); b++) out.push(closedMonth(b, now, tz));
  return out;
}

// Historical months to collect because shared storage has no complete report
// for them. Newest first, at most `maxPerRun`, never earlier than `earliest`
// (YYYY-MM) nor earlier than a month Shopify already returned no data for.
//   coverage: [{period_start, period_end, completeness}] from the Worker
//   skip:     months already planned this run (YYYY-MM)
export function backfillPlan(coverage, { earliest, maxPerRun = 2, now = new Date(), tz = STORE_TZ, noDataBefore = null, skip = [] } = {}) {
  if (!earliest || !/^\d{4}-\d{2}$/.test(earliest) || !(maxPerRun > 0)) return [];
  const have = new Set((coverage || []).filter(c => {
    const full = c.period_start.slice(8, 10) === '01' && c.period_start.slice(0, 7) === c.period_end.slice(0, 7) &&
      c.period_end === closedMonthEnd(c.period_start.slice(0, 7));
    return full && c.completeness !== 'partial';
  }).map(c => c.period_start.slice(0, 7)));
  const floor = noDataBefore && noDataBefore > earliest ? noDataBefore : earliest;
  const out = [];
  for (let b = 1; b <= 240 && out.length < maxPerRun; b++) {
    const p = closedMonth(b, now, tz);
    const key = p.start.slice(0, 7);
    if (key < floor) break;
    if (have.has(key) || skip.includes(key)) continue;
    out.push(Object.assign(p, { kind: 'backfill' }));
  }
  return out;
}
function closedMonthEnd(key) {
  const y = +key.slice(0, 4), m = +key.slice(5, 7);
  return `${key}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// Collector exit codes -> the failure codes the Worker records for the dashboard.
export function failureCodeFor(exit) {
  return ({ [EXIT.SIGN_IN_NEEDED]: 'sign_in_needed', [EXIT.CAPTCHA]: 'captcha', [EXIT.UNKNOWN_PAGE]: 'unknown_page',
            [EXIT.EXPORT_FAILED]: 'export_failed', [EXIT.VALIDATION_FAILED]: 'validation_failed',
            [EXIT.UPLOAD_FAILED]: 'upload_failed' })[exit] || null;
}

export function customPeriod(start, end) {
  if (!isYmd(start) || !isYmd(end) || start > end) throw new Error('Custom period needs --start YYYY-MM-DD --end YYYY-MM-DD with start ≤ end.');
  if (daysBetween(start, end) > 366) throw new Error('Custom period is longer than a year.');
  return { kind: 'custom', start, end, comparison: previousPeriod(start, end) };
}

// ---- the report query ----
// Same query as the saved report configured as `reportId` (a copy of
// "Total sales by product" grouped by product id and sales channel), with
// explicit dates and the previous
// period. Loaded through the report URL; the saved report itself is never
// changed (the collector never clicks Save).
export function buildQuery(period) {
  if (!isYmd(period.start) || !isYmd(period.end)) throw new Error('Bad period.');
  return [
    'FROM sales',
    'SHOW net_items_sold, gross_sales, discounts, sales_reversals, net_sales, taxes, total_sales',
    'WHERE product_title IS NOT NULL',
    'GROUP BY product_id, product_title, product_vendor, product_type, sales_channel',
    'WITH TOTALS',
    `SINCE ${period.start} UNTIL ${period.end}`,
    'COMPARE TO previous_period',
    'ORDER BY total_sales DESC',
    'LIMIT 1000'
  ].join('\n');
}
export function reportUrl(cfg, period) {
  const admin = new URL(cfg.adminUrl);
  if (admin.origin !== 'https://admin.shopify.com') throw new Error('adminUrl must be on https://admin.shopify.com');
  if (!/^\d+$/.test(String(cfg.reportId))) throw new Error('reportId must be numeric.');
  return `${admin.origin}${admin.pathname.replace(/\/$/, '')}/analytics/reports/${cfg.reportId}?ql=${encodeURIComponent(buildQuery(period))}`;
}

// ---- CSV ----
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

// ---- validation ----
const CUSTOMER_RE = /(customer|buyer|e-?mail|phone|address|ship(ping)?[ _-]?(city|state|postal|zip|name)|postal|zip|billing|recipient)/i;

// Turns a downloaded export into an ingest payload, or explains why not.
// `pageTotals` (optional) are the Summary figures read off the report page;
// when present the file must agree with them.
export function validateExport(text, period, opts = {}) {
  const problems = [];
  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, problems: ['The export has no data rows.'] };
  const header = rows[0];
  const leaked = header.filter(h => CUSTOMER_RE.test(h));
  if (leaked.length) return { ok: false, problems: ['The export carries customer-looking columns (' + leaked.join(', ') + '); refused.'] };

  const res = SR.parseShopifyProductReport(rows, {});
  if (!res.ok) return { ok: false, problems: res.errors };
  if (!res.capabilities.hasProductId) problems.push('No Product ID column: the saved report must group by product_id.');
  if (!res.capabilities.hasSalesChannel) problems.push('No Sales channel column: the saved report must group by sales_channel.');
  if (!res.capabilities.hasPrior) problems.push('No previous-period columns.');
  const t = res.totals.current;
  if (opts.pageTotals) {
    const pt = opts.pageTotals;
    if (pt.units != null && Math.round(pt.units) !== Math.round(t.units)) problems.push(`File has ${t.units} units; the report page shows ${pt.units}.`);
    if (pt.net != null && Math.abs(pt.net - t.net) > 0.01) problems.push(`File has ${t.net.toFixed(2)} net sales; the report page shows ${pt.net.toFixed(2)}.`);
  }
  if (problems.length) return { ok: false, problems, parsed: res };

  const rowsOut = res.records.map(r => ({
    productId: r.productId || null, title: r.title, vendor: r.vendor,
    productType: r.ptypeBlank ? '' : r.ptype, salesChannel: r.salesChannel || null,
    cur: r.cur, prior: r.priorKnown ? r.prior : null
  }));
  // Included / excluded split (rows left out of rankings, e.g. shipping
  // protection), using the dashboard's own exclusion rules.
  const split = PG.splitExclusions(res.records.map(r => Object.assign({}, r)), PG.DEFAULT_EXCLUSIONS);
  const sumT = (list) => {
    const o = {}; ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total'].forEach(k => {
      const v = list.reduce((a, r) => a + (r.cur[k] || 0), 0);
      o[k] = k === 'units' ? Math.round(v) : Math.round((v + Number.EPSILON) * 100) / 100;
    });
    return o;
  };
  const payload = {
    source: 'shopify',
    reportScope: REPORT_SCOPE,
    period: { start: period.start, end: period.end },
    comparison: Object.assign({}, period.comparison || previousPeriod(period.start, period.end), { source: 'Shopify previous_period' }),
    timezone: opts.timeZone || STORE_TZ,
    currency: opts.currency || 'USD',
    sourceFilename: `Total sales by product + ID - ${period.start} - ${period.end}.csv`,
    client: opts.client || 'sb-plant-breakdown collector',
    importedBy: 'collector',
    sourceCapabilities: {},
    collectedAt: opts.collectedAt || new Date().toISOString(),
    includedTotals: sumT(split.included),
    excludedTotals: sumT(split.excluded),
    exclusionLabels: [...new Set(split.excluded.map(r => r.exclusionLabel))],
    totals: t,
    rows: rowsOut
  };
  return {
    ok: true, payload, warnings: res.warnings,
    facts: { rows: res.rowCount, products: new Set(res.records.map(r => r.productKey)).size,
             units: t.units, net: t.net, priorNet: res.totals.prior.net,
             ownNet: res.channelTotals.own.net, amazonNet: res.channelTotals.amazon.net,
             amazonUnits: res.channelTotals.amazon.units,
             channels: res.channelTotals.channels.map(c => c.channel) }
  };
}

// Reads "1,234 / 1,111" style Summary cells: the first number is the current period.
export function parseSummaryNumber(cell) {
  if (cell == null) return null;
  // The cell's text is "1,234\n1,111" (current, then previous, on two
  // lines); some renderings join them as "1,234 / 1,111".
  const first = String(cell).trim().split(/\s*\/\s*|\n+/)[0].replace(/[‑−]/g, '-').replace(/[$,\s]/g, '');
  const n = Number(first);
  return Number.isFinite(n) && first !== '' ? n : null;
}

// ---- config ----
export function validateConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['Config is not an object.'];
  try { if (new URL(cfg.adminUrl).origin !== 'https://admin.shopify.com') errs.push('adminUrl must be https://admin.shopify.com/store/<handle>.'); }
  catch { errs.push('adminUrl is missing or not a URL.'); }
  if (!/^\d+$/.test(String(cfg.reportId || ''))) errs.push('reportId must be the numeric id of the saved report.');
  if (cfg.workerUrl) {
    try {
      const u = new URL(cfg.workerUrl);
      const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
      if (u.protocol !== 'https:' && !local) errs.push('workerUrl must be https (http is allowed only for 127.0.0.1 / localhost testing).');
    } catch { errs.push('workerUrl is not a URL.'); }
  }
  if (cfg.browserChannel != null && !['chrome', 'msedge'].includes(cfg.browserChannel)) errs.push('browserChannel must be null, "chrome" or "msedge".');
  const w = cfg.signInWaitMinutes;
  if (w != null && !(Number.isInteger(w) && w >= 0 && w <= 120)) errs.push('signInWaitMinutes must be 0–120.');
  const P = cfg.periods || {};
  if (P.closedMonths != null) {
    const c = P.closedMonths;
    if (!Number.isInteger(c.lookback) || c.lookback < 0 || c.lookback > 12) errs.push('periods.closedMonths.lookback must be 0–12.');
    if (!Array.isArray(c.onDays) || c.onDays.some(d => !Number.isInteger(d) || d < 1 || d > 28)) errs.push('periods.closedMonths.onDays must be days 1–28.');
  }
  if (P.backfill != null) {
    if (!/^\d{4}-\d{2}$/.test(String(P.backfill.earliest || ''))) errs.push('periods.backfill.earliest must be YYYY-MM.');
    const n = P.backfill.maxPerRun;
    if (n != null && !(Number.isInteger(n) && n >= 0 && n <= 6)) errs.push('periods.backfill.maxPerRun must be 0–6.');
  }
  for (const k of Object.keys(cfg)) {
    if (/secret|password|token|apikey|api_key/i.test(k) && !/CredentialTarget$/.test(k)) errs.push(`Config key "${k}" looks like a secret. Secrets belong in Windows Credential Manager, not the config file.`);
  }
  return errs;
}

export function runId(now = new Date()) { return 'pbx_' + now.toISOString().replace(/[:.]/g, '-'); }
