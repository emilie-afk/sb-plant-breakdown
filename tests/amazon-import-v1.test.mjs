// Amazon IMPORT path, v1 "metric data" layout.
//
// Fixture: tests/fixtures/amazon-metric-data-v1-sample.csv — SYNTHETIC
// (tools/make-sample-fixtures.mjs) in the exact column layout of Seller
// Central's metric-data export: Amazon's own Total line first, then one row per
// ASIN (ASINs already extracted from the =HYPERLINK(...) formulas, as the xlsx
// reader does). Product-level aggregates only; no customer fields exist.
//
// This test exists because the export's real column order is NOT the one
// app.js's positional parseAmazon assumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, ROOT, AMAZON_V1_FIXTURE, FACTS } from './load.mjs';

const require = createRequire(import.meta.url);
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));
require(path.join(ROOT, 'shopify-report.js'));
const globals = loadBrowserGlobals();
const detectors = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };

const rows = readCsv(AMAZON_V1_FIXTURE);
const parsed = AP.parseAmazonMetricData(rows);

// Figures read off Amazon's own Total line in the export.
const V1 = FACTS.amazon.v1;
const AMAZON_TOTALS = { glance: V1.glance, units: V1.units, shipped: V1.shipped, convRate: V1.conv };

// ────────────────────────────────────────────────────────────
// The actual shape of the real export
// ────────────────────────────────────────────────────────────
test('the v1 export has these columns, in this order', () => {
  assert.deepEqual(rows[0], [
    'ASIN', 'Item name', 'Conversion rate (%)', 'Featured Offer glance views',
    'Featured Offer rate', 'Ordered units', 'Shipped units'
  ]);
});

test('the positional assumption in app.js does not hold for this file', () => {
  // app.js's parseAmazon format 2 reads:
  //   glance=col2 conv=col3 units=col4 avg=col5 rev=col6 inv=col7
  // Against this file that is conversion, glance, Featured Offer rate,
  // ordered units and shipped units respectively — every measure displaced.
  const header = rows[0].map(h => h.toLowerCase());
  assert.equal(header[2], 'conversion rate (%)', 'col 2 is conversion, not glance views');
  assert.equal(header[3], 'featured offer glance views', 'col 3 is glance views, not conversion');
  assert.equal(header[4], 'featured offer rate', 'col 4 is buy-box rate, not units');
  assert.equal(header[6], 'shipped units', 'col 6 is shipped units, not revenue');
  assert.equal(header.length, 7, 'there is no col 7, so inventory cannot exist');
});

test('the header-based parser resolves every column correctly', () => {
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.ok, true);
  const c = parsed.columnReport.cols;
  assert.equal(c.asin, 0);
  assert.equal(c.title, 1);
  assert.equal(c.conv, 2);
  assert.equal(c.glance, 3);
  assert.equal(c.buybox, 4);
  assert.equal(c.units, 5);
  assert.equal(c.shipped, 6);
  assert.equal(c.revenue, undefined);
  assert.equal(c.inv, undefined);
});

// ────────────────────────────────────────────────────────────
// Capabilities: say what the file does not have
// ────────────────────────────────────────────────────────────
test('the parser declares that this export carries no revenue and no inventory', () => {
  assert.equal(parsed.capabilities.hasRevenue, false);
  assert.equal(parsed.capabilities.hasInventory, false);
  assert.equal(parsed.capabilities.hasGlance, true);
  assert.equal(parsed.capabilities.hasUnits, true);
  assert.equal(parsed.capabilities.hasConversion, true);
  assert.equal(parsed.capabilities.hasShipped, true);
  assert.match(parsed.warnings.join(' '), /no sales figure/i);
  assert.match(parsed.warnings.join(' '), /no inventory column/i);
});

test('no revenue is invented when the file has none', () => {
  assert.ok(parsed.products.every(p => p.rev === 0 && p.revenueKnown === false));
  assert.ok(parsed.products.every(p => p.inv === 0 && p.inventoryKnown === false));
});

// ────────────────────────────────────────────────────────────
// Reconciliation against Amazon's own Total line
// ────────────────────────────────────────────────────────────
test('rows reconcile to Amazon\'s Total line', () => {
  assert.ok(parsed.totalsRow, 'the Total line is captured, not discarded');
  assert.equal(parsed.rowCount, V1.rows);
  assert.equal(parsed.products.reduce((s, p) => s + p.units, 0), AMAZON_TOTALS.units);
  assert.equal(parsed.products.reduce((s, p) => s + p.glance, 0), AMAZON_TOTALS.glance);
  assert.equal(parsed.reconciliation.ok, true, JSON.stringify(parsed.reconciliation));
});

test('the Total line is not counted as a product', () => {
  assert.ok(!parsed.products.some(p => /^total$/i.test(p.title)));
  assert.ok(!parsed.products.some(p => p.asin === 'Total'));
});

// ────────────────────────────────────────────────────────────
// ASINs out of HYPERLINK formulas
// ────────────────────────────────────────────────────────────
test('ASINs are recovered and are all exactly 10 characters', () => {
  const withAsin = parsed.products.filter(p => p.asin);
  assert.equal(withAsin.length, V1.rows, `${withAsin.length} of ${parsed.rowCount} rows have an ASIN`);
  assert.ok(withAsin.every(p => /^[A-Z0-9]{10}$/.test(p.asin)), 'every ASIN is a 10-char token');
  assert.equal(parsed.products[0].asin, V1.firstAsin);
});

test('ASINs are unique, so no two products collapse onto one key', () => {
  const asins = parsed.products.filter(p => p.asin).map(p => p.asin);
  assert.equal(new Set(asins).size, asins.length);
});

// ────────────────────────────────────────────────────────────
// Conversion rate handling
// ────────────────────────────────────────────────────────────
test('a fractional conversion rate is not divided by 100 again', () => {
  // The Total line states a fraction for the store overall (e.g. 0.03 = 3%).
  const totalConv = parsed.totalsRow.conv;
  assert.ok(Math.abs(totalConv - AMAZON_TOTALS.convRate) < 1e-6);
  assert.ok(parsed.products.every(p => p.conv >= 0 && p.conv <= 1),
    'no product may end up with a conversion rate above 100%');
});

test('a percentage-style conversion rate is normalised', () => {
  const p = AP.parseAmazonMetricData([
    ['ASIN', 'Item name', 'Unit Session Percentage', 'Sessions - Total', 'Units Ordered'],
    ['B000000001', 'Test plant', '12.5%', '400', '50']
  ]);
  assert.equal(p.ok, true);
  assert.ok(Math.abs(p.products[0].conv - 0.125) < 1e-9);
  assert.equal(p.products[0].glance, 400);
  assert.equal(p.products[0].units, 50);
});

// ────────────────────────────────────────────────────────────
// Robustness
// ────────────────────────────────────────────────────────────
test('a reordered export still parses correctly', () => {
  const reordered = rows.map(r => [r[5], r[1], r[0], r[3], r[2], r[6], r[4]]);
  const p = AP.parseAmazonMetricData(reordered);
  assert.equal(p.ok, true);
  assert.equal(p.products.reduce((s, x) => s + x.units, 0), AMAZON_TOTALS.units);
  assert.equal(p.products.reduce((s, x) => s + x.glance, 0), AMAZON_TOTALS.glance);
});

test('an export with a real revenue column uses it', () => {
  const p = AP.parseAmazonMetricData([
    ['(Child) ASIN', 'Title', 'Sessions - Total', 'Unit Session Percentage', 'Units Ordered',
     'Ordered Product Sales', 'Available Inventory'],
    ['B000000002', 'Echeveria Lola', '1000', '5%', '50', '$725.00', '12']
  ]);
  assert.equal(p.ok, true);
  assert.equal(p.capabilities.hasRevenue, true);
  assert.equal(p.capabilities.hasInventory, true);
  assert.equal(p.products[0].rev, 725);
  assert.equal(p.products[0].inv, 12);
  assert.equal(p.products[0].avg, 14.5);
});

test('a file missing a title column is refused outright', () => {
  const p = AP.parseAmazonMetricData([['ASIN', 'Sessions'], ['B000000003', '10']]);
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /product title/i);
});

test('a file with neither units nor traffic is refused', () => {
  const p = AP.parseAmazonMetricData([['ASIN', 'Item name'], ['B000000004', 'Something']]);
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /nothing to report/i);
});

test('the file is recognised by its headers', () => {
  assert.equal(AP.looksLikeAmazonMetricData(rows), true);
  assert.equal(AP.looksLikeAmazonMetricData([['Product title', 'Product vendor', 'Net sales']]), false);
});

// ────────────────────────────────────────────────────────────
// It flows through classification and grouping
// ────────────────────────────────────────────────────────────
test('the v1 export groups into genera and categories', () => {
  const recs = AR.amazonNormalizeSnapshot({ products: parsed.products }, {
    classify: (r) => PG.classifyRecord(r, detectors),
    suspicion: (r) => PG.classifySuspicion(r, detectors)
  });
  const { included } = PG.splitExclusions(recs);
  const buckets = PG.aggregateByGroup(included);
  assert.equal(included.length, V1.rows);
  assert.equal(buckets.reduce((s, b) => s + b.products, 0), V1.rows);
  assert.equal(buckets.reduce((s, b) => s + b.cur.units, 0), AMAZON_TOTALS.units);
  assert.equal(buckets.reduce((s, b) => s + b.cur.glance, 0), AMAZON_TOTALS.glance);
  assert.ok(buckets.filter(b => b.groupType === PG.GROUP_TYPE_GENUS).length >= 50);
  assert.ok(buckets.some(b => b.groupType === PG.GROUP_TYPE_CATEGORY));
});
