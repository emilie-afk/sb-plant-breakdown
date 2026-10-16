// "The Amazon report will change again."
//
// Simulates the next format change using the v2 sample export (synthetic, in
// the real v2 layout): every column renamed and the order shuffled, numbers
// untouched. The
// importer must (1) never fall back to the positional parser, (2) detect the
// new format, (3) suggest a mapping a person can confirm, (4) map nothing
// without confirmation, and (5) reconcile to Amazon's Total line once mapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, ROOT, AMAZON_V1_FIXTURE, AMAZON_V2_FIXTURE } from './load.mjs';

const require = createRequire(import.meta.url);
const AP = require(path.join(ROOT, 'amazon-parse.js'));

const v2rows = readCsv(AMAZON_V2_FIXTURE);
const v2 = AP.parseAmazonMetricData(v2rows);

// v2 header -> plausible next-version header
const RENAME = {
  'ASIN': 'Child ASIN',
  'Item name': 'Product title',
  'Glance views': 'Detail page views',
  'Conversion rate (%)': 'Unit conversion (%)',
  'Shipped units': 'Units shipped',
  'Average selling price ($)': 'Avg. selling price',
  'Shipped revenue ($)': 'Shipped product sales',
  'Available Inventory Units': 'Sellable inventory',
  'Ordered revenue ($)': 'Sales (ordered)',
  'Total order items': 'Order items (total)',
  'Units per Order Item': 'Units per order item',
  'Ordered units': 'Units (ordered)'
};
const ORDER = [1, 11, 0, 8, 2, 3, 9, 4, 6, 5, 7, 10];   // new column order
const v3rows = v2rows.map((r, i) => ORDER.map(j => i === 0 ? RENAME[r[j]] : r[j]));
const v3header = v3rows[0];

test('the simulated format really is different', () => {
  assert.notEqual(AP.amazonHeaderSignature(v3header), AP.amazonHeaderSignature(v2rows[0]));
  assert.equal(v3header[1], 'Units (ordered)');
});

test('it is still routed to the header-based parser, never the positional one', () => {
  assert.equal(AP.looksLikeAmazonMetricData(v3rows), true);
});

test('without a mapping the new format is flagged, and nothing is guessed', () => {
  const a = AP.amazonAssessFormat(v3header, null, [AP.amazonHeaderSignature(v2rows[0])]);
  assert.equal(a.known, false);
  assert.equal(a.needsMapping, true);
  const p = AP.parseAmazonMetricData(v3rows);
  // Unmapped, the renamed revenue / units / traffic columns are simply absent.
  assert.equal(p.capabilities.hasRevenue, false);
  assert.equal(p.columnReport.cols.units, undefined);
  assert.ok(p.products.every(x => x.units === 0 && x.rev === 0), 'no figure lands in the wrong field');
});

test('suggestions name the right field for every renamed column', () => {
  const a = AP.amazonAssessFormat(v3header, null, []);
  const s = Object.fromEntries(a.suggestions.map(x => [x.header, x.field]));
  assert.equal(s['Product title'], 'title');
  assert.equal(s['Units (ordered)'], 'units');
  assert.equal(s['Sales (ordered)'], 'revenue');
  assert.equal(s['Detail page views'], 'glance');
  assert.equal(s['Unit conversion (%)'], 'conv');
  assert.equal(s['Avg. selling price'], 'asp');
  assert.equal(s['Sellable inventory'], 'inv');
  assert.equal(s['Order items (total)'], 'orderItems');
  // Already-known spellings are resolved without asking.
  assert.equal(a.resolved.asin, 2, '"Child ASIN" is a known spelling');
  assert.equal(a.resolved.shipped, 7, '"Units shipped" is a known spelling');
  assert.equal(a.resolved.shippedRevenue, 8, '"Shipped product sales" is a known spelling');
});

test('the confirmed mapping reproduces v2 exactly and reconciles to the Total line', () => {
  const a = AP.amazonAssessFormat(v3header, null, []);
  const mapping = Object.fromEntries(a.suggestions.map(x => [x.normalised, x.field]));
  assert.equal(AP.amazonValidateMapping(v3header, mapping).ok, true);
  const p = AP.parseAmazonMetricData(v3rows, { mapping });
  assert.equal(p.ok, true);
  assert.equal(p.reconciliation.ok, true, JSON.stringify(p.reconciliation.checks));
  const sum = (x, f) => Math.round(x.products.reduce((s, q) => s + q[f], 0) * 100) / 100;
  for (const f of ['units', 'shipped', 'glance', 'rev', 'shippedRev', 'orderItems']) {
    assert.equal(sum(p, f), sum(v2, f), f);
  }
  assert.equal(p.capabilities.revenueBasis, 'ordered');
  assert.equal(p.capabilities.hasInventory, false, 'the all-zero inventory guard still applies');
});

test('once confirmed, the same format is recognised and imports without asking', () => {
  const sig = AP.amazonHeaderSignature(v3header);
  const a = AP.amazonAssessFormat(v3header, {}, [sig]);
  assert.equal(a.known, true);
  assert.equal(a.needsMapping, false);
});

test('a mapping that sends two columns to one field is refused', () => {
  const bad = { 'units (ordered)': 'units', 'units shipped': 'units', 'product title': 'title' };
  const v = AP.amazonValidateMapping(v3header, bad);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Ordered units is chosen for two columns/);
});

test('a mapping that leaves no title is refused', () => {
  const v = AP.amazonValidateMapping(v3header, { 'product title': 'ignore', 'units (ordered)': 'units' });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /product title/);
});

test('a column can be explicitly ignored', () => {
  const a = AP.amazonAssessFormat(v3header, null, []);
  const mapping = Object.fromEntries(a.suggestions.map(x => [x.normalised, x.field]));
  mapping['avg. selling price'] = 'ignore';
  const p = AP.parseAmazonMetricData(v3rows, { mapping });
  assert.equal(p.columnReport.cols.asp, undefined);
  assert.ok(!p.columnReport.unknown.includes('Avg. selling price'), 'ignored, not reported as unknown');
});

test('v1 and v2 are still recognised by their built-in spellings', () => {
  const v1rows = readCsv(AMAZON_V1_FIXTURE);
  assert.equal(AP.amazonAssessFormat(v1rows[0], null, []).needsMapping, false);
  assert.equal(AP.amazonAssessFormat(v2rows[0], null, []).needsMapping, false);
});

test('a renamed format gets its own version and identity, never v1 or v2', () => {
  const a = AP.amazonAssessFormat(v3header, null, []);
  const mapping = Object.fromEntries(a.suggestions.map(x => [x.normalised, x.field]));
  const p = AP.parseAmazonMetricData(v3rows, { mapping });
  assert.match(p.capabilities.reportVersion, /^metric-data new format [0-9a-f]{6}$/);
  assert.notEqual(p.capabilities.reportVersion, 'metric-data v2');
  const again = AP.parseAmazonMetricData(v3rows, { mapping });
  assert.equal(again.capabilities.reportVersion, p.capabilities.reportVersion, 'stable across re-imports');
});

test('the two known formats are recognised by exact fingerprint', () => {
  const v1rows = readCsv(AMAZON_V1_FIXTURE);
  assert.equal(AP.parseAmazonMetricData(v1rows).capabilities.reportVersion, 'metric-data v1');
  assert.equal(v2.capabilities.reportVersion, 'metric-data v2');
});
