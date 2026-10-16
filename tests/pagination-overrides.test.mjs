// Pagination, classification flags and overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, SAMPLE_FIXTURE, FACTS, ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const globals = loadBrowserGlobals();
const detectors = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };

function parseWith(overrideMap) {
  return SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), {
    classify: (r) => PG.classifyRecord(r, Object.assign({}, detectors, {
      override: overrideMap ? PG.makeOverrideLookup(overrideMap) : null
    })),
    suspicion: (r) => PG.classifySuspicion(r, detectors)
  });
}
const F = FACTS.shopify, A = F.anchors;
const N = F.included, PAGES = Math.ceil(N / 100), LAST = N - (PAGES - 1) * 100;
const parsed = parseWith(null);
const included = PG.splitExclusions(parsed.records).included;

// ────────────────────────────────────────────────────────────
// Pagination
// ────────────────────────────────────────────────────────────
test('the complete table can be browsed past row 200', () => {
  assert.equal(included.length, N);
  assert.ok(N > 300);
  const p1 = PG.paginate(included, 1, 100);
  assert.equal(p1.rows.length, 100);
  assert.equal(p1.pages, PAGES);
  assert.equal(p1.from, 1); assert.equal(p1.to, 100);

  const p3 = PG.paginate(included, 3, 100);
  assert.equal(p3.from, 201); assert.equal(p3.to, 300);
  assert.equal(p3.rows[0], included[200], 'page 3 starts at row 201');

  const last = PG.paginate(included, PAGES, 100);
  assert.equal(last.to, N);
  assert.equal(last.rows.length, LAST);
  assert.equal(last.rows[last.rows.length - 1], included[N - 1], 'the final product is reachable');
});

test('every product appears on exactly one page, and all of them are reachable', () => {
  const seen = new Set();
  const pages = PG.paginate(included, 1, 50).pages;
  for (let i = 1; i <= pages; i++) {
    for (const r of PG.paginate(included, i, 50).rows) {
      assert.ok(!seen.has(r), `${r.title} appeared twice`);
      seen.add(r);
    }
  }
  assert.equal(seen.size, included.length);
});

test('"All" returns the whole set as one page', () => {
  const p = PG.paginate(included, 1, 'all');
  assert.equal(p.rows.length, N);
  assert.equal(p.pages, 1);
  assert.equal(p.to, N);
});

test('an out-of-range page is clamped rather than returning nothing', () => {
  assert.equal(PG.paginate(included, 999, 100).page, PAGES);
  assert.equal(PG.paginate(included, 0, 100).page, 1);
  assert.equal(PG.paginate(included, -5, 100).page, 1);
  assert.ok(PG.paginate(included, 999, 100).rows.length > 0);
});

test('an empty result paginates to nothing without blowing up', () => {
  const p = PG.paginate([], 1, 100);
  assert.equal(p.total, 0); assert.equal(p.from, 0); assert.equal(p.to, 0); assert.equal(p.pages, 1);
});

test('SEARCH runs across the whole set before pagination, not within a page', () => {
  // "Echeveria" products are spread through the file, well past row 200.
  const matches = PG.applyScope(included, { search: 'echeveria' });
  assert.ok(matches.length > 20);
  const positions = matches.map(r => included.indexOf(r));
  assert.ok(Math.max(...positions) > 200, 'matches exist beyond the first page');
  // Paginating the matches never loses one.
  const p = PG.paginate(matches, 1, 10);
  assert.equal(p.total, matches.length);
  assert.ok(p.pages > 1);
});

test('SORTING runs across the whole set before pagination', () => {
  const byNet = included.slice().sort((a, b) => b.cur.net - a.cur.net);
  const firstPage = PG.paginate(byNet, 1, 25).rows;
  const globalTop = Math.max(...included.map(r => r.cur.net));
  assert.equal(firstPage[0].cur.net, globalTop, 'page 1 holds the global maximum');
  // Ascending order surfaces the global minimum, which lives deep in the file.
  const asc = included.slice().sort((a, b) => a.cur.net - b.cur.net);
  assert.equal(PG.paginate(asc, 1, 25).rows[0].cur.net, Math.min(...included.map(r => r.cur.net)));
});

test('a filter plus a page size still reaches every matching product', () => {
  const OWN = F.vendorNames.own, n = F.vendors[OWN].rows;
  const scoped = PG.applyScope(included, { vendor: OWN });
  assert.equal(scoped.length, n);
  const p = PG.paginate(scoped, 5, 100);
  assert.equal(p.pages, Math.ceil(n / 100));
  assert.equal(p.from, 401); assert.equal(p.to, Math.min(500, n));
});

test('exports are never paginated', () => {
  const scoped = PG.applyScope(included, {});
  const page = PG.paginate(scoped, 1, 100);
  assert.equal(page.rows.length, 100);
  assert.equal(scoped.length, N, 'the export source stays the full filtered set');
});

// ────────────────────────────────────────────────────────────
// Suspicious classifications
// ────────────────────────────────────────────────────────────
test('the two named examples are flagged', () => {
  const heat = included.find(r => r.title === A.flagSub.title);
  assert.equal(heat.ptype, 'Fertilizers', 'imported type is preserved verbatim');
  assert.equal(heat.group, 'Fertilizer', 'the product type still decides the grouping');
  assert.ok(heat.suspicion, 'but it is flagged');
  assert.equal(heat.suspicion.kind, 'type_vs_title');
  assert.equal(heat.suspicion.suggested, 'Subscriptions');
  assert.match(heat.suspicion.message, /Fertilizers/);

  const card = included.find(r => r.title === A.flagCard.title);
  assert.equal(card.ptype, 'Greeting Card');
  assert.equal(card.group, 'Stationery & Cards');
  assert.equal(card.suspicion.kind, 'type_vs_title');
  assert.equal(card.suspicion.suggested, 'Gift Cards');
});

test('flagging stays a short, actionable list rather than noise', () => {
  const flagged = PG.flaggedRecords(included, 'review');
  assert.ok(flagged.length > 0 && flagged.length < 40, `${flagged.length} flagged`);
  assert.ok(flagged.every(r => r.suspicion.severity === 'review'));
});

test('a gift box that contains pots is NOT flagged — a composite type is doing its job', () => {
  const arrangement = included.find(r => r.title === A.giftWood.title);
  assert.equal(arrangement.ptype, 'Gift');
  assert.equal(arrangement.group, 'Gifts');
  assert.equal(arrangement.suspicion, null);
});

test('a blank product type is information, not a problem to fix', () => {
  const blanks = included.filter(r => r.ptypeBlank);
  assert.equal(blanks.length, F.blankTypes);
  assert.ok(blanks.every(r => !r.suspicion || r.suspicion.severity === 'info'));
  assert.equal(PG.flaggedRecords(blanks, 'review').length, 0);
});

test('the imported product type is visible beside the normalized group', () => {
  for (const r of included) {
    assert.equal(typeof r.ptype, 'string');
    assert.equal(typeof r.group, 'string');
    assert.ok(r.naturalGroup, 'the classification before any override is retained');
  }
  const heat = included.find(r => r.title === A.flagSub.title);
  assert.notEqual(heat.ptype, heat.group, 'they are genuinely two different fields');
});

// ────────────────────────────────────────────────────────────
// Overrides
// ────────────────────────────────────────────────────────────
test('an override changes the group and nothing else', () => {
  const before = included.find(r => r.title === A.flagSub.title);
  const map = PG.setOverride({}, before, { group: 'Subscriptions', groupType: PG.GROUP_TYPE_CATEGORY, isPlant: false });

  const after = PG.splitExclusions(parseWith(map).records).included
    .find(r => r.title === A.flagSub.title);

  assert.equal(after.group, 'Subscriptions');
  assert.equal(after.overridden, true);
  // Everything imported is untouched.
  assert.equal(after.ptype, 'Fertilizers');
  assert.equal(after.title, before.title);
  assert.equal(after.vendor, before.vendor);
  assert.deepEqual(after.cur, before.cur);
  assert.deepEqual(after.prior, before.prior);
  // ...and the classification it would have had is kept for audit and undo.
  assert.equal(after.naturalGroup, 'Fertilizer');
});

test('an override moves the money between groups and totals still reconcile', () => {
  const target = included.find(r => r.title === A.flagSub.title);
  const map = PG.setOverride({}, target, { group: 'Subscriptions', isPlant: false });
  const after = PG.splitExclusions(parseWith(map).records).included;

  assert.equal(Math.round(after.reduce((s, r) => s + r.cur.net, 0) * 100) / 100, F.includedNet);
  const groups = PG.aggregateByGroup(after);
  assert.equal(Math.round(groups.reduce((s, g) => s + g.cur.net, 0) * 100) / 100, F.includedNet);
  assert.equal(groups.reduce((s, g) => s + g.products, 0), after.length);
});

test('an override can move a product onto the plant side, genus and all', () => {
  const zz = included.find(r => r.title === A.unidentified.title);
  const map = PG.setOverride({}, zz, { group: 'Echeveria', groupType: PG.GROUP_TYPE_GENUS, isPlant: true });
  const after = PG.splitExclusions(parseWith(map).records).included.find(r => r.title === A.unidentified.title);
  assert.equal(after.group, 'Echeveria');
  assert.equal(after.isPlant, true);
  assert.equal(after.groupType, PG.GROUP_TYPE_GENUS);
  assert.equal(after.ptype, zz.ptype, 'imported type unchanged');
});

test('an overridden row stops being flagged', () => {
  const heat = included.find(r => r.title === A.flagSub.title);
  const map = PG.setOverride({}, heat, { group: 'Subscriptions', isPlant: false });
  const after = PG.splitExclusions(parseWith(map).records).included;
  assert.equal(PG.flaggedRecords(after, 'review').some(r => r.title === A.flagSub.title), false);
});

test('removing an override restores the natural classification exactly', () => {
  const heat = included.find(r => r.title === A.flagSub.title);
  let map = PG.setOverride({}, heat, { group: 'Subscriptions', isPlant: false });
  assert.equal(Object.keys(map).length, 1);
  map = PG.setOverride(map, heat, null);
  assert.equal(Object.keys(map).length, 0);
  const after = PG.splitExclusions(parseWith(map).records).included.find(r => r.title === A.flagSub.title);
  assert.equal(after.group, 'Fertilizer');
  assert.equal(after.overridden, false);
  assert.ok(after.suspicion, 'and it is flagged again');
});

test('override keys are per-channel and survive a re-import', () => {
  const shopify = { channel: 'shopify', title: 'Spider Plant', vendor: 'Dropship Supplier A', ptype: 'Houseplants' };
  const amazon = { channel: 'amazon', title: 'Spider Plant', asin: 'B0TEST00001' };
  assert.notEqual(PG.overrideKeyFor(shopify), PG.overrideKeyFor(amazon));
  assert.equal(PG.overrideKeyFor(amazon), 'amazon␟B0TEST00001');
  // The same product parsed twice produces the same key, so an override set
  // today still applies to next month's import of the same row.
  const again = { channel: 'shopify', title: 'Spider Plant', vendor: 'Dropship Supplier A', ptype: 'Houseplants' };
  assert.equal(PG.overrideKeyFor(shopify), PG.overrideKeyFor(again));
});

test('the override picker offers every category the module can produce', () => {
  const cats = PG.knownCategories();
  for (const want of ['Gifts', 'Gift Cards', 'Subscriptions', 'Pots & Planters', 'Soil',
                      'Fertilizer', 'Tools', 'Accessories', 'Unclassified']) {
    assert.ok(cats.includes(want), `picker is missing ${want}`);
  }
});
