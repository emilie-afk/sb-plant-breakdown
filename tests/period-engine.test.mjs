// Months, quarters and years from monthly reports (period-engine.js).
// All data here is SYNTHETIC: invented products and figures built by the
// helpers below, with expected values computed independently from the same
// inputs, never by the code under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, r2 } from './load.mjs';

const require = createRequire(import.meta.url);
const PE = require(path.join(ROOT, 'period-engine.js'));
const SR = require(path.join(ROOT, 'shopify-report.js'));

const MEAS = ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total'];
const lastDay = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate();

// A deterministic product line-up: product p sells (p+1)*(month+1) units at
// (10+p) each, in two channels. Product 5 only sells in even months, and
// product 6 only in the third month of each quarter.
function monthRecords(key, { scale = 1, products = 7 } = {}) {
  const m = +key.slice(5, 7);
  const out = [];
  for (let p = 0; p < products; p++) {
    if (p === 5 && m % 2) continue;
    if (p === 6 && m % 3) continue;
    for (const ch of ['Online Store', 'Sellbrite']) {
      const units = (p + 1) * m * (ch === 'Sellbrite' ? 1 : 2) * scale;
      const gross = r2(units * (10 + p)), disc = r2(-units * 0.5), ret = p === 3 ? -5 : 0;
      const net = r2(gross + disc + ret), tax = r2(net * 0.08);
      out.push({
        title: 'Plant ' + p, vendor: 'Vendor ' + (p % 3), ptype: 'Succulent', productId: String(1000 + p),
        productKey: 'pid:' + (1000 + p), salesChannel: ch, channelGroup: ch === 'Sellbrite' ? 'amazon' : 'own',
        cur: { units, gross, disc, ret, net, tax, total: r2(net + tax), glance: 0, inv: 100 * m + p },
        prior: { units: 999, gross: 999, disc: 0, ret: 0, net: 999, tax: 0, total: 999 }, priorKnown: true
      });
    }
  }
  return out;
}
function report(key, { start, end, revision = 1, status = 'active', completeness, scope = 'total_sales_by_product', source = 'shopify' } = {}) {
  start = start || key + '-01';
  end = end || key + '-' + String(lastDay(key)).padStart(2, '0');
  return { id: `${source}:${scope}:${start}:${end}:r${revision}`, source, report_scope: scope, period_start: start, period_end: end,
           revision, status, completeness: completeness || 'complete' };
}
function sumOf(recordsList) {
  const t = Object.fromEntries(MEAS.map(k => [k, 0]));
  recordsList.flat().forEach(r => MEAS.forEach(k => { t[k] += r.cur[k]; }));
  MEAS.forEach(k => { t[k] = k === 'units' ? Math.round(t[k]) : r2(t[k]); });
  return t;
}
const months = (y, from, n) => Array.from({ length: n }, (_, i) => `${y}-${String(from + i).padStart(2, '0')}`);
function build(reports, recordsById, kind, year, index, today, mode) {
  const auth = PE.periodAuthoritativeMonths(reports);
  const plan = PE.periodPlan(kind, year, index, auth, { today });
  const parts = plan.revisionsUsed.map(u => ({ end: u.end, records: recordsById[u.reportId] }));
  let recs = PE.periodAggregate(parts);
  let cmp = null;
  if (mode) {
    cmp = PE.periodComparison(plan, mode, auth, reports);
    if (cmp.available) recs = PE.periodAttachComparison(recs, PE.periodAggregate(cmp.parts.map(x => ({ end: x.end, records: recordsById[x.report.id] }))));
  }
  return { auth, plan, recs, cmp };
}

test('three monthly reports produce the correct quarter', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { plan, recs } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  assert.equal(plan.status, 'complete');
  assert.equal(plan.label, 'Q3 2025 (complete)');
  assert.deepEqual(plan.revisionsUsed.map(u => u.month), ['2025-07', '2025-08', '2025-09']);
  assert.deepEqual(PE.periodTotals(recs).net, sumOf(Object.values(data)).net);
  for (const k of MEAS) assert.equal(PE.periodTotals(recs)[k], sumOf(Object.values(data))[k], k);
  // one record per product per channel, never one per month
  assert.equal(recs.length, 7 * 2);
});

test('twelve monthly reports produce the correct year', () => {
  const reps = [], data = {};
  for (const k of months(2025, 1, 12)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { plan, recs } = build(reps, data, 'year', 2025, null, '2026-10-16');
  assert.equal(plan.status, 'complete');
  assert.equal(plan.revisionsUsed.length, 12);
  const want = sumOf(Object.values(data));
  for (const k of MEAS) assert.equal(PE.periodTotals(recs)[k], want[k], k);
  // Q1 + Q2 + Q3 + Q4 = the year (all built from the same months, so nothing is counted twice)
  const q = [1, 2, 3, 4].map(i => PE.periodTotals(build(reps, data, 'quarter', 2025, i, '2026-10-16').recs).net);
  assert.equal(r2(q.reduce((a, b) => a + b, 0)), want.net);
});

test('a revised month updates the quarter and year without double counting', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const before = PE.periodTotals(build(reps, data, 'quarter', 2025, 3, '2026-10-16').recs);
  // August is re-collected with corrections: revision 2 becomes active and
  // revision 1 is kept as superseded history.
  const aug1 = reps.find(r => r.period_start === '2025-08-01');
  aug1.status = 'superseded';
  const aug2 = report('2025-08', { revision: 2 }); reps.push(aug2);
  data[aug2.id] = monthRecords('2025-08', { scale: 2 });
  const { plan, recs } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  const after = PE.periodTotals(recs);
  assert.equal(plan.revisionsUsed.find(u => u.month === '2025-08').revision, 2, 'the revision used is recorded');
  const delta = r2(sumOf([data[aug2.id]]).net - sumOf([data[aug1.id]]).net);
  assert.equal(after.net, r2(before.net + delta), 'quarter moves by exactly the revision change');
  assert.notEqual(after.net, r2(before.net + sumOf([data[aug2.id]]).net), 'the old revision is not still counted');
  // Even if a caller passes both revisions as active by mistake, only one represents the month.
  aug1.status = 'active';
  const auth = PE.periodAuthoritativeMonths(reps);
  assert.equal(auth.months['2025-08'].report.revision, 2);
  assert.ok(auth.ignored.some(i => i.report === aug1));
});

test('missing months produce a partial report, never zero-filled', () => {
  const reps = [], data = {};
  for (const k of ['2025-01', '2025-03']) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { plan, recs } = build(reps, data, 'quarter', 2025, 1, '2026-10-16');
  assert.equal(plan.status, 'incomplete');
  assert.equal(plan.partial, true);
  assert.deepEqual(plan.missing, ['2025-02']);
  assert.match(plan.label, /partial: no report for Feb 2025/);
  assert.equal(PE.periodTotals(recs).net, sumOf(Object.values(data)).net);
  // The year with only two months is partial too, naming all ten missing months.
  const y = build(reps, data, 'year', 2025, null, '2026-10-16').plan;
  assert.equal(y.missing.length, 10);
});

test('a running quarter is quarter-to-date with its real coverage dates', () => {
  const reps = [report('2026-10', { end: '2026-10-15', completeness: 'partial' })];
  const data = { [reps[0].id]: monthRecords('2026-10') };
  const { plan } = build(reps, data, 'quarter', 2026, 4, '2026-10-16');
  assert.equal(plan.status, 'to_date');
  assert.equal(plan.label, 'Q4 2026 — quarter to date (partial) · Oct 1 – 15, 2026');
  assert.deepEqual(plan.parts.map(p => p.status), ['partial', 'future', 'future']);
  const m = build(reps, data, 'month', 2026, 10, '2026-10-16').plan;
  assert.equal(m.label, 'Oct 2026 — month to date (partial) · Oct 1 – 15, 2026');
  const reps2 = reps.concat(months(2026, 1, 9).map(k => report(k)));
  const y = build(reps2, Object.fromEntries(reps2.map(r => [r.id, monthRecords(r.period_start.slice(0, 7))])), 'year', 2026, null, '2026-10-16').plan;
  assert.equal(y.label, '2026 — year to date (partial) · Jan 1 – Oct 15, 2026');
});

test('overlapping reports are never summed', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const q3 = report('2025-07', { end: '2025-09-30' });            // a stored quarter report
  const sepMtd = report('2025-09', { end: '2025-09-15' });        // an old month-to-date copy
  reps.push(q3, sepMtd);
  data[q3.id] = monthRecords('2025-07', { scale: 5 });
  data[sepMtd.id] = monthRecords('2025-09', { scale: 3 });
  const { auth, recs, plan } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  const monthsOnly = sumOf([data[reps[0].id], data[reps[1].id], data[reps[2].id]]);
  assert.equal(PE.periodTotals(recs).net, monthsOnly.net);
  assert.ok(!plan.revisionsUsed.some(u => u.reportId === q3.id || u.reportId === sepMtd.id));
  assert.equal(auth.ignored.length, 2);
  assert.match(auth.ignored.find(i => i.report === q3).reason, /never combined/);
  assert.match(auth.ignored.find(i => i.report === sepMtd).reason, /never summed/);
});

test('embedded previous-period columns are never summed into a quarter', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { recs, cmp } = build(reps, data, 'quarter', 2025, 3, '2026-10-16', 'previous');
  assert.equal(cmp.available, false, 'Q2 2025 is not stored, so there is no comparison');
  assert.ok(recs.every(r => r.priorKnown === false && r.prior.net === 0), 'the 999 embedded priors are dropped');
});

test('comparisons use the equivalent stored period, and percentages follow the totals', () => {
  const reps = [], data = {};
  for (const k of months(2025, 4, 6)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  for (const k of months(2024, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k, { scale: 0.5 }); }
  const prev = build(reps, data, 'quarter', 2025, 3, '2026-10-16', 'previous');
  assert.equal(prev.cmp.available, true);
  assert.equal(prev.cmp.start, '2025-04-01'); assert.equal(prev.cmp.end, '2025-06-30');
  const curT = sumOf(months(2025, 7, 3).map(k => data[reps.find(r => r.period_start === k + '-01').id]));
  const priorT = sumOf(months(2025, 4, 3).map(k => data[reps.find(r => r.period_start === k + '-01').id]));
  const prSum = r2(prev.recs.reduce((s, r) => s + r.prior.net, 0));
  assert.equal(prSum, priorT.net);
  // Percentage change from the combined totals, not an average of monthly changes.
  const ch = SR.shopifyChange(curT.net, priorT.net, true);
  assert.equal(ch.pct, r2((curT.net - priorT.net) / Math.abs(priorT.net) * 100));
  const yoy = build(reps, data, 'quarter', 2025, 3, '2026-10-16', 'yoy');
  assert.equal(yoy.cmp.available, true);
  assert.equal(yoy.cmp.start, '2024-07-01');
  // A partial month needs a counterpart with exactly the same days.
  const mtd = report('2025-10', { end: '2025-10-12', completeness: 'partial' });
  reps.push(mtd); data[mtd.id] = monthRecords('2025-10');
  const q4 = build(reps, data, 'quarter', 2025, 4, '2025-10-13', 'previous');
  assert.equal(q4.cmp.available, false);
  assert.match(q4.cmp.reason, /Jul 1 – 12, 2025/);
  const jul = report('2025-07', { end: '2025-07-12', scope: 'total_sales_by_product' });
  reps.push(jul); data[jul.id] = monthRecords('2025-07', { scale: 0.25 });
  const q4b = build(reps, data, 'quarter', 2025, 4, '2025-10-13', 'previous');
  assert.equal(q4b.cmp.available, true);
  assert.equal(q4b.cmp.end, '2025-07-12');
});

test('distinct products are counted across the period, not added up per month', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const monthlyCounts = Object.values(data).map(rs => new Set(rs.map(r => r.productId)).size);
  assert.deepEqual(monthlyCounts, [5, 6, 6]);
  const { recs } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  assert.equal(PE.periodDistinctProducts(recs), 7);
  assert.notEqual(PE.periodDistinctProducts(recs), monthlyCounts.reduce((a, b) => a + b, 0));
});

test('average per unit and conversion are recalculated from combined totals', () => {
  const mk = (units, net, glance) => ({ productKey: 'pid:1', title: 'A', vendor: 'V', ptype: 'T',
    cur: { units, gross: net, disc: 0, ret: 0, net, tax: 0, total: net, glance, inv: 0 } });
  const recs = PE.periodAggregate([{ end: '2025-01-31', records: [mk(10, 100, 100)] }, { end: '2025-02-28', records: [mk(90, 450, 300)] }]);
  // Monthly: $10.00/unit and $5.00/unit, 10% and 30% conversion.
  assert.equal(recs[0].avg, r2(550 / 100), 'combined $5.50 per unit, not the $7.50 average of averages');
  assert.equal(recs[0].conv, 100 / 400, '25% from combined units ÷ glance views, not 20%');
  const t = PE.periodTotals(recs);
  assert.equal(t.avgPerUnit, 5.5); assert.equal(t.conversion, 0.25);
  // Amazon-shaped records follow the same rule.
  const az = PE.periodAggregate([
    { end: '2025-01-31', records: [{ asin: 'B000000001', title: 'X', units: 10, rev: 100, glance: 100, inv: 40 }] },
    { end: '2025-02-28', records: [{ asin: 'B000000001', title: 'X', units: 90, rev: 450, glance: 300, inv: 25 }] }]);
  assert.equal(az[0].conv, 0.25); assert.equal(az[0].avg, 5.5);
  assert.equal(az[0].inv, 25, 'inventory is the latest snapshot, never 65');
});

test('inventory is point-in-time: the latest month, with its date', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { recs, plan } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  const p0 = recs.find(r => r.productId === '1000' && r.salesChannel === 'Online Store');
  assert.equal(p0.cur.inv, 900, 'September inventory (100 × 9 + 0), not the sum of three months');
  assert.equal(p0.invAsOf, '2025-09-30');
  // Product 5 sells only in even months, so it is absent from September: no
  // current inventory figure, rather than August's stale one.
  const p5 = recs.find(r => r.productId === '1005' && r.salesChannel === 'Online Store');
  assert.equal(p5.cur.inv, 0); assert.equal(p5.invKnown, false);
  const snap = PE.periodBuildSnapshot('shopify', plan, null, recs, {});
  assert.equal(snap.meta.inventoryAsOf, '2025-09-30');
});

test('channel filters still split the combined period exactly', () => {
  const PG = require(path.join(ROOT, 'product-grouping.js'));
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k); reps.push(r); data[r.id] = monthRecords(k); }
  const { recs } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  const own = PG.filterChannel(recs, 'own'), amz = PG.filterChannel(recs, 'amazon'), all = PG.filterChannel(recs, 'all');
  const net = (rs) => r2(rs.reduce((s, r) => s + r.cur.net, 0));
  assert.equal(r2(net(own) + net(amz)), net(all));
  const wantAmz = sumOf(Object.values(data).map(rs => rs.filter(r => r.salesChannel === 'Sellbrite'))).net;
  assert.equal(net(amz), wantAmz);
  assert.equal(all.length, 7, 'merged across channels: one row per product');
});

test('availability lists the earliest history and the gaps', () => {
  const reps = ['2025-11', '2026-01', '2026-02'].map(k => report(k));
  reps.push(report('2026-03', { end: '2026-03-10', completeness: 'partial' }));
  const av = PE.periodAvailability(PE.periodAuthoritativeMonths(reps), { today: '2026-03-11' });
  assert.equal(av.earliest, '2025-11');
  assert.deepEqual(av.gaps, ['2025-12']);
  assert.deepEqual(av.quarters.map(q => q.name), ['Q4 2025', 'Q1 2026']);
  assert.deepEqual(av.years.map(y => y.name), ['2025', '2026']);
  assert.deepEqual(PE.periodDefaultSelection(PE.periodAuthoritativeMonths(reps)), { kind: 'month', year: 2026, index: 3 });
});

test('the combined snapshot records which monthly revisions it used', () => {
  const reps = [], data = {};
  for (const k of months(2025, 7, 3)) { const r = report(k, { revision: k === '2025-08' ? 3 : 1 }); reps.push(r); data[r.id] = monthRecords(k); }
  const { plan, recs } = build(reps, data, 'quarter', 2025, 3, '2026-10-16');
  const snap = PE.periodBuildSnapshot('shopify', plan, null, recs, { capabilities: { hasProductId: true, hasSalesChannel: true } });
  assert.equal(snap.meta.ephemeral, true);
  assert.deepEqual(snap.meta.period.revisionsUsed.map(u => u.revision), [1, 3, 1]);
  assert.equal(snap.meta.capabilities.hasPrior, false);
  assert.equal(snap.meta.distinctProducts, 7);
  assert.equal(snap.startDate, '2025-07-01'); assert.equal(snap.endDate, '2025-09-30');
});
