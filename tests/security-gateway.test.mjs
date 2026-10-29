// The same-origin gateway: allowlisted routes/methods/params only, fixed
// destination, server-held keys chosen per route, no caller headers forwarded,
// no redirects followed, no caching, viewers cannot write.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../server/session.mjs';
import { apiHandler, trackerHandler, matchRoute, _resetTrackerToken } from '../server/handlers.mjs';

const ORIGIN = 'https://dash.example';
const FAST = { N: 16384, r: 8, p: 1 };
const BASE_ENV = {
  SESSION_SECRET: 'x'.repeat(40),
  DASHBOARD_VIEWER_PASSWORD_HASH: S.hashPassword('viewer-password-123', FAST),
  DASHBOARD_EDITOR_PASSWORD_HASH: S.hashPassword('editor-password-456', FAST),
  WORKER_URL: 'https://worker.example', WORKER_VIEWER_SECRET: 'V'.repeat(40), WORKER_UPLOAD_SECRET: 'U'.repeat(40), WORKER_SETTINGS_SECRET: 'T'.repeat(40),
  STOCK_TRACKER_URL: 'https://tracker.example', STOCK_TRACKER_PASSWORD: 'tracker-pass-xyz'
};
const cfg = S.loadAuthConfig(BASE_ENV);
function session(role) { const s = S.signSession(cfg, { role }); return { cookie: S.COOKIE + '=' + s.token, csrf: S.csrfToken(cfg, s.payload.sid) }; }
function mockFetch(respond) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return respond ? respond(url, init) : new Response(JSON.stringify({ ok: true, echo: url }), { status: 200 }); };
  f.calls = calls; return f;
}
function req(method, path, { s, csrf = true, origin = ORIGIN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (s) { h.cookie = s.cookie; if (csrf) h['x-sb-csrf'] = s.csrf; }
  if (origin) h.origin = origin;
  if (body !== undefined) h['content-type'] = 'application/json';
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}
const run = (r, { env = BASE_ENV, fetchImpl = mockFetch(), store = S.memoryStore() } = {}) => apiHandler(r, { env, store, fetchImpl });

test('anonymous and invalid sessions get 401 before any route detail; nothing is fetched', async () => {
  const f = mockFetch();
  for (const p of ['/api/v1/reports', '/api/v1/nope', '/api/v1/settings/secret_thing']) {
    const r = await run(req('GET', p), { fetchImpl: f });
    assert.equal(r.status, 401);
  }
  assert.equal((await run(req('GET', '/api/v1/reports', { s: { cookie: S.COOKIE + '=forged.token' } }), { fetchImpl: f })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('missing server configuration fails closed (503)', async () => {
  const s = session('viewer');
  assert.equal((await run(req('GET', '/api/v1/reports', { s }), { env: { ...BASE_ENV, SESSION_SECRET: '' } })).status, 503);
  assert.equal((await run(req('GET', '/api/v1/reports', { s }), { env: { ...BASE_ENV, WORKER_VIEWER_SECRET: 'short' } })).status, 503);
  for (const u of ['http://worker.example', 'https://worker.example/path', 'https://u:p@worker.example', 'https://worker.example?x=1', 'not a url', 'http://127.0.0.1:8787'])
    assert.equal((await run(req('GET', '/api/v1/reports', { s }), { env: { ...BASE_ENV, WORKER_URL: u } })).status, 503, u);
  assert.equal((await run(req('GET', '/api/v1/reports', { s }), { env: { ...BASE_ENV, WORKER_URL: 'http://127.0.0.1:8787', ALLOW_LOCAL_WORKER: '1' } })).status, 200);
});

test('only allowlisted routes, methods and parameters exist', () => {
  const P = (s) => new URLSearchParams(s);
  assert.equal(matchRoute('GET', '/v1/reports', P('')).upstreamPath, '/v1/reports');
  assert.equal(matchRoute('GET', '/v1/reports', P('source=amazon&history=1')).upstreamPath, '/v1/reports?source=amazon&history=1');
  for (const [m, p, q] of [['GET', '/v1/reports', 'source=evil'], ['GET', '/v1/reports', 'url=https://x'], ['GET', '/v1/reports', 'history=2'],
    ['GET', '/v1/reports/../health/rows', ''], ['GET', '/v1/reports/shopify:x:2026-01-01:2026-01-31:r1/rows', 'offset=0&limit=99999'],
    ['GET', '/v1/reports/javascript:alert(1)/rows', 'offset=0&limit=10'], ['GET', '/v1/imports', 'limit=1000'],
    ['GET', '/v1/settings/anything', ''], ['PUT', '/v1/settings/restricted_items', ''], ['PUT', '/v1/settings/vendor_map', ''],
    ['DELETE', '/v1/reports', ''], ['POST', '/v1/ingest/collection-failure', ''], ['GET', '/v1/ingest/coverage', ''],
    ['GET', '/v1/health', ''], ['GET', '//evil.example/v1/reports', ''], ['GET', '/v1/reports/', '']])
    assert.ok(matchRoute(m, p, P(q)).error, `${m} ${p}?${q} is refused`);
  const rows = matchRoute('GET', '/v1/reports/' + encodeURIComponent('shopify:Sales by product:2026-09-01:2026-09-30:r2') + '/rows', P('offset=0&limit=5000'));
  assert.ok(!rows.error); assert.equal(rows.keyVar, 'WORKER_VIEWER_SECRET');
  assert.equal(matchRoute('PUT', '/v1/settings/classification_overrides', P('')).keyVar, 'WORKER_SETTINGS_SECRET');
  assert.equal(matchRoute('POST', '/v1/ingest/product-report', P('')).keyVar, 'WORKER_UPLOAD_SECRET');
  assert.equal(matchRoute('GET', '/v1/settings/market_config', P('')).keyVar, 'WORKER_VIEWER_SECRET');
});

test('the destination is fixed, the key is chosen per route, caller headers are never forwarded', async () => {
  const f = mockFetch();
  const s = session('editor');
  await run(req('GET', '/api/v1/reports?source=shopify', { s, headers: { authorization: 'Bearer attacker', 'x-forwarded-host': 'evil.example', host: 'evil.example' } }), { fetchImpl: f });
  await run(req('PUT', '/api/v1/settings/catalog_mappings', { s, body: { value: {}, baseVersion: 0 } }), { fetchImpl: f });
  await run(req('POST', '/api/v1/ingest/product-report', { s, body: { a: 1 } }), { fetchImpl: f });
  assert.deepEqual(f.calls.map(c => c.url), ['https://worker.example/v1/reports?source=shopify', 'https://worker.example/v1/settings/catalog_mappings', 'https://worker.example/v1/ingest/product-report']);
  assert.deepEqual(f.calls.map(c => c.init.headers.authorization), ['Bearer ' + 'V'.repeat(40), 'Bearer ' + 'T'.repeat(40), 'Bearer ' + 'U'.repeat(40)]);
  for (const c of f.calls) {
    assert.equal(c.init.redirect, 'manual');
    assert.deepEqual(Object.keys(c.init.headers).sort().filter(k => !['authorization', 'accept', 'content-type'].includes(k)), [], 'only our own headers');
    assert.ok(!JSON.stringify(c.init.headers).includes('attacker') && !JSON.stringify(c.init.headers).includes(S.COOKIE));
  }
});

test('viewers cannot write; writes need CSRF and same origin', async () => {
  const f = mockFetch();
  const v = session('viewer'), e = session('editor');
  assert.equal((await run(req('PUT', '/api/v1/settings/catalog_mappings', { s: v, body: { value: {} } }), { fetchImpl: f })).status, 403);
  assert.equal((await run(req('POST', '/api/v1/ingest/product-report', { s: v, body: {} }), { fetchImpl: f })).status, 403);
  assert.equal((await run(req('PUT', '/api/v1/settings/catalog_mappings', { s: e, csrf: false, body: { value: {} } }), { fetchImpl: f })).status, 403);
  assert.equal((await run(req('PUT', '/api/v1/settings/catalog_mappings', { s: e, origin: 'https://evil.example', body: { value: {} } }), { fetchImpl: f })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('bodies: JSON only, size-capped, parsed before forwarding', async () => {
  const f = mockFetch(); const e = session('editor');
  assert.equal((await run(req('PUT', '/api/v1/settings/catalog_mappings', { s: e, body: '{bad' }), { fetchImpl: f })).status, 400);
  const r = req('PUT', '/api/v1/settings/catalog_mappings', { s: e, body: '"' + 'a'.repeat(2 * 1024 * 1024 + 10) + '"' });
  assert.equal((await run(r, { fetchImpl: f })).status, 413);
  const t = new Request(ORIGIN + '/api/v1/settings/catalog_mappings', { method: 'PUT', headers: { cookie: e.cookie, 'x-sb-csrf': e.csrf, origin: ORIGIN, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal((await run(t, { fetchImpl: f })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('upstream redirects, bad bodies, failures and key errors are contained; replies are never cached', async () => {
  const s = session('viewer');
  const red = await run(req('GET', '/api/v1/reports', { s }), { fetchImpl: mockFetch(() => new Response('', { status: 302, headers: { location: 'https://evil.example' } })) });
  assert.equal(red.status, 502);
  assert.equal((await run(req('GET', '/api/v1/reports', { s }), { fetchImpl: mockFetch(() => new Response('<html>', { status: 200 })) })).status, 502);
  assert.equal((await run(req('GET', '/api/v1/reports', { s }), { fetchImpl: async () => { throw new Error('down ' + 'V'.repeat(40)); } })).status, 502);
  const k = await run(req('GET', '/api/v1/reports', { s }), { fetchImpl: mockFetch(() => new Response('{"ok":false,"error":"unauthorized"}', { status: 401 })) });
  assert.equal(k.status, 502); assert.equal((await k.json()).error, 'upstream_auth_failed');
  const ok = await run(req('GET', '/api/v1/reports', { s }));
  assert.match(ok.headers.get('cache-control'), /no-store/); assert.match(ok.headers.get('cache-control'), /private/);
  assert.match(ok.headers.get('vary') || '', /Cookie/i);
  assert.ok(!(await ok.text()).includes('V'.repeat(40)), 'the key never comes back');
});

test('stock tracker proxy: session required, fixed paths, password stays on the server', async () => {
  _resetTrackerToken();
  const f = mockFetch((url) => url.endsWith('/auth') ? new Response('{"token":"t1"}') : new Response('{"items":[]}'));
  assert.equal((await trackerHandler(req('GET', '/api/stock-tracker'), { env: BASE_ENV, store: S.memoryStore(), fetchImpl: f })).status, 401);
  const s = session('viewer');
  assert.equal((await trackerHandler(req('GET', '/api/stock-tracker?path=/x', { s }), { env: BASE_ENV, store: S.memoryStore(), fetchImpl: f })).status, 400);
  assert.equal((await trackerHandler(req('POST', '/api/stock-tracker', { s, body: {} }), { env: BASE_ENV, store: S.memoryStore(), fetchImpl: f })).status, 405);
  const r = await trackerHandler(req('GET', '/api/stock-tracker?refresh=1', { s }), { env: BASE_ENV, store: S.memoryStore(), fetchImpl: f });
  assert.equal(r.status, 200);
  assert.deepEqual(f.calls.map(c => c.url), ['https://tracker.example/.netlify/functions/auth', 'https://tracker.example/.netlify/functions/scrape?refresh=true']);
  assert.ok(!(await r.text()).includes('tracker-pass-xyz'));
  assert.equal((await trackerHandler(req('GET', '/api/stock-tracker', { s }), { env: { ...BASE_ENV, STOCK_TRACKER_PASSWORD: '' }, store: S.memoryStore(), fetchImpl: f })).status, 503);
  assert.equal((await trackerHandler(req('GET', '/api/stock-tracker', { s }), { env: { ...BASE_ENV, STOCK_TRACKER_URL: 'http://tracker.example' }, store: S.memoryStore(), fetchImpl: f })).status, 503);
  _resetTrackerToken();
});
