// The saved report's channel export, end to end: "Total sales by product + ID"
// grouped by product id, title, vendor, type AND sales channel, compared to the
// previous period, exported as "All results".
//
// Fixture: tests/fixtures/shopify-sales-channel-sample.csv — SYNTHETIC
// (tools/make-sample-fixtures.mjs), generated from the same invented product
// set as the built-in report sample, so the two must agree to the cent.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE, CHANNEL_FIXTURE, AMAZON_V1_FIXTURE, FACTS, r2 } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const g = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: g.detectGenus, detectNonPlantType: g.detectNonPlantType });
const res = SR.parseShopifyProductReport(readCsv(CHANNEL_FIXTURE), { classify });
const recs = res.records.map(SR.shopifyToSnapshotProduct);
const sum = (a, f) => r2(a.reduce((t, r) => t + r.cur[f], 0));
const CH = FACTS.channel;

test('the channel export parses cleanly with product id, channel and prior period', () => {
  assert.equal(res.ok, true, res.errors.join(' '));
  assert.deepEqual(res.warnings, []);
  assert.equal(res.rowCount, CH.rows);
  assert.equal(res.records.length, CH.rows, 'one record per product per channel, nothing merged at import');
  assert.equal(res.capabilities.hasProductId, true);
  assert.equal(res.capabilities.hasSalesChannel, true);
  assert.equal(res.capabilities.hasPrior, true);
});

test('totals equal the same period without channels, to the cent', () => {
  const plain = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
  assert.deepEqual(res.totals.current, plain.totals.current);
  assert.equal(res.totals.current.net, CH.cur.net);
  assert.equal(res.totals.prior.net, CH.prior.net);
  assert.equal(PG.filterChannel(recs, 'all').length, plain.records.length, 'merged across channels: the same products');
});

test('own store and Amazon via Sellbrite split the total exactly', () => {
  const ct = res.channelTotals;
  assert.equal(ct.amazon.units, CH.amazon.units);
  assert.equal(ct.amazon.net, CH.amazon.net);
  assert.equal(ct.own.units, CH.own.units);
  assert.equal(ct.own.net, CH.own.net);
  assert.equal(r2(ct.own.net + ct.amazon.net), CH.cur.net);
  assert.deepEqual(ct.channels.filter(c => c.group === 'amazon').map(c => c.channel), ['Sellbrite']);
  assert.deepEqual(ct.channels.map(c => c.channel).sort(), CH.channels);
  assert.equal(sum(PG.filterChannel(recs, 'own'), 'net'), CH.own.net);
  assert.equal(sum(PG.filterChannel(recs, 'amazon'), 'net'), CH.amazon.net);
  assert.equal(PG.filterChannel(recs, 'amazon').length, CH.amazonProducts);
});

test('Sellbrite units sit within 5% of Seller Central for the same period', () => {
  const az = AP.parseAmazonMetricData(readCsv(AMAZON_V1_FIXTURE));
  const sc = az.products.reduce((t, p) => t + p.units, 0);
  assert.equal(sc, FACTS.amazon.v1.units);
  assert.notEqual(sc, res.channelTotals.amazon.units, 'the two systems are expected to differ slightly');
  assert.ok(Math.abs(res.channelTotals.amazon.units - sc) <= sc * 0.05);
});
