// auth-view.js in isolation (vm + minimal DOM): sign-out must be confirmed by
// the server, failure keeps the page locked and retryable, expiry and
// sign-out wipe shared data, and answers arriving afterwards are discarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './load.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'auth-view.js'), 'utf8');
function store() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m }; }
function page(fetchImpl) {
  const els = {}, classes = new Set(), listeners = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, textContent: '', title: '', disabled: false, value: '', _l: {}, addEventListener(t, f) { this._l[t] = f; }, replaceChildren() { this.cleared = true; } });
  const rendered = [el('rendered-table')];
  const document = {
    getElementById: el,
    documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
    querySelectorAll: () => rendered,
    addEventListener: (t, f) => { listeners[t] = f; }
  };
  const ctx = { document, localStorage: store(), sessionStorage: store(), fetch: (...a) => fetchImpl(...a), AbortController, console, setTimeout: (f, t) => { const h = setTimeout(f, t); if (h.unref) h.unref(); return h; }, clearTimeout, Date, location: { reload() {} }, addEventListener: (t, f) => { listeners['win:' + t] = f; } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const A = ctx.SBAuth;
  A.reloads = 0; A.reload = () => { A.reloads++; };
  return { A, ctx, els, classes, rendered, ready: async () => { listeners.DOMContentLoaded(); await new Promise(r => setTimeout(r, 5)); } };
}
const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const SIGNED_IN = { ok: true, authenticated: true, role: 'editor', expiresAt: new Date(Date.now() + 3600e3).toISOString(), csrf: 'csrf-1' };

async function signedInPage(handler) {
  const p = page((url, init) => {
    if ((!init || !init.method || init.method === 'GET') && url === '/api/session') return json(200, SIGNED_IN);
    return handler(url, init || {});
  });
  await p.ready();
  assert.equal(p.A.state, 'signed_in');
  assert.ok(!p.classes.has('sb-locked'), 'unlocked once the server confirms the session');
  return p;
}

test('the page starts locked; it unlocks only when the server confirms a session', async () => {
  const p = page(() => json(200, { ok: true, authenticated: false }));
  assert.ok(p.classes.has('sb-locked'));
  await p.ready();
  assert.equal(p.A.state, 'signed_out'); assert.ok(p.classes.has('sb-locked'));
});

for (const [name, del] of [['HTTP 500', () => json(500, { ok: false, error: 'server_error' })],
                           ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
                           ['HTTP 403 (CSRF refused)', () => json(403, { ok: false, error: 'bad_csrf' })],
                           ['200 without confirmation', () => json(200, { ok: true })]]) {
  test(`logout with ${name}: not reported as signed out; page stays locked and wiped; retry offered`, async () => {
    let wiped = 0;
    const p = await signedInPage((url, init) => init.method === 'DELETE' ? del() : json(404, {}));
    p.A.onWipe(() => wiped++);
    const ok = await p.A.logout();
    assert.equal(ok, false);
    assert.equal(p.A.state, 'logout_failed');
    assert.equal(p.A.isSignedIn(), false, 'no API use while the outcome is unknown');
    assert.ok(p.classes.has('sb-locked'), 'content hidden');
    assert.ok(wiped >= 1 && p.rendered[0].cleared, 'shared data and rendered content cleared');
    assert.equal(p.A.reloads, 0, 'no reload: a reload would silently restore the session');
    assert.equal(p.els['sb-logout-retry'].style.display, '', 'retry button shown');
    assert.match(p.els['sb-logout-msg'].textContent, /did not complete/);
    assert.equal(p.els['sb-login-form'].style.display, 'none');
    // a session check meanwhile does not quietly sign the page back in
    await p.A.check();
    assert.equal(p.A.state, 'logout_failed');
    await assert.rejects(() => p.A.fetchJson('/api/v1/reports'), /Signed out/);
  });
}

test('retry after a failed logout: confirmed -> signed out and the page reloads clean; the CSRF token is reused', async () => {
  let n = 0; const seen = [];
  const p = await signedInPage((url, init) => { if (init.method !== 'DELETE') return json(404, {}); seen.push(init.headers['x-sb-csrf']); return ++n === 1 ? json(500, {}) : json(200, { ok: true, authenticated: false }); });
  assert.equal(await p.A.logout(), false);
  p.els['sb-logout-retry']._l.click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(p.A.state, 'signed_out'); assert.equal(p.A.reloads, 1);
  assert.deepEqual(seen, ['csrf-1', 'csrf-1']);
});

test('after a failed logout, a new page load restores the still-valid server session (honest state)', async () => {
  const p = await signedInPage(() => json(500, {}));
  assert.equal(await p.A.logout(), false);
  const fresh = await signedInPage(() => json(404, {}));      // the server still knows the session
  assert.equal(fresh.A.state, 'signed_in');
});

test('an answer that arrives after sign-out is discarded and its request aborted', async () => {
  let release, signal;
  const p = await signedInPage((url, init) => {
    if (init.method === 'DELETE') return json(200, { ok: true, authenticated: false });
    signal = init.signal;
    return new Promise(r => { release = () => r(new Response(JSON.stringify({ ok: true, reports: [{ id: 'secret' }] }), { status: 200 })); });
  });
  const pending = p.A.fetchJson('/api/v1/reports');
  await new Promise(r => setTimeout(r, 5));
  await p.A.logout();
  assert.ok(signal.aborted, 'request aborted at sign-out');
  release();
  await assert.rejects(pending, /Signed out/);
});

test('a 401 from any API call (expiry) wipes, locks and reloads', async () => {
  let wiped = 0;
  const p = await signedInPage(() => json(401, { ok: false, error: 'not_signed_in' }));
  p.A.onWipe(() => wiped++);
  await assert.rejects(() => p.A.fetchJson('/api/v1/reports'), /Signed out/);
  assert.equal(p.A.state, 'signed_out'); assert.ok(p.classes.has('sb-locked')); assert.equal(wiped, 1); assert.equal(p.A.reloads, 1);
});

test('expiry noticed by the session check while open: wiped and reloaded', async () => {
  let authed = true;
  const p = page((url) => json(200, authed ? SIGNED_IN : { ok: true, authenticated: false }));
  await p.ready();
  let wiped = 0; p.A.onWipe(() => wiped++);
  authed = false;
  await p.A.check();
  assert.equal(p.A.state, 'signed_out'); assert.equal(wiped, 1); assert.equal(p.A.reloads, 1);
});

test('shared caches are removed from browser storage at sign-out; legacy key copies are removed on load', async () => {
  const p = await signedInPage((url, init) => json(200, { ok: true, authenticated: false }));
  p.ctx.localStorage.setItem('sb-shared-settings-versions-v1', '{}');
  p.ctx.sessionStorage.setItem('sb-stock-tracker-cache-v1', '{"data":{}}');
  p.ctx.localStorage.setItem('my-manual-upload', 'kept');
  await p.A.logout();
  assert.equal(p.ctx.localStorage.getItem('sb-shared-settings-versions-v1'), null);
  assert.equal(p.ctx.sessionStorage.getItem('sb-stock-tracker-cache-v1'), null);
  assert.equal(p.ctx.localStorage.getItem('my-manual-upload'), 'kept');
});
