// Import lifecycle: snapshot shape, legacy compatibility, idempotent
// re-import, overlapping periods, and failure leaving the last good report
// in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, SAMPLE_FIXTURE, FACTS, ROOT, r2 } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const globals = loadBrowserGlobals();
const classify = (rec) => PG.classifyRecord(rec, {
  detectGenus: globals.detectGenus,
  detectNonPlantType: globals.detectNonPlantType
});

const F = FACTS.shopify, A = F.anchors;
const rows = readCsv(SAMPLE_FIXTURE);
const parsed = SR.parseShopifyProductReport(rows, { classify });
const products = parsed.records.map(SR.shopifyToSnapshotProduct);

function snapshotFrom(start, end, prods, extra) {
  return Object.assign({
    id: 'shopify_' + start + '_' + end,
    source: 'shopify', label: start + '..' + end,
    startDate: start, endDate: end,
    fileName: 'Total sales by product - ' + start + ' - ' + end + '.csv',
    uploadedAt: new Date().toISOString(),
    products: prods,
    meta: {
      schema: 'shopify-total-sales-by-product/v1',
      reportScope: 'Total sales by product (all channels in this Shopify store)',
      timezone: 'America/Los_Angeles', currency: 'USD',
      current: { start, end },
      comparison: { start: '2026-08-02', end: '2026-08-31', source: 'stated at import' },
      totalsAsImported: parsed.totals.current,
      capabilities: parsed.capabilities,
      importedAt: new Date().toISOString()
    }
  }, extra || {});
}

// ────────────────────────────────────────────────────────────
// Snapshot shape
// ────────────────────────────────────────────────────────────
test('the stored product keeps the legacy fields the other tabs read', () => {
  const p = products.find(x => x.title === A.spider.title && x.vendor === A.spider.vendor);
  for (const k of ['title', 'units', 'net', 'rev', 'genus', 'avg', 'glance', 'conv', 'inv', 'asin']) {
    assert.ok(k in p, `missing legacy field ${k}`);
  }
  assert.equal(p.rev, p.cur.total, 'legacy rev stays Total sales');
  assert.equal(p.net, p.cur.net);
  assert.equal(p.genus, 'Chlorophytum');
});

test('a non-plant keeps the legacy "(no genus)" marker the cross-channel views expect', () => {
  const sub = products.find(x => x.group === 'Subscriptions');
  assert.equal(sub.genus, '(no genus)');
  assert.equal(sub.genusName, '');
  assert.equal(sub.isPlant, false);
  assert.equal(sub.group, 'Subscriptions');
});

test('the stored product also carries the new vendor, type and prior fields', () => {
  const p = products.find(x => x.title === A.spider.title && x.vendor === A.spider.vendor);
  assert.equal(p.vendor, A.spider.vendor);
  assert.equal(p.ptype, A.spider.ptype);
  assert.equal(p.priorKnown, true);
  assert.equal(p.prior.units, A.spider.prior.units);
  assert.equal(p.groupType, PG.GROUP_TYPE_GENUS);
});

test('record metadata never claims SKU or variant knowledge', () => {
  assert.ok(products.every(p => p.sku === '' && p.asin === ''));
  assert.equal(parsed.capabilities.hasVariantId, false);
});

// ────────────────────────────────────────────────────────────
// Existing (pre-release) snapshots
// ────────────────────────────────────────────────────────────
const legacySnapshot = {
  id: 'shopify_2026-07-01_2026-07-31', source: 'shopify', label: 'Jul 2026',
  startDate: '2026-07-01', endDate: '2026-07-31', uploadedAt: '2026-08-01T00:00:00Z',
  products: [
    { title: 'Spider Plant', units: 10, gross: 200, disc: -20, ret: 0, net: 180, rev: 190, avg: 19, glance: 0, conv: 0, inv: 0, genus: 'Chlorophytum' },
    { title: '2 Succulents/ Month | Subscription Boxes', units: 5, gross: 60, disc: 0, ret: 0, net: 60, rev: 62, avg: 12.4, glance: 0, conv: 0, inv: 0, genus: 'Subscription' }
  ]
};

test('a snapshot saved before this release still loads', () => {
  assert.equal(SR.shopifyIsNewFormatSnapshot(legacySnapshot), false);
  const lifted = SR.shopifyLiftLegacySnapshot(legacySnapshot, classify);
  assert.equal(lifted.length, 2);
  assert.equal(lifted[0].cur.net, 180);
  assert.equal(lifted[0].cur.total, 190);
  assert.equal(lifted[0].cur.tax, 10, 'tax back-derived from total minus net');
  assert.ok(lifted.every(p => p.legacy === true));
});

test('a legacy snapshot reports unknown vendor and no prior period rather than inventing them', () => {
  const lifted = SR.shopifyLiftLegacySnapshot(legacySnapshot, classify);
  assert.ok(lifted.every(p => p.vendor === SR.SHOPIFY_UNKNOWN_VENDOR));
  assert.ok(lifted.every(p => p.priorKnown === false));
  assert.ok(lifted.every(p => p.identityBasis === 'title (legacy snapshot)'));
  const ch = SR.shopifyChange(lifted[0].cur.net, lifted[0].prior.net, lifted[0].priorKnown);
  assert.equal(ch.state, 'unknown');
  assert.equal(SR.shopifyChangeLabel(ch), 'no prior period');
});

test('a legacy snapshot is still fully classified and groupable', () => {
  const lifted = SR.shopifyLiftLegacySnapshot(legacySnapshot, classify);
  const groups = PG.aggregateByGroup(lifted);
  assert.equal(groups.reduce((s, g) => s + g.products, 0), 2);
  assert.ok(groups.some(g => g.group === 'Chlorophytum'));
  assert.ok(groups.some(g => g.group === 'Subscriptions'));
});

test('a new-format snapshot is recognised as such', () => {
  assert.equal(SR.shopifyIsNewFormatSnapshot(snapshotFrom('2026-09-01', '2026-09-30', products)), true);
});

// ────────────────────────────────────────────────────────────
// Re-import / idempotency
// ────────────────────────────────────────────────────────────
test('re-importing the same scope and period revises the report, it does not add again', () => {
  let list = [];
  const a = snapshotFrom('2026-09-01', '2026-09-30', products);
  list = SR.shopifyUpsertReport(list, a).list;
  const totalOnce = list.reduce((s, snap) => s + snap.products.reduce((x, p) => x + p.cur.net, 0), 0);

  const b = snapshotFrom('2026-09-01', '2026-09-30', products);
  const up = SR.shopifyUpsertReport(list, b);
  list = up.list;

  assert.equal(up.replaced, 1);
  assert.equal(list.length, 1, 'still one report for that period');
  const totalTwice = list.reduce((s, snap) => s + snap.products.reduce((x, p) => x + p.cur.net, 0), 0);
  assert.equal(Math.round(totalTwice * 100) / 100, Math.round(totalOnce * 100) / 100);
});

test('three identical re-imports are indistinguishable from one', () => {
  let list = [];
  for (let i = 0; i < 3; i++) list = SR.shopifyUpsertReport(list, snapshotFrom('2026-09-01', '2026-09-30', products)).list;
  assert.equal(list.length, 1);
  assert.equal(r2(list[0].products.reduce((s, p) => s + p.cur.net, 0)), F.cur.net);
});

test('a different period is a different report, not a replacement', () => {
  let list = SR.shopifyUpsertReport([], snapshotFrom('2026-09-01', '2026-09-30', products)).list;
  const up = SR.shopifyUpsertReport(list, snapshotFrom('2026-08-01', '2026-08-31', products));
  assert.equal(up.replaced, 0);
  assert.equal(up.list.length, 2);
});

test('a different report scope is a different report', () => {
  let list = SR.shopifyUpsertReport([], snapshotFrom('2026-09-01', '2026-09-30', products)).list;
  const other = snapshotFrom('2026-09-01', '2026-09-30', products);
  other.id = 'shopify_pos_2026-09-01_2026-09-30';
  other.meta = Object.assign({}, other.meta, { reportScope: 'Point of sale only' });
  const up = SR.shopifyUpsertReport(list, other);
  assert.equal(up.replaced, 0);
  assert.equal(up.list.length, 2);
});

test('an Amazon snapshot is never touched by a Shopify re-import', () => {
  const amazon = { id: 'amazon_2026-09-01_2026-09-30', source: 'amazon', startDate: '2026-09-01', endDate: '2026-09-30', products: [] };
  const list = SR.shopifyUpsertReport([amazon], snapshotFrom('2026-09-01', '2026-09-30', products)).list;
  assert.equal(list.length, 2);
  assert.ok(list.some(s => s.source === 'amazon'));
});

// ────────────────────────────────────────────────────────────
// Overlapping periods
// ────────────────────────────────────────────────────────────
test('overlapping reporting periods are detected and never silently summed', () => {
  const sept = snapshotFrom('2026-09-01', '2026-09-30', products);
  const q3 = snapshotFrom('2026-07-01', '2026-09-30', products);
  q3.id = 'shopify_2026-07-01_2026-09-30';
  const list = [sept, q3];
  const pairs = SR.shopifyOverlappingReports(list, 'shopify');
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].sort(), [q3.id, sept.id].sort());
});

test('adjacent, non-overlapping periods are fine', () => {
  const aug = snapshotFrom('2026-08-01', '2026-08-31', products);
  const sept = snapshotFrom('2026-09-01', '2026-09-30', products);
  assert.equal(SR.shopifyPeriodsOverlap(aug, sept), false);
  assert.equal(SR.shopifyOverlappingReports([aug, sept], 'shopify').length, 0);
});

test('a monthly report cannot answer an arbitrary weekly question', () => {
  const snap = snapshotFrom('2026-09-01', '2026-09-30', products);
  assert.equal(snap.meta.capabilities.hasDailyDates, false);
  // Selectable periods are exactly the saved report coverage, nothing finer.
  const coverage = [snap].map(s => ({ start: s.startDate, end: s.endDate }));
  const weekWanted = { start: '2026-09-07', end: '2026-09-13' };
  const answerable = coverage.some(c => c.start === weekWanted.start && c.end === weekWanted.end);
  assert.equal(answerable, false);
});

// ────────────────────────────────────────────────────────────
// Failed imports
// ────────────────────────────────────────────────────────────
test('a failed parse leaves the last successful report untouched', () => {
  const good = snapshotFrom('2026-09-01', '2026-09-30', products);
  let list = SR.shopifyUpsertReport([], good).list;
  const before = JSON.stringify(list);

  const broken = rows.map(r => r.filter((_, i) => i !== 7)); // drop Net sales
  const bad = SR.parseShopifyProductReport(broken, { classify });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length);
  // The import path only upserts when ok === true.
  if (bad.ok) list = SR.shopifyUpsertReport(list, snapshotFrom('2026-09-01', '2026-09-30', bad.records)).list;

  assert.equal(JSON.stringify(list), before);
  assert.equal(r2(list[0].products.reduce((s, p) => s + p.cur.net, 0)), F.cur.net);
});

test('a reconciliation mismatch is surfaced, not swallowed', () => {
  const rec = SR.shopifyReconcile(parsed.totals.current, { net: 40000 }, 0.02);
  assert.equal(rec.ok, false);
  assert.equal(rec.checks[0].measure, 'net');
  assert.ok(Math.abs(rec.checks[0].delta - (F.cur.net - 40000)) < 0.01);
});

// ────────────────────────────────────────────────────────────
// Export scope
// ────────────────────────────────────────────────────────────
test('an export writes exactly the rows the filtered tables show', () => {
  const { included } = PG.splitExclusions(products.map(p => p));
  const scope = { vendor: F.vendorNames.air, ptype: 'All', group: 'All', plantScope: 'all', search: '' };
  const scoped = PG.applyScope(included, scope);
  assert.equal(scoped.length, F.vendors[F.vendorNames.air].rows);
  // the group table, the chart and the CSV all read the same array
  const buckets = PG.aggregateByGroup(scoped);
  assert.equal(buckets.reduce((s, b) => s + b.products, 0), scoped.length);
  assert.equal(Math.round(buckets.reduce((s, b) => s + b.cur.net, 0) * 100) / 100,
               Math.round(scoped.reduce((s, r) => s + r.cur.net, 0) * 100) / 100);
});

test('a vendor export never leaks an excluded product', () => {
  const { included, excluded } = PG.splitExclusions(products.map(p => p));
  assert.equal(excluded.length, 1);
  const everyVendor = PG.aggregateByVendor(included);
  assert.ok(!everyVendor.some(v => v.vendor === 'Route'));
  assert.ok(included.every(r => r.vendor !== 'Route'));
});
