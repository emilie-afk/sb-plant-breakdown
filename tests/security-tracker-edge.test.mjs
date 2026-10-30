// /api/stock-tracker runs as a Netlify Edge Function in production (the
// tracker's scrape takes ~30 s; the previous Function gateway allowed 9 s).
// These tests cover the shared core with the Edge Function's authorizer (it
// asks this site's /api/session with the caller's cookie), the single
// whole-request deadline, and the deployment shape (no Node-only code in the
// edge path, no duplicate route).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../server/session.mjs';
import { sessionHandler } from '../server/handlers.mjs';
import { trackerCore, sessionProbe, _resetTrackerToken, _peekTrackerToken, TRACKER_BUDGET_MS } from '../server/tracker-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://dash.example';
const ENV = {
  SESSION_SECRET: 'x'.repeat(40),
  GOOGLE_CLIENT_ID: '1234-test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-client-secret-123',
  GOOGLE_ALLOWED_EMAILS: 'viewer@example.com', GOOGLE_EDITOR_EMAILS: 'editor@example.com', GOOGLE_REDIRECT_ORIGINS: ORIGIN,
  STOCK_TRACKER_URL: 'https://tracker.example', STOCK_TRACKER_PASSWORD: 'tracker-pass-xyz'
};
const cfg = S.loadAuthConfig(ENV);
const cookieFor = (email, role) => S.COOKIE + '=' + S.signSession(cfg, { role, email }).token;
const get = (p, cookie) => new Request(ORIGIN + p, { headers: cookie ? { cookie } : {} });

// A fetch that serves this site's real /api/session (with a shared store) and
// a fake tracker app. Records every call.
function site({ store = S.memoryStore(), tracker } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    if (u.origin === ORIGIN && u.pathname === '/api/session') return sessionHandler(new Request(u, { method: init.method || 'GET', headers: init.headers }), { env: ENV, store });
    if (u.origin === 'https://tracker.example') return tracker(u, init);
    throw new Error('unexpected fetch ' + url);
  };
  f.calls = calls; f.store = store; return f;
}
const okTracker = (u) => u.pathname.endsWith('/auth') ? new Response('{"token":"t1"}') : new Response('{"sbOos":[{"sku":"A"}],"mcgOnly":[{"sku":"B"}]}');
const edge = (r, f, opts = {}) => trackerCore(r, { env: ENV, authorize: sessionProbe(f), fetchImpl: f, ...opts });

test('edge path: signed-in viewer and editor get data; the supplier list is renamed; password never returned', async () => {
  for (const [email, role] of [['viewer@example.com', 'viewer'], ['editor@example.com', 'editor']]) {
    _resetTrackerToken();
    const f = site({ tracker: okTracker });
    const r = await edge(get('/api/stock-tracker', cookieFor(email, role)), f);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { sbOos: [{ sku: 'A' }], supplierOnly: [{ sku: 'B' }] });
    assert.ok(!text.includes('tracker-pass-xyz') && !text.includes('t1'));
    assert.match(r.headers.get('cache-control'), /no-store/);
    // the session probe forwarded only the cookie, to this origin, and followed no redirect
    const probe = f.calls[0];
    assert.equal(probe.url, ORIGIN + '/api/session');
    assert.equal(probe.init.redirect, 'manual');
    assert.deepEqual(Object.keys(probe.init.headers).sort(), ['accept', 'cookie']);
  }
});

test('edge path: no cookie, forged, revoked, or no-longer-listed sessions get 401 and the tracker is never called', async () => {
  _resetTrackerToken();
  const store = S.memoryStore();
  const f = site({ store, tracker: okTracker });
  assert.equal((await edge(get('/api/stock-tracker'), f)).status, 401);
  assert.equal((await edge(get('/api/stock-tracker', S.COOKIE + '=forged.token'), f)).status, 401);
  // revoked (signed out elsewhere)
  const s = S.signSession(cfg, { role: 'viewer', email: 'viewer@example.com' });
  await store.set('revoked/' + s.payload.sid, { exp: s.payload.exp });
  assert.equal((await edge(get('/api/stock-tracker', S.COOKIE + '=' + s.token), f)).status, 401);
  // email removed from the allow-list after sign-in
  const gone = S.signSession(cfg, { role: 'viewer', email: 'former@example.com' });
  assert.equal((await edge(get('/api/stock-tracker', S.COOKIE + '=' + gone.token), f)).status, 401);
  assert.equal(f.calls.filter(c => c.url.startsWith('https://tracker.example')).length, 0);
});

test('edge path: session endpoint down or misconfigured -> no data, tracker untouched', async () => {
  _resetTrackerToken();
  const calls = [];
  const mk = (resp) => async (url) => { calls.push(String(url)); if (String(url).startsWith('https://tracker.example')) return okTracker(new URL(url)); return resp(); };
  const c = cookieFor('viewer@example.com', 'viewer');
  assert.equal((await trackerCore(get('/api/stock-tracker', c), { env: ENV, authorize: sessionProbe(mk(() => new Response('', { status: 302, headers: { location: 'https://evil.example' } }))), fetchImpl: mk(() => null) })).status, 502);
  assert.equal((await trackerCore(get('/api/stock-tracker', c), { env: ENV, authorize: sessionProbe(mk(() => new Response('{"ok":false}', { status: 503 }))), fetchImpl: mk(() => null) })).status, 503);
  assert.equal((await trackerCore(get('/api/stock-tracker', c), { env: ENV, authorize: sessionProbe(async () => { throw new Error('down'); }), fetchImpl: mk(() => null) })).status, 502);
  assert.equal((await trackerCore(get('/api/stock-tracker', c), { env: ENV, authorize: sessionProbe(mk(() => new Response('{"authenticated":true,"role":"admin"}'))), fetchImpl: mk(() => null) })).status, 401);
  assert.equal(calls.filter(u => u.startsWith('https://tracker.example')).length, 0);
});

test('edge path: method and parameters are fixed; refresh maps to the tracker refresh only', async () => {
  _resetTrackerToken();
  const f = site({ tracker: okTracker });
  const c = cookieFor('viewer@example.com', 'viewer');
  assert.equal((await edge(new Request(ORIGIN + '/api/stock-tracker', { method: 'POST', headers: { cookie: c } }), f)).status, 405);
  assert.equal((await edge(get('/api/stock-tracker?url=https://evil.example', c), f)).status, 400);
  assert.equal(f.calls.length, 0, 'refused before the session probe');
  assert.equal((await edge(get('/api/stock-tracker?refresh=1', c), f)).status, 200);
  assert.deepEqual(f.calls.map(x => x.url).filter(u => u.startsWith('https://tracker.example')),
    ['https://tracker.example/.netlify/functions/auth', 'https://tracker.example/.netlify/functions/scrape?refresh=true']);
});

// ---- the single deadline ------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A body that arrives `ms` after the headers (null = never) and IGNORES aborts,
// like an upstream that stalls mid-response.
function lateBody(text, ms) {
  return new ReadableStream({ start(c) { if (ms !== null) setTimeout(() => { try { c.enqueue(new TextEncoder().encode(text)); c.close(); } catch {} }, ms); } });
}
const BUDGET = 200, SLACK = 150;
async function timed(p) { const t0 = Date.now(); const r = await p; return { r, ms: Date.now() - t0 }; }

test('budget sits between the tracker (~30 s) and the Edge Function limit (40 s)', () => {
  assert.ok(TRACKER_BUDGET_MS >= 30000 && TRACKER_BUDGET_MS < 40000);
});

test('a slow but in-time scrape succeeds; the same deadline covers every step', async () => {
  _resetTrackerToken();
  const c = cookieFor('viewer@example.com', 'viewer');
  const tracker = (u) => u.pathname.endsWith('/auth') ? new Response(lateBody('{"token":"t1"}', 40))
                                                      : new Response(lateBody('{"sbOos":[]}', 60));
  const { r, ms } = await timed(edge(get('/api/stock-tracker', c), site({ tracker }), { budgetMs: BUDGET }));
  assert.equal(r.status, 200);
  assert.ok(ms < BUDGET);
  assert.equal(_peekTrackerToken(), 't1');
});

test('stalled session check (never answers, ignores abort) -> 504 within the deadline, tracker untouched', async () => {
  _resetTrackerToken();
  const calls = [];
  const f = async (url, init) => { calls.push(String(url)); return new Promise(() => {}); };   // hangs forever
  const { r, ms } = await timed(trackerCore(get('/api/stock-tracker', cookieFor('viewer@example.com', 'viewer')),
    { env: ENV, authorize: sessionProbe(f), fetchImpl: f, budgetMs: BUDGET }));
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error, 'tracker_timeout');
  assert.ok(ms < BUDGET + SLACK, 'answered in ' + ms + ' ms');
  assert.deepEqual(calls, [ORIGIN + '/api/session']);
});

test('session check whose BODY stalls -> 504 within the deadline', async () => {
  _resetTrackerToken();
  let seenSignal = null;
  const f = async (url, init) => { seenSignal = init.signal; return new Response(lateBody('{"authenticated":true,"role":"viewer"}', null)); };
  const { r, ms } = await timed(trackerCore(get('/api/stock-tracker', cookieFor('viewer@example.com', 'viewer')),
    { env: ENV, authorize: sessionProbe(f), fetchImpl: f, budgetMs: BUDGET }));
  assert.equal(r.status, 504);
  assert.ok(ms < BUDGET + SLACK);
  assert.ok(seenSignal && seenSignal.aborted, 'the shared signal was passed to the probe and aborted at the deadline');
});

test('slow tracker sign-in body -> 504 within the deadline; the late token never enters the cache', async () => {
  _resetTrackerToken();
  const signals = [];
  const tracker = (u, init) => { signals.push(init.signal);
    return u.pathname.endsWith('/auth') ? new Response(lateBody('{"token":"late-token"}', BUDGET + 100)) : new Response('{"sbOos":[]}'); };
  const f = site({ tracker });
  const { r, ms } = await timed(edge(get('/api/stock-tracker', cookieFor('viewer@example.com', 'viewer')), f, { budgetMs: BUDGET }));
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error, 'tracker_timeout');
  assert.ok(ms < BUDGET + SLACK, 'answered in ' + ms + ' ms');
  assert.ok(signals.every(s => s.aborted), 'tracker calls shared the aborted signal');
  await sleep(BUDGET + 250);                       // let the late body arrive
  assert.equal(_peekTrackerToken(), null, 'late sign-in did not populate the token cache');
  assert.ok(!f.calls.some(x => x.url.includes('/scrape')), 'no scrape after the deadline');
});

test('a late sign-in from a timed-out request cannot overwrite a newer request\'s token', async () => {
  _resetTrackerToken();
  const c = cookieFor('viewer@example.com', 'viewer');
  const slow = site({ tracker: (u) => u.pathname.endsWith('/auth') ? new Response(lateBody('{"token":"stale"}', BUDGET + 80)) : new Response('{}') });
  assert.equal((await edge(get('/api/stock-tracker', c), slow, { budgetMs: BUDGET })).status, 504);
  const fresh = site({ tracker: (u) => u.pathname.endsWith('/auth') ? new Response('{"token":"fresh"}') : new Response('{"sbOos":[]}') });
  assert.equal((await edge(get('/api/stock-tracker', c), fresh, { budgetMs: BUDGET })).status, 200);
  await sleep(BUDGET + 200);
  assert.equal(_peekTrackerToken(), 'fresh');
});

test('slow scrape body (headers in time, body late or never) -> 504 within the deadline', async () => {
  for (const ms0 of [BUDGET + 100, null]) {
    _resetTrackerToken();
    const tracker = (u) => u.pathname.endsWith('/auth') ? new Response('{"token":"t1"}') : new Response(lateBody('{"sbOos":[]}', ms0));
    const { r, ms } = await timed(edge(get('/api/stock-tracker', cookieFor('viewer@example.com', 'viewer')), site({ tracker }), { budgetMs: BUDGET }));
    assert.equal(r.status, 504);
    assert.equal((await r.json()).error, 'tracker_timeout');
    assert.ok(ms < BUDGET + SLACK, 'answered in ' + ms + ' ms');
  }
  await sleep(150);
});

test('a slow scrape REQUEST (no headers yet) -> 504; it was aborted through the shared signal', async () => {
  _resetTrackerToken();
  let aborted = false;
  const tracker = (u, init) => u.pathname.endsWith('/auth') ? new Response('{"token":"t1"}')
    : new Promise((res, rej) => init.signal.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); }));
  const { r, ms } = await timed(edge(get('/api/stock-tracker', cookieFor('viewer@example.com', 'viewer')), site({ tracker }), { budgetMs: BUDGET }));
  assert.equal(r.status, 504);
  assert.ok(ms < BUDGET + SLACK);
  assert.ok(aborted);
});

test('deployment shape: one /api/stock-tracker route, served by the Edge Function; edge code is Web-API only', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'netlify/functions/stock-tracker.mjs')), 'no Netlify Function competes for the route');
  const edgeSrc = fs.readFileSync(path.join(ROOT, 'netlify/edge-functions/stock-tracker.js'), 'utf8');
  assert.match(edgeSrc, /path:\s*'\/api\/stock-tracker'/);
  assert.match(edgeSrc, /from '\.\.\/\.\.\/server\/tracker-core\.mjs'/);
  assert.match(edgeSrc, /sessionProbe\(/);
  const core = fs.readFileSync(path.join(ROOT, 'server/tracker-core.mjs'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(core), 'tracker-core imports nothing (runs in Deno and Node)');
  assert.ok(!/process\.env|Buffer|require\(/.test(core));
  for (const f of fs.readdirSync(path.join(ROOT, 'netlify/functions'))) {
    assert.ok(!/stock-tracker/.test(fs.readFileSync(path.join(ROOT, 'netlify/functions', f), 'utf8')), f + ' must not route /api/stock-tracker');
  }
});
