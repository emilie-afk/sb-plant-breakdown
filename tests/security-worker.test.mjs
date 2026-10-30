// Worker roles end to end (real routes, real migrations, synthetic data), and
// the gateway driving the real Worker: per-route keys, idempotent ingest,
// settings validation, private settings survive, nothing private in health.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';
import { checkSettingValue } from '../worker/src/store.js';
import * as S from '../server/session.mjs';
import { apiHandler } from '../server/handlers.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const ES = require(path.join(ROOT, 'export-safety.js'));
const g = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: g.detectGenus, detectNonPlantType: g.detectNonPlantType });
const sept = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
const payload = () => ({
  source: 'shopify', reportScope: 'total_sales_by_product', period: { start: '2026-09-01', end: '2026-09-30' },
  timezone: 'America/Los_Angeles', currency: 'USD', sourceFilename: 'sample.csv', totals: sept.totals.current,
  rows: sept.records.map(r => ({ productId: r.productId || null, title: r.title, vendor: r.vendor, productType: r.ptype, cur: r.cur, prior: r.priorKnown ? r.prior : null }))
});

const K = { INGEST_SECRET: 'i'.repeat(40), VIEWER_SECRET: 'v'.repeat(40), UPLOAD_SECRET: 'u'.repeat(40), SETTINGS_SECRET: 's'.repeat(40), DASHBOARD_SECRET: 'd'.repeat(40) };
const env = (over = {}) => ({ DB: makeD1(path.join(ROOT, 'worker', 'migrations')), ALLOWED_ORIGINS: 'https://dash.example', ...K, ...over });
async function call(e, method, p, key, body) {
  const h = { 'content-type': 'application/json' }; if (key) h.authorization = 'Bearer ' + key;
  const r = await worker.fetch(new Request('https://w.example' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e);
  let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j };
}

test('health is public and carries no private data', async () => {
  const r = await call(env(), 'GET', '/v1/health');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['ok', 'service', 'time']);
});

test('role matrix: each key can do its job and nothing else', async () => {
  const e = env();
  const ID = encodeURIComponent('shopify:total_sales_by_product:2026-09-01:2026-09-30:r1');
  const ops = {
    ingest: ['POST', '/v1/ingest/product-report', payload()],
    failure: ['POST', '/v1/ingest/collection-failure', { code: 'other', message: 'x', source: 'shopify' }],
    coverage: ['GET', '/v1/ingest/coverage'],
    reports: ['GET', '/v1/reports'], rows: ['GET', `/v1/reports/${ID}/rows?offset=0&limit=10`], imports: ['GET', '/v1/imports'],
    readSetting: ['GET', '/v1/settings/market_config'],
    writeSetting: ['PUT', '/v1/settings/catalog_mappings', { value: {}, baseVersion: 0 }]
  };
  const allowed = {
    INGEST_SECRET: ['ingest', 'failure', 'coverage'],
    VIEWER_SECRET: ['reports', 'rows', 'imports', 'readSetting'],
    UPLOAD_SECRET: ['ingest'],
    SETTINGS_SECRET: ['writeSetting']
  };
  for (const [secret, ok] of Object.entries(allowed)) {
    for (const [name, [m, p, b]] of Object.entries(ops)) {
      const r = await call(e, m, p, K[secret], b);
      if (ok.includes(name)) assert.notEqual(r.status, 403, `${secret} may ${name}`);
      else assert.equal(r.status, 403, `${secret} may not ${name}`);
      if (name === 'writeSetting' && ok.includes(name)) ops.writeSetting[2] = { value: {}, baseVersion: r.json.version };
    }
  }
});

test('missing or short secrets grant nothing; a short bearer never matches', async () => {
  const e = env({ VIEWER_SECRET: 'short-secret', UPLOAD_SECRET: undefined });
  assert.equal((await call(e, 'GET', '/v1/reports', 'short-secret')).status, 401);
  assert.equal((await call(e, 'GET', '/v1/reports', '')).status, 401);
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', 'undefined', payload())).status, 401);
  const none = env({ INGEST_SECRET: '', VIEWER_SECRET: '', UPLOAD_SECRET: '', SETTINGS_SECRET: '', DASHBOARD_SECRET: '' });
  for (const k of Object.values(K)) assert.equal((await call(none, 'GET', '/v1/reports', k)).status, 401);
});

test('CORS is not authentication: an allowed origin without a key is still 401', async () => {
  const r = await worker.fetch(new Request('https://w.example/v1/reports', { headers: { origin: 'https://dash.example' } }), env());
  assert.equal(r.status, 401);
});

test('settings: unknown keys 404, vendor_map only via its route, values validated', async () => {
  const e = env();
  assert.equal((await call(e, 'GET', '/v1/settings/not_a_setting', K.VIEWER_SECRET)).status, 404);
  assert.equal((await call(e, 'PUT', '/v1/settings/vendor_map', K.DASHBOARD_SECRET, { value: {}, baseVersion: 0 })).status, 400);
  assert.equal((await call(e, 'PUT', '/v1/settings/restricted_items', K.DASHBOARD_SECRET, { value: { items: 'x' }, baseVersion: 0 })).status, 400);
  assert.equal((await call(e, 'PUT', '/v1/settings/market_config', K.DASHBOARD_SECRET, { value: { storeGroups: [{ match: '(a+)+$', group: 'X' }] }, baseVersion: 0 })).status, 400);
  assert.ok(checkSettingValue('restricted_items', { items: [{ sku: 'A1', name: 'Plant A' }] }) === null);
  assert.ok(checkSettingValue('market_config', { storeGroups: [{ match: '^alpha', group: 'Alpha' }], focusStores: ['Alpha'] }) === null);
  assert.ok(checkSettingValue('market_config', { focusStores: ['x'.repeat(200)] }));
  assert.ok(checkSettingValue('restricted_items', { items: [{}] }));
});

test('errors are redacted: no stack, SQL or values', async () => {
  const e = env(); e.DB = { prepare() { throw new Error('SQL near "secret_table" ' + K.VIEWER_SECRET); } };
  const r = await call(e, 'GET', '/v1/reports', K.VIEWER_SECRET);
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { ok: false, error: 'server_error' });
});

// ---- gateway -> real Worker ------------------------------------------
const NENV = { SESSION_SECRET: 'x'.repeat(40),
  GOOGLE_CLIENT_ID: '1234-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-client-secret-123',
  GOOGLE_ALLOWED_EMAILS: 'viewer@example.com', GOOGLE_EDITOR_EMAILS: 'editor@example.com', GOOGLE_REDIRECT_ORIGINS: 'https://dash.example',
  WORKER_URL: 'https://w.example', WORKER_VIEWER_SECRET: K.VIEWER_SECRET, WORKER_UPLOAD_SECRET: K.UPLOAD_SECRET, WORKER_SETTINGS_SECRET: K.SETTINGS_SECRET };
const cfg = S.loadAuthConfig(NENV);
const sess = (role) => { const s = S.signSession(cfg, { role, email: role + '@example.com' }); return { cookie: S.COOKIE + '=' + s.token, csrf: S.csrfToken(cfg, s.payload.sid) }; };
const gw = (e) => async (method, p, s, body) => {
  const h = { cookie: s.cookie, 'x-sb-csrf': s.csrf, origin: 'https://dash.example' }; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await apiHandler(new Request('https://dash.example/api' + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    { env: NENV, store: S.memoryStore(), fetchImpl: (u, init) => worker.fetch(new Request(u, init), e) });
  return { status: r.status, json: await r.json() };
};

test('gateway + Worker: editor upload is idempotent, viewer reads it, viewer cannot upload', async () => {
  const e = env(); const G = gw(e);
  const ed = sess('editor'), vw = sess('viewer');
  const a = await G('POST', '/v1/ingest/product-report', ed, payload());
  const b = await G('POST', '/v1/ingest/product-report', ed, payload());
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.ok(b.json.duplicate || b.json.unchanged || b.json.revision === a.json.revision, 'same file twice is one revision');
  assert.equal((await G('POST', '/v1/ingest/product-report', vw, payload())).status, 403);
  const list = await G('GET', '/v1/reports?source=shopify', vw);
  assert.equal(list.status, 200); assert.equal(list.json.reports.length, 1);
  const imp = await G('GET', '/v1/imports?limit=10', vw);
  assert.equal(imp.json.imports.filter(i => i.importedBy !== 'collector').length >= 1, true, 'recorded as a manual upload');
});

test('private settings pushed by the operator survive and reach a viewer session; editors cannot overwrite them via the gateway', async () => {
  const e = env(); const G = gw(e);
  const synthetic = { storeGroups: [{ match: '^nursery alpha', group: 'Nursery Alpha' }], focusStores: ['Nursery Alpha'] };
  assert.equal((await call(e, 'PUT', '/v1/settings/market_config', K.SETTINGS_SECRET, { value: synthetic, baseVersion: 0 })).status, 200);
  const r = await G('GET', '/v1/settings/market_config', sess('viewer'));
  assert.deepEqual(r.json.setting.value, synthetic);
  assert.equal((await G('PUT', '/v1/settings/market_config', sess('editor'), { value: {}, baseVersion: 1 })).status, 405);
  assert.equal((await G('PUT', '/v1/settings/catalog_mappings', sess('editor'), { value: { a: 1 }, baseVersion: 0 })).status, 200);
});

test('exports: formula-looking text is neutralised, numbers are not; HTML escaping', () => {
  for (const [i, o] of [['=HYPERLINK("x")', '\'=HYPERLINK("x")'], ['+1+2 cmd', "'+1+2 cmd"], ['@SUM(A1)', "'@SUM(A1)"], ['-x', "'-x"], ['\tx', "'\tx"],
    ['-12.5', '-12.5'], ['+3', '+3'], ['12%', '12%'], ['Plant', 'Plant'], [42, 42], [null, null]]) assert.equal(ES.sbSafeCell(i), o, JSON.stringify(i));
  assert.equal(ES.sbHtml('<img src=x onerror=alert(1)>&"\''), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  const X = { utils: { json_to_sheet: (rows) => rows, aoa_to_sheet: (rows) => rows } };
  ES.sbWrapXlsx(X);
  assert.deepEqual(X.utils.json_to_sheet([{ t: '=1+1', n: 5 }]), [{ t: "'=1+1", n: 5 }]);
  assert.deepEqual(X.utils.aoa_to_sheet([['@x', '-3']]), [["'@x", '-3']]);
});
