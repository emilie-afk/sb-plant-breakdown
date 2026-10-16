// Amazon now runs through the SAME grouping module as Shopify.
//
// Fixture note: no real Amazon export was available on this machine, so
// tests/fixtures/amazon-metric-data-*.csv are SYNTHETIC. The column shape is
// the genuine 8-column "metric data" export that app.js's parseAmazon reads,
// and the product mix mirrors the real catalogue, but the figures are
// invented. Live verification against a real Amazon export is outstanding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, ROOT, FIXTURES } from './load.mjs';

const require = createRequire(import.meta.url);
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));
require(path.join(ROOT, 'shopify-report.js'));            // supplies shopifyChange
const SR = require(path.join(ROOT, 'shopify-report.js'));
const globals = loadBrowserGlobals();

const detectors = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };
const classify = (r) => PG.classifyRecord(r, detectors);
const suspicion = (r) => PG.classifySuspicion(r, detectors);

// Reproduce app.js's parseAmazon for the 8-column metric-data format.
function parseAmazonFixture(file) {
  const rows = readCsv(path.join(FIXTURES, file));
  const num = (x) => {
    const n = parseFloat(String(x ?? '').replace(/[,$\s%]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  return rows.slice(1).filter(r => r[1]).map(r => {
    let conv = num(r[3]); if (conv > 1) conv /= 100;
    return { asin: r[0], title: r[1], glance: num(r[2]), conv, units: num(r[4]),
             avg: num(r[5]), rev: num(r[6]), inv: num(r[7]),
             genus: globals.detectGenus(r[1]) || '(no genus)' };
  });
}

const curSnap = { id: 'amazon_2026-09-01_2026-09-30', source: 'amazon', label: 'Sep 2026',
                  startDate: '2026-09-01', endDate: '2026-09-30', uploadedAt: '2026-10-01T00:00:00Z',
                  fileName: 'amazon-metric-data-2026-09.csv', products: parseAmazonFixture('amazon-metric-data-2026-09.csv') };
const priSnap = { id: 'amazon_2026-08-01_2026-08-31', source: 'amazon', label: 'Aug 2026',
                  startDate: '2026-08-01', endDate: '2026-08-31', uploadedAt: '2026-09-01T00:00:00Z',
                  fileName: 'amazon-metric-data-2026-08.csv', products: parseAmazonFixture('amazon-metric-data-2026-08.csv') };

const recs = AR.amazonNormalizeSnapshot(curSnap, { classify, suspicion });
const priorRecs = AR.amazonNormalizeSnapshot(priSnap, { classify, suspicion });
AR.amazonAttachPrior(recs, priorRecs);
const { included, excluded } = PG.splitExclusions(recs);
const sum = (rs, k) => Math.round(rs.reduce((s, r) => s + r.cur[k], 0) * 100) / 100;

// ────────────────────────────────────────────────────────────
// It really is the shared module
// ────────────────────────────────────────────────────────────
test('Amazon records carry the shared classification fields', () => {
  assert.equal(recs.length, 25);
  for (const r of recs) {
    assert.ok(r.group, `${r.title} has no group`);
    assert.ok(r.groupType === PG.GROUP_TYPE_GENUS || r.groupType === PG.GROUP_TYPE_CATEGORY);
    assert.equal(typeof r.isPlant, 'boolean');
    assert.equal(r.channel, 'amazon');
  }
});

test('Amazon groups plants by genus and everything else by category', () => {
  const g = (t) => recs.find(r => r.title === t);
  assert.equal(g("Echeveria 'Perle Von Nurnberg' 2 inch Live Succulent").group, 'Echeveria');
  assert.equal(g("Echeveria 'Perle Von Nurnberg' 2 inch Live Succulent").groupType, PG.GROUP_TYPE_GENUS);
  assert.equal(g('Monstera Deliciosa 6 inch Live Houseplant').group, 'Monstera');
  assert.equal(g('Tillandsia Ionantha Air Plant 5 Pack').group, 'Tillandsia');
  assert.equal(g('Succulent and Cactus Potting Soil Mix 4 Quart').group, 'Soil');
  assert.equal(g('Succulent Plant Food Fertilizer 8 oz').group, 'Fertilizer');
  assert.equal(g('4 inch Ceramic Planter Pot with Drainage').group, 'Pots & Planters');
  assert.equal(g('Mini Garden Tool Set with Tweezers and Scissors').group, 'Tools');
  assert.equal(g('Succulent Subscription Box 3 Month Plan').group, 'Subscriptions');
  for (const t of ['Soil', 'Fertilizer', 'Pots & Planters', 'Tools', 'Subscriptions']) {
    assert.equal(recs.find(r => r.group === t).groupType, PG.GROUP_TYPE_CATEGORY, t);
  }
});

test('non-plant Amazon products are NOT all dumped into one bucket', () => {
  const cats = PG.aggregateByGroup(included).filter(b => b.groupType === PG.GROUP_TYPE_CATEGORY);
  const names = cats.map(c => c.group).sort();
  assert.ok(cats.length >= 6, names.join(', '));
  for (const want of ['Soil', 'Fertilizer', 'Pots & Planters', 'Tools', 'Subscriptions', 'Gifts']) {
    assert.ok(names.includes(want), `missing ${want}`);
  }
  assert.ok(!names.includes('(no genus)'));
});

test('an unidentified Amazon plant is separate from an unclassified product', () => {
  // "Ruby Glow Succulent 2 inch" matches no genus pattern, but the title
  // plainly says it is a live plant.
  const ruby = recs.find(r => r.title === 'Ruby Glow Succulent 2 inch');
  assert.equal(ruby.group, PG.GROUP_UNIDENTIFIED_PLANT);
  assert.equal(ruby.isPlant, true);
  assert.equal(ruby.groupType, PG.GROUP_TYPE_GENUS);

  // "ZZQQ 9000" says nothing at all. It is NOT quietly called a plant.
  const zz = recs.find(r => r.title === 'ZZQQ 9000');
  assert.equal(zz.group, PG.GROUP_UNCLASSIFIED);
  assert.equal(zz.isPlant, false);
  assert.equal(zz.groupType, PG.GROUP_TYPE_CATEGORY);

  assert.notEqual(ruby.group, zz.group);
});

test('a pack of cards is stationery, not a plant variety pack', () => {
  // detectGenus() calls anything with "Pack" a Bundle and detectNonPlantType()
  // tests /pack/ before /card/, so without the title-category rules this row
  // would be grouped as a plant.
  const cards = recs.find(r => r.title === 'Succulent Care Guide Greeting Card 10 Pack');
  assert.equal(cards.group, 'Stationery & Cards');
  assert.equal(cards.isPlant, false);
  const pots = recs.find(r => r.title === 'Terracotta Clay Pot 6 Pack');
  assert.equal(pots.group, 'Pots & Planters');
  assert.equal(pots.isPlant, false);
});

test('a gift containing succulents is a Gift on Amazon too', () => {
  const box = recs.find(r => r.title === 'Succulent Gift Box Set of 4 with Pots');
  assert.equal(box.group, 'Gifts');
  assert.equal(box.isPlant, false);
  const groups = PG.aggregateByGroup(included);
  assert.equal(groups.filter(g => g.records.includes(box)).length, 1, 'counted exactly once');
});

test('no Amazon product is hidden because genus detection failed', () => {
  const groups = PG.aggregateByGroup(included);
  assert.equal(groups.reduce((s, g) => s + g.products, 0), included.length);
  assert.ok(included.some(r => !r.genus));
  assert.ok(included.every(r => r.group && r.group !== '' && r.group !== '(no genus)'));
});

test('all products are in scope by default', () => {
  assert.equal(PG.applyScope(included, {}).length, included.length);
  const plants = PG.applyScope(included, { plantScope: 'plants' });
  const nonPlants = PG.applyScope(included, { plantScope: 'nonplants' });
  assert.equal(plants.length + nonPlants.length, included.length);
  assert.equal(Math.round((sum(plants, 'net') + sum(nonPlants, 'net')) * 100) / 100, sum(included, 'net'));
});

// ────────────────────────────────────────────────────────────
// Reconciliation
// ────────────────────────────────────────────────────────────
test('Amazon group totals reconcile to the snapshot totals', () => {
  const t = AR.amazonSnapshotTotals(curSnap);
  assert.equal(t.net, 23428.64);
  assert.equal(t.units, 1436);
  const groups = PG.aggregateByGroup(included);
  assert.equal(Math.round(groups.reduce((s, g) => s + g.cur.net, 0) * 100) / 100, t.net - sum(excluded, 'net'));
  assert.equal(groups.reduce((s, g) => s + g.cur.units, 0), t.units - sum(excluded, 'units'));
});

test('Amazon traffic and inventory survive aggregation; conversion is derived', () => {
  const groups = PG.aggregateByGroup(included);
  const ech = groups.find(g => g.group === 'Echeveria');
  assert.equal(ech.cur.glance, 4210 + 1980);
  assert.equal(ech.cur.units, 261 + 81);
  assert.equal(ech.cur.inv, 180 + 42);
  assert.ok(Math.abs(PG.conversionOf(ech.cur) - (342 / 6190)) < 1e-9);
  // Conversion is never summed.
  assert.equal(ech.cur.conv, undefined);
});

test('Amazon sales stay Ordered product sales and are never given a tax split', () => {
  for (const r of recs) {
    assert.equal(r.cur.tax, 0);
    assert.equal(r.cur.total, r.cur.net);
    assert.equal(r.cur.gross, 0);
    assert.equal(r.cur.disc, 0);
  }
});

test('Amazon has no vendor or product type, and says so rather than faking one', () => {
  assert.ok(recs.every(r => r.vendor === AR.AMAZON_NO_VENDOR));
  assert.ok(recs.every(r => r.ptype === AR.AMAZON_NO_TYPE));
  assert.ok(recs.every(r => r.ptypeBlank === true));
  // ...and "no product type" is not flagged as a per-row problem.
  assert.equal(recs.filter(r => r.suspicion && r.suspicion.kind === 'missing_type').length, 0);
});

// ────────────────────────────────────────────────────────────
// Comparison between snapshots
// ────────────────────────────────────────────────────────────
test('a prior snapshot is matched on ASIN, and the basis is recorded', () => {
  const ech = recs.find(r => r.asin === 'B0SUCC0001');
  assert.equal(ech.priorMatch, 'asin');
  assert.equal(ech.prior.net, 3128.52);
  assert.equal(ech.prior.units, 348);
  const ch = SR.shopifyChange(ech.cur.net, ech.prior.net, true);
  assert.equal(ch.state, 'ok');
  assert.ok(ch.pct < 0);
  assert.equal(ch.abs, Math.round((2346.39 - 3128.52) * 100) / 100);
});

test('a product with no prior row reports "New / no prior sales"', () => {
  const fresh = recs.find(r => r.asin === 'B0NEW000001');
  assert.equal(fresh.priorMatch, 'none');
  assert.equal(fresh.prior.net, 0);
  const ch = SR.shopifyChange(fresh.cur.net, fresh.prior.net, true);
  assert.equal(ch.state, 'new');
  assert.equal(ch.pct, null);
  assert.equal(SR.shopifyChangeLabel(ch), 'New / no prior sales');
});

test('a product that sold nothing last period is "New", not a percentage', () => {
  const card = recs.find(r => r.asin === 'B0CARD0001');
  assert.equal(card.prior.net, 0);
  assert.equal(SR.shopifyChange(card.cur.net, card.prior.net, true).state, 'new');
});

test('without a comparison snapshot every change reads "no prior period"', () => {
  const solo = AR.amazonNormalizeSnapshot(curSnap, { classify, suspicion });
  assert.ok(solo.every(r => r.priorKnown === false));
  assert.equal(SR.shopifyChange(solo[0].cur.net, solo[0].prior.net, solo[0].priorKnown).state, 'unknown');
});

test('group-level comparison reconciles to the product-level comparison', () => {
  const groups = PG.aggregateByGroup(included);
  for (const g of groups) {
    assert.equal(Math.round(g.records.reduce((s, r) => s + r.prior.net, 0) * 100) / 100, g.prior.net);
  }
});

// ────────────────────────────────────────────────────────────
// Exclusions and alerts
// ────────────────────────────────────────────────────────────
test('exclusion rules apply on Amazon too, and nothing matches by default', () => {
  assert.equal(excluded.length, 0, 'no Route vendor exists on Amazon');
  assert.equal(included.length, recs.length);
});

test('zero inventory with traffic is still detectable after grouping', () => {
  const oos = included.filter(r => r.cur.inv === 0 && r.cur.glance > 0);
  assert.ok(oos.length >= 2);
  assert.ok(oos.some(r => r.title === 'Haworthia Zebra Plant 2 inch'));
});
