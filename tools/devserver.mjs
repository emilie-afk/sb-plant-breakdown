// tools/devserver.mjs — local end-to-end harness. NOT deployed.
//
// Serves dist/ (with the CSP from dist/_headers) and runs the real Netlify
// function handlers and the real Worker in one process: an in-memory D1
// (Node SQLite + the real migrations) and an in-memory session store.
// Optionally seeds SYNTHETIC reports from tests/fixtures.
//
//   DEV_VIEWER_PASSWORD=... DEV_EDITOR_PASSWORD=... node tools/devserver.mjs [--port 8899] [--seed] [--settings dir]
//
// --settings dir   push restricted_items.json / market_config.json from a
//                  local folder (e.g. a private one outside the repo) as Worker
//                  settings, for a local parity check. Never commit them.
// Secrets are random per run and never printed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { makeD1 } from '../tests/d1shim.mjs';
import { hashPassword, memoryStore } from '../server/session.mjs';
import { sessionHandler, apiHandler, trackerHandler } from '../server/handlers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('port', 8899));
const rnd = () => crypto.randomBytes(32).toString('hex');
const vpw = process.env.DEV_VIEWER_PASSWORD, epw = process.env.DEV_EDITOR_PASSWORD;
if (!vpw || !epw) { console.error('Set DEV_VIEWER_PASSWORD and DEV_EDITOR_PASSWORD (>= 12 characters each).'); process.exit(2); }

const K = { INGEST_SECRET: rnd(), VIEWER_SECRET: rnd(), UPLOAD_SECRET: rnd(), SETTINGS_SECRET: rnd(), DASHBOARD_SECRET: rnd(), AUTH_SECRET: rnd() };
const wenv = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), ALLOWED_ORIGINS: '', ...K };
const env = {
  SESSION_SECRET: rnd(), DASHBOARD_VIEWER_PASSWORD_HASH: hashPassword(vpw), DASHBOARD_EDITOR_PASSWORD_HASH: hashPassword(epw),
  WORKER_URL: 'https://worker.local', WORKER_VIEWER_SECRET: K.VIEWER_SECRET, WORKER_UPLOAD_SECRET: K.UPLOAD_SECRET, WORKER_SETTINGS_SECRET: K.SETTINGS_SECRET, WORKER_AUTH_SECRET: K.AUTH_SECRET,
  LOGIN_MAX_FAILURES_PER_CLIENT: process.env.DEV_LOGIN_MAX || '5'
};
const baseStore = memoryStore();
// --dev-controls: test hooks (never in the Netlify functions): make the next
// revocations fail, or delay report-row answers, via GET /__dev/control?...
const DEV = { failRevoke: false, delayRowsMs: 0, on: process.argv.includes('--dev-controls') };
const store = { get: (k) => baseStore.get(k), delete: (k) => baseStore.delete(k),
  set: async (k, v) => { if (DEV.failRevoke && k.startsWith('revoked/')) throw new Error('simulated storage failure'); return baseStore.set(k, v); } };
const workerFetch = (u, init) => worker.fetch(new Request(u, init), wenv);
const wcall = async (method, p, key, body) => (await worker.fetch(new Request('https://worker.local' + p, { method,
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), wenv)).json();

const XSS = '<b data-xss="1">X</b><img src=x onerror="window.__sbXss=1">';
const HOSTILE_SHOPIFY = [
  { title: XSS + 'Echeveria Hostile', vendor: 'Gift Maker Co', productType: 'Succulent', cur: { units: 900, gross: 9000, disc: 0, ret: 0, net: 9000, tax: 0, total: 9000 } },
  { title: 'Echeveria Newline\n=1+1', vendor: 'Gift Maker Co', productType: 'Succulent', cur: { units: 800, gross: 8000, disc: 0, ret: 0, net: 8000, tax: 0, total: 8000 } },
  { title: '=HYPERLINK("http://x","Haworthia Formula")', vendor: XSS + 'Vendor Co', productType: '<i data-xss="1">Type</i>', cur: { units: 700, gross: 7000, disc: 0, ret: 0, net: 7000, tax: 0, total: 7000 } }
];
if (process.argv.includes('--seed')) {
  const require = createRequire(import.meta.url);
  const { readCsv, loadBrowserGlobals, SAMPLE_FIXTURE } = await import('../tests/load.mjs');
  const SR = require(path.join(ROOT, 'shopify-report.js')), PG = require(path.join(ROOT, 'product-grouping.js'));
  const g = loadBrowserGlobals();
  const rep = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify: (r) => PG.classifyRecord(r, { detectGenus: g.detectGenus, detectNonPlantType: g.detectNonPlantType }) });
  const months = [['2026-07-01', '2026-07-31', 0.8], ['2026-08-01', '2026-08-31', 0.9], ['2026-09-01', '2026-09-30', 1]];
  const sc = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v !== 'number' ? v : k === 'units' ? Math.round(v * f) : Math.round(v * f * 100) / 100]));
  for (const [start, end, f] of months) {
    const rows = rep.records.map(r => ({ productId: r.productId || null, title: r.title, vendor: r.vendor, productType: r.ptype, cur: sc(r.cur, f), prior: null }));
    // Hostile text in every imported field: the page must show it as text,
    // never run it, and exports must keep it in one neutralised cell.
    for (const h of HOSTILE_SHOPIFY) rows.push(Object.assign({ productId: null, prior: null }, h, { cur: Object.assign({}, h.cur) }));
    const totals = rows.reduce((t, r) => { for (const k of Object.keys(r.cur)) if (typeof r.cur[k] === 'number') t[k] = Math.round(((t[k] || 0) + r.cur[k]) * 100) / 100; return t; }, {});
    const r = await wcall('POST', '/v1/ingest/product-report', K.INGEST_SECRET, { source: 'shopify', reportScope: 'total_sales_by_product', period: { start, end },
      timezone: 'America/Los_Angeles', currency: 'USD', sourceFilename: `synthetic-${start}.csv`, totals, rows });
    if (!r.ok) console.error('seed failed', start, r.error, (r.errors || []).slice(0, 3));
  }
  // Market (ShipStation Product Sales) for the same months, with hostile store names, titles and SKUs.
  const MR = require(path.join(ROOT, 'market-report.js'));
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  for (const [start, end, f] of months) {
    const lines = [['Store', 'SKU', 'Description', 'Category', 'QtySold', 'TotalSales'],
      ['Nursery Alpha (Web)', 'S2AA0001', "Echeveria 'Sample One'", '', Math.round(40 * f), (280 * f).toFixed(2)],
      ['Nursery Alpha (Web)', '=SKU1+1', XSS + 'Echeveria Hostile', '', Math.round(30 * f), (300 * f).toFixed(2)],
      [XSS + 'Store', 'S2AA0003', 'Haworthia Newline\n=1+1', '', Math.round(25 * f), (250 * f).toFixed(2)],
      ['Shop Beta (Shopify)', '@S4', 'Sedum Example [large]', '', Math.round(12 * f), (96 * f).toFixed(2)]];
    const rowsM = lines.map(l => l.map(String));
    const parsed = MR.marketParseProductSales(rowsM, { storeGroups: [] });
    if (!parsed.ok) { console.error('market seed parse', parsed.errors); continue; }
    const payload = MR.marketPayloadFromParse(parsed, { start, end }, { timeZone: 'America/Los_Angeles', currency: 'USD', client: 'devserver', collectedAt: new Date().toISOString() });
    const r = await wcall('POST', '/v1/ingest/product-report', K.INGEST_SECRET, payload);
    if (!r.ok) console.error('market seed failed', start, r.error, (r.errors || []).slice(0, 3));
  }
  await wcall('POST', '/v1/ingest/collection-failure', K.INGEST_SECRET, { source: 'shopify', errorCode: 'sign_in_needed', message: 'Shopify sign-in needed (synthetic)', period: { start: '2026-10-01', end: '2026-10-27' } });
  console.log('Seeded 3 synthetic Shopify and market months (with hostile text) and one collection failure.');
}
const sdir = arg('settings');
if (sdir) for (const k of ['restricted_items', 'market_config']) {
  const f = path.join(sdir, k + '.json');
  if (!fs.existsSync(f)) continue;
  const r = await wcall('PUT', '/v1/settings/' + k, K.SETTINGS_SECRET, { value: JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')), baseVersion: 0 });
  console.log(`setting ${k}: ${r.ok ? 'loaded' : 'refused ' + r.error}`);
}

const headers = (() => {
  const t = fs.readFileSync(path.join(ROOT, 'dist', '_headers'), 'utf8');
  const h = {}; for (const line of t.split('\n')) { const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line); if (m) h[m[1]] = m[2]; }
  delete h['Strict-Transport-Security']; return h;
})();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost:" + port}`);
    if (DEV.on && url.pathname === '/__dev/control') {
      if (url.searchParams.has('failRevoke')) DEV.failRevoke = url.searchParams.get('failRevoke') === '1';
      if (url.searchParams.has('delayRowsMs')) DEV.delayRowsMs = Math.min(60000, Number(url.searchParams.get('delayRowsMs')) || 0);
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(DEV));
    }
    if (DEV.delayRowsMs && /^\/api\/v1\/reports\/.+\/rows$/.test(url.pathname)) await new Promise(r => setTimeout(r, DEV.delayRowsMs));
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const ctx = { env, store, fetchImpl: workerFetch, ip: req.socket.remoteAddress };
      const out = url.pathname === '/api/session' ? await sessionHandler(r, ctx)
        : url.pathname.startsWith('/api/v1/') ? await apiHandler(r, ctx)
        : url.pathname === '/api/stock-tracker' ? await trackerHandler(r, ctx)
        : new Response('{"ok":false,"error":"not_found"}', { status: 404 });
      // Local http: Chromium accepts Secure cookies on localhost.
      res.writeHead(out.status, Object.fromEntries(out.headers));
      return res.end(Buffer.from(await out.arrayBuffer()));
    }
    const vend = /^\/vendor\/[A-Za-z0-9._\/-]+$/.test(url.pathname) && !url.pathname.includes('..') ? path.join(ROOT, 'dist', url.pathname) : null;
    if (vend && fs.existsSync(vend)) {
      res.writeHead(200, { 'content-type': vend.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      return res.end(fs.readFileSync(vend));
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(fs.readFileSync(path.join(ROOT, 'dist', 'index.html')));
  } catch (e) { res.writeHead(500); res.end('server_error'); }
}).listen(port, () => console.log(`Local dashboard: http://localhost:${port}/`));
