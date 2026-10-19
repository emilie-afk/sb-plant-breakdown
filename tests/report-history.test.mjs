// Report history in shared storage: revisions, timestamps, completeness,
// included/excluded totals, the viewer key and collection failures. Real
// Worker routes and migrations over Node's SQLite; SYNTHETIC report data.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';
import { completenessFor, storeDate } from '../worker/src/validate.js';

const INGEST = 'i'.repeat(40), DASH = 'd'.repeat(40), VIEW = 'v'.repeat(40);
const env = (opts) => ({ DB: makeD1(path.join(ROOT, 'worker', 'migrations'), opts), INGEST_SECRET: INGEST, DASHBOARD_SECRET: DASH, VIEWER_SECRET: VIEW });
async function call(e, method, p, { key, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  const res = await worker.fetch(new Request('https://w.example' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function rows(scale = 1) {
  return [
    { productId: '11', title: 'Plant A', vendor: 'V1', productType: 'Succulent', salesChannel: 'Online Store',
      cur: { units: 4 * scale, gross: 40 * scale, disc: -4 * scale, ret: 0, net: 36 * scale, tax: 2 * scale, total: 38 * scale } },
    { productId: '12', title: 'Shipping protection', vendor: 'V2', productType: 'Service', salesChannel: 'Online Store',
      cur: { units: 1, gross: 3, disc: 0, ret: 0, net: 3, tax: 0, total: 3 } }
  ];
}
function payload(start, end, over = {}) {
  const rs = over.rows || rows();
  const totals = {};
  ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total'].forEach(k => { totals[k] = Math.round(rs.reduce((s, r) => s + r.cur[k], 0) * 100) / 100; });
  return Object.assign({ source: 'shopify', reportScope: 'total_sales_by_product', importedBy: 'collector',
    period: { start, end }, timezone: 'America/Los_Angeles', currency: 'USD', totals, rows: rs }, over, { rows: rs });
}

test('a collection timestamp is not the sales period: completeness uses the store calendar', () => {
  assert.equal(storeDate('2026-10-16T06:30:00Z', 'America/Los_Angeles'), '2026-10-15');
  assert.equal(completenessFor('2026-09-01', '2026-09-30', '2026-09-30T23:00:00Z', 'America/Los_Angeles'), 'partial', 'Sep 30 was still running in Los Angeles');
  assert.equal(completenessFor('2026-09-01', '2026-09-30', '2026-10-01T08:00:00Z', 'America/Los_Angeles'), 'complete');
  assert.equal(completenessFor('2026-10-01', '2026-10-15', '2026-10-20T08:00:00Z', 'America/Los_Angeles'), 'partial', 'month to date is partial');
  assert.equal(completenessFor('2026-07-01', '2026-09-30', '2026-10-01T08:00:00Z', 'America/Los_Angeles'), 'complete', 'a finished quarter');
  assert.equal(completenessFor('2026-07-01', '2026-09-30', '2026-09-30T20:00:00Z', 'America/Los_Angeles'), 'partial');
});

test('each report keeps source, dates, timezone, currency, timestamps, revision, status and split totals', async () => {
  const e = env();
  const r = await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-09-01', '2026-09-30', {
    collectedAt: '2026-10-02T09:00:00Z',
    includedTotals: { units: 4, gross: 40, disc: -4, ret: 0, net: 36, tax: 2, total: 38 },
    excludedTotals: { units: 1, gross: 3, disc: 0, ret: 0, net: 3, tax: 0, total: 3 },
    exclusionLabels: ['Shipping protection'] }) });
  assert.equal(r.json.outcome, 'succeeded');
  assert.equal(r.json.completeness, 'complete');
  const rep = (await call(e, 'GET', '/v1/reports', { key: VIEW })).json.reports[0];
  assert.equal(rep.source, 'shopify');
  assert.equal(rep.period_start, '2026-09-01'); assert.equal(rep.period_end, '2026-09-30');
  assert.equal(rep.timezone, 'America/Los_Angeles'); assert.equal(rep.currency, 'USD');
  assert.equal(rep.collected_at, '2026-10-02T09:00:00.000Z');
  assert.ok(rep.activated_at, 'successful import timestamp');
  assert.notEqual(rep.collected_at, rep.period_end);
  assert.equal(rep.revision, 1); assert.equal(rep.completeness, 'complete'); assert.equal(rep.status, 'active');
  assert.equal(rep.includedTotals.net, 36); assert.equal(rep.excludedTotals.net, 3);
  assert.deepEqual(rep.exclusionLabels, ['Shipping protection']);
});

test('a split that does not add up to the totals is refused', async () => {
  const e = env();
  const r = await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-09-01', '2026-09-30', {
    includedTotals: { units: 5, gross: 43, disc: -4, ret: 0, net: 39, tax: 2, total: 41 },
    excludedTotals: { units: 1, gross: 3, disc: 0, ret: 0, net: 3, tax: 0, total: 3 } }) });
  assert.equal(r.status, 422);
  assert.ok(r.json.errors.some(x => x.code === 'split_mismatch'));
});

test('refreshing a period adds a revision and keeps the history; identical retries do not', async () => {
  const e = env();
  const post = (b) => call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: b });
  assert.equal((await post(payload('2026-09-01', '2026-09-30'))).json.revision, 1);
  const again = await post(payload('2026-09-01', '2026-09-30', { collectedAt: new Date().toISOString() }));
  assert.equal(again.json.outcome, 'unchanged', 'a later identical collection is not a new revision');
  const r2 = await post(payload('2026-09-01', '2026-09-30', { rows: rows(2) }));
  assert.equal(r2.json.revision, 2);
  assert.equal((await post(payload('2026-09-01', '2026-09-30', { rows: rows(2) }))).json.outcome, 'unchanged');
  const active = (await call(e, 'GET', '/v1/reports', { key: VIEW })).json.reports;
  assert.equal(active.length, 1, 'the latest successful revision is the default');
  assert.equal(active[0].revision, 2);
  const hist = (await call(e, 'GET', '/v1/reports?history=1', { key: VIEW })).json.reports;
  assert.deepEqual(hist.map(h => [h.revision, h.status]), [[2, 'active'], [1, 'superseded']]);
  // The earlier revision's rows can still be read (and so downloaded).
  const old = await call(e, 'GET', '/v1/reports/' + encodeURIComponent(hist[1].id) + '/rows', { key: VIEW });
  assert.equal(old.json.status, 'superseded');
  assert.equal(old.json.rows[0].cur.net, 36);
});

test('previous months and years stay available after later refreshes', async () => {
  const e = env();
  for (const [s, en] of [['2025-01-01', '2025-01-31'], ['2025-12-01', '2025-12-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-15']]) {
    await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload(s, en) });
  }
  await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-10-01', '2026-10-16') });
  const reps = (await call(e, 'GET', '/v1/reports?source=shopify', { key: VIEW })).json.reports;
  assert.deepEqual(reps.map(r => r.period_start + '..' + r.period_end), [
    '2026-10-01..2026-10-16', '2026-10-01..2026-10-15', '2026-09-01..2026-09-30', '2025-12-01..2025-12-31', '2025-01-01..2025-01-31']);
});

test('a failed import keeps the last successful report', async () => {
  const e = env();
  await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-09-01', '2026-09-30') });
  e.DB._setFailOnBatch(2);
  const bad = await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-09-01', '2026-09-30', { rows: rows(3) }) });
  assert.equal(bad.json.outcome, 'failed');
  e.DB._setFailOnBatch(0);
  const hist = (await call(e, 'GET', '/v1/reports?history=1', { key: VIEW })).json.reports;
  assert.deepEqual(hist.map(h => [h.revision, h.status]), [[1, 'active']], 'the abandoned attempt is not history');
  await call(e, 'POST', '/v1/ingest/collection-failure', { key: INGEST, body: { source: 'shopify', errorCode: 'sign_in_needed', message: 'Sign in at https://x.example as a@b.example' } });
  const runs = (await call(e, 'GET', '/v1/imports', { key: VIEW })).json.imports;
  assert.equal(runs[0].outcome, 'failed');
  assert.equal(runs[0].error_code, 'sign_in_needed');
  assert.equal(runs[0].error_message, 'Sign in at <url> as <email>');
  assert.equal((await call(e, 'GET', '/v1/reports', { key: VIEW })).json.reports[0].revision, 1);
});

test('the same figures collected after the period ended mark it complete without a new revision', async () => {
  const e = env();
  const p1 = payload('2026-09-01', '2026-09-30', { collectedAt: '2026-09-30T18:00:00Z' });
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: p1 })).json.completeness, 'partial');
  const p2 = payload('2026-09-01', '2026-09-30', { collectedAt: '2026-10-02T18:00:00Z' });
  const r = await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: p2 });
  assert.equal(r.json.outcome, 'unchanged'); assert.equal(r.json.markedComplete, true);
  const rep = (await call(e, 'GET', '/v1/reports', { key: VIEW })).json.reports[0];
  assert.equal(rep.completeness, 'complete'); assert.equal(rep.revision, 1); assert.ok(rep.confirmed_at);
});

test('keys: viewer reads only; collector adds, reports failures and reads coverage only', async () => {
  const e = env();
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', { key: VIEW, body: payload('2026-09-01', '2026-09-30') })).status, 403);
  assert.equal((await call(e, 'PUT', '/v1/settings/classification_overrides', { key: VIEW, body: { value: {} } })).status, 403);
  assert.equal((await call(e, 'POST', '/v1/ingest/collection-failure', { key: VIEW, body: {} })).status, 403);
  assert.equal((await call(e, 'POST', '/v1/ingest/collection-failure', { key: DASH, body: {} })).status, 403);
  await call(e, 'POST', '/v1/ingest/product-report', { key: INGEST, body: payload('2026-09-01', '2026-09-30') });
  const cov = await call(e, 'GET', '/v1/ingest/coverage?source=shopify', { key: INGEST });
  assert.equal(cov.status, 200);
  assert.deepEqual(Object.keys(cov.json.coverage[0]).sort(), ['collected_at', 'completeness', 'period_end', 'period_start', 'revision']);
  assert.equal((await call(e, 'GET', '/v1/ingest/coverage', { key: VIEW })).status, 403);
  assert.equal((await call(e, 'GET', '/v1/reports', { key: INGEST })).status, 403);
  assert.equal((await call(e, 'GET', '/v1/reports', { key: VIEW })).status, 200);
});

test('a manual browser upload carries the included / excluded split too', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const SS = require(path.join(ROOT, 'shared-sync.js'));
  const PG = require(path.join(ROOT, 'product-grouping.js'));
  const prod = (title, vendor, net) => ({ title, vendor, ptype: 'X', group: 'G', priorKnown: false,
    cur: { units: 1, gross: net, disc: 0, ret: 0, net, tax: 0, total: net } });
  const snap = { source: 'shopify', startDate: '2026-09-01', endDate: '2026-09-30', meta: { timezone: 'America/Los_Angeles', currency: 'USD' },
                 products: [prod('Plant', 'V1', 40), prod('Route protection', 'Route', 2.5)] };
  const conv = SS.sharedPayloadFromSnapshot(snap, { grouping: PG });
  assert.equal(conv.payload.includedTotals.net, 40);
  assert.equal(conv.payload.excludedTotals.net, 2.5);
  assert.deepEqual(conv.payload.exclusionLabels, ['Route (shipping protection)']);
  const e = env();
  const r = await call(e, 'POST', '/v1/ingest/product-report', { key: DASH, body: conv.payload });
  assert.equal(r.json.outcome, 'succeeded', JSON.stringify(r.json));
});
