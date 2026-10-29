// Server-verified sessions: sign-in, cookie, expiry, forgery, revocation,
// generations, CSRF, origin, durable sign-in limits, fail-closed config.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as S from '../server/session.mjs';
import { sessionHandler } from '../server/handlers.mjs';
import worker from '../worker/src/index.js';
import { makeD1 } from './d1shim.mjs';
import { ROOT } from './load.mjs';

// The real Worker (real migrations, Node SQLite) answers the gateway's
// attempt-counter calls, each after a random delay so concurrent requests
// genuinely interleave.
const AUTH_KEY = 'a'.repeat(40);
function workerFetch({ delay = 5, wenv } = {}) {
  const e = wenv || { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), AUTH_SECRET: AUTH_KEY };
  const f = async (u, init) => { await new Promise(r => setTimeout(r, Math.random() * delay)); return worker.fetch(new Request(u, init), e); };
  f.env = e; return f;
}

const ORIGIN = 'https://dash.example';
const VIEW_PW = 'viewer-password-123', EDIT_PW = 'editor-password-456';
const FAST = { N: 16384, r: 8, p: 1 };
const VIEW_HASH = S.hashPassword(VIEW_PW, FAST), EDIT_HASH = S.hashPassword(EDIT_PW, FAST);
export const ENV = { SESSION_SECRET: 'x'.repeat(40), DASHBOARD_VIEWER_PASSWORD_HASH: VIEW_HASH, DASHBOARD_EDITOR_PASSWORD_HASH: EDIT_HASH,
  WORKER_URL: 'https://worker.example', WORKER_AUTH_SECRET: AUTH_KEY };

function req(method, { cookie, csrf, origin = ORIGIN, body, ctype = 'application/json', ip } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie; if (csrf) h['x-sb-csrf'] = csrf; if (origin) h.origin = origin; if (ctype) h['content-type'] = ctype;
  if (ip) h['x-nf-client-connection-ip'] = ip;
  return new Request(ORIGIN + '/api/session', { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
}
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const sharedFetch = workerFetch();
async function login(env, store, pw, opts = {}) {
  const res = await sessionHandler(req('POST', { body: { password: pw }, ...opts }), { env, store, now: opts.now, fetchImpl: opts.fetchImpl || sharedFetch });
  return { res, body: await res.json(), cookie: cookieOf(res) };
}

test('missing or weak configuration denies everything (503)', async () => {
  for (const env of [{}, { ...ENV, SESSION_SECRET: 'short' }, { SESSION_SECRET: 'x'.repeat(40) },
    { SESSION_SECRET: 'x'.repeat(40), DASHBOARD_VIEWER_PASSWORD_HASH: 'plaintext-password' },
    { SESSION_SECRET: 'x'.repeat(40), DASHBOARD_VIEWER_PASSWORD_HASH: S.hashPassword(VIEW_PW, FAST).replace('$16384$', '$1024$') }]) {
    const r = await sessionHandler(req('POST', { body: { password: VIEW_PW } }), { env, store: S.memoryStore() });
    assert.equal(r.status, 503);
  }
});

test('password hashes: scrypt, salted, constant-shape, min length', async () => {
  assert.ok(await S.verifyPassword(VIEW_PW, VIEW_HASH));
  assert.ok(!(await S.verifyPassword(VIEW_PW + 'x', VIEW_HASH)));
  assert.notEqual(S.hashPassword(VIEW_PW, FAST), S.hashPassword(VIEW_PW, FAST));
  assert.throws(() => S.hashPassword('short'));
  assert.ok(!(await S.verifyPassword('x'.repeat(600), VIEW_HASH)));
});

test('sign-in sets a Secure, HttpOnly, SameSite=Strict __Host- cookie; no password or key in the reply', async () => {
  const store = S.memoryStore();
  const { res, body } = await login(ENV, store, EDIT_PW);
  assert.equal(res.status, 200);
  assert.equal(body.role, 'editor');
  const sc = res.headers.get('set-cookie');
  assert.match(sc, /^__Host-sbpb_session=/); for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(a), a);
  assert.doesNotMatch(sc, /Domain=/i);
  assert.match(res.headers.get('cache-control'), /no-store/);
  const text = JSON.stringify(body);
  assert.ok(!text.includes(EDIT_PW) && !text.includes(ENV.SESSION_SECRET) && !text.includes(EDIT_HASH));
  const v = await login(ENV, store, VIEW_PW); assert.equal(v.body.role, 'viewer');
});

test('session restore: GET returns the role and CSRF token; anonymous GET says signed out', async () => {
  const store = S.memoryStore();
  const { cookie, body } = await login(ENV, store, VIEW_PW);
  const r = await (await sessionHandler(req('GET', { cookie }), { env: ENV, store })).json();
  assert.deepEqual([r.authenticated, r.role, r.csrf], [true, 'viewer', body.csrf]);
  const anon = await (await sessionHandler(req('GET'), { env: ENV, store })).json();
  assert.equal(anon.authenticated, false);
});

test('wrong password, bad origin, non-JSON and malformed bodies are refused', async () => {
  const store = S.memoryStore();
  assert.equal((await login(ENV, store, 'nope-nope-nope')).res.status, 401);
  assert.equal((await sessionHandler(req('POST', { body: { password: VIEW_PW }, origin: 'https://evil.example' }), { env: ENV, store })).status, 403);
  assert.equal((await sessionHandler(req('POST', { body: { password: VIEW_PW }, origin: null }), { env: ENV, store })).status, 403);
  assert.equal((await sessionHandler(req('POST', { body: 'password=' + VIEW_PW, ctype: 'application/x-www-form-urlencoded' }), { env: ENV, store })).status, 415);
  assert.equal((await sessionHandler(req('POST', { body: '{bad' }), { env: ENV, store, fetchImpl: sharedFetch })).status, 401);
  assert.equal((await sessionHandler(req('PUT', { body: {} }), { env: ENV, store })).status, 405);
});

test('expired, forged, tampered and other-generation tokens are rejected', async () => {
  const cfg = S.loadAuthConfig(ENV);
  const now = Date.now();
  const { token } = S.signSession(cfg, { role: 'viewer', now });
  assert.ok(S.verifySessionToken(cfg, token, now));
  assert.equal(S.verifySessionToken(cfg, token, now + cfg.ttlSec * 1000 + 1000), null, 'expired');
  const [b, sig] = token.split('.');
  const p = JSON.parse(Buffer.from(b, 'base64url')); p.role = 'editor';
  assert.equal(S.verifySessionToken(cfg, Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig, now), null, 'tampered');
  const other = S.loadAuthConfig({ ...ENV, SESSION_SECRET: 'y'.repeat(40) });
  assert.equal(S.verifySessionToken(other, token, now), null, 'other secret');
  const gen2 = S.loadAuthConfig({ ...ENV, SESSION_GENERATION: '2' });
  assert.equal(S.verifySessionToken(gen2, token, now), null, 'generation bump ends every session');
  const long = S.signSession(S.loadAuthConfig({ ...ENV, SESSION_TTL_HOURS: '24' }), { role: 'viewer', now }).token;
  assert.equal(S.verifySessionToken(cfg, long, now), null, 'lifetime longer than configured');
  for (const t of ['', 'a', 'a.b.c', '.', 'x'.repeat(2000)]) assert.equal(S.verifySessionToken(cfg, t, now), null);
});

test('logout needs CSRF + origin, revokes the session server-side and clears the cookie', async () => {
  const store = S.memoryStore();
  const { cookie, body } = await login(ENV, store, EDIT_PW);
  assert.equal((await sessionHandler(req('DELETE', { cookie }), { env: ENV, store })).status, 403, 'no CSRF');
  assert.equal((await sessionHandler(req('DELETE', { cookie, csrf: body.csrf, origin: 'https://evil.example' }), { env: ENV, store })).status, 403);
  const out = await sessionHandler(req('DELETE', { cookie, csrf: body.csrf }), { env: ENV, store });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const after = await (await sessionHandler(req('GET', { cookie }), { env: ENV, store })).json();
  assert.equal(after.authenticated, false, 'a copied cookie stops working after logout');
});

test('logout whose revocation cannot be stored is NOT reported as success (the function answers 500)', async () => {
  const store = S.memoryStore();
  const { cookie, body } = await login(ENV, store, EDIT_PW);
  const broken = { ...store, async set() { throw new Error('blobs down'); } };
  await assert.rejects(() => sessionHandler(req('DELETE', { cookie, csrf: body.csrf }), { env: ENV, store: broken }));
  const still = await (await sessionHandler(req('GET', { cookie }), { env: ENV, store })).json();
  assert.equal(still.authenticated, true, 'the session is honestly still valid; the client must retry');
});

test('CSRF token is bound to the session; authorize enforces role, origin and token', async () => {
  const cfg = S.loadAuthConfig(ENV);
  const store = S.memoryStore();
  const a = S.signSession(cfg, { role: 'viewer' }), b = S.signSession(cfg, { role: 'editor' });
  const mk = (tok, extra = {}) => new Request(ORIGIN + '/api/v1/x', { method: 'PUT', headers: { cookie: S.COOKIE + '=' + tok, origin: ORIGIN, ...extra } });
  assert.equal((await S.authorize(mk(b.token, { 'x-sb-csrf': S.csrfToken(cfg, a.payload.sid) }), cfg, store, { write: true, role: 'editor' })).error, 'bad_csrf');
  assert.equal((await S.authorize(mk(a.token, { 'x-sb-csrf': S.csrfToken(cfg, a.payload.sid) }), cfg, store, { write: true, role: 'editor' })).status, 403, 'viewer cannot write');
  assert.ok((await S.authorize(mk(b.token, { 'x-sb-csrf': S.csrfToken(cfg, b.payload.sid) }), cfg, store, { write: true, role: 'editor' })).ok);
});

test('sign-in limits: per client, then globally; success clears the client count; no raw address stored', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '3', LOGIN_MAX_FAILURES_GLOBAL: '6', LOGIN_WINDOW_MINUTES: '15' };
  const fetchImpl = workerFetch(); const store = S.memoryStore(); const now = Date.now();
  const L = (pw, ip, t = now) => login(env, store, pw, { ip, now: t, fetchImpl });
  for (let i = 0; i < 3; i++) assert.equal((await L('wrong-wrong-wrong', '203.0.113.9')).res.status, 401);
  const blocked = await L(VIEW_PW, '203.0.113.9');
  assert.equal(blocked.res.status, 429, 'even the right password waits');
  assert.ok(Number(blocked.res.headers.get('retry-after')) > 0);
  const rows = fetchImpl.env.DB._raw.prepare('SELECT bucket FROM auth_attempts').all().map(r => r.bucket);
  assert.ok(rows.every(b => !b.includes('203.0.113.9')), 'buckets are HMACs');
  assert.equal((await L(VIEW_PW, '198.51.100.7')).res.status, 200, 'another client still signs in');
  const g = () => fetchImpl.env.DB._raw.prepare("SELECT n FROM auth_attempts WHERE bucket='global'").get().n;
  assert.equal(g(), 4, 'the successful sign-in gave its global slot back');
  const realNow = Date.now; Date.now = () => realNow() + 16 * 60000;   // the Worker keeps its own clock
  try { assert.equal((await L(VIEW_PW, '203.0.113.9', now + 16 * 60000)).res.status, 200, 'the window passes'); }
  finally { Date.now = realNow; }
});

test('CONCURRENT: 40 simultaneous wrong passwords from one client -> exactly the limit get a password check', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '5', LOGIN_MAX_FAILURES_GLOBAL: '1000' };
  const fetchImpl = workerFetch({ delay: 20 }); const store = S.memoryStore();
  const res = await Promise.all(Array.from({ length: 40 }, () => login(env, store, 'wrong-wrong-wrong', { ip: '203.0.113.50', fetchImpl })));
  const by = (s) => res.filter(r => r.res.status === s).length;
  assert.equal(by(401), 5); assert.equal(by(429), 35);
  const db = fetchImpl.env.DB._raw;
  assert.equal(db.prepare("SELECT n FROM auth_attempts WHERE bucket='global'").get().n, 40, 'every attempt counted');
  assert.equal(db.prepare("SELECT n FROM auth_attempts WHERE bucket LIKE 'client:%'").get().n, 40);
});

test('CONCURRENT: 40 simultaneous attempts from 40 clients -> the global limit holds', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '5', LOGIN_MAX_FAILURES_GLOBAL: '10' };
  const fetchImpl = workerFetch({ delay: 20 }); const store = S.memoryStore();
  const res = await Promise.all(Array.from({ length: 40 }, (_, i) => login(env, store, 'wrong-wrong-wrong', { ip: '192.0.2.' + i, fetchImpl })));
  assert.equal(res.filter(r => r.res.status === 401).length, 10);
  assert.equal(res.filter(r => r.res.status === 429).length, 30);
  // and a correct password is refused too while the global window is full
  assert.equal((await login(env, store, VIEW_PW, { ip: '192.0.2.250', fetchImpl })).res.status, 429);
});

test('CONCURRENT: a burst of correct sign-ins does not exhaust the global limit', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_GLOBAL: '10' };
  const fetchImpl = workerFetch({ delay: 20 }); const store = S.memoryStore();
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => login(env, store, VIEW_PW, { ip: '198.18.0.' + i, fetchImpl })));
  assert.ok(res.every(r => r.res.status === 200));
  assert.equal(fetchImpl.env.DB._raw.prepare("SELECT n FROM auth_attempts WHERE bucket='global'").get().n, 0);
});

test('sign-in fails closed when the attempt counter is missing or unreachable', async () => {
  const store = S.memoryStore();
  assert.equal((await login({ ...ENV, WORKER_AUTH_SECRET: '' }, store, VIEW_PW)).res.status, 503);
  assert.equal((await login(ENV, store, VIEW_PW, { fetchImpl: async () => { throw new Error('down'); } })).res.status, 503);
  assert.equal((await login(ENV, store, VIEW_PW, { fetchImpl: async () => new Response('{"ok":false}', { status: 403 }) })).res.status, 503);
  assert.equal((await login(ENV, store, VIEW_PW, { fetchImpl: async () => new Response('{"ok":true}', { status: 200 }) })).res.status, 503, 'malformed counter reply');
});

test('the attempt routes accept only the auth key and validated input', async () => {
  const e = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), AUTH_SECRET: AUTH_KEY, VIEWER_SECRET: 'v'.repeat(40), DASHBOARD_SECRET: 'd'.repeat(40) };
  const call = (key, body, p = '/v1/auth/attempt') => worker.fetch(new Request('https://w' + p, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
  const ok = { client: 'c'.repeat(32), windowSec: 900 };
  assert.equal((await call('v'.repeat(40), ok)).status, 403);
  assert.equal((await call('d'.repeat(40), ok)).status, 403, 'not even the admin key');
  assert.equal((await call(AUTH_KEY, { ...ok, client: '../x' })).status, 400);
  assert.equal((await call(AUTH_KEY, { ...ok, windowSec: 5 })).status, 400);
  assert.equal((await call(AUTH_KEY, ok)).status, 200);
  for (const p of ['/v1/reports', '/v1/settings/market_config', '/v1/imports'])
    assert.equal((await worker.fetch(new Request('https://w' + p, { headers: { authorization: 'Bearer ' + AUTH_KEY } }), e)).status, 403, 'auth key reads nothing: ' + p);
});
