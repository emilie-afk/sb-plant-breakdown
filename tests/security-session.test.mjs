// Sign in with Google (server-side OAuth code flow + PKCE), the allow-list,
// server-verified sessions, logout, CSRF and the durable, concurrency-safe
// sign-in limits. Google's network is replaced (tests/google-mock.mjs); the
// production configuration (real endpoint URLs and issuer) is what is tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as S from '../server/session.mjs';
import { sessionHandler } from '../server/handlers.mjs';
import { googleStart, googleCallback, verifyIdToken, _resetJwksCache } from '../server/google.mjs';
import worker from '../worker/src/index.js';
import { makeD1 } from './d1shim.mjs';
import { ROOT } from './load.mjs';
import { ENV, ORIGIN, CLIENT_ID, AUTH_KEY, makeGoogle, cookieValue } from './google-mock.mjs';

const get = (p, headers = {}) => new Request(ORIGIN + p, { headers });
const setCookies = (res) => res.headers.getSetCookie();

// The whole round trip: start -> (Google) -> callback. -> { res, sessionCookie, location }
async function signIn(G, email, { env = ENV, ip = '203.0.113.1', tamper } = {}) {
  const start = await googleStart(get('/api/auth/google/start'), { env });
  const oauth = cookieValue(setCookies(start), S.OAUTH_COOKIE);
  const { code, state } = G.approve(start.headers.get('location'), email);
  let q = `?code=${code}&state=${state}`;
  let cookie = oauth;
  if (tamper) ({ q, cookie } = tamper({ q, cookie, code, state }));
  const res = await googleCallback(get('/api/auth/google/callback' + q, cookie ? { cookie } : {}), { env, ip, fetchImpl: G.fetch });
  return { res, location: res.headers.get('location'), sessionCookie: cookieValue(setCookies(res), S.COOKIE) };
}
const status = async (cookie, env = ENV, store = S.memoryStore()) => (await sessionHandler(get('/api/session', cookie ? { cookie } : {}), { env, store })).json();

test('configuration fails closed (sign-in, session and API all refuse)', async () => {
  const bad = [{}, { ...ENV, SESSION_SECRET: 'short' }, { ...ENV, GOOGLE_CLIENT_ID: '' }, { ...ENV, GOOGLE_CLIENT_ID: 'not-a-google-client' },
    { ...ENV, GOOGLE_CLIENT_SECRET: '' }, { ...ENV, GOOGLE_ALLOWED_EMAILS: '', GOOGLE_EDITOR_EMAILS: '' }, { ...ENV, GOOGLE_ALLOWED_EMAILS: 'not an email' },
    { ...ENV, GOOGLE_REDIRECT_ORIGINS: '' }, { ...ENV, GOOGLE_REDIRECT_ORIGINS: 'http://dash.example' }, { ...ENV, GOOGLE_REDIRECT_ORIGINS: 'http://127.0.0.1:8890' },
    { ...ENV, GOOGLE_TOKEN_URL: 'http://127.0.0.1:1/token', ALLOW_LOCAL_OAUTH: '1', GOOGLE_REDIRECT_ORIGINS: 'https://dash.example', GOOGLE_AUTH_URL: 'https://evil.example/auth' },
    { ...ENV, GOOGLE_CLIENT_SECRET: 'x'.repeat(40) }];
  for (const env of bad) {
    assert.equal(S.loadAuthConfig(env).ok, false, JSON.stringify(Object.keys(env)));
    assert.equal((await sessionHandler(get('/api/session'), { env, store: S.memoryStore() })).status, 503);
    assert.match((await googleStart(get('/api/auth/google/start'), { env })).headers.get('location'), /signin=unavailable/);
  }
  // endpoint overrides are ignored entirely unless ALLOW_LOCAL_OAUTH=1 (production)
  const prod = S.loadAuthConfig({ ...ENV, GOOGLE_AUTH_URL: 'http://127.0.0.1:1/auth', GOOGLE_ISSUER: 'https://evil.example' });
  assert.ok(prod.ok); assert.equal(prod.google.authUrl, S.GOOGLE_ENDPOINTS.authUrl); assert.deepEqual(prod.google.issuers, S.GOOGLE_ENDPOINTS.issuers);
});

test('start: redirect to Google with state, nonce and an S256 PKCE challenge; secrets sealed in a Lax HttpOnly cookie', async () => {
  const res = await googleStart(get('/api/auth/google/start'), { env: ENV });
  assert.equal(res.status, 302);
  const u = new URL(res.headers.get('location'));
  assert.equal(u.origin + u.pathname, S.GOOGLE_ENDPOINTS.authUrl);
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), ORIGIN + '/api/auth/google/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'openid email');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  for (const k of ['state', 'nonce', 'code_challenge']) assert.ok((u.searchParams.get(k) || '').length >= 40, k);
  const sc = setCookies(res).find(c => c.startsWith(S.OAUTH_COOKIE + '='));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(sc.includes(a), a);
  const raw = Buffer.from(sc.split(';')[0].split('=')[1], 'base64url').toString('latin1');
  assert.ok(!raw.includes(u.searchParams.get('state')) && !raw.includes('verifier'), 'state cookie is encrypted, not just signed');
  assert.match(res.headers.get('cache-control'), /no-store/);
  // an origin that is not configured never gets a redirect URI
  const other = await googleStart(new Request('https://evil.example/api/auth/google/start'), { env: ENV });
  assert.match(other.headers.get('location'), /^\/\?signin=unavailable/);
  assert.equal((await googleStart(new Request(ORIGIN + '/api/auth/google/start', { method: 'POST' }), { env: ENV })).status, 405);
});

test('callback: an editor on the list gets an editor session (Secure, HttpOnly, SameSite=Strict __Host- cookie)', async () => {
  const G = makeGoogle();
  const { res, location, sessionCookie } = await signIn(G, 'editor@example.com');
  assert.equal(res.status, 302); assert.equal(location, '/');
  const sc = setCookies(res).find(c => c.startsWith(S.COOKIE + '='));
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(a), a);
  assert.doesNotMatch(sc, /Domain=/i);
  assert.ok(setCookies(res).some(c => c.startsWith(S.OAUTH_COOKIE + '=;') && /Max-Age=0/.test(c)), 'state cookie cleared');
  const st = await status(sessionCookie);
  assert.deepEqual([st.authenticated, st.role, st.email], [true, 'editor', 'editor@example.com']);
  assert.ok(st.csrf && st.expiresAt);
  assert.ok(G.calls.includes(S.GOOGLE_ENDPOINTS.tokenUrl) && G.calls.includes(S.GOOGLE_ENDPOINTS.jwksUrl), 'code exchanged and signature checked against Google keys');
});

test('callback: allowed viewers get viewer sessions; emails match case-insensitively', async () => {
  const G = makeGoogle();
  const a = await signIn(G, 'viewer@example.com');
  assert.equal((await status(a.sessionCookie)).role, 'viewer');
  const b = await signIn(G, 'VIEWER2@example.COM');
  assert.deepEqual([(await status(b.sessionCookie)).role, (await status(b.sessionCookie)).email], ['viewer', 'viewer2@example.com']);
});

test('callback: an account that is not on the list gets no session (?signin=denied)', async () => {
  const G = makeGoogle();
  const r = await signIn(G, 'outsider@example.com');
  assert.equal(r.location, '/?signin=denied'); assert.equal(r.sessionCookie, null);
});

test('callback refuses: cancelled, missing/forged/expired state cookie, state mismatch, code replay', async () => {
  const G = makeGoogle();
  const cancel = await googleCallback(get('/api/auth/google/callback?error=access_denied&state=x'), { env: ENV, fetchImpl: G.fetch });
  assert.equal(cancel.headers.get('location'), '/?signin=cancelled');
  assert.equal((await signIn(G, 'editor@example.com', { tamper: (t) => ({ ...t, cookie: null }) })).location, '/?signin=expired');
  assert.equal((await signIn(G, 'editor@example.com', { tamper: (t) => ({ ...t, cookie: t.cookie.slice(0, -4) + 'AAAA' }) })).location, '/?signin=expired');
  assert.equal((await signIn(G, 'editor@example.com', { tamper: (t) => ({ ...t, q: `?code=${t.code}&state=${t.state}x` }) })).location, '/?signin=failed');
  // a state cookie older than 10 minutes
  const start = await googleStart(get('/api/auth/google/start'), { env: ENV, now: Date.now() - 601e3 });
  const { code, state } = G.approve(start.headers.get('location'), 'editor@example.com');
  const old = await googleCallback(get(`/api/auth/google/callback?code=${code}&state=${state}`, { cookie: cookieValue(setCookies(start), S.OAUTH_COOKIE) }), { env: ENV, fetchImpl: G.fetch });
  assert.equal(old.headers.get('location'), '/?signin=expired');
  // the same code cannot be used twice (Google refuses; so do we)
  const st2 = await googleStart(get('/api/auth/google/start'), { env: ENV });
  const ok = G.approve(st2.headers.get('location'), 'editor@example.com');
  const ck = cookieValue(setCookies(st2), S.OAUTH_COOKIE);
  const first = await googleCallback(get(`/api/auth/google/callback?code=${ok.code}&state=${ok.state}`, { cookie: ck }), { env: ENV, fetchImpl: G.fetch });
  const again = await googleCallback(get(`/api/auth/google/callback?code=${ok.code}&state=${ok.state}`, { cookie: ck }), { env: ENV, fetchImpl: G.fetch });
  assert.equal(first.headers.get('location'), '/'); assert.equal(again.headers.get('location'), '/?signin=failed');
});

test('ID token checks: forged signature, wrong audience, issuer, expiry, nonce or unverified email are all refused', async () => {
  const cases = {
    'signed by another key': { token: (c) => G.sign(c, G.rogueKey) },
    'unknown key id': { token: (c) => G.sign(c, undefined, 'nope') },
    'wrong audience': { claims: { aud: 'someone-else.apps.googleusercontent.com' } },
    'wrong issuer': { claims: { iss: 'https://evil.example' } },
    expired: { claims: { exp: Math.floor(Date.now() / 1000) - 10 } },
    'nonce mismatch': { claims: { nonce: 'other' } },
    'email not verified': { claims: { email_verified: false } },
    'alg none': { token: (c) => Buffer.from('{"alg":"none","kid":"x"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(c)).toString('base64url') + '.' }
  };
  let G;
  for (const [name, o] of Object.entries(cases)) {
    _resetJwksCache();
    G = makeGoogle(); G.overrides = o;
    const r = await signIn(G, 'editor@example.com');
    assert.equal(r.location, '/?signin=failed', name); assert.equal(r.sessionCookie, null, name);
  }
  _resetJwksCache();
  await assert.rejects(() => verifyIdToken(S.loadAuthConfig(ENV), 'a.b', 'n'), /format/);
});

test('the allow-list is checked on every request: removal ends access, editor rights follow the editor list', async () => {
  const G = makeGoogle();
  const ed = await signIn(G, 'editor@example.com');
  const demoted = { ...ENV, GOOGLE_EDITOR_EMAILS: '', GOOGLE_ALLOWED_EMAILS: ENV.GOOGLE_ALLOWED_EMAILS + ',editor@example.com' };
  assert.equal((await status(ed.sessionCookie, demoted)).role, 'viewer', 'moved off the editor list -> viewer at once');
  const removed = { ...ENV, GOOGLE_EDITOR_EMAILS: '', GOOGLE_ALLOWED_EMAILS: 'viewer@example.com' };
  assert.equal((await status(ed.sessionCookie, removed)).authenticated, false, 'removed from the list -> signed out');
});

test('session restore and anonymous status; POST /api/session (old password sign-in) no longer exists', async () => {
  assert.equal((await status(null)).authenticated, false);
  const r = await sessionHandler(new Request(ORIGIN + '/api/session', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"password":"x"}' }), { env: ENV, store: S.memoryStore() });
  assert.equal(r.status, 405); assert.equal((await r.json()).error, 'use_google_sign_in');
});

test('expired, forged, tampered and other-generation session tokens are rejected', () => {
  const cfg = S.loadAuthConfig(ENV);
  const now = Date.now();
  const { token } = S.signSession(cfg, { role: 'viewer', email: 'viewer@example.com', now });
  assert.ok(S.verifySessionToken(cfg, token, now));
  assert.equal(S.verifySessionToken(cfg, token, now + cfg.ttlSec * 1000 + 1000), null, 'expired');
  const [b, sig] = token.split('.');
  const p = JSON.parse(Buffer.from(b, 'base64url')); p.role = 'editor'; p.email = 'editor@example.com';
  assert.equal(S.verifySessionToken(cfg, Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig, now), null, 'tampered');
  assert.equal(S.verifySessionToken(S.loadAuthConfig({ ...ENV, SESSION_SECRET: 'y'.repeat(40) }), token, now), null, 'other secret');
  assert.equal(S.verifySessionToken(S.loadAuthConfig({ ...ENV, SESSION_GENERATION: '2' }), token, now), null, 'generation bump ends every session');
  const long = S.signSession(S.loadAuthConfig({ ...ENV, SESSION_TTL_HOURS: '24' }), { role: 'viewer', email: 'viewer@example.com', now }).token;
  assert.equal(S.verifySessionToken(cfg, long, now), null, 'lifetime longer than configured');
  // the OAuth state value can never be used as a session and vice versa
  const sealed = S.signValue(cfg, 'oauth', { exp: Math.floor(now / 1000) + 60 });
  assert.equal(S.verifySessionToken(cfg, sealed, now), null);
  assert.equal(S.verifyValue(cfg, 'oauth', token, now), null);
  for (const t of ['', 'a', 'a.b.c', '.', 'x'.repeat(2000)]) assert.equal(S.verifySessionToken(cfg, t, now), null);
});

test('logout needs CSRF + origin, revokes the session server-side and clears the cookie', async () => {
  const G = makeGoogle(); const store = S.memoryStore();
  const { sessionCookie } = await signIn(G, 'editor@example.com');
  const csrf = (await status(sessionCookie, ENV, store)).csrf;
  const del = (h) => sessionHandler(new Request(ORIGIN + '/api/session', { method: 'DELETE', headers: { cookie: sessionCookie, origin: ORIGIN, ...h } }), { env: ENV, store });
  assert.equal((await del({})).status, 403, 'no CSRF');
  assert.equal((await del({ 'x-sb-csrf': csrf, origin: 'https://evil.example' })).status, 403);
  const out = await del({ 'x-sb-csrf': csrf });
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await status(sessionCookie, ENV, store)).authenticated, false, 'a copied cookie stops working after logout');
});

test('logout whose revocation cannot be stored is NOT reported as success (the function answers 500)', async () => {
  const G = makeGoogle(); const store = S.memoryStore();
  const { sessionCookie } = await signIn(G, 'editor@example.com');
  const csrf = (await status(sessionCookie, ENV, store)).csrf;
  const broken = { ...store, async set() { throw new Error('blobs down'); } };
  await assert.rejects(() => sessionHandler(new Request(ORIGIN + '/api/session', { method: 'DELETE', headers: { cookie: sessionCookie, origin: ORIGIN, 'x-sb-csrf': csrf } }), { env: ENV, store: broken }));
  assert.equal((await status(sessionCookie, ENV, store)).authenticated, true, 'honestly still valid; the client must retry');
});

test('CSRF token is bound to the session; authorize enforces role, origin and token', async () => {
  const cfg = S.loadAuthConfig(ENV); const store = S.memoryStore();
  const a = S.signSession(cfg, { role: 'viewer', email: 'viewer@example.com' }), b = S.signSession(cfg, { role: 'editor', email: 'editor@example.com' });
  const mk = (tok, extra = {}) => new Request(ORIGIN + '/api/v1/x', { method: 'PUT', headers: { cookie: S.COOKIE + '=' + tok, origin: ORIGIN, ...extra } });
  assert.equal((await S.authorize(mk(b.token, { 'x-sb-csrf': S.csrfToken(cfg, a.payload.sid) }), cfg, store, { write: true, role: 'editor' })).error, 'bad_csrf');
  assert.equal((await S.authorize(mk(a.token, { 'x-sb-csrf': S.csrfToken(cfg, a.payload.sid) }), cfg, store, { write: true, role: 'editor' })).status, 403, 'viewer cannot write');
  assert.ok((await S.authorize(mk(b.token, { 'x-sb-csrf': S.csrfToken(cfg, b.payload.sid) }), cfg, store, { write: true, role: 'editor' })).ok);
});

// ---- durable, concurrency-safe sign-in limits (counted before checking) ----
test('sign-in limits: refused accounts are counted per client; a successful sign-in clears its count', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '3', LOGIN_MAX_FAILURES_GLOBAL: '50' };
  const G = makeGoogle();
  for (let i = 0; i < 3; i++) assert.equal((await signIn(G, 'outsider@example.com', { env, ip: '203.0.113.9' })).location, '/?signin=denied');
  assert.equal((await signIn(G, 'editor@example.com', { env, ip: '203.0.113.9' })).location, '/?signin=too_many', 'even an allowed account waits');
  const rows = G.wenv.DB._raw.prepare('SELECT bucket FROM auth_attempts').all().map(r => r.bucket);
  assert.ok(rows.every(b => !b.includes('203.0.113.9')), 'buckets are HMACs, no raw address');
  assert.equal((await signIn(G, 'editor@example.com', { env, ip: '198.51.100.7' })).location, '/', 'another client still signs in');
  const realNow = Date.now; Date.now = () => realNow() + 16 * 60000;   // the Worker keeps its own clock
  try { assert.equal((await signIn(G, 'editor@example.com', { env, ip: '203.0.113.9' })).location, '/', 'the window passes'); }
  finally { Date.now = realNow; }
});

test('CONCURRENT: 40 simultaneous refused sign-ins from one client -> exactly the limit are checked', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '5', LOGIN_MAX_FAILURES_GLOBAL: '1000' };
  const G = makeGoogle({ delay: 20 });
  const res = await Promise.all(Array.from({ length: 40 }, () => signIn(G, 'outsider@example.com', { env, ip: '203.0.113.50' })));
  assert.equal(res.filter(r => r.location === '/?signin=denied').length, 5);
  assert.equal(res.filter(r => r.location === '/?signin=too_many').length, 35);
  assert.equal(G.wenv.DB._raw.prepare("SELECT n FROM auth_attempts WHERE bucket='global'").get().n, 40, 'every attempt counted');
  assert.equal(G.calls.filter(u => u === S.GOOGLE_ENDPOINTS.tokenUrl).length, 5, 'only 5 code exchanges with Google');
});

test('CONCURRENT: 40 simultaneous attempts from 40 clients -> the global limit holds', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_PER_CLIENT: '5', LOGIN_MAX_FAILURES_GLOBAL: '10' };
  const G = makeGoogle({ delay: 20 });
  const res = await Promise.all(Array.from({ length: 40 }, (_, i) => signIn(G, 'outsider@example.com', { env, ip: '192.0.2.' + i })));
  assert.equal(res.filter(r => r.location === '/?signin=denied').length, 10);
  assert.equal(res.filter(r => r.location === '/?signin=too_many').length, 30);
});

test('CONCURRENT: a burst of allowed sign-ins does not use up the global limit', async () => {
  const env = { ...ENV, LOGIN_MAX_FAILURES_GLOBAL: '10' };
  const G = makeGoogle({ delay: 20 });
  const res = await Promise.all(Array.from({ length: 8 }, (_, i) => signIn(G, 'viewer@example.com', { env, ip: '198.18.0.' + i })));
  assert.ok(res.every(r => r.location === '/'));
  assert.equal(G.wenv.DB._raw.prepare("SELECT n FROM auth_attempts WHERE bucket='global'").get().n, 0);
});

test('sign-in fails closed when the attempt counter is missing or unreachable', async () => {
  const G = makeGoogle();
  assert.equal((await signIn(G, 'editor@example.com', { env: { ...ENV, WORKER_AUTH_SECRET: '' } })).location, '/?signin=unavailable');
  const down = makeGoogle(); const f = down.fetch;
  down.fetch = (u, i) => String(u).startsWith('https://worker.example') ? Promise.reject(new Error('down')) : f(u, i);
  assert.equal((await signIn(down, 'editor@example.com')).location, '/?signin=unavailable');
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
