// server/tracker-core.mjs — /api/stock-tracker, shared by the Netlify Edge
// Function (production), the local dev server and the tests.
//
// The tracker app's scrape takes about 30 s (measured on the current
// dashboard). The previous Netlify Function gateway cut it off with its own
// 9 s upstream timeout, so the page always got "tracker unavailable".
// Production now runs this from an Edge Function (netlify/edge-functions/
// stock-tracker.js), which may wait up to 40 s for its response to begin.
// Everything here is plain Web APIs (no Node modules) so it runs in both runtimes.
//
// One deadline covers the WHOLE request: the sign-in check, the tracker sign-in
// (request and body), and the scrape (request and body). Every upstream call
// shares one abort signal, and the result is raced against the deadline, so
// the caller gets 504 tracker_timeout on time even if an upstream ignores the
// abort. Work that finishes after the deadline is discarded: it cannot answer
// the caller or write the cached tracker token.
//
// The caller supplies `authorize(req, { signal })` -> { ok } | { ok:false, status, error }:
//   - Edge Function: sessionProbe() asks /api/session with the caller's cookie
//     (signature, expiry, revocation, current allow-list);
//   - Node (dev server/tests): server/session.mjs authorize() directly.
// The tracker password and the tracker's token never reach the browser.

const NO_STORE = {
  'cache-control': 'no-store, private, max-age=0',
  'pragma': 'no-cache',
  'vary': 'Cookie',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};
export function trackerReply(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extra } });
}

// The tracker app names its "listed by the supplier, not carried by us" list
// after the supplier; the page receives a neutral name.
export function normalizeTracker(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = Object.assign({}, j);
  for (const k of Object.keys(out)) if (/^mcg/i.test(k)) { out['supplier' + k.slice(3)] = out[k]; delete out[k]; }
  return out;
}

// Total time for the whole request. Above the tracker's usual ~30 s, below the
// Edge Function's 40 s limit for the response to begin.
export const TRACKER_BUDGET_MS = 37000;
const MAX_BYTES = 5 * 1024 * 1024;
const token = { value: null, exp: 0 };
export function _resetTrackerToken() { token.value = null; token.exp = 0; }
export function _peekTrackerToken() { return token.value; }   // tests only

class Fail extends Error { constructor(res) { super('fail'); this.res = res; } }

export async function trackerCore(req, { env, authorize, fetchImpl = fetch, now = Date.now(), budgetMs = TRACKER_BUDGET_MS }) {
  if (req.method !== 'GET') return trackerReply({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET' });
  const url = new URL(req.url);
  for (const k of url.searchParams.keys()) if (k !== 'refresh') return trackerReply({ ok: false, error: 'bad_parameter' }, 400);
  const refresh = url.searchParams.get('refresh') === '1';

  const ac = new AbortController();
  const signal = ac.signal;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve(trackerReply({ ok: false, error: 'tracker_timeout' }, 504)); }, budgetMs);
  });
  // Throws once the deadline has passed: late work stops at its next step.
  const live = () => { if (signal.aborted) throw new Error('deadline'); };

  const work = (async () => {
    let a;
    try { a = await authorize(req, { signal }); } catch { live(); a = { ok: false, status: 502, error: 'session_unavailable' }; }
    live();
    if (!a || !a.ok) throw new Fail(trackerReply({ ok: false, error: (a && a.error) || 'not_signed_in' }, (a && a.status) || 401));

    let base;
    try { base = new URL(String(env.STOCK_TRACKER_URL || '')); } catch { base = null; }
    const pwd = String(env.STOCK_TRACKER_PASSWORD || '');
    if (!base || base.protocol !== 'https:' || base.pathname !== '/' || base.search || !pwd) throw new Fail(trackerReply({ ok: false, error: 'not_configured' }, 503));

    const call = async (path, init) => { live(); const r = await fetchImpl(base.origin + path, { ...init, redirect: 'manual', signal }); live(); return r; };
    const signIn = async () => {
      const r = await call('/.netlify/functions/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
      const j = await r.json().catch(() => ({}));
      live();                       // a late answer never becomes the cached token
      if (!r.ok || !j || typeof j.token !== 'string' || !j.token) throw new Error('auth');
      token.value = j.token; token.exp = now + 6 * 3600 * 1000;
      return j.token;
    };
    try {
      let tk = (token.value && now <= token.exp) ? token.value : await signIn();
      const path = '/.netlify/functions/scrape' + (refresh ? '?refresh=true' : '');
      let r = await call(path, { headers: { authorization: 'Bearer ' + tk } });
      if (r.status === 401) { tk = await signIn(); r = await call(path, { headers: { authorization: 'Bearer ' + tk } }); }
      if (!r.ok) throw new Fail(trackerReply({ ok: false, error: 'tracker_failed', status: r.status }, 502));
      const text = await r.text();
      live();
      if (text.length > MAX_BYTES) throw new Fail(trackerReply({ ok: false, error: 'tracker_response_too_large' }, 502));
      return trackerReply(normalizeTracker(JSON.parse(text)), 200);
    } catch (e) {
      if (!signal.aborted) token.value = null;   // only a request still in time may touch the cache
      throw e;
    }
  })().catch((e) => {
    if (signal.aborted) return null;             // the deadline already answered
    return e instanceof Fail ? e.res : trackerReply({ ok: false, error: 'tracker_unavailable' }, 502);
  });

  try {
    const res = await Promise.race([work, deadline]);
    return res || await deadline;
  } finally {
    clearTimeout(timer);
    ac.abort();                                  // stop anything still running
  }
}

// For the Edge Function: authorize by asking this site's own /api/session with
// the caller's cookie, under the request's shared abort signal. Only "signed in
// as viewer or editor" passes.
export function sessionProbe(fetchImpl = fetch) {
  return async (req, { signal } = {}) => {
    const origin = new URL(req.url).origin;
    const r = await fetchImpl(origin + '/api/session', {
      method: 'GET', redirect: 'manual', signal,
      headers: { cookie: req.headers.get('cookie') || '', accept: 'application/json' }
    });
    if (r.status === 503) return { ok: false, status: 503, error: 'not_configured' };
    if (r.status !== 200) return { ok: false, status: 502, error: 'session_unavailable' };
    const j = await r.json().catch(() => null);
    if (!j || j.authenticated !== true || (j.role !== 'viewer' && j.role !== 'editor')) return { ok: false, status: 401, error: 'not_signed_in' };
    return { ok: true, role: j.role };
  };
}
