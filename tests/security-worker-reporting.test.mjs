// The Marketing Dashboard's reporting key (REPORTING_SECRET): its own revocable credential on the existing
// read API. Real routes and migrations, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const g = loadBrowserGlobals();
const sept = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify: (r) => PG.classifyRecord(r, { detectGenus: g.detectGenus, detectNonPlantType: g.detectNonPlantType }) });
const payload = () => ({
  source: 'shopify', reportScope: 'total_sales_by_product', period: { start: '2026-09-01', end: '2026-09-30' },
  timezone: 'America/Los_Angeles', currency: 'USD', sourceFilename: 'PRIVATE-FILE-NAME.csv', totals: sept.totals.current,
  rows: sept.records.map(r => ({ productId: r.productId || null, title: r.title, vendor: r.vendor, productType: r.ptype, cur: r.cur, prior: r.priorKnown ? r.prior : null })),
});
const K = { INGEST_SECRET: 'i'.repeat(40), VIEWER_SECRET: 'v'.repeat(40), UPLOAD_SECRET: 'u'.repeat(40), SETTINGS_SECRET: 's'.repeat(40),
  DASHBOARD_SECRET: 'd'.repeat(40), AUTH_SECRET: 'a'.repeat(40), REPORTING_SECRET: 'r'.repeat(40) };
const env = (over = {}) => ({ DB: makeD1(path.join(ROOT, 'worker', 'migrations')), ALLOWED_ORIGINS: 'https://dash.example', ...K, ...over });
async function call(e, method, p, key, body, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers }; if (key) h.authorization = 'Bearer ' + key;
  const r = await worker.fetch(new Request('https://w.example' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e);
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j };
}
const ID = encodeURIComponent('shopify:total_sales_by_product:2026-09-01:2026-09-30:r1');

test('the reporting key reads reports, rows and imports, and nothing else', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', K.INGEST_SECRET, payload(), { 'x-sb-client': 'PRIVATE-HOST' })).status, 200);
  const R = K.REPORTING_SECRET;
  assert.equal((await call(e, 'GET', '/v1/reports', R)).status, 200);
  assert.equal((await call(e, 'GET', `/v1/reports/${ID}/rows?offset=0&limit=10`, R)).status, 200);
  assert.equal((await call(e, 'GET', '/v1/imports', R)).status, 200);
  for (const [m, p, b] of [['POST', '/v1/ingest/product-report', payload()], ['POST', '/v1/ingest/collection-failure', { code: 'other', message: 'x', source: 'shopify' }],
    ['GET', '/v1/ingest/coverage'], ['POST', '/v1/ingest/vendor-map', { value: {} }], ['GET', '/v1/settings/market_config'],
    ['PUT', '/v1/settings/catalog_mappings', { value: {}, baseVersion: 0 }], ['POST', '/v1/auth/attempt', { client: 'abcdefghijklmnop', windowSec: 60 }]]) {
    assert.equal((await call(e, m, p, R, b)).status, 403, `${m} ${p}`);
  }
});

test('reports and rows match the viewer key; file names, client labels and error text are withheld', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', K.INGEST_SECRET, payload());
  await call(e, 'POST', '/v1/ingest/product-report', K.INGEST_SECRET, { ...payload(), rows: 'not rows' });   // a rejected import with an error
  const viewer = await call(e, 'GET', '/v1/reports', K.VIEWER_SECRET);
  const rep = await call(e, 'GET', '/v1/reports', K.REPORTING_SECRET);
  const [v] = viewer.json.reports, [r] = rep.json.reports;
  assert.equal(r.id, v.id);
  assert.equal(r.revision, v.revision);
  assert.deepEqual(r.totals, v.totals);
  for (const k of ['period_start', 'period_end', 'timezone', 'completeness', 'collected_at', 'status', 'report_scope']) assert.equal(r[k], v[k], k);
  assert.equal(v.source_filename, 'PRIVATE-FILE-NAME.csv');
  assert.ok(!('source_filename' in r) && !('imported_by' in r));
  const vr = await call(e, 'GET', `/v1/reports/${ID}/rows?offset=0&limit=5000`, K.VIEWER_SECRET);
  const rr = await call(e, 'GET', `/v1/reports/${ID}/rows?offset=0&limit=5000`, K.REPORTING_SECRET);
  assert.deepEqual(rr.json.rows, vr.json.rows);
  const imports = (await call(e, 'GET', '/v1/imports', K.REPORTING_SECRET)).json.imports;
  assert.ok(imports.length >= 2);
  for (const i of imports) for (const k of ['error_message', 'client', 'imported_by']) assert.ok(!(k in i), k);
  assert.ok(imports.some(i => i.outcome === 'rejected' && i.error_code), 'the outcome and code stay');
  assert.ok(!JSON.stringify(rep.json).includes('PRIVATE'));
});

test('rows page with offset and limit', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', K.INGEST_SECRET, payload());
  const all = (await call(e, 'GET', `/v1/reports/${ID}/rows?offset=0&limit=5000`, K.REPORTING_SECRET)).json.rows;
  assert.ok(all.length >= 4);
  const a = (await call(e, 'GET', `/v1/reports/${ID}/rows?offset=0&limit=2`, K.REPORTING_SECRET)).json.rows;
  const b = (await call(e, 'GET', `/v1/reports/${ID}/rows?offset=2&limit=2`, K.REPORTING_SECRET)).json.rows;
  assert.deepEqual([...a, ...b], all.slice(0, 4));
});

test('unset or short reporting keys grant nothing; revoking takes effect at once', async () => {
  for (const over of [{ REPORTING_SECRET: undefined }, { REPORTING_SECRET: 'short' }]) {
    assert.equal((await call(env(over), 'GET', '/v1/reports', K.REPORTING_SECRET)).status, 401);
  }
  const e = env();
  assert.equal((await call(e, 'GET', '/v1/reports', K.REPORTING_SECRET)).status, 200);
  delete e.REPORTING_SECRET;
  assert.equal((await call(e, 'GET', '/v1/reports', K.REPORTING_SECRET)).status, 401);
});

// Regression: REPORTING_SECRET equal to DASHBOARD_SECRET used to resolve to the dashboard role and read settings.
test('a reporting key equal to any other credential fails closed: that value grants nothing anywhere', async () => {
  const others = ['DASHBOARD_SECRET', 'VIEWER_SECRET', 'INGEST_SECRET', 'UPLOAD_SECRET', 'SETTINGS_SECRET', 'AUTH_SECRET'];
  const every = [['GET', '/v1/reports'], ['GET', `/v1/reports/${ID}/rows?offset=0&limit=10`], ['GET', '/v1/imports'],
    ['GET', '/v1/settings/market_config'], ['PUT', '/v1/settings/catalog_mappings', { value: {}, baseVersion: 0 }],
    ['POST', '/v1/ingest/product-report', payload()], ['GET', '/v1/ingest/coverage'], ['POST', '/v1/ingest/vendor-map', { value: {} }],
    ['POST', '/v1/ingest/collection-failure', { code: 'other', message: 'x', source: 'shopify' }], ['POST', '/v1/auth/attempt', { client: 'abcdefghijklmnop', windowSec: 60 }]];
  for (const name of others) {
    const e = env({ REPORTING_SECRET: K[name] });
    for (const [m, p, b] of every) {
      assert.equal((await call(e, m, p, K[name], b)).status, 401, `REPORTING_SECRET = ${name}: ${m} ${p}`);
    }
    // Credentials that do not collide keep working.
    const intact = others.find(o => o !== name && o !== 'AUTH_SECRET' && o !== 'UPLOAD_SECRET' && o !== 'SETTINGS_SECRET' && o !== 'INGEST_SECRET') || 'VIEWER_SECRET';
    if (intact !== name) assert.equal((await call(e, 'GET', '/v1/reports', K[intact])).status, 200, `${intact} unaffected when reporting = ${name}`);
  }
});

test('any two equal secrets fail closed for that value', async () => {
  const e = env({ VIEWER_SECRET: K.DASHBOARD_SECRET });
  assert.equal((await call(e, 'GET', '/v1/reports', K.DASHBOARD_SECRET)).status, 401);
  assert.equal((await call(e, 'GET', '/v1/settings/market_config', K.DASHBOARD_SECRET)).status, 401);
  assert.equal((await call(e, 'GET', '/v1/reports', K.REPORTING_SECRET)).status, 200, 'distinct secrets still work');
});

test('the viewer key keeps exactly its earlier access', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', K.INGEST_SECRET, payload());
  assert.equal((await call(e, 'GET', '/v1/settings/market_config', K.VIEWER_SECRET)).status, 200);
  const v = (await call(e, 'GET', '/v1/reports', K.VIEWER_SECRET)).json.reports[0];
  assert.equal(v.source_filename, 'PRIVATE-FILE-NAME.csv');
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', K.VIEWER_SECRET, payload())).status, 403);
});
