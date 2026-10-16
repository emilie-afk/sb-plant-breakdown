// The shared report store, end to end: real Worker routes, real migrations,
// real SQL (Node's SQLite standing in for D1), report data from the SYNTHETIC
// sample fixtures (tools/make-sample-fixtures.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE, WITH_ID_FIXTURE, AMAZON_V2_FIXTURE, FACTS, r2 } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const globals = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType });

const MIGRATIONS = path.join(ROOT, 'worker', 'migrations');
const INGEST = 'i'.repeat(40), DASH = 'd'.repeat(40);
const ORIGIN = 'https://sb-plant-breakdown.netlify.app';

function freshEnv(opts) {
  return { DB: makeD1(MIGRATIONS, opts), INGEST_SECRET: INGEST, DASHBOARD_SECRET: DASH, ALLOWED_ORIGINS: ORIGIN };
}
async function call(env, method, p, { key, body, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  if (origin) headers.origin = origin;
  const res = await worker.fetch(new Request('https://w.example' + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

// Build an ingest payload from the sample report, exactly as the
// collector or the dashboard's manual upload would.
const F = FACTS.shopify, A = F.anchors;
const sept = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
function septPayload(over = {}) {
  return Object.assign({
    source: 'shopify', reportScope: 'total_sales_by_product', importedBy: 'collector',
    period: { start: '2026-09-01', end: '2026-09-30' },
    comparison: { start: '2026-08-02', end: '2026-08-31', source: 'stated at import' },
    timezone: 'America/Los_Angeles', currency: 'USD',
    sourceFilename: 'Total sales by product - 2026-09-01 - 2026-09-30.csv',
    client: 'test-host',
    totals: sept.totals.current,
    rows: sept.records.map(r => ({ productId: r.productId || null, title: r.title, vendor: r.vendor,
      productType: r.ptype, cur: r.cur, prior: r.priorKnown ? r.prior : null }))
  }, over);
}

// ────────────────────────────────────────────────────────────
// Access
// ────────────────────────────────────────────────────────────
test('health needs no key; everything else does', async () => {
  const env = freshEnv();
  assert.equal((await call(env, 'GET', '/v1/health')).status, 200);
  assert.equal((await call(env, 'GET', '/v1/reports')).status, 401);
  assert.equal((await call(env, 'GET', '/v1/reports', { key: 'wrong'.repeat(10) })).status, 401);
});

test('the collector key can add reports and nothing else', async () => {
  const env = freshEnv();
  assert.equal((await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() })).status, 200);
  assert.equal((await call(env, 'GET', '/v1/reports', { key: INGEST })).status, 403);
  assert.equal((await call(env, 'GET', '/v1/imports', { key: INGEST })).status, 403);
  assert.equal((await call(env, 'PUT', '/v1/settings/classification_overrides', { key: INGEST, body: { value: {} } })).status, 403);
});

test('who imported is decided by the key, not by the payload', async () => {
  const env = freshEnv();
  await call(env, 'POST', '/v1/ingest/product-report', { key: DASH, body: septPayload({ importedBy: 'collector' }) });
  const runs = (await call(env, 'GET', '/v1/imports', { key: DASH })).json.imports;
  assert.equal(runs[0].imported_by, 'manual');
});

test('CORS answers only the configured origin', async () => {
  const env = freshEnv();
  const ok = await call(env, 'GET', '/v1/health', { origin: ORIGIN });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  const other = await call(env, 'GET', '/v1/health', { origin: 'https://evil.example' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

// ────────────────────────────────────────────────────────────
// Storing and reading back a report
// ────────────────────────────────────────────────────────────
test('a monthly report is stored and reads back to the cent', async () => {
  const env = freshEnv();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() });
  assert.equal(r.json.outcome, 'succeeded');
  assert.equal(r.json.revision, 1);

  const list = (await call(env, 'GET', '/v1/reports?source=shopify', { key: DASH })).json.reports;
  assert.equal(list.length, 1);
  assert.equal(list[0].totals.net, F.cur.net);
  assert.equal(list[0].totals.total, F.cur.total);
  assert.equal(list[0].totals.units, F.cur.units);
  assert.equal(list[0].row_count, F.rows);
  assert.equal(list[0].timezone, 'America/Los_Angeles');
  assert.equal(list[0].comparison_start, '2026-08-02');

  const rows = (await call(env, 'GET', '/v1/reports/' + encodeURIComponent(list[0].id) + '/rows', { key: DASH })).json.rows;
  assert.equal(rows.length, F.rows);
  const spider = rows.find(x => x.title === A.spider.title && x.vendor === A.spider.vendor);
  assert.equal(spider.cur.net, A.spider.cur.net);
  assert.equal(spider.prior.units, A.spider.prior.units);
  const neg = rows.find(x => x.title === A.negative.title && x.vendor === A.negative.vendor);
  assert.equal(neg.cur.net, A.negative.cur.net, 'negative sales survive storage');
  assert.ok(neg.cur.net < 0);
  assert.equal(Math.round(rows.reduce((s, x) => s + x.cur.net, 0) * 100) / 100, F.cur.net);
});

test('the product-id export stores its ids', async () => {
  const env = freshEnv();
  const withId = SR.parseShopifyProductReport(readCsv(WITH_ID_FIXTURE), { classify });
  const body = septPayload({
    period: { start: '2026-09-15', end: '2026-10-14' }, comparison: null,
    totals: withId.totals.current,
    rows: withId.records.map(r => ({ productId: r.productId, title: r.title, vendor: r.vendor, productType: r.ptype, cur: r.cur }))
  });
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(r.json.outcome, 'succeeded', JSON.stringify(r.json));
  const list = (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports;
  assert.equal(list[0].has_product_id, 1);
  assert.equal(list[0].capabilities.hasProductId, true);
  const rows = (await call(env, 'GET', '/v1/reports/' + encodeURIComponent(list[0].id) + '/rows', { key: DASH })).json.rows;
  assert.ok(rows.every(x => /^\d+$/.test(x.productId)));
});

// ────────────────────────────────────────────────────────────
// Idempotency
// ────────────────────────────────────────────────────────────
test('re-sending the identical report writes nothing new', async () => {
  const env = freshEnv();
  await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() });
  const again = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() });
  assert.equal(again.json.outcome, 'unchanged');
  assert.equal(again.json.revision, 1);
  const c = env.DB._raw.prepare('SELECT COUNT(*) c FROM reports').get().c;
  assert.equal(c, 1, 'no second report row');
  const rc = env.DB._raw.prepare('SELECT COUNT(*) c FROM report_rows').get().c;
  assert.equal(rc, F.rows, 'rows not duplicated');
  const runs = (await call(env, 'GET', '/v1/imports', { key: DASH })).json.imports;
  assert.deepEqual(runs.map(r => r.outcome).sort(), ['succeeded', 'unchanged']);
});

test('a revised report for the same period supersedes, never adds', async () => {
  const env = freshEnv();
  await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() });
  const body = septPayload();
  body.rows[0] = { ...body.rows[0], cur: { ...body.rows[0].cur, units: body.rows[0].cur.units + 1 } };
  body.totals = { ...body.totals, units: body.totals.units + 1 };
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(r.json.outcome, 'succeeded');
  assert.equal(r.json.revision, 2);
  const active = env.DB._raw.prepare("SELECT id, revision FROM reports WHERE status='active'").all();
  assert.equal(active.length, 1);
  assert.equal(active[0].revision, 2);
  const list = (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports;
  assert.equal(list.length, 1);
  assert.equal(list[0].totals.units, F.cur.units + 1);
});

test('the database itself refuses two active reports for one period', () => {
  const env = freshEnv();
  const db = env.DB._raw;
  const ins = (id, st) => db.prepare(`INSERT INTO reports (id, report_key, source, report_scope, period_start, period_end,
      timezone, currency, content_hash, row_count, totals_json, capabilities_json, status, imported_at, imported_by)
      VALUES (?, 'k', 'shopify', 's', '2026-09-01', '2026-09-30', 'tz', 'USD', 'h', 0, '{}', '{}', ?, 'now', 'manual')`).run(id, st);
  ins('a', 'active');
  assert.throws(() => ins('b', 'active'), /UNIQUE/);
  ins('c', 'superseded');   // any number of superseded revisions is fine
});

// ────────────────────────────────────────────────────────────
// Validation failures keep the last good report
// ────────────────────────────────────────────────────────────
async function withGoodReport() {
  const env = freshEnv();
  await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body: septPayload() });
  return env;
}
async function activeNet(env) {
  return (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports.map(r => r.totals.net);
}

test('rows that do not add up to the stated totals are refused', async () => {
  const env = await withGoodReport();
  const body = septPayload(); body.rows.pop();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(r.status, 422);
  assert.ok(r.json.errors.some(e => e.code === 'totals_mismatch'));
  assert.deepEqual(await activeNet(env), [F.cur.net], 'last good report untouched');
  const runs = (await call(env, 'GET', '/v1/imports', { key: DASH })).json.imports;
  assert.equal(runs[0].outcome, 'rejected');
  assert.match(runs[0].error_code, /totals_mismatch/);
  assert.ok(runs[0].error_message.length > 10, 'a readable failure message is kept');
});

test('a payload carrying customer-looking fields is refused outright', async () => {
  const env = await withGoodReport();
  const body = septPayload(); body.rows[0] = { ...body.rows[0], customer_email: 'x@example.com' };
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(r.status, 422);
  assert.ok(r.json.errors.some(e => e.code === 'customer_data_present'));
  const stored = env.DB._raw.prepare("SELECT COUNT(*) c FROM report_rows WHERE title LIKE '%@%'").get().c;
  assert.equal(stored, 0);
  assert.ok(!JSON.stringify(r.json).includes('x@example.com'), 'the value is never echoed back');
});

test('a comparison period overlapping the reporting period is refused', async () => {
  const env = await withGoodReport();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST,
    body: septPayload({ comparison: { start: '2026-09-15', end: '2026-10-15' } }) });
  assert.ok(r.json.errors.some(e => e.code === 'comparison_overlaps'));
});

test('an export that hit its source row limit is refused as probably truncated', async () => {
  const env = await withGoodReport();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST,
    body: septPayload({ sourceRowLimit: F.rows }) });
  assert.ok(r.json.errors.some(e => e.code === 'possibly_truncated'));
});

test('bad JSON is refused and recorded nowhere as a report', async () => {
  const env = await withGoodReport();
  const res = await worker.fetch(new Request('https://w.example/v1/ingest/product-report', {
    method: 'POST', headers: { authorization: 'Bearer ' + INGEST, 'content-type': 'application/json' }, body: '{not json'
  }), env);
  assert.equal(res.status, 400);
  assert.deepEqual(await activeNet(env), [F.cur.net]);
});

// ────────────────────────────────────────────────────────────
// Storage failure part-way through
// ────────────────────────────────────────────────────────────
test('a storage failure mid-import leaves the previous report active and intact', async () => {
  const env = await withGoodReport();
  const body = septPayload();
  body.rows[0] = { ...body.rows[0], cur: { ...body.rows[0].cur, units: body.rows[0].cur.units + 1 } };
  body.totals = { ...body.totals, units: body.totals.units + 1 };
  env.DB._setFailOnBatch(3);                              // fail while rows are being written
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(r.status, 500);
  assert.equal(r.json.outcome, 'failed');

  const statuses = env.DB._raw.prepare('SELECT revision, status FROM reports ORDER BY revision').all();
  assert.deepEqual(statuses.map(s => [s.revision, s.status]), [[1, 'active'], [2, 'abandoned']]);
  const list = (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports;
  assert.equal(list.length, 1);
  assert.equal(list[0].revision, 1);
  assert.equal(list[0].totals.units, F.cur.units, 'the dashboard still sees the last good figures');
  const runs = (await call(env, 'GET', '/v1/imports', { key: DASH })).json.imports;
  assert.equal(runs[0].outcome, 'failed');
  assert.match(runs[0].error_message, /previous report is unchanged/);

  // Retrying afterwards works and does not collide with the failed attempt.
  env.DB._setFailOnBatch(0);
  const retry = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  assert.equal(retry.json.outcome, 'succeeded');
  assert.equal(retry.json.revision, 3);
  const active = env.DB._raw.prepare("SELECT revision FROM reports WHERE status='active'").all();
  assert.deepEqual(active.map(a => a.revision), [3]);
});

// ────────────────────────────────────────────────────────────
// Overlapping periods
// ────────────────────────────────────────────────────────────
test('an overlapping period may be stored, but is reported and never merged', async () => {
  const env = await withGoodReport();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST,
    body: septPayload({ period: { start: '2026-07-01', end: '2026-09-30' }, comparison: null }) });
  assert.equal(r.json.outcome, 'succeeded');
  assert.equal(r.json.overlaps.length, 1);
  assert.equal(r.json.overlaps[0].periodStart, '2026-09-01');
  const list = (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports;
  assert.equal(list.length, 2, 'two separate reports, never one summed figure');
  const runs = (await call(env, 'GET', '/v1/imports', { key: DASH })).json.imports;
  assert.match(runs[0].error_message, /never summed/);
});

// ────────────────────────────────────────────────────────────
// Amazon
// ────────────────────────────────────────────────────────────
test('an Amazon report keeps its ASINs and Amazon-only measures', async () => {
  const env = freshEnv();
  const p = AP.parseAmazonMetricData(readCsv(AMAZON_V2_FIXTURE));
  const rows = p.products.map(x => ({
    asin: x.asin, title: x.title, vendor: '(not in Amazon export)', productType: '(not in Amazon export)',
    cur: { units: x.units, net: x.rev, total: x.rev, glance: x.glance, inv: x.inv },
    extra: { shipped: x.shipped, shippedRev: x.shippedRev, orderItems: x.orderItems }
  }));
  const V2 = FACTS.amazon.v2;
  const totals = { units: V2.units, net: V2.orderedRevenue, total: V2.orderedRevenue };
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: DASH, body: {
    source: 'amazon', reportScope: 'metric-data v2', period: { start: '2026-01-01', end: '2026-10-10' },
    timezone: 'America/Los_Angeles', currency: 'USD', totals, rows, sourceFilename: 'metric-data.xlsx'
  } });
  assert.equal(r.json.outcome, 'succeeded', JSON.stringify(r.json.errors));
  const list = (await call(env, 'GET', '/v1/reports?source=amazon', { key: DASH })).json.reports;
  const back = (await call(env, 'GET', '/v1/reports/' + encodeURIComponent(list[0].id) + '/rows', { key: DASH })).json.rows;
  assert.equal(back.length, V2.rows);
  const ivy = back.find(x => x.asin === V2.ivy.asin);
  assert.equal(ivy.cur.net, V2.ivy.rev);
  assert.deepEqual(ivy.extra, { shipped: V2.ivy.shipped, shippedRev: V2.ivy.shippedRev, orderItems: V2.ivy.orderItems });
  assert.equal(back.reduce((s, x) => s + x.cur.glance, 0), V2.glance);
});

test('an Amazon row with a malformed ASIN is refused', async () => {
  const env = freshEnv();
  const r = await call(env, 'POST', '/v1/ingest/product-report', { key: DASH, body: {
    source: 'amazon', reportScope: 'x', period: { start: '2026-09-01', end: '2026-09-30' },
    timezone: 'America/Los_Angeles', currency: 'USD', totals: { units: 1 },
    rows: [{ asin: 'B0GSFRG62300', title: 'x', cur: { units: 1 } }]
  } });
  assert.ok(r.json.errors.some(e => e.code === 'bad_asin'));
});

// ────────────────────────────────────────────────────────────
// Shared settings
// ────────────────────────────────────────────────────────────
test('shared settings round-trip and refuse a stale overwrite', async () => {
  const env = freshEnv();
  const k = '/v1/settings/amazon_column_mappings';
  assert.equal((await call(env, 'GET', k, { key: DASH })).json.setting, null);
  const w1 = await call(env, 'PUT', k, { key: DASH, body: { value: { sigA: { mapping: { a: 'units' } } }, baseVersion: 0 } });
  assert.equal(w1.json.version, 1);
  const got = (await call(env, 'GET', k, { key: DASH })).json.setting;
  assert.deepEqual(got.value, { sigA: { mapping: { a: 'units' } } });
  // A second browser still holding version 0 cannot overwrite version 1.
  const stale = await call(env, 'PUT', k, { key: DASH, body: { value: {}, baseVersion: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.currentVersion, 1);
  assert.equal((await call(env, 'PUT', '/v1/settings/not_a_setting', { key: DASH, body: { value: 1 } })).status, 404);
});

test('source capabilities are whitelisted and cannot override what the Worker verifies', async () => {
  const env = freshEnv();
  const body = septPayload({ sourceCapabilities: {
    hasProductId: true,            // false in reality: this sample has no ids
    reportVersion: 'metric-data v2',
    evil: '<script>', nested: { a: 1 }
  } });
  await call(env, 'POST', '/v1/ingest/product-report', { key: INGEST, body });
  const caps = (await call(env, 'GET', '/v1/reports', { key: DASH })).json.reports[0].capabilities;
  assert.equal(caps.hasProductId, false, 'verified by the Worker, not taken from the payload');
  assert.equal(caps.reportVersion, 'metric-data v2', 'a whitelisted descriptive field is kept');
  assert.equal('evil' in caps, false);
  assert.equal('nested' in caps, false);
});
