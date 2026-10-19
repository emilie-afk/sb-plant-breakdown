// Amazon orders synced into Shopify by Sellbrite:
//   before March 2026  no overlap
//   March 2026         partial-month overlap; the exact start date is unknown
//   April 2026 onward  full-month overlap
// With a Sales channel column the Sellbrite rows are excluded by value (works
// for March without knowing the start). Without it, anything touching March
// 2026 or later is a POTENTIAL overlap and is never presented as deduplicated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PE = require(path.join(ROOT, 'period-engine.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));

const rec = (ch, net) => ({ title: 'Plant', vendor: 'V', ptype: 'Succulent', productKey: 'pid:1', productId: '1',
  salesChannel: ch, channelGroup: ch ? SR.shopifyChannelGroupOf(ch) : '',
  cur: { units: 1, gross: net, disc: 0, ret: 0, net, tax: 0, total: net, glance: 0, inv: 0 } });
const snap = (start, end, recs, extra) => Object.assign({ source: 'shopify', startDate: start, endDate: end, products: recs, meta: {} }, extra || {});

test('the overlap phases by date range (no Sales channel column)', () => {
  const lv = (a, b) => SR.shopifySellbriteOverlap(a, b);
  assert.equal(lv('2026-02-01', '2026-02-28').level, 'none');
  assert.equal(lv('2025-01-01', '2025-12-31').level, 'none');
  assert.equal(lv('2026-02-01', '2026-02-28').potential, false);
  assert.equal(lv('2026-03-01', '2026-03-31').level, 'partial', 'March is a partial-month overlap');
  assert.equal(lv('2026-03-01', '2026-03-10').level, 'partial');
  assert.equal(lv('2026-04-01', '2026-04-30').level, 'full');
  assert.equal(lv('2026-09-01', '2026-09-30').level, 'full');
  assert.equal(lv('2026-01-01', '2026-03-31').level, 'mixed', 'Q1 2026 includes March');
  assert.equal(lv('2026-01-01', '2026-03-31').potential, true);
  assert.equal(lv('2026-02-15', '2026-03-02').potential, true, 'touching March is enough');
  assert.equal(lv('2026-03-20', '2026-04-10').level, 'mixed');
  assert.equal(SR.SHOPIFY_AMAZON_VIA_SHOPIFY_SINCE, '2026-03-01', 'the warning threshold is March 1, not April 1');
  assert.equal(SR.SHOPIFY_AMAZON_VIA_SHOPIFY_FULL_FROM, '2026-04-01');
});

test('without a Sales channel column: before March is safe, March or later is a potential overlap', () => {
  const plain = [rec(null, 10)];
  assert.equal(SR.shopifyChannelStatus(snap('2026-02-01', '2026-02-28', plain)).dedupSafe, true);
  const mar = SR.shopifyChannelStatus(snap('2026-03-01', '2026-03-31', plain));
  assert.equal(mar.mayIncludeAmazon, true);
  assert.equal(mar.dedupSafe, false);
  assert.equal(mar.uncovered[0].level, 'partial');
  const q1 = SR.shopifyChannelStatus(snap('2026-01-01', '2026-03-31', plain));
  assert.equal(q1.mayIncludeAmazon, true, 'Q1 2026 has a potential overlap because of March');
});

test('with a Sales channel column, Sellbrite rows are excluded by value, in March too', () => {
  const recs = [rec('Online Store', 30), rec('Sellbrite', 12)];
  const st = SR.shopifyChannelStatus(snap('2026-03-01', '2026-03-31', recs));
  assert.equal(st.hasChannel, true);
  assert.equal(st.dedupSafe, true);
  assert.equal(st.totals.amazon.net, 12);
  const own = PG.filterChannel(recs, 'own');
  assert.equal(own.reduce((t, r) => t + r.cur.net, 0), 30, 'own-store contribution leaves the Sellbrite rows out');
});

test('combined periods judge each month: a channel-less March makes Q1 a potential overlap; channel-less Jan/Feb do not', () => {
  const recs = [rec(null, 5), rec('Online Store', 5), rec('Sellbrite', 2)];
  const cov = (marHas) => [
    { month: '2026-01', start: '2026-01-01', end: '2026-01-31', hasChannel: false },
    { month: '2026-02', start: '2026-02-01', end: '2026-02-28', hasChannel: false },
    { month: '2026-03', start: '2026-03-01', end: '2026-03-31', hasChannel: marHas }];
  const safe = SR.shopifyChannelStatus(snap('2026-01-01', '2026-03-31', recs, { meta: { channelCoverage: cov(true) } }));
  assert.equal(safe.dedupSafe, true);
  assert.equal(safe.hasChannel, false, 'not every month has the column');
  assert.equal(safe.anyChannel, true, 'the channel filter still applies to March');
  const risky = SR.shopifyChannelStatus(snap('2026-01-01', '2026-03-31', recs, { meta: { channelCoverage: cov(false) } }));
  assert.equal(risky.mayIncludeAmazon, true);
  assert.deepEqual(risky.uncovered.map(u => u.start), ['2026-03-01'], 'only March is flagged');
  // A year: Apr+ months without the column are full-overlap months.
  const y = SR.shopifyChannelStatus(snap('2026-01-01', '2026-12-31', recs, { meta: { channelCoverage: [
    { start: '2026-02-01', end: '2026-02-28', hasChannel: false }, { start: '2026-05-01', end: '2026-05-31', hasChannel: false }] } }));
  assert.equal(y.uncovered[0].level, 'full');
});

test('the period engine records channel coverage for combined periods', () => {
  const plan = { kind: 'quarter', year: 2026, index: 1, name: 'Q1 2026', status: 'complete', partial: false, label: 'Q1 2026 (complete)',
    missing: [], shortMonths: [], coverage: { start: '2026-01-01', end: '2026-03-31' }, start: '2026-01-01', end: '2026-03-31',
    revisionsUsed: [{ month: '2026-03', reportId: 'x', revision: 1, start: '2026-03-01', end: '2026-03-31', status: 'complete' }] };
  const cov = [{ month: '2026-03', start: '2026-03-01', end: '2026-03-31', hasChannel: false }];
  const s = PE.periodBuildSnapshot('shopify', plan, null, [rec(null, 1)], { channelCoverage: cov });
  assert.deepEqual(s.meta.channelCoverage, cov);
  assert.equal(SR.shopifyChannelStatus(s).mayIncludeAmazon, true);
});

test('the explanation never claims all of March, and never uses April 1 as the threshold', () => {
  const note = SR.shopifyOverlapNote(SR.shopifyChannelStatus(snap('2026-03-01', '2026-03-31', [rec(null, 1)])));
  assert.match(note, /unknown day in March/);
  assert.match(note, /not deduplicated/);
  assert.doesNotMatch(note, /all of March|since April|from April 1/i);
  assert.equal(SR.shopifyOverlapNote(SR.shopifyChannelStatus(snap('2026-02-01', '2026-02-28', [rec(null, 1)]))), '');
});

test('the cross-channel and market views use the channel rule, not an April threshold', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /OVERLAP_THRESHOLD|"2026-04-01"|since April 2026/);
  assert.match(app, /shopifyChannelStatus\(sSnap\)/);
  assert.match(app, /not deduplicated/);
  const guard = fs.readFileSync(path.join(ROOT, 'channel-guard.js'), 'utf8');
  assert.match(guard, /anyChannel \? ownStoreView/);
  assert.match(guard, /not deduplicated/);
  for (const f of ['shopify-views.js', 'channel-guard.js', 'period-view.js', 'docs/sales-analytics.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /since April|all of March|post-April/i, f);
  }
});
