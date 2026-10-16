// Browser snapshots <-> shared storage, through the real Worker.
// Every round trip must come back to the cent and render identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE, AMAZON_V1_FIXTURE, AMAZON_V2_FIXTURE, FACTS } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));
const SS = require(path.join(ROOT, 'shared-sync.js'));
const globals = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType });

const DASH = 'd'.repeat(40);
const env = () => ({ DB: makeD1(path.join(ROOT, 'worker', 'migrations')), DASHBOARD_SECRET: DASH, INGEST_SECRET: 'i'.repeat(40) });
async function call(e, method, p, body) {
  const res = await worker.fetch(new Request('https://w.example' + p, {
    method, headers: { authorization: 'Bearer ' + DASH, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), e);
  return res.json();
}
const helpers = { classify, toSnapshotProduct: SR.shopifyToSnapshotProduct, amazonSnapshotIdentity: AR.amazonSnapshotIdentity };
const sum = (ps, f) => Math.round(ps.reduce((s, p) => s + (typeof f === 'function' ? f(p) : p[f]), 0) * 100) / 100;

// A Shopify snapshot exactly as the import flow stores it.
const F = FACTS.shopify, A = F.anchors, V2 = FACTS.amazon.v2;
const sept = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
const septSnap = {
  id: 'shopify_2026-09-01_2026-09-30', source: 'shopify', label: 'Sep 2026',
  startDate: '2026-09-01', endDate: '2026-09-30', fileName: 'Total sales by product - 2026-09-01 - 2026-09-30.csv',
  uploadedAt: '2026-10-14T00:00:00Z', products: sept.records.map(SR.shopifyToSnapshotProduct),
  meta: { timezone: 'America/Los_Angeles', currency: 'USD', comparison: { start: '2026-08-02', end: '2026-08-31', source: 'stated at import' },
          sourceFilename: 'Total sales by product - 2026-09-01 - 2026-09-30.csv' }
};

test('a Shopify snapshot round-trips through shared storage to the cent', async () => {
  const e = env();
  const conv = SS.sharedPayloadFromSnapshot(septSnap);
  assert.equal(conv.ok, true);
  assert.equal(conv.payload.reportScope, 'total_sales_by_product');
  const up = await call(e, 'POST', '/v1/ingest/product-report', conv.payload);
  assert.equal(up.outcome, 'succeeded', JSON.stringify(up.errors));

  const rep = (await call(e, 'GET', '/v1/reports')).reports[0];
  const rows = (await call(e, 'GET', '/v1/reports/' + encodeURIComponent(rep.id) + '/rows')).rows;
  const back = SS.sharedSnapshotFromReport(rep, rows, helpers);

  assert.equal(back.id, septSnap.id);
  assert.equal(back.products.length, F.rows);
  for (const k of ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total']) {
    assert.equal(sum(back.products, p => p.cur[k]), sum(septSnap.products, p => p.cur[k]), k);
  }
  const a = septSnap.products.find(p => p.title === A.spider.title && p.vendor === A.spider.vendor);
  const b = back.products.find(p => p.title === A.spider.title && p.vendor === A.spider.vendor);
  assert.deepEqual(b.cur, a.cur);
  assert.deepEqual(b.prior, a.prior);
  assert.equal(b.group, a.group);
  assert.equal(b.vendor, A.spider.vendor);
  assert.deepEqual(back.meta.comparison, septSnap.meta.comparison);
  assert.equal(back.meta.shared.revision, 1);
});

test('blank product types stay blank-flagged after the round trip', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', SS.sharedPayloadFromSnapshot(septSnap).payload);
  const rep = (await call(e, 'GET', '/v1/reports')).reports[0];
  const back = SS.sharedSnapshotFromReport(rep, (await call(e, 'GET', '/v1/reports/' + encodeURIComponent(rep.id) + '/rows')).rows, helpers);
  assert.equal(back.products.filter(p => p.ptypeBlank).length, F.blankTypes);
});

test('uploading the same snapshot twice is a no-op', async () => {
  const e = env();
  const p = SS.sharedPayloadFromSnapshot(septSnap).payload;
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', p)).outcome, 'succeeded');
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', p)).outcome, 'unchanged');
});

test('a legacy browser snapshot goes to its own scope and can never revise a proper report', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', SS.sharedPayloadFromSnapshot(septSnap).payload);
  const legacy = {
    id: 'shopify_2026-09-01_2026-09-30', source: 'shopify', startDate: '2026-09-01', endDate: '2026-09-30',
    products: [{ title: 'Spider Plant', units: 10, gross: 200, disc: -20, ret: 0, net: 180, rev: 190 }]
  };
  const conv = SS.sharedPayloadFromSnapshot(legacy);
  assert.equal(conv.legacy, true);
  assert.equal(conv.payload.reportScope, SS.SHARED_SHOPIFY_LEGACY_SCOPE);
  const up = await call(e, 'POST', '/v1/ingest/product-report', conv.payload);
  assert.equal(up.outcome, 'succeeded');
  const reps = (await call(e, 'GET', '/v1/reports')).reports;
  assert.equal(reps.length, 2, 'stored beside the proper report, not over it');
  const proper = reps.find(r => r.report_scope === 'total_sales_by_product');
  assert.equal(proper.totals.net, F.cur.net);
});

test('an Amazon v2 snapshot round-trips with ASINs, revenue and Amazon-only measures', async () => {
  const e = env();
  const p = AP.parseAmazonMetricData(readCsv(AMAZON_V2_FIXTURE));
  const snap = { id: 'amazon_2026-01-01_2026-10-10_metric-data-v2', source: 'amazon', startDate: '2026-01-01', endDate: '2026-10-10',
                 products: p.products, meta: { capabilities: p.capabilities, reportScope: p.capabilities.reportVersion, sourceFilename: 'metric-data.xlsx' } };
  const conv = SS.sharedPayloadFromSnapshot(snap);
  const up = await call(e, 'POST', '/v1/ingest/product-report', conv.payload);
  assert.equal(up.outcome, 'succeeded', JSON.stringify(up.errors));
  const rep = (await call(e, 'GET', '/v1/reports?source=amazon')).reports[0];
  const back = SS.sharedSnapshotFromReport(rep, (await call(e, 'GET', '/v1/reports/' + encodeURIComponent(rep.id) + '/rows')).rows, helpers);
  assert.equal(back.id, snap.id, 'same identity as a local import of the same file');
  assert.equal(back.products.length, V2.rows);
  assert.equal(sum(back.products, 'units'), V2.units);
  assert.equal(sum(back.products, 'rev'), V2.orderedRevenue);
  assert.equal(sum(back.products, 'glance'), V2.glance);
  assert.equal(sum(back.products, 'shippedRev'), V2.shippedRevenue);
  assert.equal(back.meta.capabilities.revenueBasis, 'ordered');
  assert.equal(back.meta.capabilities.hasInventory, false);
});

test('an Amazon v1 snapshot (no revenue) stores no invented revenue', async () => {
  const e = env();
  const p = AP.parseAmazonMetricData(readCsv(AMAZON_V1_FIXTURE));
  const snap = { source: 'amazon', startDate: '2026-09-01', endDate: '2026-09-30', products: p.products,
                 meta: { capabilities: p.capabilities, reportScope: 'metric-data v1' } };
  const up = await call(e, 'POST', '/v1/ingest/product-report', SS.sharedPayloadFromSnapshot(snap).payload);
  assert.equal(up.outcome, 'succeeded', JSON.stringify(up.errors));
  const rep = (await call(e, 'GET', '/v1/reports?source=amazon')).reports[0];
  assert.equal(rep.totals.net, 0);
  assert.equal(rep.totals.units, FACTS.amazon.v1.units);
});

test('a catalog snapshot is never uploaded as a sales report', () => {
  const r = SS.sharedPayloadFromSnapshot({ source: 'shopify', isCatalog: true, products: [{ title: 'x' }] });
  assert.equal(r.ok, false);
});

test('the payload carries only product-level fields', () => {
  const p = SS.sharedPayloadFromSnapshot(septSnap).payload;
  const keys = new Set(p.rows.flatMap(r => Object.keys(r)));
  assert.deepEqual([...keys].sort(), ['cur', 'prior', 'productId', 'productType', 'title', 'vendor']);
});

// ────────────────────────────────────────────────────────────
// Status for the Data & imports view
// ────────────────────────────────────────────────────────────
test('status reports staleness and failures in plain terms', () => {
  const reports = [{ source: 'shopify', period_start: '2026-09-01', period_end: '2026-09-30' }];
  const runs = [
    { source: 'shopify', outcome: 'rejected', imported_by: 'collector', started_at: '2026-10-15T07:00:00Z', finished_at: '2026-10-15T07:00:02Z',
      error_message: 'Rows sum to 1,201 for units but the report states 1,202.' },
    { source: 'shopify', outcome: 'succeeded', imported_by: 'collector', started_at: '2026-10-01T07:00:00Z', finished_at: '2026-10-01T07:00:09Z' }
  ];
  const s = SS.sharedImportStatus(reports, runs, { today: '2026-10-15', staleDays: 10, expect: ['shopify', 'amazon'] });
  assert.equal(s.sources.shopify.daysSinceLatestPeriodEnd, 15);
  assert.equal(s.sources.shopify.stale, true);
  assert.equal(s.sources.shopify.failing, true);
  assert.equal(s.sources.shopify.lastSuccessfulImport, '2026-10-01T07:00:09Z');
  const msgs = s.alerts.map(a => a.message).join(' | ');
  assert.match(msgs, /last shopify import by automatic \(collector\) was rejected\. The previous report is still the one shown/);
  assert.match(msgs, /ends 2026-09-30, 15 days ago/);
  assert.match(msgs, /No amazon report is in shared storage yet/);
});

test('a later manual upload does not hide a failing collector', () => {
  const s = SS.sharedImportStatus(
    [{ source: 'shopify', period_start: '2026-10-01', period_end: '2026-10-14' }],
    [{ source: 'shopify', outcome: 'unchanged', imported_by: 'manual', finished_at: '2026-10-15T09:00:00Z', period_start: '2026-09-01', period_end: '2026-09-30' },
     { source: 'shopify', outcome: 'rejected', imported_by: 'collector', finished_at: '2026-10-15T07:00:00Z',
       period_start: '2026-10-01', period_end: '2026-10-14', error_message: 'Rows sum to 9 for units but the report states 10.' },
     { source: 'shopify', outcome: 'succeeded', imported_by: 'collector', finished_at: '2026-10-14T07:00:00Z' }],
    { today: '2026-10-15', staleDays: 10 });
  assert.equal(s.sources.shopify.failing, true);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].message, /by automatic \(collector\) was rejected \(2026-10-01 → 2026-10-14\)/);
});

test('a collector run that succeeds after a failure clears the alert', () => {
  const s = SS.sharedImportStatus(
    [{ source: 'shopify', period_start: '2026-10-01', period_end: '2026-10-14' }],
    [{ source: 'shopify', outcome: 'succeeded', imported_by: 'collector', finished_at: '2026-10-15T08:00:00Z' },
     { source: 'shopify', outcome: 'rejected', imported_by: 'collector', finished_at: '2026-10-15T07:00:00Z' }],
    { today: '2026-10-15', staleDays: 10 });
  assert.equal(s.alerts.length, 0);
});

test('a fresh, successful source raises no alerts', () => {
  const s = SS.sharedImportStatus(
    [{ source: 'shopify', period_start: '2026-10-01', period_end: '2026-10-14' }],
    [{ source: 'shopify', outcome: 'succeeded', finished_at: '2026-10-15T07:00:00Z' }],
    { today: '2026-10-15', staleDays: 10 });
  assert.equal(s.alerts.length, 0);
});
