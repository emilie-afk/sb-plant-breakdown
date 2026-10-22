// Vendor from the Products Master: when several suppliers share one Shopify
// location, Shopify's "Product vendor" no longer tells them apart, so the
// Products Master vendor tabs decide. Synthetic sheets, catalog and SKUs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';
import * as CV from '../collector/src/vendormap.mjs';
import * as L from '../collector/src/lib.mjs';

const require = createRequire(import.meta.url);
const VM = require(path.join(ROOT, 'vendor-master.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));

// ── synthetic Products Master tabs ──────────────────────────────────────
const CSV = {
  giftA: 'Product,Cost,SKUs,Shopify Name,Shopify Link\nBox One,10,"GA-ONE\nGA-ONE-DLX",Sample Gift Box One,https://admin.example/store/x/products/1001\nBox Two,12,GA-TWO,Sample Gift Box Two,\n',
  arr:   'Product,SB SKU,SB Product Link\n"Small Heart\n\nSample Heart Arrangement",ARR-HEART,https://shop.example/products/sample-heart\n',
  plants:'STT,Plant Name,MCG SKU,SB Bundles SKU\n1,Echeveria Sample,M1000,M1000+POT1\n2,Haworthia Sample,M2000,\n',
  hpd:   'No.,Plant Name,HD SKU\n1,Fern Sample,4_FERN_SAMPLE\n',
  root:  'Root,,,Store,\nTitle,SKU,Cost,Title,SKU\nPink Plant,LR_PINK_6,20,Pink Plant (store),4_FERN_SAMPLE\n'
};
const TAB_SPECS = [
  { label: 'Gifts A', vendor: 'Gift Vendor A', sku: ['SKUs'], name: ['Shopify Name'], link: ['Shopify Link'], csv: CSV.giftA },
  { label: 'Arrangements', vendor: 'Arrangement Co', sku: ['SB SKU'], name: ['Product'], link: ['SB Product Link'], csv: CSV.arr, skuPrefix: ['ARR-'] },
  { label: 'Plants', vendor: 'Main Store', sku: ['MCG SKU', 'SB Bundles SKU'], name: ['Plant Name'], csv: CSV.plants },
  { label: 'Houseplants', vendor: 'Dropship House', sku: ['HD SKU'], name: ['Plant Name'], csv: CSV.hpd },
  { label: 'Root Cost', vendor: 'Root Vendor', sku: ['SKU#1'], name: ['Title#1'], csv: CSV.root }
];
const TABS = TAB_SPECS.map(t => Object.assign({}, t, { rows: VM.vendorParseCsv(t.csv) }));
const KEEP = ['Dropship House', 'Dropship House Wholesale', 'Root Vendor'];
const ALIASES = { 'Dropship House Wholesale': 'Dropship House' };
const TYPES = { 'Subscription': 'Main Store' };
// After the move every supplier shows the shared location's vendor in Shopify.
const CATALOG = [
  { id: '1001', handle: 'gift-one', title: 'Sample Gift Box One', vendor: 'Main Store', variants: [{ sku: 'GA-ONE' }, { sku: 'GA-ONE-DLX' }] },
  { id: '1002', handle: 'gift-two', title: 'Sample Gift Box Two', vendor: 'Main Store', variants: [{ sku: 'GA-TWO' }] },
  { id: '1003', handle: 'sample-heart', title: 'Sample Heart Arrangement', vendor: 'Main Store', variants: [{ sku: 'ARR-HEART' }] },
  { id: '1004', handle: 'arr-new', title: 'New Arrangement Not Yet In Sheet', vendor: 'Main Store', variants: [{ sku: 'ARR-NEW-1' }, { sku: 'ARR-NEW-2' }] },
  { id: '1005', handle: 'echeveria', title: 'Echeveria Sample', vendor: 'Main Store', variants: [{ sku: 'M1000' }] },
  { id: '1006', handle: 'fern', title: 'Fern Sample', vendor: 'Dropship House', variants: [{ sku: '4_FERN_SAMPLE' }] },
  { id: '1007', handle: 'sub', title: 'Monthly Subscription', vendor: 'Main Store', variants: [{ sku: 'SUB-1' }] },
  { id: '1008', handle: 'mixed', title: 'Mixed Up', vendor: 'Main Store', variants: [{ sku: 'GA-TWO' }, { sku: 'M2000' }] },
  { id: '1009', handle: 'pink', title: 'Pink Plant', vendor: 'Root Vendor', variants: [{ sku: 'LR_PINK_6' }] },
  { id: '1010', handle: 'wh', title: 'Wholesale Fern', vendor: 'Dropship House Wholesale', variants: [{ sku: 'WH-1' }] },
  { id: '1011', handle: 'club', title: 'Plant Club - 2 a month', vendor: 'Gift Vendor A', productType: 'Subscription', variants: [{ sku: 'CLUB-2' }] }
];
const MAP = VM.buildVendorMap(CATALOG, TABS, { keepShopifyVendors: KEEP, vendorAliases: ALIASES, typeVendors: TYPES, now: '2026-10-22T00:00:00Z' });

test('header columns: "SKU#1" picks the first of two SKU columns; multi-line cells hold several SKUs or names', () => {
  const b = VM.vendorBuildIndex(TABS);
  assert.deepEqual(Object.keys(b.index.sku['LR_PINK_6']), ['Root Vendor']);
  assert.deepEqual(Object.keys(b.index.sku['4_FERN_SAMPLE']), ['Dropship House'], 'the store-side SKU column of Root Cost is not read');
  assert.ok(b.index.sku['GA-ONE-DLX'] && b.index.sku['M1000+POT1']);
  assert.ok(b.index.title['sample heart arrangement'], 'second line of a Product cell is the Shopify name');
  assert.ok(b.index.pid['1001'] && b.index.handle['sample-heart']);
  assert.ok(b.tabs.every(t => !t.problems.length));
});

test('each product resolves by the strictest evidence available', () => {
  const e = MAP.entries;
  assert.deepEqual([e['1001'].v, e['1001'].b], ['Gift Vendor A', 'pid']);
  assert.deepEqual([e['1002'].v, e['1002'].b], ['Gift Vendor A', 'sku']);
  assert.deepEqual([e['1003'].v, e['1003'].b], ['Arrangement Co', 'handle']);
  assert.deepEqual([e['1004'].v, e['1004'].b], ['Arrangement Co', 'prefix']);
  assert.deepEqual([e['1005'].v, e['1005'].b], ['Main Store', 'sku']);
  assert.deepEqual([e['1006'].v, e['1006'].b], ['Dropship House', 'keep'], 'suppliers that are not moving keep the Shopify vendor');
  assert.deepEqual([e['1009'].v, e['1009'].b], ['Root Vendor', 'keep']);
  assert.equal(e['1007'], undefined, 'not in the Products Master: no entry');
  assert.equal(e['1008'], undefined, 'two vendors: no guess');
  const conflict = MAP.review.find(r => r.id === '1008');
  assert.deepEqual([conflict.basis, conflict.candidates], ['conflict', ['Gift Vendor A', 'Main Store']]);
  assert.ok(MAP.review.find(r => r.id === '1007' && r.basis === 'unresolved'));
  assert.ok(MAP.review.find(r => r.id === '1004' && r.basis === 'prefix'), 'prefix matches are listed so they can be added to the sheet');
  assert.deepEqual([e['1010'].v, e['1010'].b, e['1010'].s], ['Dropship House', 'keep', 'Dropship House Wholesale'], 'another Shopify name of the same supplier is shown as that supplier');
  assert.deepEqual([e['1011'].v, e['1011'].b], ['Main Store', 'type'], 'subscriptions are supplied by the configured vendor whatever Shopify says');
  assert.deepEqual(MAP.counts, { resolved: 6, kept: 3, byPrefix: 1, conflicts: 1, unresolved: 1 });
});

test('the dashboard applies the map and keeps the imported Shopify vendor', () => {
  const r = { productId: '1002', vendor: 'Main Store', title: 'Sample Gift Box Two', ptype: 'Gift' };
  const a = VM.applyVendor(r, MAP);
  assert.deepEqual(a, { vendor: 'Gift Vendor A', vendorImported: 'Main Store', vendorBasis: 'products_master_sku' });
  Object.assign(r, a);
  assert.deepEqual(VM.applyVendor(r, MAP), a, 'applying twice changes nothing');
  assert.deepEqual(VM.applyVendor({ productId: '1007', vendor: 'Main Store' }, MAP).vendorBasis, 'shopify_not_in_master');
  assert.deepEqual(VM.applyVendor({ productId: '1006', vendor: 'Dropship House' }, MAP).vendorBasis, 'shopify_kept');
  assert.deepEqual(VM.applyVendor({ vendor: 'X' }, null), { vendor: 'X', vendorImported: 'X', vendorBasis: 'shopify' });
});

test('products the catalog does not show (unpublished) are found in the sheet by name', () => {
  // a sold product that is not in the storefront catalog: no entry by id
  const a = VM.applyVendor({ productId: '777', vendor: 'Main Store', title: 'Fern  Sample' }, MAP);
  assert.deepEqual([a.vendor, a.vendorBasis], ['Dropship House', 'products_master_name']);
  assert.equal(VM.applyVendor({ productId: '778', vendor: 'Main Store', title: 'Haworthia Sample' }, MAP).vendor, 'Main Store');
  // a supplier that is not moving keeps its vendor even if the name matches elsewhere (aliased)
  const k = VM.applyVendor({ productId: '779', vendor: 'Dropship House Wholesale', title: 'Haworthia Sample' }, MAP);
  assert.deepEqual([k.vendor, k.vendorImported, k.vendorBasis], ['Dropship House', 'Dropship House Wholesale', 'shopify_kept']);
  // a name listed by two vendors is not used
  const twice = VM.buildVendorMap([], [TABS[2], Object.assign({}, TABS[3], { rows: VM.vendorParseCsv('No.,Plant Name,HD SKU\n1,Haworthia Sample,X1\n') })], {});
  assert.equal(twice.titles['haworthia sample'], undefined);
  assert.equal(VM.vendorNameKey('Bird’s Nest - Fern'), "bird s nest fern");
  const sub = VM.applyVendor({ productId: '780', vendor: 'Gift Vendor A', title: '1 plant/ month - 6 month', ptype: 'Subscription' }, MAP);
  assert.deepEqual([sub.vendor, sub.vendorBasis], ['Main Store', 'type_rule'], 'an unpublished subscription too');
});

test('vendor totals: sales move between vendors, never change in total', () => {
  const recs = [['1001', 30], ['1002', 20], ['1005', 50], ['1007', 5], ['1006', 7]].map(([id, net]) => ({
    productId: id, vendor: CATALOG.find(p => p.id === id).vendor, title: 't' + id,
    cur: { units: 1, gross: net, disc: 0, ret: 0, net, tax: 0, total: net, glance: 0, inv: 0 }, prior: {}, priorKnown: false }));
  const before = PG.aggregateByVendor(recs).reduce((s, b) => s + b.cur.net, 0);
  recs.forEach(r => Object.assign(r, VM.applyVendor(r, MAP)));
  const by = Object.fromEntries(PG.aggregateByVendor(recs).map(b => [b.vendor, b.cur.net]));
  assert.deepEqual(by, { 'Gift Vendor A': 50, 'Main Store': 55, 'Dropship House': 7 });
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), before);
});

test('a saved override keyed on the old title key still matches after the vendor is resolved', () => {
  const rec = { channel: 'shopify', title: 'No Id Product', vendor: 'Gift Vendor A', vendorImported: 'Main Store', ptype: 'Gift' };
  assert.equal(PG.legacyOverrideKeyFor(rec), 'shopify␟No Id Product␟Main Store␟Gift');
});

test('a broken read never replaces a good map', () => {
  assert.deepEqual(VM.checkVendorMap(MAP, null), []);
  const broken = VM.buildVendorMap(CATALOG, [Object.assign({}, TABS[0], { sku: ['Not There'], name: [], link: [] })], { keepShopifyVendors: KEEP });
  assert.ok(VM.checkVendorMap(broken, null).some(p => /columns? was found|SKU column not found/.test(p)));
  const big = { schema: VM.VENDOR_MAP_SCHEMA, entries: {} }, small = { schema: VM.VENDOR_MAP_SCHEMA, entries: {} };
  for (let i = 0; i < 100; i++) big.entries[String(5000 + i)] = { v: 'A', b: 'sku' };
  for (let i = 0; i < 30; i++) small.entries[String(5000 + i)] = { v: 'A', b: 'sku' };
  assert.ok(VM.checkVendorMap(small, big).some(p => /down from 100/.test(p)));
});

// ── Worker: stored as the setting "vendor_map" ──────────────────────────
const INGEST = 'i'.repeat(40), DASH = 'd'.repeat(40), VIEW = 'v'.repeat(40);
const env = () => ({ DB: makeD1(path.join(ROOT, 'worker', 'migrations')), INGEST_SECRET: INGEST, DASHBOARD_SECRET: DASH, VIEWER_SECRET: VIEW });
async function call(e, method, p, key, body) {
  const res = await worker.fetch(new Request('https://w.example' + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: body === undefined ? undefined : JSON.stringify(body) }), e);
  return { status: res.status, json: await res.json().catch(() => null) };
}
test('Worker: the collector stores the map, viewers read it, a suspicious drop is refused', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/v1/ingest/vendor-map', VIEW, { map: MAP })).status, 403, 'the viewer key stays read-only');
  const up = await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: MAP });
  assert.equal(up.status, 200); assert.equal(up.json.version, 1);
  const got = await call(e, 'GET', '/v1/settings/vendor_map', VIEW);
  assert.equal(got.json.setting.value.entries['1002'].v, 'Gift Vendor A');
  assert.equal(got.json.setting.value.entries['1002'].s, 'Main Store', 'the Shopify vendor travels with it');
  // 30 products resolved before, now only 1: refused unless forced
  const many = JSON.parse(JSON.stringify(MAP));
  for (let i = 0; i < 30; i++) many.entries[String(9000 + i)] = { v: 'Gift Vendor A', b: 'sku', s: 'Main Store' };
  assert.equal((await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: many })).status, 200);
  const tiny = { schema: VM.VENDOR_MAP_SCHEMA, entries: { '1001': { v: 'Gift Vendor A', b: 'pid', s: 'Main Store' } } };
  const refused = await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: tiny });
  assert.equal(refused.status, 409); assert.equal(refused.json.error, 'suspicious_drop');
  assert.equal((await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: tiny, force: true })).status, 200);
  assert.equal((await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: { schema: 'x', entries: {} } })).status, 400);
  assert.equal((await call(e, 'POST', '/v1/ingest/vendor-map', INGEST, { map: { schema: VM.VENDOR_MAP_SCHEMA, entries: { 'abc': { v: 'A', b: 'sku' } } } })).status, 400);
});

// ── collector: built from the sheet's public CSV export and the catalog ──
function fakeFetch({ html = false } = {}) {
  const byGid = { '11': CSV.giftA, '12': CSV.arr, '13': CSV.plants, '14': CSV.hpd, '15': CSV.root };
  return async (url) => {
    const u = String(url);
    const gid = /gid=(\d+)/.exec(u);
    if (gid) {
      return { ok: true, status: 200, headers: { get: () => html ? 'text/html' : 'text/csv; charset=utf-8' },
               text: async () => html ? '<!doctype html><html>Sign in</html>' : byGid[gid[1]] };
    }
    const page = +(/page=(\d+)/.exec(u) || [0, 1])[1];
    const products = page === 1 ? CATALOG.map(p => ({ id: +p.id, handle: p.handle, title: p.title, vendor: p.vendor, product_type: p.productType || '', variants: p.variants })) : [];
    return { ok: true, status: 200, json: async () => ({ products }) };
  };
}
const VMCFG = { sheetId: 'S'.repeat(30), storeUrl: 'https://shop.example', keepShopifyVendors: KEEP, vendorAliases: ALIASES, typeVendors: TYPES,
  tabs: TAB_SPECS.map((t, i) => ({ label: t.label, gid: String(11 + i), vendor: t.vendor, sku: t.sku, name: t.name, link: t.link, skuPrefix: t.skuPrefix })) };

test('collector: builds the same map from the sheet export and the catalog; refuses a private sheet', async () => {
  const { map, problems } = await CV.buildVendorMapFromSources(VMCFG, { fetchImpl: fakeFetch() });
  assert.deepEqual(problems, []);
  assert.deepEqual(map.entries, MAP.entries);
  await assert.rejects(CV.buildVendorMapFromSources(VMCFG, { fetchImpl: fakeFetch({ html: true }) }), /not a CSV/);
});
test('collector: once a day, never throws, and the config is checked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmap-'));
  try {
    const logs = [];
    const cfg = { workerUrl: 'https://w.example', vendorMaster: VMCFG };
    let posted = null;
    const f = fakeFetch();
    const fetchImpl = async (url, opts) => {
      if (String(url).endsWith('/v1/ingest/vendor-map')) { posted = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ ok: true, version: 3 }) }; }
      return f(url, opts);
    };
    const r1 = await CV.refreshVendorMap(cfg, { secret: 'x', baseDir: dir, log: s => logs.push(s), fetchImpl, now: new Date('2026-10-22T09:00:00Z') });
    assert.equal(r1.status, 'uploaded'); assert.equal(posted.map.entries['1003'].v, 'Arrangement Co');
    const r2 = await CV.refreshVendorMap(cfg, { secret: 'x', baseDir: dir, fetchImpl, now: new Date('2026-10-22T15:00:00Z') });
    assert.equal(r2.status, 'fresh');
    const r3 = await CV.refreshVendorMap(cfg, { secret: 'x', baseDir: dir, fetchImpl: async () => { throw new Error('offline'); }, now: new Date('2026-10-24T09:00:00Z') });
    assert.equal(r3.status, 'failed');
    assert.equal((await CV.refreshVendorMap({ workerUrl: 'https://w.example' }, { secret: 'x', baseDir: dir })).status, 'not_configured');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const base = { adminUrl: 'https://admin.shopify.com/store/x', reportId: '1' };
  assert.deepEqual(L.validateConfig(Object.assign({}, base, { vendorMaster: VMCFG })), []);
  assert.ok(L.validateConfig(Object.assign({}, base, { vendorMaster: { sheetId: 'x', tabs: [] } })).length >= 2);
});

test('nothing identifying the real sheet is in the repository', () => {
  const ex = fs.readFileSync(path.join(ROOT, 'collector', 'config.example.json'), 'utf8');
  assert.match(ex, /<products-master-sheet-id>/);
  for (const f of ['vendor-master.js', 'collector/src/vendormap.mjs', 'worker/src/vendormap.js', 'collector/config.example.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{30,}/);
  }
});
