// Session expiry is enforced by the page itself at the known deadline,
// whatever the server or network does; "expired" and "server unavailable"
// are distinct; a late session-check answer can never unlock the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './load.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'auth-view.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function store() { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; }
const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const session = (ms, extra = {}) => Object.assign({ ok: true, authenticated: true, role: 'editor', expiresAt: new Date(Date.now() + ms).toISOString(), csrf: 'csrf-1' }, extra);

// net: a function (url, init) -> Promise<Response>, swappable during a test
function page(net, { search = '' } = {}) {
  const els = {}, classes = new Set(), listeners = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, textContent: '', title: '', disabled: false, value: '', attrs: {}, _l: {},
    addEventListener(t, f) { this._l[t] = f; }, setAttribute(k, v) { this.attrs[k] = v; }, replaceChildren() { this.cleared = true; } });
  const rendered = [el('rendered-table')];
  const document = {
    getElementById: el,
    documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
    querySelectorAll: () => rendered,
    addEventListener: (t, f) => { listeners[t] = f; }
  };
  const P = { net };
  const ctx = { document, localStorage: store(), sessionStorage: store(), fetch: (u, i) => P.net(u, i || {}), AbortController, console,
    setTimeout: (f, t) => { const h = setTimeout(f, t); if (h.unref) h.unref(); return h; }, clearTimeout, Date,
    location: { reload() {}, assign() {}, pathname: '/', hash: '', search }, history: { replaceState() { P.urlCleaned = true; } },
    addEventListener: (t, f) => { listeners['win:' + t] = f; } };
  ctx.window = ctx;
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const A = ctx.SBAuth; A.reloads = 0; A.reload = () => { A.reloads++; };
  P.navigations = []; A.navigate = (u) => { P.navigations.push(u); };
  let wiped = 0; A.onWipe(() => wiped++);
  return Object.assign(P, { A, els, classes, rendered, listeners, wiped: () => wiped,
    locked: () => classes.has('sb-locked'), msg: () => els['sb-login-msg'].textContent,
    ready: async () => { listeners.DOMContentLoaded(); await sleep(10); } });
}
const isGet = (u, i) => u === '/api/session' && (!i.method || i.method === 'GET');

test('1. expiry while OFFLINE: locked, requests aborted and shared data wiped at the deadline; stays locked; "expired" not "unavailable"', async () => {
  let pendingSignal = null;
  const p = page((u, i) => isGet(u, i) ? json(200, session(400)) : new Promise((_, rej) => { pendingSignal = i.signal; i.signal.addEventListener('abort', () => rej(new Error('aborted'))); }));
  await p.ready();
  assert.equal(p.A.state, 'signed_in'); assert.ok(!p.locked());
  const req = p.A.fetchJson('/api/v1/reports').then(() => null, (e) => e);   // a data request still waiting at the deadline
  p.net = () => Promise.reject(new TypeError('Failed to fetch'));   // the network goes away
  await sleep(500);
  assert.equal(p.A.state, 'expired');
  assert.ok(p.locked(), 'locked without any server answer');
  assert.ok(pendingSignal.aborted, 'pending data request aborted');
  assert.match(String((await req) && (await req).message), /Signed out|expired/);
  assert.ok(p.wiped() >= 1 && p.rendered[0].cleared, 'shared data and rendered content wiped');
  assert.match(p.msg(), /session expired/i); assert.match(p.msg(), /not reachable/i);
  assert.equal(p.A.serverDown, true);
  await p.A.check();                                         // still offline
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
  await assert.rejects(() => p.A.fetchJson('/api/v1/reports'), /Signed out/);
});

test('1b. a late timer (sleeping laptop) is caught by the deadline guard and by any API call', async () => {
  const p = page((u, i) => isGet(u, i) ? json(200, session(3600e3)) : json(200, { ok: true }));
  await p.ready();
  p.A.expiresAt = new Date(Date.now() - 1000).toISOString();     // deadline already passed, timer not yet fired
  await assert.rejects(() => p.A.fetchJson('/api/v1/reports'), /Signed out|expired/);
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
  const q = page((u, i) => isGet(u, i) ? json(200, session(3600e3)) : json(200, {}));
  await q.ready();
  q.A.expiresAt = new Date(Date.now() - 1000).toISOString();
  q.listeners.visibilitychange();
  assert.equal(q.A.state, 'expired');
});

test('2. expiry with HTTP 503: stays locked as "expired" (server down noted), never "signed in"', async () => {
  const p = page((u, i) => json(200, session(300)));
  await p.ready();
  p.net = () => json(503, { ok: false, error: 'not_configured' });
  await sleep(450);
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
  assert.equal(p.A.serverDown, true);
  assert.match(p.msg(), /session expired/i);
  // the server answering "authenticated" for an expired page does not unlock it either
  p.net = () => json(200, session(3600e3));
  await p.A.check();
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
  assert.equal(p.A.serverDown, false);
});

test('2b. server unavailable at start-up is a different state and message from "expired"', async () => {
  const p = page(() => json(503, { ok: false }));
  await p.ready();
  assert.equal(p.A.state, 'unavailable'); assert.ok(p.locked());
  assert.doesNotMatch(p.msg(), /expired/i); assert.match(p.msg(), /not available/i);
  const q = page(() => Promise.reject(new TypeError('offline')));
  await q.ready();
  assert.equal(q.A.state, 'unavailable'); assert.match(q.msg(), /could not be reached/i);
});

test('2c. a session the server reports with a deadline already in the past never unlocks', async () => {
  const p = page(() => json(200, session(-5000)));
  await p.ready();
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
});

test('3. a session-check answer arriving AFTER sign-out cannot unlock or change the page', async () => {
  let release;
  const p = page((u, i) => isGet(u, i) ? json(200, session(3600e3)) : json(500, {}));
  await p.ready();
  p.net = (u, i) => isGet(u, i) ? new Promise(r => { release = () => r(new Response(JSON.stringify(session(3600e3)), { status: 200 })); })
                                : json(500, {});           // DELETE fails -> logout_failed
  const late = p.A.check();                                // in flight
  await sleep(5);
  assert.equal(await p.A.logout(), false);
  assert.equal(p.A.state, 'logout_failed');
  release(); await late;
  assert.equal(p.A.state, 'logout_failed'); assert.ok(p.locked(), 'still locked');
  // confirmed sign-out, then a late "authenticated" answer from before it
  const q = page((u, i) => isGet(u, i) ? json(200, session(3600e3)) : json(200, { ok: true, authenticated: false }));
  await q.ready();
  let rel2;
  q.net = (u, i) => isGet(u, i) ? new Promise(r => { rel2 = () => r(new Response(JSON.stringify(session(3600e3)), { status: 200 })); })
                                : json(200, { ok: true, authenticated: false });
  const late2 = q.A.check(); await sleep(5);
  assert.equal(await q.A.logout(), true);
  rel2(); await late2;
  assert.equal(q.A.state, 'signed_out'); assert.ok(q.locked());
});

test('3b. a check started before expiry and answered after it cannot unlock', async () => {
  let release;
  const p = page((u, i) => json(200, session(300)));
  await p.ready();
  p.net = () => new Promise(r => { if (!release) release = () => r(new Response(JSON.stringify(session(3600e3)), { status: 200 })); else r(new Response(JSON.stringify(session(3600e3)), { status: 200 })); });
  const late = p.A.check();
  await sleep(450);
  assert.equal(p.A.state, 'expired');
  release(); await late;
  assert.equal(p.A.state, 'expired'); assert.ok(p.locked());
});

test('3c. a late "not signed in" answer from an older check does not sign out a session a newer check confirmed', async () => {
  let release;
  const p = page(() => json(200, { ok: true, authenticated: false }));
  await p.ready();
  p.net = () => new Promise(r => { release = () => r(new Response('{"ok":true,"authenticated":false}', { status: 200 })); });
  const late = p.A.check(); await sleep(5);
  const first = release;
  p.net = () => json(200, session(3600e3));
  await p.A.check();                          // e.g. back from Google in another tab: the newer check
  assert.equal(p.A.state, 'signed_in');
  first(); await late;
  assert.equal(p.A.state, 'signed_in'); assert.ok(!p.locked());
});

// Re-authentication is a full-page trip to Google and back: the locked page
// sends the person to /api/auth/google/start; the page Google returns to finds
// the new session with its first check.
for (const [name, setup] of [
  ['expiry while offline', async (p) => { p.net = () => Promise.reject(new TypeError('offline')); await sleep(450); }],
  ['expiry with 503', async (p) => { p.net = () => json(503, {}); await sleep(450); }],
  ['failed sign-out', async (p) => { p.net = (u, i) => isGet(u, i) ? json(200, session(3600e3)) : json(500, {}); await p.A.logout(); }],
  ['server unavailable at start-up', async (p) => { p.net = () => json(503, {}); }]
]) {
  test(`4. re-authentication after ${name}: "Sign in with Google" leaves for Google; the returning page is signed in`, async () => {
    const p = page(() => name === 'server unavailable at start-up' ? json(503, {}) : json(200, session(name === 'failed sign-out' ? 3600e3 : 300)));
    await p.ready();
    await setup(p);
    assert.ok(p.locked()); assert.notEqual(p.A.state, 'signed_in');
    p.els['sb-login-submit']._l.click();
    assert.deepEqual(p.navigations, ['/api/auth/google/start']);
    assert.ok(p.locked(), 'stays locked while leaving');
    const back = page(() => json(200, session(3600e3, { csrf: 'csrf-2', email: 'editor@example.com' })));
    await back.ready();
    assert.equal(back.A.state, 'signed_in'); assert.ok(!back.locked());
    assert.equal(back.A.csrf, 'csrf-2'); assert.equal(back.A.email, 'editor@example.com');
    assert.equal(back.msg(), '');
  });
}

test('4b. a refused Google sign-in comes back as ?signin=denied: shown once, removed from the address bar, page stays locked', async () => {
  const p = page(() => json(200, { ok: true, authenticated: false }), { search: '?signin=denied' });
  await p.ready();
  assert.equal(p.A.state, 'signed_out'); assert.ok(p.locked());
  assert.match(p.msg(), /not allowed/i); assert.ok(p.urlCleaned);
  const q = page(() => json(200, { ok: true, authenticated: false }), { search: '?signin=<script>' });
  await q.ready();
  assert.equal(q.msg(), '', 'unknown or malformed codes are ignored');
});
