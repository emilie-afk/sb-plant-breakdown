// Canonical classification across Shopify, Amazon and ShipStation market rows.
// Synthetic titles only: they reproduce the PATTERNS found in the audit
// (heat packs typed as fertilizer, pot-size descriptors, marketing phrases,
// cultivar names in quotes), not real product listings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadBrowserGlobals, ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const PG = require(path.join(ROOT, 'product-grouping.js'));
const MR = require(path.join(ROOT, 'market-report.js'));
const g = loadBrowserGlobals();
const O = { detectGenus: g.detectGenus, detectAllGenera: g.detectAllGenera, detectNonPlantType: g.detectNonPlantType };
const C = (title, ptype = '', extra = {}) => PG.classifyRecord(Object.assign({ title, ptype }, extra), O);

// ── category and genus are separate fields ──────────────────────────────
test('a plant: category Plants, genus kept, primary group = genus', () => {
  const c = C('Echeveria Lola', 'Succulents');
  assert.deepEqual([c.category, c.genus, c.group, c.groupType, c.isPlant], ['Plants', 'Echeveria', 'Echeveria', 'Genus', true]);
});
test('a gift box keeps an identifiable genus but groups as Gifts', () => {
  const c = C('Gift Wrapped Tillandsia Ionantha with Ceramic Vase', 'Air Plants');
  assert.equal(c.group, 'Gifts'); assert.equal(c.category, 'Gifts'); assert.equal(c.genus, 'Tillandsia');
  assert.equal(c.groupType, 'Product category');
});
test('a subscription keeps a genus only when one genus is named; never a pseudo-genus', () => {
  assert.equal(C('Air Plant Club - 1 Tillandsia a month', '').group, 'Subscriptions');
  const mixed = C('Plant Club - 1 Tillandsia + 1 Echeveria', '');
  assert.equal(mixed.group, 'Subscriptions'); assert.equal(mixed.genus, '');
  for (const t of ['Succulent Variety Pack', 'Monthly Subscription Box - 3 Plants'])
    assert.ok(!['Bundle', 'Subscription'].includes(C(t).genus), t);
});
test('a mixed pack is a category, never a genus, and has no genus', () => {
  const c = C('Sample Succulent Variety Pack (2" Pots) - 30-Pack');
  assert.deepEqual([c.group, c.groupType, c.genus, c.isPlant], ['Mixed variety pack', 'Product category', '', true]);
  const two = C('Echeveria and Sedum Bundle - 6 Pack');
  assert.equal(two.group, 'Mixed variety pack', 'two genera named: not forced into one');
});
test('a single-genus pack stays under its genus', () => {
  assert.equal(C('Sempervivum Variety Pack (2" Pots) - 15-Pack').group, 'Sempervivum');
});

// ── the reported misclassifications ─────────────────────────────────────
test('heat packs are Heat Packs whatever the stored type or a "(Subscription)" note', () => {
  for (const [t, p] of [['Heat Pack (Subscriber add-on)', 'Fertilizers'], ['Heat Pack', 'Accessories'],
                        ['HEAT PACK - keeps the box warm', ''], ['Warming Pack for Winter Shipping', 'Subscription']]) {
    const c = C(t, p);
    assert.equal(c.group, 'Heat Packs', t + ' / ' + p);
    assert.equal(c.genus, '');
  }
});
test('air plant food is Fertilizer, not Tillandsia', () => {
  assert.equal(C('Air Plant Food (4 oz)').group, 'Fertilizer');
  assert.equal(C('Air Plant Food', 'Air Plants').group, 'Fertilizer');
  assert.equal(C('Tillandsia Fertilizer Spray - 1oz', 'Gardening Tools').group, 'Fertilizer');
  assert.equal(C('Plant Food for Succulents').genus, '');
});
test('gift boxes and arrangements are Gifts, not ordinary plants', () => {
  assert.equal(C('Succulent Gift Box', 'Succulents').group, 'Gifts');
  assert.equal(C('Succulent Gift Box (2" Pots) - 8-Pack').group, 'Gifts');
  assert.equal(C('Live Succulent Arrangement in Modern Ceramic Planter').group, 'Gifts');
  assert.equal(C('Pet Memorial Gift Box', 'Gift').group, 'Gifts');
});
test('ordinary plants are NOT Gifts because of marketing phrases or cultivar names', () => {
  assert.equal(C("Opuntia 'Party Favor'").group, 'Opuntia');
  assert.equal(C('Haworthia Zebra - Live Plant, Great Gift for Mom, Wedding Favors').group, 'Haworthia');
  assert.equal(C('Mini Succulent - Gift Ideas, Party Favors, Home Decor (2 Inch)').group, 'Unidentified plant');
  assert.equal(C("Aeonium 'Irish Bouquet'", 'Succulents').group, 'Aeonium');
  // kids' party favors that are coloring sheets are stationery, not gifts
  assert.equal(C('Kids Party Favors - Coloring Sheets 6-Pack').group, 'Stationery & Cards');
});
test('pot-size descriptors do not turn plants or plant packs into Pots & Planters', () => {
  assert.equal(C('Sample Succulents Bulk Pack (2" Pots) - 60-Pack').group, 'Mixed variety pack');
  assert.equal(C('Pothos Golden - 4" Grower Pot').group, 'Pothos');
  assert.equal(C('Sulcorebutia Purple Cactus - Live Plant, 4 Inch White Pot').group, 'Sulcorebutia');
  assert.equal(C('Mini Succulent in 2 Inch Hexagon Ceramic Pot with Bamboo Drainage Tray').group, 'Unidentified plant');
  assert.equal(C('Low Light Variety Bundle - 4" Pots').group, 'Mixed variety pack');
  // ...while real pots stay pots, including pots "for succulents"
  assert.equal(C('Square Pot 4.5" x 4.0" Grey').group, 'Pots & Planters');
  assert.equal(C('Clay Terracotta Pot Pack (3"x3") - 10-Pack').group, 'Pots & Planters');
  assert.equal(C('3 inch Terracotta Pot | Small Clay Pot for Succulents & Air Plants').group, 'Pots & Planters');
  assert.equal(C('Houseplant Print Pot').group, 'Pots & Planters');
});
test('subscriptions vs products that merely mention one', () => {
  assert.equal(C('5 Plants/Month Auto renew', 'Pots & Planters').group, 'Subscriptions');
  assert.equal(C('Gift 3 plants/ month - 6 month Subscription - prepaid', 'Subscription').group, 'Subscriptions');
  assert.equal(C('Heat Pack (Subscription)', 'Fertilizers').group, 'Heat Packs', 'the bracket note does not make it a subscription');
});
test('gift cards vs printables vs greeting cards', () => {
  assert.equal(C('Gift Card - $20 | Plant Gift Card', 'Greeting Card').group, 'Gift Cards');
  assert.equal(C('eGift Card | Online Store', 'Gift').group, 'Gift Cards');
  assert.equal(C('Printable: Garden Party Gift Tag', 'Gift Card').group, 'Stationery & Cards');
  assert.equal(C('Best Wishes Card', 'Greeting Card').group, 'Stationery & Cards');
});
test('mystery single plants are plants; mystery packs are mixed packs', () => {
  assert.equal(C('Mystery Cactus [medium]').group, 'Unidentified plant');
  assert.equal(C('Assorted Mystery Succulents Pack (8)').group, 'Mixed variety pack');
});
test('missing genera, hybrids and misspellings are recognised', () => {
  for (const [t, gname] of [['Dionaea muscipula - Venus Flytrap', 'Dionaea'], ['Drosera capensis', 'Drosera'],
    ['Sarracenia purpurea', 'Sarracenia'], ['Rosularia platyphylla', 'Rosularia'], ['Cylindropuntia spinosior', 'Cylindropuntia'],
    ["Gasterhaworthia 'Sample'", 'Gasterhaworthia'], ["Echinobivia 'Rainbow'", 'Echinobivia'], ["Cremneria 'Expatriata'", 'Cremneria'],
    ['Alworthia pentagona', 'Alworthia'], ['Stomatium mustellinum', 'Stomatium'], ['Dicshidia oiantha', 'Dischidia'],
    ["Echinopis 'Crested'", 'Echinopsis'], ['Peanut Cactus - Echinopsis chamaecereus', 'Echinopsis'],
    ["Zygocactus 'Christmas Cactus' - 4\" Pot", 'Schlumbergera']]) {
    assert.equal(C(t).group, gname, t);
  }
});
test('negations and bonus care guides do not change the category', () => {
  assert.equal(C('Tillandsia ionantha - Live Air Plant, No Soil Needed').group, 'Tillandsia');
  assert.equal(C('Crassula Sunset Succulent | Succulent Care Guide (2 inch)').group, 'Crassula');
});
test('books, decor and shipping protection get their own categories', () => {
  assert.equal(C('Container Gardens (Book)').group, 'Merchandise');
  assert.equal(C('Reindeer Moss (Natural)').group, 'Decor');
  assert.equal(C('Spanish Moss Bundle').group, 'Tillandsia', 'Spanish moss is Tillandsia, not decor');
  assert.equal(C('Winter Shipping Protection - up to 3 Plants').group, 'Shipping Protection');
});

// ── product type: evidence, not truth; raw value preserved ─────────────
test('type labels are canonical for filters; the raw value is never rewritten', () => {
  for (const t of ['Air Plant', 'Air Plants', 'Air PLants', 'AirPlant', 'airplants']) assert.equal(PG.canonicalProductType(t), 'Air Plants', t);
  assert.equal(PG.canonicalProductType('houseplant'), 'Houseplants');
  assert.equal(PG.canonicalProductType('Indoor Plants'), 'Houseplants', 'decided: one displayed label');
  const rec = { title: 'Tillandsia Bulbosa', ptype: 'Air PLants' };
  const c = PG.classifyRecord(rec, O);
  assert.equal(rec.ptype, 'Air PLants'); assert.equal(c.ptypeCanonical, 'Air Plants');
  const recs = [{ ptype: 'Air Plant', cur: { units: 1, net: 1 } }, { ptype: 'AirPlant', cur: { units: 2, net: 2 } }];
  assert.equal(PG.applyScope(recs, { ptype: 'Air Plants' }).length, 2);
  assert.equal(PG.aggregateByProductType(recs).length, 1);
});
test('a fulfilment label ("Dropship", "(none)") is no evidence: the title decides', () => {
  assert.equal(C('Hoya Krimson Princess - 4" Pot', 'Dropship').group, 'Hoya');
  assert.equal(C('Wave Pot 4.0" x 3.5"', '(none)').group, 'Pots & Planters');
});
test('a type/title disagreement the title settles is recorded, not silently hidden', () => {
  const s = PG.classifySuspicion({ title: 'Heat Pack', ptype: 'Fertilizers' }, O);
  assert.equal(s.kind, 'type_overruled_by_title'); assert.equal(s.severity, 'info');
});

// ── overrides: stable identifiers, legacy keys still honoured ──────────
test('override keys use stable ids per source', () => {
  assert.equal(PG.overrideKeyFor({ channel: 'shopify', productId: '123', title: 'X' }), 'shopify␟pid:123');
  assert.equal(PG.overrideKeyFor({ channel: 'amazon', asin: 'B0TEST' }), 'amazon␟B0TEST');
  assert.equal(PG.overrideKeyFor({ channel: 'market', vendor: 'Store A', sku: 'S-1', title: 'X' }), 'market␟Store A␟sku:S-1');
  assert.equal(PG.overrideKeyFor({ channel: 'shopify', title: 'X', vendor: 'V', ptype: 'T' }), 'shopify␟X␟V␟T');
});
test('an override saved under the old title key still applies, and re-saving moves it to the id key', () => {
  const rec = { channel: 'shopify', productId: '42', title: 'Mystery Plant', vendor: 'V', ptype: 'Succulents' };
  const legacy = { [PG.legacyOverrideKeyFor(rec)]: { group: 'Gifts', groupType: 'Product category' } };
  const c = PG.classifyRecord(rec, Object.assign({ override: PG.makeOverrideLookup(legacy) }, O));
  assert.equal(c.group, 'Gifts'); assert.equal(c.overridden, true);
  const moved = PG.setOverride(legacy, rec, { group: 'Gifts' });
  assert.deepEqual(Object.keys(moved), ['shopify␟pid:42']);
  // a renamed product keeps its override (same Product ID)
  const renamed = Object.assign({}, rec, { title: 'Mystery Plant (new name)' });
  assert.equal(PG.classifyRecord(renamed, Object.assign({ override: PG.makeOverrideLookup(moved) }, O)).group, 'Gifts');
  // an unrelated product with the same title but another id is untouched
  const other = Object.assign({}, rec, { productId: '43' });
  assert.equal(PG.classifyRecord(other, Object.assign({ override: PG.makeOverrideLookup(moved) }, O)).overridden, false);
});
test('a genus override sets category Plants; a category override keeps a plant-bearing genus', () => {
  const asGenus = PG.classifyRecord({ title: 'Mystery Cactus' }, Object.assign({ override: () => ({ group: 'Opuntia', groupType: 'Genus' }) }, O));
  assert.deepEqual([asGenus.category, asGenus.genus, asGenus.group], ['Plants', 'Opuntia', 'Opuntia']);
  const asGift = PG.classifyRecord({ title: 'Echeveria Lola' }, Object.assign({ override: () => ({ group: 'Gifts' }) }, O));
  assert.deepEqual([asGift.category, asGift.genus], ['Gifts', 'Echeveria']);
});

// ── the same rules in every view ────────────────────────────────────────
test('equivalent categories line up across sources in the cross-source "genus" field', () => {
  const shopGift = PG.legacyGenusOf(C('Birthday Gift Box', 'Gift', { channel: 'shopify' }));
  const mktGift = PG.legacyGenusOf(C('Succulent Gift Box (2" Pots) - 8-Pack', '(none)', { channel: 'market' }));
  assert.equal(shopGift, 'Gifts'); assert.equal(mktGift, 'Gifts');
  const shopSub = PG.legacyGenusOf(C('2 succulents/ month - 3 month Subscription', 'Subscription'));
  const mktSub = PG.legacyGenusOf(C('Monthly Subscription Box - 4 Plants', '(none)'));
  assert.equal(shopSub, 'Subscriptions'); assert.equal(mktSub, 'Subscriptions');
  const shopPack = PG.legacyGenusOf(C('Succulent Variety Packs', 'Unclassified'));
  const mktPack = PG.legacyGenusOf(C('Outdoor Succulents Pack (2" Pots) - 10-Pack', '(none)'));
  const azPack = PG.legacyGenusOf(C('Assorted Mystery Succulents Pack (8)', '', { channel: 'amazon' }));
  assert.deepEqual([shopPack, mktPack, azPack], ['Mixed variety pack', 'Mixed variety pack', 'Mixed variety pack']);
  // distinct product types are NOT merged to make totals align
  assert.equal(PG.legacyGenusOf(C('Heat Pack', 'Accessories')), '(no genus)');
  assert.notEqual(PG.legacyGenusOf(C('Gift Card - $25', 'Gift Card')), 'Gifts');
});
test('the market snapshot groups with the shared classifier', () => {
  const report = { id: 'r', period_start: '2026-09-01', period_end: '2026-09-30', imported_at: 'x', revision: 1 };
  const rows = [
    { title: 'Succulent Gift Box (2" Pots) - 8-Pack', vendor: 'Store A', sku: 'A', productType: '(none)', cur: { units: 2, net: 50 } },
    { title: 'Air Plant Food (4 oz)', vendor: 'Store A', sku: 'B', productType: '(none)', cur: { units: 1, net: 9 } },
    { title: 'Coupon', vendor: 'Store A', sku: '', productType: '(adjustment)', cur: { units: 0, net: -5 } }
  ];
  const legacyGenus = (rec) => PG.legacyGenusOf(PG.classifyRecord(rec, O));
  const snap = MR.marketExternalSnapshotFromShared(report, rows, { legacyGenus });
  assert.deepEqual(snap.products.map(p => p.genus), ['Gifts', '(no genus)']);
  assert.equal(snap.products.reduce((s, p) => s + p.estRev, 0), 59, 'adjustments stay out; figures untouched');
});

// ── reconciliation ──────────────────────────────────────────────────────
test('re-classifying changes groups only: sales and units are unchanged and every product has one group', () => {
  const titles = ['Heat Pack (Subscription)', 'Air Plant Food', 'Succulent Gift Box', "Opuntia 'Party Favor'",
    'Sample Succulents Bulk Pack (2" Pots) - 60-Pack', 'Square Pot 4.5"', 'Mystery Cactus', 'Dicshidia oiantha',
    'Gift Card - $20', 'Unknown Thing 123', 'Echeveria Lola', 'Sedum and Aeonium Bundle - 6 Pack'];
  const recs = titles.map((t, i) => ({ title: t, ptype: i % 3 ? '' : 'Succulents', vendor: i === 9 ? 'Route' : 'V',
    cur: { units: i + 1, gross: 10 * (i + 1), disc: 0, ret: 0, net: 10 * (i + 1), tax: 0, total: 10 * (i + 1), glance: 0, inv: 0 },
    prior: {}, priorKnown: false }));
  const before = JSON.stringify(recs.map(r => r.cur));
  recs.forEach(r => { const c = PG.classifyRecord(r, O); r.group = c.group; r.groupType = c.groupType; r.isPlant = c.isPlant; });
  assert.equal(JSON.stringify(recs.map(r => r.cur)), before);
  assert.ok(recs.every(r => typeof r.group === 'string' && r.group.length));
  const split = PG.splitExclusions(recs);
  assert.equal(split.excluded.length, 1, 'the Route exclusion still applies');
  const groups = PG.aggregateByGroup(split.included);
  const sum = (a, f) => Math.round(a.reduce((s, x) => s + f(x), 0) * 100) / 100;
  assert.equal(sum(groups, b => b.cur.net), sum(split.included, r => r.cur.net));
  assert.equal(sum(groups, b => b.cur.units), sum(split.included, r => r.cur.units));
  assert.equal(sum(groups, b => b.products), split.included.length, 'each product counted in exactly one group');
});
test('channel separation is unaffected: Sellbrite rows are still filtered before grouping', () => {
  const mk = (ch, net) => ({ title: 'Succulent Gift Box', vendor: 'V', ptype: 'Succulents', productId: '9', salesChannel: ch,
    channelGroup: /sellbrite/i.test(ch) ? 'amazon' : 'own', cur: { units: 1, net, gross: net, disc: 0, ret: 0, tax: 0, total: net }, prior: {} });
  const own = PG.filterChannel([mk('Online Store', 30), mk('Sellbrite', 20)], 'own');
  assert.equal(own.length, 1); assert.equal(own[0].cur.net, 30);
  assert.equal(PG.classifyRecord(own[0], O).group, 'Gifts');
});
