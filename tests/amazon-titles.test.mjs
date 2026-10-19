// Amazon CLASSIFICATION on marketplace-style listing titles.
//
// Fixture: tests/fixtures/amazon-order-extract-sample.csv — SYNTHETIC
// (tools/make-sample-fixtures.mjs): the layout of an order-report extract
// reduced to ASIN, product title, units and sales. Marketplace titles are
// keyword-heavy ("Live Plant ... Great Gift Ideas ..."), which is what this
// test exercises.
//
// PRIVACY: an order report carries ship-city/state/postal code, country and
// buyer identification fields. An extract used for testing must hold only
// ASIN, title, units and sales, aggregated to product level — the header check
// below enforces that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, ROOT, AMAZON_ORDERS_FIXTURE, FACTS } from './load.mjs';

const require = createRequire(import.meta.url);
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));
require(path.join(ROOT, 'shopify-report.js'));
const globals = loadBrowserGlobals();
const detectors = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };

const rows = readCsv(AMAZON_ORDERS_FIXTURE);
const products = rows.slice(1).filter(r => r[1]).map(r => ({
  asin: r[0], title: r[1], glance: 0, conv: 0,
  units: Number(r[4]) || 0, avg: Number(r[5]) || 0, rev: Number(r[6]) || 0, inv: 0
}));
const recs = AR.amazonNormalizeSnapshot({ products }, {
  classify: (r) => PG.classifyRecord(r, detectors),
  suspicion: (r) => PG.classifySuspicion(r, detectors)
});
const { included } = PG.splitExclusions(recs);
const buckets = PG.aggregateByGroup(included);

test('the extract carries no customer data', () => {
  assert.deepEqual(rows[0], ['ASIN', 'Item name', 'Glance Views', 'Unit Session Percentage',
                             'Units Ordered', 'Average Sales Price', 'Ordered Product Sales', 'Available Inventory']);
  const banned = /ship-|buyer|postal|cpf|order-id|customized/i;
  assert.ok(!rows[0].some(h => banned.test(h)), 'no customer-ish column may exist');
  assert.equal(products.length, FACTS.amazon.orders.rows);
});

test('Amazon ASINs are exactly 10 characters', () => {
  // parseAmazon extracts ASINs with a 10-character pattern, so an 11-character
  // placeholder would merge distinct products onto one key.
  const asins = products.map(p => p.asin);
  assert.ok(asins.every(a => a.length === 10), 'every ASIN is 10 chars');
  assert.equal(new Set(asins).size, asins.length, 'and they are unique');
});

test('every product is classified into exactly one group', () => {
  assert.equal(buckets.reduce((s, b) => s + b.products, 0), included.length);
  assert.ok(included.every(r => r.group && r.group !== '' && r.group !== '(no genus)'));
});

test('group totals reconcile to the source extract', () => {
  const src = Math.round(products.reduce((s, p) => s + p.rev, 0) * 100) / 100;
  const grouped = Math.round(buckets.reduce((s, b) => s + b.cur.net, 0) * 100) / 100;
  assert.equal(grouped, src);
  assert.equal(buckets.reduce((s, b) => s + b.cur.units, 0), products.reduce((s, p) => s + p.units, 0));
});

test('marketplace titles resolve to many genera, not one catch-all bucket', () => {
  const genera = buckets.filter(b => b.groupType === PG.GROUP_TYPE_GENUS);
  assert.ok(genera.length >= 40, `only ${genera.length} genera resolved`);
  for (const want of ['Echeveria', 'Haworthia', 'Tillandsia', 'Crassula', 'Philodendron', 'Calathea', 'Peperomia']) {
    assert.ok(buckets.some(b => b.group === want), `missing genus ${want}`);
  }
  // No single group may swallow the catalogue.
  const biggest = Math.max(...buckets.map(b => b.products));
  assert.ok(biggest < included.length * 0.25, `one group holds ${biggest} of ${included.length} products`);
});

test('unidentified plants stay a small, genuinely genus-less minority', () => {
  const unid = included.filter(r => r.group === PG.GROUP_UNIDENTIFIED_PLANT);
  const unclass = included.filter(r => r.group === PG.GROUP_UNCLASSIFIED);
  assert.ok(unid.length <= 15, `${unid.length} unidentified plants`);
  assert.equal(unclass.length, 0, 'nothing fell through to Unclassified');
  // They are plants, and they are kept visible.
  assert.ok(unid.every(r => r.isPlant && r.groupType === PG.GROUP_TYPE_GENUS));
});

test('"gift ideas" in a plant listing does not make it a Gift', () => {
  // Amazon titles are keyword-stuffed. A cactus marketed with "Gift Ideas"
  // is still a cactus; only an actual gift box/set is a Gift.
  const giftWorded = included.filter(r => /gift/i.test(r.title));
  assert.ok(giftWorded.length > 3, 'the data must contain gift-worded plant listings');
  const miscategorised = giftWorded.filter(r => r.group === 'Gifts' && !/gift (box|set|basket|bag)/i.test(r.title));
  assert.equal(miscategorised.length, 0,
    'gift-worded plants wrongly filed as Gifts: ' + miscategorised.map(r => r.title.slice(0, 60)).join(' | '));
});

test('non-plant products are categorised, not forced onto the plant side', () => {
  const nonPlants = included.filter(r => !r.isPlant);
  assert.ok(nonPlants.length > 0);
  assert.ok(nonPlants.every(r => r.groupType === PG.GROUP_TYPE_CATEGORY));
  const names = new Set(nonPlants.map(r => r.group));
  assert.ok(names.size >= 2, 'more than one non-plant category: ' + [...names].join(', '));
});

test('Amazon records still declare what the export does not contain', () => {
  assert.ok(recs.every(r => r.vendor === AR.AMAZON_NO_VENDOR));
  assert.ok(recs.every(r => r.ptype === AR.AMAZON_NO_TYPE));
  assert.ok(recs.every(r => r.cur.tax === 0 && r.cur.total === r.cur.net));
});
