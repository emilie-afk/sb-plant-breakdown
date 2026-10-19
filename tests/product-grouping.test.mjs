// Classification, exclusion, scope and aggregation tests.
// Assertions use deterministic synthetic fixtures and generated sample facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, SAMPLE_FIXTURE, FACTS, ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const globals = loadBrowserGlobals();

const classify = (rec) => PG.classifyRecord(rec, {
  detectGenus: globals.detectGenus,
  detectNonPlantType: globals.detectNonPlantType
});

const parsed = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
const F = FACTS.shopify, A = F.anchors, V = F.vendorNames;
const split = PG.splitExclusions(parsed.records);
const included = split.included;
const excluded = split.excluded;

const sum = (recs, k) => Math.round(recs.reduce((s, r) => s + r.cur[k], 0) * 100) / 100;

// ────────────────────────────────────────────────────────────
// Exclusions
// ────────────────────────────────────────────────────────────
test('Route is excluded by default and reported separately', () => {
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].vendor, 'Route');
  assert.equal(excluded[0].title, A.route.title);
  assert.equal(excluded[0].exclusionId, 'route');
  assert.equal(excluded[0].cur.net, F.routeNet);
});

test('excluded + included reconciles exactly to the source total', () => {
  assert.equal(sum(included, 'net') + sum(excluded, 'net'), parsed.totals.current.net);
  assert.equal(sum(included, 'net'), F.includedNet);
  assert.equal(sum(included, 'units') + sum(excluded, 'units'), F.cur.units);
});

test('an excluded product is marked excluded, not unclassified and not unmatched', () => {
  assert.equal(excluded[0].excluded, true);
  assert.notEqual(excluded[0].group, PG.GROUP_UNCLASSIFIED);
  assert.equal(excluded[0].group, 'Shipping Protection');
  assert.ok(included.every(r => r.excluded === false));
});

test('exclusion rules can be turned off without touching the parser', () => {
  const none = PG.splitExclusions(parsed.records.map(r => Object.assign({}, r)),
    [{ id: 'route', label: 'Route', match: () => false }]);
  assert.equal(none.excluded.length, 0);
  assert.equal(sum(none.included, 'net'), F.cur.net);
});

// ────────────────────────────────────────────────────────────
// Classification: one record, one primary group
// ────────────────────────────────────────────────────────────
test('every record lands in exactly one group, so group totals reconcile', () => {
  const groups = PG.aggregateByGroup(included);
  assert.equal(groups.reduce((s, g) => s + g.products, 0), included.length);
  assert.equal(Math.round(groups.reduce((s, g) => s + g.cur.net, 0) * 100) / 100, F.includedNet);
  assert.equal(groups.reduce((s, g) => s + g.cur.units, 0), sum(included, 'units'));
});

test('group totals reconcile for every measure, not just net sales', () => {
  const groups = PG.aggregateByGroup(included);
  for (const k of ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total']) {
    const g = Math.round(groups.reduce((s, b) => s + b.cur[k], 0) * 100) / 100;
    assert.equal(g, sum(included, k), `measure ${k}`);
  }
});

test('a plant is grouped by genus, a non-plant by category, and the type is labelled', () => {
  const groups = PG.aggregateByGroup(included);
  const echeveria = groups.find(g => g.group === 'Echeveria');
  assert.equal(echeveria.groupType, PG.GROUP_TYPE_GENUS);
  assert.equal(echeveria.isPlant, true);
  const subs = groups.find(g => g.group === 'Subscriptions');
  assert.equal(subs.groupType, PG.GROUP_TYPE_CATEGORY);
  assert.equal(subs.isPlant, false);
});

test('non-plant products are NOT all dumped into one "no genus" bucket', () => {
  const cats = PG.aggregateByGroup(included).filter(g => g.groupType === PG.GROUP_TYPE_CATEGORY);
  const names = cats.map(c => c.group).sort();
  assert.ok(cats.length >= 6, `expected several categories, got ${names.join(', ')}`);
  for (const expected of ['Subscriptions', 'Gifts', 'Pots & Planters', 'Accessories', 'Fertilizer', 'Tools']) {
    assert.ok(names.includes(expected), `missing category ${expected}`);
  }
  assert.ok(!names.includes('(no genus)'));
});

test('an unidentified plant genus is a different group from a non-plant', () => {
  const unid = included.filter(r => r.group === PG.GROUP_UNIDENTIFIED_PLANT);
  assert.ok(unid.length > 0);
  assert.ok(unid.every(r => r.isPlant === true));
  assert.ok(unid.every(r => r.groupType === PG.GROUP_TYPE_GENUS));
  // e.g. "Pink Starlight" is typed Succulents but matches no genus pattern.
  assert.ok(unid.some(r => r.title === A.unidentified.title));
  const unclass = included.filter(r => r.group === PG.GROUP_UNCLASSIFIED);
  assert.ok(unclass.every(r => r.isPlant === false));
});

test('no product is hidden because genus detection returned nothing', () => {
  const noGenus = included.filter(r => !r.genus);
  assert.ok(noGenus.length > 0);
  const groups = PG.aggregateByGroup(included);
  for (const r of noGenus) {
    assert.ok(groups.some(g => g.group === r.group), `${r.title} has no group`);
    assert.notEqual(r.group, '');
    assert.notEqual(r.group, '(no genus)');
  }
});

test('a gift containing a succulent is a Gift, not a succulent genus', () => {
  const arrangement = included.find(r => r.title === A.giftHeart.title);
  assert.equal(arrangement.ptype, 'Gift');
  assert.equal(arrangement.group, 'Gifts');
  assert.equal(arrangement.isPlant, false);
  // ...and it is counted once, in Gifts only.
  const groups = PG.aggregateByGroup(included);
  const inGifts = groups.find(g => g.group === 'Gifts').records.filter(r => r === arrangement).length;
  assert.equal(inGifts, 1);
  assert.equal(groups.filter(g => g.records.includes(arrangement)).length, 1);
});

test('an explicit override beats the product type', () => {
  const rec = { title: A.giftHeart.title, ptype: 'Gift', vendor: V.own };
  const c = PG.classifyRecord(rec, {
    detectGenus: globals.detectGenus,
    detectNonPlantType: globals.detectNonPlantType,
    override: () => ({ group: 'Echeveria', isPlant: true })
  });
  assert.equal(c.group, 'Echeveria');
  assert.equal(c.groupType, PG.GROUP_TYPE_GENUS);
  assert.equal(c.basis, 'override');
});

test('the store\'s inconsistent air-plant spellings all resolve to plants', () => {
  for (const t of ['Air Plant', 'Air PLants', 'Air Plants', 'AirPlant']) {
    assert.equal(PG.classifyProductType(t).kind, 'plant', t);
  }
});

test('a blank product type falls back to the title without being dropped', () => {
  const blanks = included.filter(r => r.ptypeBlank);
  assert.equal(blanks.length, F.blankTypes);
  assert.ok(blanks.every(r => r.group && r.group !== ''));
  const pot = blanks.find(r => r.title === A.blankPot.title);
  assert.equal(pot.group, 'Pots & Planters');
  assert.equal(pot.isPlant, false);
  const fert = blanks.find(r => r.title === A.blankFert.title);
  assert.equal(fert.group, 'Fertilizer');
});

test('an unknown product type and an unreadable title end up Unclassified, visibly', () => {
  const c = PG.classifyRecord({ title: 'ZZQQ 9000', ptype: '' }, {
    detectGenus: () => '', detectNonPlantType: () => 'Other'
  });
  assert.equal(c.group, PG.GROUP_UNCLASSIFIED);
  assert.equal(c.groupType, PG.GROUP_TYPE_CATEGORY);
  assert.equal(c.isPlant, false);
});

// ────────────────────────────────────────────────────────────
// Vendor analytics
// ────────────────────────────────────────────────────────────
test('vendor totals reconcile to the included total', () => {
  const vendors = PG.aggregateByVendor(included);
  assert.equal(vendors.length, F.vendorCount - 1, 'every vendor in the file, minus the excluded Route');
  assert.equal(Math.round(vendors.reduce((s, v) => s + v.cur.net, 0) * 100) / 100, F.includedNet);
  assert.equal(vendors.reduce((s, v) => s + v.products, 0), included.length);
});

test('vendor analytics covers every product type, not just plants', () => {
  const sb = PG.aggregateByVendor(included).find(v => v.vendor === V.own);
  const types = new Set(sb.records.map(r => r.groupType));
  assert.ok(types.has(PG.GROUP_TYPE_GENUS) && types.has(PG.GROUP_TYPE_CATEGORY));
  // Non-plant revenue must be inside the vendor's own total.
  const nonPlantNet = sum(sb.records.filter(r => !r.isPlant), 'net');
  assert.ok(nonPlantNet > 0);
  assert.equal(sb.cur.net, Math.round((sum(sb.records.filter(r => r.isPlant), 'net') + nonPlantNet) * 100) / 100);
});

test('a product with no genus is still inside its vendor total', () => {
  const sb = PG.aggregateByVendor(included).find(v => v.vendor === V.own);
  const noGenus = sb.records.filter(r => !r.genus);
  assert.ok(noGenus.length > 0);
  assert.ok(sum(noGenus, 'net') > 0);
  assert.equal(sb.products, sb.records.length);
});

test('"products with recorded sales" excludes zero-sales rows but keeps them in the catalog count', () => {
  const sb = PG.aggregateByVendor(included).find(v => v.vendor === V.own);
  assert.equal(sb.products, F.vendors[V.own].rows);
  assert.ok(sb.withSales < sb.products);
  assert.equal(sb.withSales, sb.records.filter(r => r.cur.units !== 0 || r.cur.net !== 0).length);
});

test('share of sales is computed against the selected scope and sums to 1', () => {
  const vendors = PG.withShare(PG.aggregateByVendor(included), 'net');
  const total = vendors.reduce((s, v) => s + v.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('vendor prior-period values and changes are available', () => {
  const sb = PG.aggregateByVendor(included).find(v => v.vendor === V.own);
  assert.equal(sb.priorKnown, true);
  assert.ok(sb.prior.net > 0);
  const ch = SR.shopifyChange(sb.cur.net, sb.prior.net, sb.priorKnown);
  assert.equal(ch.state, 'ok');
  assert.equal(ch.abs, Math.round((sb.cur.net - sb.prior.net) * 100) / 100);
});

test('the drill-down path vendor to category to product keeps the same scope', () => {
  const vendorName = V.own;
  const scoped = PG.applyScope(included, { vendor: vendorName });
  const byType = PG.aggregateByProductType(scoped);
  assert.equal(Math.round(byType.reduce((s, b) => s + b.cur.net, 0) * 100) / 100, sum(scoped, 'net'));
  const byGroup = PG.aggregateByGroup(scoped);
  assert.equal(Math.round(byGroup.reduce((s, b) => s + b.cur.net, 0) * 100) / 100, sum(scoped, 'net'));
  // and the product rows inside each bucket add back up
  for (const b of byGroup) assert.equal(Math.round(b.records.reduce((s, r) => s + r.cur.net, 0) * 100) / 100, b.cur.net);
});

// ────────────────────────────────────────────────────────────
// Scope: one filter set for cards, tables, charts and exports
// ────────────────────────────────────────────────────────────
test('a vendor filter narrows every consumer identically', () => {
  const scoped = PG.applyScope(included, { vendor: V.drop });
  assert.equal(scoped.length, F.vendors[V.drop].rows);
  assert.ok(scoped.every(r => r.vendor === V.drop));
  const t = PG.groupTotals(scoped);
  assert.equal(t.cur.net, F.vendors[V.drop].net);
  // the same records are what an export would write
  assert.equal(PG.aggregateByGroup(scoped).reduce((s, b) => s + b.products, 0), scoped.length);
});

test('the default scope is every vendor, every type and every product', () => {
  assert.equal(PG.applyScope(included, {}).length, included.length);
  assert.equal(PG.applyScope(included, { vendor: 'All', ptype: 'All', group: 'All', plantScope: 'all' }).length, included.length);
});

test('plants-only and non-plants-only partition the scope exactly', () => {
  const plants = PG.applyScope(included, { plantScope: 'plants' });
  const nonPlants = PG.applyScope(included, { plantScope: 'nonplants' });
  assert.equal(plants.length + nonPlants.length, included.length);
  assert.equal(Math.round((sum(plants, 'net') + sum(nonPlants, 'net')) * 100) / 100, F.includedNet);
  assert.ok(plants.every(r => r.isPlant));
  assert.ok(nonPlants.every(r => !r.isPlant));
});

test('product search matches title, vendor and group', () => {
  assert.ok(PG.applyScope(included, { search: 'echeveria' }).length > 10);
  assert.equal(PG.applyScope(included, { search: V.gift.toLowerCase() }).length, F.vendors[V.gift].rows);
  assert.ok(PG.applyScope(included, { search: 'zzzz-no-such-product' }).length === 0);
});

test('a product type filter and a vendor filter compose', () => {
  const s = PG.applyScope(included, { vendor: V.own, ptype: 'Subscription' });
  assert.ok(s.length > 0);
  assert.ok(s.every(r => r.vendor === V.own && r.ptype === 'Subscription'));
});

// ────────────────────────────────────────────────────────────
// Derived measures
// ────────────────────────────────────────────────────────────
test('average sales per unit is net sales over units, and safe at zero units', () => {
  const groups = PG.aggregateByGroup(included);
  const g = groups.find(b => b.cur.units > 0);
  assert.equal(PG.avgPerUnit(g.cur), Math.round((g.cur.net / g.cur.units) * 100) / 100);
  assert.equal(PG.avgPerUnit({ units: 0, net: 10 }), 0);
});

test('a group of only zero-sales products still appears with zero, not absent', () => {
  const zeroOnly = included.filter(r => r.cur.units === 0 && r.cur.net === 0);
  assert.ok(zeroOnly.length > 0);
  const groups = PG.aggregateByGroup(zeroOnly);
  assert.ok(groups.length > 0);
  assert.ok(groups.every(g => g.withSales === 0 && g.products > 0));
});
