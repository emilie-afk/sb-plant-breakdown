// server/handlers.mjs — the three same-origin endpoints behind the dashboard.
//
//   /api/session        GET status · DELETE sign out (sign-in: /api/auth/google/*, google.mjs)
//   /api/v1/...         allowlisted gateway to the Worker (server-held keys)
//   /api/stock-tracker  GET stock-tracker data (server-held tracker password)
//
// Every handler takes a standard Request and returns a Response, so the same
// code runs in Netlify Functions, the local dev server and the tests.
import * as S from './session.mjs';

const NO_STORE = {
  'cache-control': 'no-store, private, max-age=0',
  'pragma': 'no-cache',
  'vary': 'Cookie',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};
export function reply(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extra } });
}

// ---------------------------------------------------------------------------
// /api/session
// ---------------------------------------------------------------------------
export async function sessionHandler(req, { env, store, now = Date.now() }) {
  const cfg = S.loadAuthConfig(env);
  if (!cfg.ok) return reply({ ok: false, error: 'not_configured' }, 503);

  if (req.method === 'GET') {
    const a = await S.authorize(req, cfg, store, { now });
    if (!a.ok) return reply({ ok: true, authenticated: false }, 200, a.status === 401 && S.readCookie(req) ? { 'set-cookie': S.clearCookie() } : {});
    return reply({ ok: true, authenticated: true, role: a.session.role, email: a.session.email,
                   expiresAt: new Date(a.session.exp * 1000).toISOString(), csrf: S.csrfToken(cfg, a.session.sid) });
  }

  // Sign-in is "Sign in with Google" (server/google.mjs): there is no password.
  if (req.method === 'POST') return reply({ ok: false, error: 'use_google_sign_in' }, 405, { allow: 'GET, DELETE' });

  if (req.method === 'DELETE') {
    const a = await S.authorize(req, cfg, store, { write: true, now });
    if (a.ok) await store.set('revoked/' + a.session.sid, { exp: a.session.exp });
    else if (a.status === 403) return reply({ ok: false, error: a.error }, 403);
    return reply({ ok: true, authenticated: false }, 200, { 'set-cookie': S.clearCookie() });
  }
  return reply({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET, DELETE' });
}

// ---------------------------------------------------------------------------
// /api/v1/... — the gateway. Not a general proxy: only these routes, methods
// and parameters exist; the destination is fixed by WORKER_URL; caller headers
// are never forwarded; the Worker key is chosen here, by operation.
// ---------------------------------------------------------------------------
export const READ_SETTINGS = new Set(['classification_overrides', 'amazon_column_mappings', 'catalog_mappings',
  'vendor_map', 'restricted_items', 'market_config']);
export const WRITE_SETTINGS = new Set(['classification_overrides', 'amazon_column_mappings', 'catalog_mappings']);
const REPORT_ID = /^(shopify|amazon|market):[^:/?#\\\x00-\x1f]{1,120}:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}:r\d{1,6}$/;
const SOURCES = new Set(['shopify', 'amazon', 'market']);
const MAX_UPLOAD = 5 * 1024 * 1024;     // Netlify functions accept ~6 MB per request

function intParam(v, min, max) {
  if (v == null || v === '') return null;
  if (!/^\d{1,7}$/.test(v)) return undefined;
  const n = Number(v);
  return n < min || n > max ? undefined : n;
}
// -> { upstreamPath, method, keyVar, role, write, body?:'json' } | { error, status }
export function matchRoute(method, path, params) {
  const only = (allowed) => { for (const k of params.keys()) if (!allowed.includes(k)) return false; return true; };
  if (path === '/v1/reports' && method === 'GET') {
    if (!only(['source', 'history'])) return { status: 400, error: 'bad_parameter' };
    const q = new URLSearchParams();
    const src = params.get('source');
    if (src != null) { if (!SOURCES.has(src)) return { status: 400, error: 'bad_parameter' }; q.set('source', src); }
    const h = params.get('history');
    if (h != null) { if (h !== '1') return { status: 400, error: 'bad_parameter' }; q.set('history', '1'); }
    return { upstreamPath: '/v1/reports' + (q.toString() ? '?' + q : ''), method, keyVar: 'WORKER_VIEWER_SECRET', role: 'viewer' };
  }
  let m = /^\/v1\/reports\/([^/]+)\/rows$/.exec(path);
  if (m && method === 'GET') {
    let id; try { id = decodeURIComponent(m[1]); } catch { return { status: 400, error: 'bad_parameter' }; }
    if (!REPORT_ID.test(id) || !only(['offset', 'limit'])) return { status: 400, error: 'bad_parameter' };
    const offset = intParam(params.get('offset'), 0, 10000000), limit = intParam(params.get('limit'), 1, 5000);
    if (offset === undefined || limit === undefined) return { status: 400, error: 'bad_parameter' };
    const q = new URLSearchParams({ offset: String(offset || 0), limit: String(limit || 5000) });
    return { upstreamPath: '/v1/reports/' + encodeURIComponent(id) + '/rows?' + q, method, keyVar: 'WORKER_VIEWER_SECRET', role: 'viewer' };
  }
  if (path === '/v1/imports' && method === 'GET') {
    if (!only(['source', 'limit'])) return { status: 400, error: 'bad_parameter' };
    const q = new URLSearchParams();
    const src = params.get('source');
    if (src != null) { if (!SOURCES.has(src)) return { status: 400, error: 'bad_parameter' }; q.set('source', src); }
    const limit = intParam(params.get('limit'), 1, 200);
    if (limit === undefined) return { status: 400, error: 'bad_parameter' };
    if (limit) q.set('limit', String(limit));
    return { upstreamPath: '/v1/imports' + (q.toString() ? '?' + q : ''), method, keyVar: 'WORKER_VIEWER_SECRET', role: 'viewer' };
  }
  m = /^\/v1\/settings\/([a-z_]{1,40})$/.exec(path);
  if (m && params.toString() === '') {
    if (method === 'GET' && READ_SETTINGS.has(m[1])) return { upstreamPath: path, method, keyVar: 'WORKER_VIEWER_SECRET', role: 'viewer' };
    if (method === 'PUT' && WRITE_SETTINGS.has(m[1])) return { upstreamPath: path, method, keyVar: 'WORKER_SETTINGS_SECRET', role: 'editor', write: true, body: 'json', max: 2 * 1024 * 1024 };
    if (READ_SETTINGS.has(m[1])) return { status: 405, error: 'method_not_allowed' };
    return { status: 404, error: 'not_found' };
  }
  if (path === '/v1/ingest/product-report' && method === 'POST' && params.toString() === '') {
    return { upstreamPath: path, method, keyVar: 'WORKER_UPLOAD_SECRET', role: 'editor', write: true, body: 'json', max: MAX_UPLOAD };
  }
  return { status: 404, error: 'not_found' };
}

function workerBase(env) {
  const raw = String(env.WORKER_URL || '').trim();
  let u; try { u = new URL(raw); } catch { return null; }
  const local = (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && env.ALLOW_LOCAL_WORKER === '1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
  return u.origin;
}

// Sign-in attempt counters, kept atomically in the Worker's database
// (POST /v1/auth/attempt | /v1/auth/success, AUTH_SECRET). Null when not
// configured: sign-in is then refused (fail closed).
export function workerLimiter(env, fetchImpl, cfg, timeoutMs = 9000) {
  const base = workerBase(env);
  const key = String(env.WORKER_AUTH_SECRET || '');
  if (!base || key.length < 32) return null;
  const post = async (path, client) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + path, { method: 'POST', redirect: 'manual', signal: ac.signal,
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client, windowSec: cfg.windowSec }) });
      const j = await r.json();
      if (r.status !== 200 || !j.ok) throw new Error('limiter');
      return j;
    } finally { clearTimeout(t); }
  };
  return {
    async reserve(client) {
      const j = await post('/v1/auth/attempt', client);
      if (!j.client || !j.global || !Number.isInteger(j.client.n) || !Number.isInteger(j.global.n)) throw new Error('limiter');
      return j;
    },
    release: (client) => post('/v1/auth/success', client)
  };
}

export async function apiHandler(req, { env, store, fetchImpl = fetch, now = Date.now(), timeoutMs = 9000 }) {
  const cfg = S.loadAuthConfig(env);
  if (!cfg.ok) return reply({ ok: false, error: 'not_configured' }, 503);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/v1\/)/, '');
  const route = matchRoute(req.method, path, url.searchParams);
  // Authenticate before revealing anything about the route table.
  const a = await S.authorize(req, cfg, store, { write: !!route.write || !['GET', 'HEAD'].includes(req.method), role: route.role || 'viewer', now });
  if (!a.ok) return reply({ ok: false, error: a.error }, a.status);
  if (route.error) return reply({ ok: false, error: route.error }, route.status);

  const base = workerBase(env);
  const key = String(env[route.keyVar] || '');
  if (!base || key.length < 32) return reply({ ok: false, error: 'not_configured' }, 503);

  let body;
  if (route.body === 'json') {
    if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return reply({ ok: false, error: 'bad_request' }, 415);
    const len = Number(req.headers.get('content-length') || 0);
    if (len > route.max) return reply({ ok: false, error: 'body_too_large' }, 413);
    body = await req.text();
    if (body.length > route.max) return reply({ ok: false, error: 'body_too_large' }, 413);
    try { JSON.parse(body); } catch { return reply({ ok: false, error: 'bad_json' }, 400); }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    // A fresh header set: nothing the caller sent (cookies, authorization,
    // forwarded-for, host) reaches the Worker.
    res = await fetchImpl(base + route.upstreamPath, {
      method: route.method, redirect: 'manual', signal: ac.signal,
      headers: Object.assign({ authorization: 'Bearer ' + key, accept: 'application/json' }, body !== undefined ? { 'content-type': 'application/json' } : {}),
      body
    });
  } catch {
    return reply({ ok: false, error: 'upstream_unreachable' }, 502);
  } finally { clearTimeout(timer); }
  if (res.status >= 300 && res.status < 400) return reply({ ok: false, error: 'upstream_redirect_refused' }, 502);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return reply({ ok: false, error: 'upstream_bad_response' }, 502); }
  // An upstream 401 means OUR server key is wrong; never tell the browser to re-key.
  if (res.status === 401) return reply({ ok: false, error: 'upstream_auth_failed' }, 502);
  return reply(json, res.status);
}

// ---------------------------------------------------------------------------
// /api/stock-tracker — the stock tracker app's data, fetched with a password that
// stays on the server (it used to be built into the page).
// ---------------------------------------------------------------------------
const trackerToken = { value: null, exp: 0 };
// The tracker app names its "listed by the supplier, not carried by us" list
// after the supplier; the page receives a neutral name.
export function normalizeTracker(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = Object.assign({}, j);
  for (const k of Object.keys(out)) if (/^mcg/i.test(k)) { out['supplier' + k.slice(3)] = out[k]; delete out[k]; }
  return out;
}
export async function trackerHandler(req, { env, store, fetchImpl = fetch, now = Date.now(), timeoutMs = 9000 }) {
  const cfg = S.loadAuthConfig(env);
  if (!cfg.ok) return reply({ ok: false, error: 'not_configured' }, 503);
  if (req.method !== 'GET') return reply({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET' });
  const a = await S.authorize(req, cfg, store, { now });
  if (!a.ok) return reply({ ok: false, error: a.error }, a.status);
  const url = new URL(req.url);
  for (const k of url.searchParams.keys()) if (k !== 'refresh') return reply({ ok: false, error: 'bad_parameter' }, 400);
  const refresh = url.searchParams.get('refresh') === '1';
  let base;
  try { base = new URL(String(env.STOCK_TRACKER_URL || '')); } catch { base = null; }
  const pwd = String(env.STOCK_TRACKER_PASSWORD || '');
  if (!base || base.protocol !== 'https:' || base.pathname !== '/' || base.search || !pwd) return reply({ ok: false, error: 'not_configured' }, 503);
  const call = async (path, init) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    try { return await fetchImpl(base.origin + path, { ...init, redirect: 'manual', signal: ac.signal }); }
    finally { clearTimeout(t); }
  };
  const auth = async () => {
    const r = await call('/.netlify/functions/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error('auth');
    trackerToken.value = j.token; trackerToken.exp = now + 6 * 3600 * 1000;
  };
  try {
    if (!trackerToken.value || now > trackerToken.exp) await auth();
    const path = '/.netlify/functions/scrape' + (refresh ? '?refresh=true' : '');
    let r = await call(path, { headers: { authorization: 'Bearer ' + trackerToken.value } });
    if (r.status === 401) { await auth(); r = await call(path, { headers: { authorization: 'Bearer ' + trackerToken.value } }); }
    if (!r.ok) return reply({ ok: false, error: 'tracker_failed', status: r.status }, 502);
    const text = await r.text();
    if (text.length > 5 * 1024 * 1024) return reply({ ok: false, error: 'tracker_response_too_large' }, 502);
    return reply(normalizeTracker(JSON.parse(text)), 200);
  } catch {
    trackerToken.value = null;
    return reply({ ok: false, error: 'tracker_unavailable' }, 502);
  }
}
export function _resetTrackerToken() { trackerToken.value = null; trackerToken.exp = 0; }
