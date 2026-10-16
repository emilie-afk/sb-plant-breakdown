// Catalog join. All three inputs are SYNTHETIC (tools/make-sample-fixtures.mjs)
// and share one invented product set:
//   - shopify-catalog-sample.json — a slimmed storefront /products.json, with
//     catalog-only products, two title+vendor pairs that appear twice, and
//     repeated SKUs.
//   - shopify-total-sales-by-product-with-id-sample.csv — the saved "+ ID"
//     report layout, carrying Product ID.
//   - shopify-total-sales-by-product-sample.csv — the built-in report layout,
//     which has NO product id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE, WITH_ID_FIXTURE, CATALOG_FIXTURE, FACTS, r2 } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const CJ = require(path.join(ROOT, 'catalog-join.js'));
const globals = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType });

const catalog = JSON.parse(fs.readFileSync(CATALOG_FIXTURE, 'utf8'));
const withIdRows = readCsv(WITH_ID_FIXTURE);
const withId = SR.parseShopifyProductReport(withIdRows, { classify });
const sample = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
const sum = (rs) => r2(rs.reduce((s, r) => s + r.cur.net, 0));
const W = FACTS.withId, C = FACTS.catalog, S = FACTS.shopify;
const [AMB1, AMB2] = S.anchors.ambiguous;

// ────────────────────────────────────────────────────────────
// The "+ ID" export itself
// ────────────────────────────────────────────────────────────
test('the saved "+ ID" report exports Product ID as its first column', () => {
  assert.deepEqual(withIdRows[0], ['Product ID', 'Product title', 'Product vendor', 'Product type',
    'Net items sold', 'Gross sales', 'Discounts', 'Sales reversals', 'Net sales', 'Taxes', 'Total sales']);
});

test('the parser reads Product ID and uses it as the identity', () => {
  assert.equal(withId.ok, true, withId.errors.join(' '));
  assert.equal(withId.capabilities.hasProductId, true);
  assert.equal(withId.records.length, W.rows);
  assert.ok(withId.records.every(r => /^\d+$/.test(r.productId)));
  assert.ok(withId.records.every(r => r.identityBasis === 'product_id'));
  assert.equal(new Set(withId.records.map(r => r.productId)).size, W.rows);
});

test('the "+ ID" export reconciles to the figure shown on screen', () => {
  assert.equal(withId.totals.current.total, W.cur.total);
  assert.equal(withId.totals.current.net, W.cur.net);
  assert.equal(withId.totals.current.units, W.cur.units);
});

test('a report without the column still parses, keyed by title+vendor+type', () => {
  assert.equal(sample.capabilities.hasProductId, false);
  assert.ok(sample.records.every(r => r.identityBasis === 'title+vendor+type' && r.productId == null));
});

test('the stored snapshot keeps the product id', () => {
  const p = SR.shopifyToSnapshotProduct(withId.records[0]);
  assert.equal(p.productId, withId.records[0].productId);
});

// ────────────────────────────────────────────────────────────
// The catalog
// ────────────────────────────────────────────────────────────
test('the catalog snapshot has the storefront snapshot shape', () => {
  assert.equal(catalog.schema, 'shopify-storefront-products/v1');
  assert.equal(catalog.products.length, C.products);
  assert.equal(new Set(catalog.products.map(p => p.id)).size, C.products, 'product ids are unique');
  assert.match(catalog.scope, /Online Store/);
});

test('SKU is not a safe key: some SKUs repeat across variants', () => {
  const idx = CJ.indexCatalog(catalog);
  const dup = Object.keys(idx.skuCount).filter(s => idx.skuCount[s] > 1);
  assert.equal(dup.length, C.duplicatedSkus);
  assert.ok(dup.length > 5);
});

// ────────────────────────────────────────────────────────────
// Join on product id (the "+ ID" report)
// ────────────────────────────────────────────────────────────
const joinedId = CJ.joinSalesToCatalog(withId.records.map(r => ({ ...r })), catalog, {});

test('with product ids, matches are exact and need no title matching', () => {
  const s = joinedId.summary;
  assert.equal(s.product_id, W.matchedById);
  assert.equal(s.exact_title_vendor, 0, 'title matching never runs when an id is present');
  assert.equal(s.ambiguous, 0, 'an id is never ambiguous');
  assert.equal(s.not_in_catalog, W.notInCatalog);
  assert.equal(r2(s.net.product_id + s.net.not_in_catalog), withId.totals.current.net, 'every dollar is accounted for');
});

test('an id that is not in the Online Store catalog keeps its id and says why', () => {
  const route = joinedId.records.find(r => r.vendor === 'Route');
  assert.equal(route.catalog.status, 'not_in_catalog');
  assert.equal(route.catalog.productId, route.productId);
  assert.match(route.catalog.basis, /not in the Online Store catalog/);
});

test('joining never changes a sales figure', () => {
  assert.equal(sum(joinedId.records), withId.totals.current.net);
  for (const r of joinedId.records) {
    const orig = withId.records.find(o => o.productId === r.productId);
    assert.deepEqual(r.cur, orig.cur);
  }
});

test('the vendor recorded at the time of sale is never rewritten by the catalog', () => {
  for (const r of joinedId.records) {
    const orig = withId.records.find(o => o.productId === r.productId);
    assert.equal(r.vendor, orig.vendor);
    if (r.catalog.vendorConflict) assert.equal(r.catalog.vendorConflict.sales, orig.vendor);
  }
});

// ────────────────────────────────────────────────────────────
// Fallback join on title + vendor (no ids)
// ────────────────────────────────────────────────────────────
const joinedSample = CJ.joinSalesToCatalog(sample.records.map(r => ({ ...r })), catalog, {});

test('without ids, only UNIQUE exact title+vendor matches are applied automatically', () => {
  const s = joinedSample.summary;
  assert.equal(s.ambiguous, C.septAmbiguous);
  assert.equal(s.not_in_catalog, C.septNotInCatalog);
  assert.equal(s.exact_title_vendor, S.rows - C.septAmbiguous - C.septNotInCatalog);
  assert.equal(s.product_id, 0);
  assert.equal(s.exact_title_vendor + s.ambiguous + s.not_in_catalog, S.rows);
});

test('two catalog products with the same title and vendor are flagged, not guessed', () => {
  const amb = joinedSample.records.filter(r => r.catalog.status === 'ambiguous');
  assert.deepEqual(amb.map(r => r.title).sort(), [AMB1, AMB2].sort());
  for (const r of amb) {
    assert.equal(r.catalog.requiresReview, true);
    assert.equal(r.catalog.candidates.length, 2);
    assert.equal(r.catalog.product, undefined, 'no product is chosen');
  }
});

test('fuzzy similarity only ever produces review suggestions, never a match', () => {
  const unmatched = joinedSample.records.filter(r => r.catalog.status === 'not_in_catalog');
  for (const r of unmatched) {
    assert.equal(r.catalog.product, undefined);
    assert.equal(r.catalog.requiresReview, true);
    assert.ok(Array.isArray(r.catalog.suggestions));
  }
});

// ────────────────────────────────────────────────────────────
// Approved mappings
// ────────────────────────────────────────────────────────────
test('an approved mapping resolves an ambiguous row, and is reused on the next report', () => {
  const amb = joinedSample.records.find(r => r.title === AMB1);
  const choice = amb.catalog.candidates[0].productId;
  const approved = CJ.approveMapping({}, amb, choice, 'reviewer', 'checked handle in admin');
  const again = CJ.joinSalesToCatalog(sample.records.map(r => ({ ...r })), catalog, approved);
  const r = again.records.find(x => x.title === AMB1);
  assert.equal(r.catalog.status, 'approved');
  assert.equal(r.catalog.product.productId, choice);
  assert.equal(r.catalog.approvedBy, 'reviewer');
  assert.equal(again.summary.ambiguous, C.septAmbiguous - 1, 'only the other ambiguous row remains');
});

test('an approval pointing at a product no longer in the catalog is not trusted', () => {
  const amb = joinedSample.records.find(r => r.title === AMB1);
  const approved = CJ.approveMapping({}, amb, '999999999999', 'reviewer');
  const again = CJ.joinSalesToCatalog(sample.records.map(r => ({ ...r })), catalog, approved);
  assert.equal(again.records.find(x => x.title === AMB1).catalog.status, 'ambiguous');
});

test('a product id always beats an approved mapping', () => {
  const r = withId.records[0];
  const approved = CJ.approveMapping({}, r, catalog.products[5].id, 'reviewer');
  const j = CJ.joinSalesToCatalog([{ ...r }], catalog, approved);
  assert.equal(j.records[0].catalog.status, 'product_id');
});

test('revoking an approval restores the automatic result', () => {
  const amb = joinedSample.records.find(r => r.title === AMB1);
  let approved = CJ.approveMapping({}, amb, amb.catalog.candidates[0].productId, 'reviewer');
  approved = CJ.revokeMapping(approved, amb);
  assert.deepEqual(approved, {});
});

// ────────────────────────────────────────────────────────────
// Products with no recorded sales, and allocation
// ────────────────────────────────────────────────────────────
test('catalog products absent from the report are listed as "no recorded sales", nothing more', () => {
  assert.equal(joinedId.noRecordedSales.length, C.products - W.matchedById);
  const one = joinedId.noRecordedSales[0];
  assert.deepEqual(Object.keys(one).sort(), ['handle', 'productId', 'productType', 'title', 'variantCount', 'vendor']);
  assert.equal('inStock' in one, false, 'no stock inference');
  assert.equal('performance' in one, false, 'no performance inference');
});

test('product-level sales are never split across variants', () => {
  for (const r of joinedId.records) {
    assert.equal(r.variants, undefined);
    assert.equal(r.variantSales, undefined);
  }
});

// ────────────────────────────────────────────────────────────
// Supplementary data: verified identifiers only
// ────────────────────────────────────────────────────────────
test('workbook rows enrich the catalog only through a unique SKU', () => {
  const idx = CJ.indexCatalog(catalog);
  const uniqueSku = Object.keys(idx.skuCount).find(s => idx.skuCount[s] === 1);
  const dupSku = Object.keys(idx.skuCount).find(s => idx.skuCount[s] > 1);
  const res = CJ.enrichBySku(catalog, [
    { sku: uniqueSku, cost: 4.0 },
    { sku: dupSku, cost: 9.9 },
    { sku: 'NOT-A-REAL-SKU-123', cost: 1 },
    { cost: 2 }
  ]);
  assert.equal(res.applied.length, 1);
  assert.equal(res.applied[0].sku, uniqueSku);
  assert.deepEqual(res.refused.map(x => x.reason).sort(),
    ['SKU is on more than one catalog variant', 'SKU not in catalog', 'no SKU']);
});
