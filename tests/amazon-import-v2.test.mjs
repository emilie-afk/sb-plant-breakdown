// Amazon IMPORT path after Amazon changed the metric-data report (v2).
//
// Fixture: tests/fixtures/amazon-metric-data-v2-sample.csv — SYNTHETIC
// (tools/make-sample-fixtures.mjs) in the exact v2 column layout, with Amazon's
// own Total line first. Product-level aggregates only.
//
// What changed from v1, and what each change could have broken:
//   - 7 columns became 12, and every column moved. "Ordered units" went from
//     column 5 to column 11. A positional reader would now read SHIPPED units
//     as ordered units and SHIPPED revenue as sales.
//   - Revenue appeared, under a new name ("Ordered revenue ($)"), alongside a
//     second revenue column ("Shipped revenue ($)").
//   - Inventory appeared ("Available Inventory Units") but is 0 on every row.
//   - Traffic is now "Glance views", not "Featured Offer glance views" — a
//     different metric with the same unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, ROOT, AMAZON_V1_FIXTURE, AMAZON_V2_FIXTURE, FACTS } from './load.mjs';

const require = createRequire(import.meta.url);
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));
const SR = require(path.join(ROOT, 'shopify-report.js'));
const globals = loadBrowserGlobals();
const detectors = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };

const rows = readCsv(AMAZON_V2_FIXTURE);
const v1rows = readCsv(AMAZON_V1_FIXTURE);
const parsed = AP.parseAmazonMetricData(rows);
const v1 = AP.parseAmazonMetricData(v1rows);

// Read off Amazon's own Total line in the v2 export.
const V2 = FACTS.amazon.v2, V1 = FACTS.amazon.v1, IVY = V2.ivy;
const TOTAL = {
  glance: V2.glance, units: V2.units, shipped: V2.shipped, orderItems: V2.orderItems,
  orderedRevenue: V2.orderedRevenue, shippedRevenue: V2.shippedRevenue, conv: V2.conv
};

// ────────────────────────────────────────────────────────────
// The shape of the changed report
// ────────────────────────────────────────────────────────────
test('the changed export has 12 columns in a new order', () => {
  assert.deepEqual(rows[0], [
    'ASIN', 'Item name', 'Glance views', 'Conversion rate (%)', 'Shipped units',
    'Average selling price ($)', 'Shipped revenue ($)', 'Available Inventory Units',
    'Ordered revenue ($)', 'Total order items', 'Units per Order Item', 'Ordered units'
  ]);
  assert.equal(v1rows[0].length, 7);
});

test('every column is resolved by name, wherever Amazon moved it', () => {
  assert.equal(parsed.ok, true, parsed.errors.join(' '));
  const c = parsed.columnReport.cols;
  assert.equal(c.asin, 0); assert.equal(c.title, 1);
  assert.equal(c.glance, 2); assert.equal(c.conv, 3);
  assert.equal(c.shipped, 4); assert.equal(c.asp, 5);
  assert.equal(c.shippedRevenue, 6); assert.equal(c.inv, 7);
  assert.equal(c.revenue, 8); assert.equal(c.orderItems, 9);
  assert.equal(c.unitsPerItem, 10); assert.equal(c.units, 11);
  assert.deepEqual(parsed.columnReport.unknown, [], 'no column is left unrecognised');
});

test('ordered units moved from column 5 to column 11 and are still found', () => {
  assert.equal(v1.columnReport.cols.units, 5);
  assert.equal(parsed.columnReport.cols.units, 11);
});

// ────────────────────────────────────────────────────────────
// Revenue: ordered, not shipped
// ────────────────────────────────────────────────────────────
test('sales are ORDERED revenue, paired with ORDERED units', () => {
  const cap = parsed.capabilities;
  assert.equal(cap.hasRevenue, true);
  assert.equal(cap.revenueBasis, 'ordered');
  assert.equal(cap.revenueLabel, 'Ordered revenue ($)');
  const rev = Math.round(parsed.products.reduce((s, p) => s + p.rev, 0) * 100) / 100;
  assert.equal(rev, TOTAL.orderedRevenue);
  assert.notEqual(rev, TOTAL.shippedRevenue, 'shipped revenue must not be used as sales');
});

test('shipped revenue is kept separately and never mixed with ordered units', () => {
  assert.equal(parsed.capabilities.hasShippedRevenue, true);
  const shipped = Math.round(parsed.products.reduce((s, p) => s + p.shippedRev, 0) * 100) / 100;
  assert.equal(shipped, TOTAL.shippedRevenue);
  // One ASIN whose shipped and ordered figures differ.
  const ivy = parsed.products.find(p => p.asin === IVY.asin);
  assert.equal(ivy.rev, IVY.rev);
  assert.equal(ivy.units, IVY.units);
  assert.equal(ivy.shippedRev, IVY.shippedRev);
  assert.equal(ivy.shipped, IVY.shipped);
  assert.notEqual(ivy.shipped, ivy.units);
  assert.equal(ivy.avg, Math.round(IVY.rev / IVY.units * 100) / 100, 'average = ordered revenue / ordered units');
});

test("Amazon's own average selling price is kept for reference, not used as our average", () => {
  const p = parsed.products.find(x => x.units > 0 && x.amazonAsp != null &&
                                      Math.abs(x.amazonAsp - x.rev / x.units) > 0.05);
  // Amazon's ASP does not always equal ordered revenue / ordered units, which is
  // exactly why the dashboard computes its own and labels it.
  if (p) assert.equal(p.avg, Math.round((p.rev / p.units) * 100) / 100);
  assert.ok(parsed.products.every(x => 'amazonAsp' in x));
});

test('a file with only shipped revenue is labelled as shipped and paired with shipped units', () => {
  const p = AP.parseAmazonMetricData([
    ['ASIN', 'Item name', 'Ordered units', 'Shipped units', 'Shipped revenue ($)'],
    ['B000000010', 'Echeveria Lola', '5', '4', '$60.00']
  ]);
  assert.equal(p.capabilities.revenueBasis, 'shipped');
  assert.equal(p.capabilities.revenueLabel, 'Shipped revenue ($)');
  assert.equal(p.products[0].avg, 15, '60 / 4 shipped units, not / 5 ordered');
  assert.match(p.warnings.join(' '), /not comparable to ordered revenue/);
});

// ────────────────────────────────────────────────────────────
// Inventory present but empty
// ────────────────────────────────────────────────────────────
test('an inventory column that is zero on every row is treated as not reported', () => {
  assert.equal(parsed.capabilities.inventoryColumnPresent, true);
  assert.equal(parsed.capabilities.hasInventory, false);
  assert.ok(parsed.products.every(p => p.inventoryKnown === false));
  assert.match(parsed.warnings.join(' '), new RegExp('present but zero on all ' + V2.rows + ' products'));
});

test('so no product with traffic is wrongly flagged as out of stock', () => {
  const withTraffic = parsed.products.filter(p => p.glance > 0);
  assert.equal(withTraffic.length, V2.withTraffic);
  assert.ok(withTraffic.length > 300);
  const wouldBeFlagged = withTraffic.filter(p => p.inventoryKnown && p.inv === 0);
  assert.equal(wouldBeFlagged.length, 0);
});

test('an inventory column with real values is used', () => {
  const p = AP.parseAmazonMetricData([
    ['ASIN', 'Item name', 'Ordered units', 'Available Inventory Units'],
    ['B000000011', 'Haworthia', '3', '0'],
    ['B000000012', 'Sedum', '5', '40']
  ]);
  assert.equal(p.capabilities.hasInventory, true);
  assert.equal(p.products[0].inv, 0);
  assert.equal(p.products[0].inventoryKnown, true, 'a genuine zero is now meaningful');
});

// ────────────────────────────────────────────────────────────
// Reconciliation and identity
// ────────────────────────────────────────────────────────────
test('every summable measure reconciles to Amazon\'s Total line', () => {
  assert.equal(parsed.rowCount, V2.rows);
  assert.equal(parsed.reconciliation.ok, true, JSON.stringify(parsed.reconciliation.checks));
  const got = Object.fromEntries(parsed.reconciliation.checks.map(c => [c.measure, c.got]));
  assert.equal(got.units, TOTAL.units);
  assert.equal(got.shipped, TOTAL.shipped);
  assert.equal(got.glance, TOTAL.glance);
  assert.equal(got.orderItems, TOTAL.orderItems);
  assert.equal(got.revenue, TOTAL.orderedRevenue);
  assert.equal(got.shippedRevenue, TOTAL.shippedRevenue);
});

test('ASINs resolve, are 10 characters and unique', () => {
  const asins = parsed.products.map(p => p.asin);
  assert.ok(asins.every(a => /^[A-Z0-9]{10}$/.test(a)));
  assert.equal(new Set(asins).size, V2.rows);
});

test('conversion stays a fraction and matches units / glance views overall', () => {
  assert.ok(parsed.products.every(p => p.conv >= 0 && p.conv <= 1));
  assert.ok(Math.abs(TOTAL.units / TOTAL.glance - TOTAL.conv) < 0.0005);
});

// ────────────────────────────────────────────────────────────
// Traffic basis changed between versions
// ────────────────────────────────────────────────────────────
test('the traffic basis is recorded, because v1 and v2 measure different glance views', () => {
  assert.equal(v1.capabilities.glanceBasis, 'Featured Offer glance views');
  assert.equal(parsed.capabilities.glanceBasis, 'Glance views');
  assert.notEqual(v1.capabilities.glanceBasis, parsed.capabilities.glanceBasis);
  assert.equal(v1.capabilities.reportVersion, 'metric-data v1');
  assert.equal(parsed.capabilities.reportVersion, 'metric-data v2');
});

test('v1 still parses exactly as before', () => {
  assert.equal(v1.ok, true);
  assert.equal(v1.capabilities.hasRevenue, false);
  assert.equal(v1.capabilities.hasInventory, false);
  assert.equal(v1.products.reduce((s, p) => s + p.units, 0), V1.units);
  assert.equal(v1.products.reduce((s, p) => s + p.glance, 0), V1.glance);
});

// ────────────────────────────────────────────────────────────
// Through classification, grouping and comparison
// ────────────────────────────────────────────────────────────
const recs = AR.amazonNormalizeSnapshot({ products: parsed.products }, {
  classify: (r) => PG.classifyRecord(r, detectors),
  suspicion: (r) => PG.classifySuspicion(r, detectors)
});
const { included } = PG.splitExclusions(recs);

test('the v2 export groups and reconciles end to end', () => {
  const buckets = PG.aggregateByGroup(included);
  assert.equal(buckets.reduce((s, b) => s + b.products, 0), V2.rows);
  assert.equal(Math.round(buckets.reduce((s, b) => s + b.cur.net, 0) * 100) / 100, TOTAL.orderedRevenue);
  assert.equal(buckets.reduce((s, b) => s + b.cur.units, 0), TOTAL.units);
  assert.equal(buckets.reduce((s, b) => s + b.cur.glance, 0), TOTAL.glance);
  assert.ok(buckets.filter(b => b.groupType === PG.GROUP_TYPE_GENUS).length >= 60);
});

test('nothing falls into one catch-all bucket', () => {
  const buckets = PG.aggregateByGroup(included);
  const biggest = Math.max(...buckets.map(b => b.products));
  assert.ok(biggest < included.length * 0.25, `one group holds ${biggest} of ${included.length}`);
});

test('a v1 snapshot compared with a v2 snapshot still matches on ASIN', () => {
  const v1recs = AR.amazonNormalizeSnapshot({ products: v1.products }, {
    classify: (r) => PG.classifyRecord(r, detectors)
  });
  const cur = AR.amazonNormalizeSnapshot({ products: parsed.products }, {
    classify: (r) => PG.classifyRecord(r, detectors)
  });
  AR.amazonAttachPrior(cur, v1recs);
  const matched = cur.filter(r => r.priorMatch === 'asin');
  assert.equal(matched.length, V1.rows, `${matched.length} matched on ASIN`);
  // Revenue cannot be compared: v1 had none. The change must not pretend otherwise.
  const ech = matched.find(r => r.cur.net > 0);
  assert.equal(ech.prior.net, 0, 'v1 carried no revenue, so the prior is genuinely absent');
});
