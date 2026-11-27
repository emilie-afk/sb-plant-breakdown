// External Stores period picker (market-period.js). SYNTHETIC reports only:
// the dates mirror the shapes the collector saves (weeks, months, month-to-date
// copies); the stores, products and figures are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const MP = require(path.join(ROOT, 'market-period.js'));

const TODAY = '2026-11-26';
let n = 0;
function rep(start, end, net, units, extra = {}) {
  n++;
  return Object.assign({ id: `market:shipstation_product_sales:${start}:${end}:r1`, source: 'market', report_scope: 'shipstation_product_sales',
    status: 'active', period_start: start, period_end: end, revision: 1, row_count: 10 + n,
    collected_at: `2026-11-2${n % 6}T0${n % 9}:00:00.000Z`, completeness: 'complete',
    totals: { units, net: net - 50 }, includedTotals: { units, net } }, extra);
}
const JUL = rep('2026-07-01', '2026-07-31', 1000, 100);
const AUG = rep('2026-08-01', '2026-08-31', 2000, 200);
const SEP = rep('2026-09-01', '2026-09-30', 3000, 300);
const SEP_WEEK = rep('2026-09-05', '2026-09-11', 700, 70);          // inside September: never added to it
const OCT15 = rep('2026-10-01', '2026-10-15', 400, 40, { completeness: 'partial' });
const OCT18 = rep('2026-10-01', '2026-10-18', 500, 50, { completeness: 'partial' });
const NOV_W1 = rep('2026-11-07', '2026-11-13', 900, 90);
const NOV_W2 = rep('2026-11-14', '2026-11-20', 800, 80);
const SHOPIFY_ROW = { id: 'shopify:x', source: 'shopify', report_scope: 'total_sales_by_product', status: 'active', period_start: '2026-11-14', period_end: '2026-11-20' };
const ALL = [JUL, AUG, SEP, SEP_WEEK, OCT15, OCT18, NOV_W1, NOV_W2, SHOPIFY_ROW];

test('weeks run Saturday to Friday in the store calendar', () => {
  assert.deepEqual(MP.marketWeekOf('2026-11-26'), { start: '2026-11-21', end: '2026-11-27' });   // a Thursday
  assert.deepEqual(MP.marketWeekOf('2026-11-07'), { start: '2026-11-07', end: '2026-11-13' });   // a Saturday
  assert.deepEqual(MP.marketWeekOf('2026-11-13'), { start: '2026-11-07', end: '2026-11-13' });   // a Friday
  assert.equal(MP.marketReportKind('2026-11-14', '2026-11-20'), 'week');
  assert.equal(MP.marketReportKind('2026-11-15', '2026-11-21'), 'custom', 'Sunday–Saturday is not a week here');
  assert.equal(MP.marketReportKind('2026-10-01', '2026-10-18'), 'month_to_date');
  assert.equal(MP.marketReportKind('2026-09-01', '2026-09-30'), 'full_month');
});

test('weekly selection shows exactly the saved week, with its dates and collection time', () => {
  const p = MP.marketPlan({ kind: 'week', start: '2026-11-14' }, ALL, { today: TODAY });
  assert.equal(p.status, 'exact');
  assert.deepEqual(p.used.map(u => [u.start, u.end]), [['2026-11-14', '2026-11-20']]);
  assert.deepEqual(p.reported, { units: 80, net: 800 });
  assert.equal(p.collectedAt, NOV_W2.collected_at);
  // any day of the week selects the same Saturday–Friday week
  assert.equal(MP.marketPlan({ kind: 'week', start: '2026-11-18' }, ALL, { today: TODAY }).sig, NOV_W2.id);
  const weeks = MP.marketWeekOptions(ALL, { today: TODAY, recent: 4 });
  assert.equal(weeks[0].start, '2026-11-14', 'the last finished week comes first (Nov 21–27 is still running)');
  assert.ok(weeks.find(w => w.start === '2026-11-07').report, 'saved weeks are offered directly');
  assert.ok(weeks.find(w => w.start === '2026-09-05').report, 'older saved weeks are offered too');
  assert.match(weeks.find(w => w.start === '2026-10-31').label, /no report/);
});

test('the latest saved market report is the default', () => {
  assert.deepEqual(MP.marketDefaultSelection(ALL), { kind: 'saved', reportId: NOV_W2.id });
  const c = MP.marketCatalog(ALL);
  assert.ok(c.every(e => e.id.startsWith('market:')), 'Shopify reports are never in the market catalog');
  assert.deepEqual(c.slice(0, 2).map(e => e.start), ['2026-11-14', '2026-11-07']);
  assert.equal(MP.marketDefaultSelection([]), null);
});

test('market and Shopify selections are independent; Match Shopify follows the Shopify period', () => {
  const shopifyJuly = { start: '2026-07-01', end: '2026-07-31', period: { kind: 'month', year: 2026, index: 7, name: 'Jul 2026',
    revisionsUsed: [{ start: '2026-07-01', end: '2026-07-31' }] } };
  const own = MP.marketPlan({ kind: 'week', start: '2026-11-07' }, ALL, { today: TODAY, shopify: shopifyJuly });
  assert.equal(own.sig, NOV_W1.id, 'a market week stays a market week whatever Shopify shows');
  const m = MP.marketPlan({ kind: 'match' }, ALL, { today: TODAY, shopify: shopifyJuly });
  assert.equal(m.sig, JUL.id);
  assert.match(m.label, /matches the Shopify period/);
  const single = MP.marketPlan({ kind: 'match' }, ALL, { today: TODAY, shopify: { start: '2026-11-14', end: '2026-11-20' } });
  assert.equal(single.sig, NOV_W2.id, 'a single Shopify report matches a market report with the same dates');
});

test('no exact match: says what is missing and offers the saved reports, never a prorated figure', () => {
  const p = MP.marketPlan({ kind: 'match' }, ALL, { today: TODAY, shopify: { start: '2026-11-01', end: '2026-11-24' } });
  assert.equal(p.status, 'missing');
  assert.equal(p.used.length, 0);
  assert.equal(p.reported, null, 'missing is not zero');
  assert.match(p.reason, /exactly Nov 1 – 24, 2026/);
  assert.match(p.reason, /never cut down or prorated/);
  assert.deepEqual(p.missing, [{ start: '2026-11-01', end: '2026-11-24' }]);
  assert.deepEqual(p.alternatives.slice(0, 2).map(a => a.start), ['2026-11-14', '2026-11-07'], 'overlapping reports first, newest first');
  const w = MP.marketPlan({ kind: 'week', start: '2026-10-31' }, ALL, { today: TODAY });
  assert.equal(w.status, 'missing');
  assert.ok(w.alternatives.length);
  // a combined Shopify month whose dates differ from the market month
  const q = MP.marketPlan({ kind: 'match' }, ALL, { today: TODAY, shopify: { start: '2026-10-01', end: '2026-10-24',
    period: { kind: 'month', year: 2026, index: 10, name: 'Oct 2026', revisionsUsed: [{ start: '2026-10-01', end: '2026-10-24' }] } } });
  assert.equal(q.status, 'missing');
  assert.match(q.reason, /Oct 1 – 24, 2026/);
});

test('overlapping reports are never added: weeks stay out of months, older month-to-date copies are dropped', () => {
  const oct = MP.marketPlan({ kind: 'month', year: 2026, index: 10 }, ALL, { today: TODAY });
  assert.deepEqual(oct.used.map(u => u.end), ['2026-10-18'], 'only the newest month-to-date copy');
  assert.equal(oct.reported.net, 500);
  assert.ok(oct.excluded.some(x => x.end === '2026-10-15' && /never added/.test(x.reason)));
  assert.equal(oct.status, 'incomplete');
  assert.match(oct.label, /covers only Oct 1 – 18, 2026/);
  const sep = MP.marketPlan({ kind: 'month', year: 2026, index: 9 }, ALL, { today: TODAY });
  assert.equal(sep.reported.net, 3000, 'the September week is not added to September');
  assert.ok(sep.excluded.some(x => x.kind === 'week' && /never added to monthly figures/.test(x.reason)));
  const q3 = MP.marketPlan({ kind: 'quarter', year: 2026, index: 3 }, ALL, { today: TODAY });
  assert.equal(q3.status, 'complete');
  assert.deepEqual(q3.reported, { units: 600, net: 6000 });
  // weekly figures are never summed into a month that has no report
  const nov = MP.marketPlan({ kind: 'month', year: 2026, index: 11 }, ALL, { today: TODAY });
  assert.equal(nov.status, 'missing');
  assert.equal(nov.reported, null);
  assert.equal(nov.excluded.filter(x => x.kind === 'week').length, 2);
  assert.deepEqual(nov.alternatives.slice(0, 2).map(a => a.start).sort(), ['2026-11-07', '2026-11-14']);
});

test('incomplete coverage is labelled and only complete months are combined', () => {
  const noAug = ALL.filter(r => r !== AUG);
  const q3 = MP.marketPlan({ kind: 'quarter', year: 2026, index: 3 }, noAug, { today: TODAY });
  assert.equal(q3.status, 'incomplete');
  assert.match(q3.label, /no complete market report for Aug 2026/);
  assert.deepEqual(q3.missing, [{ start: '2026-08-01', end: '2026-08-31' }]);
  assert.deepEqual(q3.reported, { units: 400, net: 4000 }, 'July + September only; August is not estimated');
  // a past short month is left out of a quarter or year and named
  const q4 = MP.marketPlan({ kind: 'quarter', year: 2026, index: 4 }, ALL, { today: TODAY });
  assert.equal(q4.status, 'missing');
  assert.ok(q4.excluded.some(x => x.end === '2026-10-18' && /not the whole month/.test(x.reason)));
  const y = MP.marketPlan({ kind: 'year', year: 2026 }, ALL, { today: TODAY });
  assert.equal(y.status, 'incomplete');
  assert.deepEqual(y.used.map(u => u.start), ['2026-07-01', '2026-08-01', '2026-09-01']);
  assert.match(y.label, /Oct 2026/);
  assert.equal(y.reported.net, 6000);
  // the running month's month-to-date report counts towards a running quarter, labelled
  const NOV_MTD = rep('2026-11-01', '2026-11-25', 1500, 150, { completeness: 'partial' });
  const OCT_FULL = rep('2026-10-01', '2026-10-31', 1200, 120);
  const q4b = MP.marketPlan({ kind: 'quarter', year: 2026, index: 4 }, [OCT_FULL, NOV_MTD, NOV_W1, NOV_W2], { today: TODAY });
  assert.equal(q4b.status, 'to_date');
  assert.match(q4b.label, /quarter to date \(partial\)/);
  assert.equal(q4b.reported.net, 2700, 'Oct + Nov 1–25, never the Nov weeks on top');
});

test('a reported zero is not missing data', () => {
  const ZERO = rep('2026-10-24', '2026-10-30', 0, 0);                 // a week whose report holds only adjustments
  const p = MP.marketPlan({ kind: 'week', start: '2026-10-24' }, ALL.concat([ZERO]), { today: TODAY });
  assert.equal(p.status, 'exact');
  assert.equal(p.zeroSales, true);
  assert.deepEqual(p.reported, { units: 0, net: 0 });
  const missing = MP.marketPlan({ kind: 'week', start: '2026-10-17' }, ALL.concat([ZERO]), { today: TODAY });
  assert.equal(missing.zeroSales, false);
  assert.equal(missing.reported, null);
  // $0 product lines stay $0, and ShipStation has no order count (null, not 0)
  const prods = [
    { rawStore: 'Nursery Alpha (Web)', store: 'Nursery Alpha', sku: 'A1', title: 'Echeveria Sample', units: 3, estRev: 0 },
    { rawStore: 'Shop Beta', store: 'Shop Beta', sku: 'B1', title: 'Sedum Sample', units: 2, estRev: 18.5 }
  ];
  const stores = MP.marketStoreTotals(prods, true);
  const alpha = stores.find(s => s.store === 'Nursery Alpha');
  assert.equal(alpha.rev, 0);
  assert.equal(alpha.units, 3);
  assert.equal(alpha.orders, null);
  assert.equal(stores[0].store, 'Shop Beta');
});

test('combining reports adds the same product once per report, keeping $0 lines', () => {
  const a = [{ rawStore: 'S1', store: 'S1', sku: 'X', title: 'Plant X', units: 2, qty: 2, estRev: 10 },
             { rawStore: 'S1', store: 'S1', sku: 'Z', title: 'Plant Z', units: 1, qty: 1, estRev: 0 }];
  const b = [{ rawStore: 'S1', store: 'S1', sku: 'X', title: 'Plant X (renamed)', units: 3, qty: 3, estRev: 15.25 }];
  const m = MP.marketMergeProducts([a, b]);
  assert.equal(m.length, 2);
  assert.deepEqual([m[0].units, m[0].estRev, m[0].title], [5, 25.25, 'Plant X (renamed)']);
  assert.equal(m[1].estRev, 0);
});

test('a failed collection stays visible until the same dates are collected', () => {
  const runs = [
    { source: 'market', outcome: 'failed', started_at: '2026-11-25T05:02:00Z', period_start: '2026-11-01', period_end: '2026-11-23', error_code: 'other' },
    { source: 'market', outcome: 'failed', started_at: '2026-11-25T09:12:00Z', period_start: '2026-11-01', period_end: '2026-11-24', error_code: 'export_failed' },
    { source: 'market', outcome: 'failed', started_at: '2026-11-25T09:13:00Z', period_start: '2026-10-01', period_end: '2026-10-31', error_code: 'unknown_page' },
    { source: 'market', outcome: 'failed', started_at: '2026-11-25T09:15:00Z', period_start: '2026-11-14', period_end: '2026-11-20', error_code: 'unknown_page' },
    { source: 'market', outcome: 'succeeded', started_at: '2026-11-26T07:05:00Z', period_start: '2026-11-14', period_end: '2026-11-20' },
    { source: 'market', outcome: 'succeeded', started_at: '2026-11-26T07:06:00Z', period_start: '2026-11-07', period_end: '2026-11-13' },
    { source: 'shopify', outcome: 'failed', started_at: '2026-11-26T08:00:00Z', period_start: '2026-11-01', period_end: '2026-11-25' }
  ];
  const f = MP.marketOutstandingFailures(runs);
  assert.deepEqual(f.map(x => [x.start, x.end, x.code]), [['2026-10-01', '2026-10-31', 'unknown_page'], ['2026-11-01', '2026-11-24', 'export_failed']],
    'later successes for other dates do not hide them; the retried week is resolved');
  const fixed = runs.concat([{ source: 'market', outcome: 'succeeded', started_at: '2026-11-26T09:00:00Z', period_start: '2026-11-01', period_end: '2026-11-25' }]);
  assert.deepEqual(MP.marketOutstandingFailures(fixed).map(x => x.start), ['2026-10-01']);
});

test('cross-channel comparisons need matching dates', () => {
  assert.equal(MP.marketSameDates([{ source: 'shopify', start: '2026-11-14', end: '2026-11-20' }, { source: 'market', start: '2026-11-14', end: '2026-11-20' }]).same, true);
  const d = MP.marketSameDates([{ source: 'shopify', start: '2026-07-01', end: '2026-07-31' }, { source: 'market', start: '2026-11-14', end: '2026-11-20' }]);
  assert.equal(d.same, false);
  assert.deepEqual(d.ranges.map(r => r.range), ['Jul 1 – 31, 2026', 'Nov 14 – 20, 2026']);
  assert.equal(MP.marketSameDates([{ source: 'shopify', start: '2026-07-01', end: '2026-07-31' }, null]).same, true);
});

test('a failed market load is not retried automatically: one call until Retry or a different selection', async () => {
  const calls = [];
  let fail = true;
  const L = MP.marketLoader(async (plan) => { calls.push(plan.sig); if (fail) throw new Error('HTTP 502'); return { id: 'snap:' + plan.sig }; });
  const settle = () => new Promise(r => setTimeout(r, 0));
  const A = { sig: 'market:a' }, B = { sig: 'market:b' };
  let rerenders = 0;
  // every completion re-renders, and every render asks again (the old loop)
  const done = () => { rerenders++; L.ensure(A, done); };
  L.ensure(A, done);
  L.ensure(A, done);                                    // a second render while loading
  await settle(); await settle();
  for (let i = 0; i < 5; i++) { L.ensure(A, done); await settle(); }
  assert.deepEqual(calls, ['market:a'], 'exactly one request despite re-renders after the rejection');
  assert.equal(L.state().status, 'failed');
  assert.equal(L.state().error, 'HTTP 502', 'the error stays visible');
  assert.equal(rerenders, 1);

  L.retry(A, done); await settle(); await settle();     // Retry: one more attempt
  for (let i = 0; i < 3; i++) { L.ensure(A, done); await settle(); }
  assert.deepEqual(calls, ['market:a', 'market:a']);
  assert.equal(L.state().attempts, 2);

  L.ensure(B); await settle(); await settle();          // a different selection: a new attempt
  L.ensure(B); await settle();
  assert.deepEqual(calls, ['market:a', 'market:a', 'market:b']);

  L.reset(); fail = false;                              // the person picks again (back to A)
  L.ensure(A); await settle(); await settle();
  L.ensure(A); await settle();
  assert.deepEqual(calls, ['market:a', 'market:a', 'market:b', 'market:a']);
  assert.equal(L.state().status, 'ready');
  assert.equal(L.state().result.id, 'snap:market:a');

  // a slow failure for an abandoned selection does not overwrite the current one
  let rejectOld;
  const M = MP.marketLoader((plan) => plan.sig === 'old' ? new Promise((_, rej) => { rejectOld = rej; }) : Promise.resolve({ id: plan.sig }));
  M.ensure({ sig: 'old' }); await settle();
  M.ensure({ sig: 'new' }); await settle(); await settle();
  rejectOld(new Error('late')); await settle();
  assert.equal(M.state().sig, 'new');
  assert.equal(M.state().status, 'ready');
});
