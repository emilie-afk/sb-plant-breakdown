// tools/browser-security-check.mjs — browser checks of the session boundary,
// HTML escaping and CSV exports, against the LOCAL harness only:
//
//   node tools/devserver.mjs --seed --dev-controls --port 8890     (fake Google sign-in)
//   PW_FROM=<dir with playwright-core> [CHROME=<chromium>] [SIGNIN_EMAIL=editor@example.test] \
//     node tools/browser-security-check.mjs http://127.0.0.1:8890 [outDir]
//
// The harness seeds hostile text (HTML/script in titles, vendors, product
// types, market store names, SKUs; a title with a line break and a formula).
// This script:
//   1. signs in, uploads a hostile Amazon file by hand, opens every tab and
//      every drill-down / clickable row it finds, and fails if any injected
//      element ([data-xss]) appears or any injected script runs;
//   2. clicks every CSV download, parses each file strictly (RFC 4180) and
//      fails if a row is broken or a cell can start a formula; reopens every
//      XLSX export with SheetJS (formulas included) and fails if any cell has
//      a formula, any text cell can start one, or a numeric column was
//      written as text;
//   3. failed sign-out (server revocation fails): page locked, sensitive text
//      gone, retry offered, never "signed out"; a reload restores the still
//      valid session;
//   4. confirmed sign-out: shared data gone from memory and storage, the hand
//      upload kept, the old cookie refused;
//   5. a slow report answer arriving after sign-out does not repopulate data.
// Results: <outDir>/browser-security.json; exit 1 if any check fails.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const site = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(site)) { console.error('Local harness URL only, e.g. http://127.0.0.1:8890'); process.exit(10); }
const outDir = path.resolve(process.argv[3] || '_work/browser-security');
fs.mkdirSync(outDir, { recursive: true });
const EMAIL = process.env.SIGNIN_EMAIL || 'editor@example.test';   // an editor account of the harness's fake Google
const require = createRequire(path.join(process.env.PW_FROM || path.resolve('collector'), 'package.json'));
const { chromium } = require(process.env.PW_MODULE || 'playwright-core');

const R = { site, startedAt: new Date().toISOString(), checks: {} };
let failed = 0;
const pass = (name, ok, detail) => { R.checks[name] = { ok: !!ok, detail }; if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); };

// strict RFC 4180
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') { if (f !== '') throw new Error('quote inside an unquoted field'); q = true; continue; }
    if (c === ',') { row.push(f); f = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; continue; }
    f += c;
  }
  if (q) throw new Error('unterminated quote');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const FORMULA = /^[=+\-@\t\r]/;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?%?$/;

const exe = process.env.CHROME;
const browser = await chromium.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { channel: 'chrome' });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
const wait = (ms) => page.waitForTimeout(ms);
const injected = () => page.evaluate(() => ({ els: document.querySelectorAll('[data-xss]').length, ran: !!window.__sbXss }));
const dev = (q) => page.evaluate(async (q) => (await fetch('/__dev/control?' + q)).json(), q);

// Sign in with (the harness's fake) Google: button -> provider page -> account.
async function googleSignIn(email) {
  await page.click('#sb-login-submit');
  await page.waitForSelector(`[data-account="${email}"]`, { timeout: 15000 });
  await page.click(`[data-account="${email}"]`);
  await page.waitForLoadState('load'); await wait(1500);
}
async function signIn() {
  await page.goto(site + '/'); await wait(1500);
  if (await page.isVisible('#sb-login-form')) await googleSignIn(EMAIL);
  await page.waitForSelector('#sb-login', { state: 'hidden', timeout: 30000 });
  await page.waitForFunction(() => /Sales period/.test(document.querySelector('#sb-data-status')?.innerText || ''), null, { timeout: 30000 });
  await wait(1500);
}

try {
  await signIn();
  // first: an account that is not on the allow-list, and a cancelled sign-in
  // (fresh context, so the main session is not affected)
  {
    const c2 = await browser.newContext(); const p2 = await c2.newPage();
    await p2.goto(site + '/'); await p2.waitForTimeout(1200);
    await p2.click('#sb-login-submit'); await p2.click('[data-account="outsider@example.test"]'); await p2.waitForTimeout(1500);
    const denied = await p2.evaluate(() => ({ url: location.href, msg: document.getElementById('sb-login-msg').textContent,
      locked: document.documentElement.classList.contains('sb-locked') }));
    const cookies = (await c2.cookies()).map(c => c.name);
    pass('an account not on the allow-list is refused: message shown, no session, page locked, URL cleaned',
         /not allowed/i.test(denied.msg) && denied.locked && !cookies.includes('__Host-sbpb_session') && !/signin=/.test(denied.url), { denied, cookies });
    await p2.click('#sb-login-submit'); await p2.click('[data-account="cancel"]'); await p2.waitForTimeout(1200);
    pass('a cancelled Google sign-in says so and stays locked', /cancelled/i.test(await p2.textContent('#sb-login-msg')));
    await c2.close();
  }
  pass('signed in with Google as an editor', (await page.textContent('#sb-session-who')) === 'Editor' &&
       (await page.evaluate(() => window.SBAuth.email)) === EMAIL);
  const sc = (await ctx.cookies()).find(c => c.name === '__Host-sbpb_session');
  pass('session cookie after Google sign-in: HttpOnly, Secure, SameSite=Strict; no OAuth state cookie left',
       !!sc && sc.httpOnly && sc.secure && sc.sameSite === 'Strict' && !(await ctx.cookies()).some(c => c.name === '__Host-sbpb_oauth'));

  // ---- SheetJS: the verified local copy, nothing from a CDN ---------------
  const sj = await page.evaluate(() => ({ version: window.XLSX && XLSX.version,
    sources: performance.getEntriesByType('resource').map(e => e.name).filter(n => /xlsx/i.test(n)) }));
  pass('SheetJS 0.20.3 is loaded from the site\'s vendored copy only', sj.version === '0.20.3' &&
       sj.sources.length === 1 && /\/vendor\/sheetjs\/0\.20\.3\/xlsx\.full\.min\.js$/.test(sj.sources[0]), sj);

  // ---- hostile Amazon file, uploaded by hand ----------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbsec-'));
  const az = path.join(tmp, 'BusinessReport-2026-09-01 - 2026-09-30.csv');
  const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  fs.writeFileSync(az, [
    'ASIN,Item name,Glance Views,Unit Session Percentage,Units Ordered,Average Sales Price,Ordered Product Sales,Available Inventory',
    ['B0SUCC0001', "Echeveria 'Perle Von Nurnberg' 2 inch Live Succulent", 4210, '6.2%', 261, 8.99, 2346.39, 180].map(q).join(','),
    ['B0XSS00001', '<b data-xss="1">X</b><img src=x onerror="window.__sbXss=1">Echeveria Hostile Amazon', 900, '5%', 45, 10, 450, 0].map(q).join(','),
    ['B0XSS00002', 'Haworthia Amazon Newline\n=1+1', 800, '4%', 32, 10, 320, 5].map(q).join(','),
    ['B0XSS00003', '@SUM(1,2) Sedum Formula', 700, '3%', 21, 10, 210, 5].map(q).join(',')
  ].join('\n'));
  await page.setInputFiles('#amazon-file-input', az); await wait(2500);
  if (await page.isVisible('#az-map-ok')) { await page.click('#az-map-ok'); await wait(1500); }
  const hasAz = await page.evaluate(() => snapshots.some(s => s.source === 'amazon' && !(s.meta && (s.meta.auto || s.meta.fromShared))));
  pass('hostile Amazon file kept as a hand upload', hasAz);

  // the same kind of report as an .xlsx workbook (August), read by the vendored SheetJS
  const SJ = require(path.resolve('vendor/sheetjs/0.20.3/xlsx.full.min.js'));
  const azx = path.join(tmp, 'BusinessReport-2026-08-01 - 2026-08-31.xlsx');
  const ws = SJ.utils.aoa_to_sheet([
    ['ASIN', 'Item name', 'Glance Views', 'Unit Session Percentage', 'Units Ordered', 'Average Sales Price', 'Ordered Product Sales', 'Available Inventory'],
    ['B0SUCC0001', "Echeveria 'Perle Von Nurnberg' 2 inch Live Succulent", 4000, 0.06, 240, 8.99, 2157.6, 150],
    ['B0XSS00001', '<b data-xss="1">X</b>Echeveria Hostile Amazon XLSX', 900, 0.05, 45, 10, 450, 0],
    ['B0XSS00004', 'Formula cell below', 100, 0.01, 1, 10, 10, 1]]);
  ws.H4 = { t: 'n', v: 1, f: '1+0' };   // a real formula in the uploaded file: only its value is used
  const wbx = SJ.utils.book_new(); SJ.utils.book_append_sheet(wbx, ws, 'Detail Page Sales and Traffic');
  fs.writeFileSync(azx, SJ.write(wbx, { type: 'buffer', bookType: 'xlsx' }));
  await page.setInputFiles('#amazon-file-input', azx); await wait(2500);
  if (await page.isVisible('#az-map-ok')) { await page.click('#az-map-ok'); await wait(1500); }
  const xImp = await page.evaluate(() => { const s = snapshots.find(x => x.source === 'amazon' && x.startDate === '2026-08-01');
    return s ? { products: s.products.length, hostileTitle: s.products.some(p => /Hostile Amazon XLSX/.test(p.title)),
                 revenue: Math.round(s.products.reduce((t, p) => t + (p.rev || (p.cur && p.cur.net) || 0), 0) * 100) / 100 } : null; });
  pass('an .xlsx Amazon report imports through the vendored SheetJS (rows, text and figures intact)',
       !!xImp && xImp.products === 3 && xImp.hostileTitle && xImp.revenue === 2617.6, xImp);
  if (await page.isVisible('#data-settings-modal')) { await page.keyboard.press('Escape'); await wait(500); }
  if (await page.isVisible('#data-settings-modal')) { await page.keyboard.press('Escape'); await wait(500); }

  // ---- every tab, every drill-down / clickable row -----------------------
  const tabs = ['shopify', 'vendors', 'amazon', 'external', 'cross', 'ovm', 'oppmap'];
  const clickSel = 'tr.clickable, tr[data-genus], tr[data-drill-genus], [data-drill], [data-vendor], [data-group], [data-sb-drill], [data-az-drill]';
  const seen = {};
  for (const t of tabs) {
    await page.click(`.tab-btn[data-tab="${t}"]`); await wait(1800);
    const panel = `#tab-${t}`;
    let clicked = 0;
    const n = await page.locator(`${panel} :is(${clickSel})`).count();
    for (let i = 0; i < Math.min(n, 6); i++) {
      const loc = page.locator(`${panel} :is(${clickSel})`).nth(i);
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 3000 }).catch(() => {}); await wait(700); clicked++;
      const inj = await injected();
      if (inj.els || inj.ran) { seen[t] = inj; break; }
    }
    const shown = await page.evaluate((p) => /Hostile|Vendor Co|Store/.test(document.querySelector(p).innerText), panel);
    const inj = await injected();
    seen[t] = Object.assign({ clicked, hostileTextShown: shown }, inj);
  }
  pass('no injected element or script in any view or drill-down', Object.values(seen).every(v => !v.els && !v.ran), seen);
  pass('hostile text is shown as text in the views', Object.values(seen).filter(v => v.hostileTextShown).length >= 4, Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.hostileTextShown])));

  // ---- every CSV download ------------------------------------------------
  const csvs = [];
  for (const t of tabs) {
    await page.click(`.tab-btn[data-tab="${t}"]`); await wait(1500);
    // open a drill so drill exports exist
    const d = page.locator(`#tab-${t} :is(${clickSel})`).first();
    if (await d.isVisible().catch(() => false)) { await d.click({ timeout: 3000 }).catch(() => {}); await wait(800); }
    const btns = page.locator(`#tab-${t} button:visible`);
    const count = await btns.count();
    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      const label = ((await b.textContent().catch(() => '')) || '').trim();
      if (!/⬇|↓|download/i.test(label) && !/download/i.test((await b.getAttribute('id')) || '')) continue;
      const dl = await Promise.all([page.waitForEvent('download', { timeout: 4000 }), b.click({ timeout: 3000 })]).then(([x]) => x).catch(() => null);
      if (!dl) continue;
      const name = dl.suggestedFilename();
      const file = path.join(outDir, name);
      await dl.saveAs(file);
      if (!name.endsWith('.csv')) continue;
      const text = fs.readFileSync(file, 'utf8');
      let rows, err = null;
      try { rows = parseCsv(text); } catch (e) { err = e.message; rows = []; }
      // a file may hold several tables separated by a blank line; inside each
      // table every row has the header's width
      const blocks = []; let cur = [];
      for (const r of rows) { if (r.join('') === '') { if (cur.length) blocks.push(cur); cur = []; } else if (!/^#/.test(r[0])) cur.push(r); }
      if (cur.length) blocks.push(cur);
      const data = blocks.flat();
      const broken = blocks.reduce((n, b) => n + b.filter(r => r.length !== b[0].length).length, 0);
      const formula = data.flat().filter(c => FORMULA.test(c) && !NUMERIC.test(c.trim()));
      const hostileOneCell = data.flat().some(c => /Newline\n=1\+1/.test(c)) || !/Newline/.test(text);
      csvs.push({ tab: t, name, rows: data.length, err, broken, formula: formula.slice(0, 3), hostileOneCell });
    }
  }
  pass('CSV exports found on every data tab', new Set(csvs.map(c => c.tab)).size >= 5, csvs.map(c => c.tab + ':' + c.name));
  pass('every CSV parses strictly, rows intact, no cell can start a formula, line-break titles stay in one cell',
       csvs.length > 0 && csvs.every(c => !c.err && !c.broken && !c.formula.length && c.hostileOneCell), csvs);

  // ---- XLSX exports: reopen and inspect every cell -------------------------
  // Exports reached from buttons above, plus the workbook exports the current
  // views do not show a button for (called directly, same code path).
  for (const [fn, arg, tab] of [['downloadBreakdown', 'amazon', 'amazon'], ['downloadClean', 'amazon', 'amazon'],
                                ['downloadBreakdown', 'shopify', 'shopify'], ['downloadClean', 'shopify', 'shopify']]) {
    await page.click(`.tab-btn[data-tab="${tab}"]`); await wait(800);
    const dl = await Promise.all([page.waitForEvent('download', { timeout: 4000 }),
      page.evaluate(([f, a]) => { if (typeof window[f] === 'function') window[f](a); }, [fn, arg])]).then(([x]) => x).catch(() => null);
    if (dl) await dl.saveAs(path.join(outDir, dl.suggestedFilename()));
  }
  const xlsxFiles = fs.readdirSync(outDir).filter(f => f.endsWith('.xlsx'));
  const xl = [];
  for (const f of xlsxFiles) {
    const b64 = fs.readFileSync(path.join(outDir, f)).toString('base64');
    // reopened with the same SheetJS build the page uses, formulas included
    const r = await page.evaluate((b64) => {
      const wb = XLSX.read(b64, { type: 'base64', cellFormula: true, cellText: false });
      const out = { sheets: wb.SheetNames.length, cells: 0, formulas: [], textCells: 0, numericCells: 0, formulaText: [], numericAsText: [], hostile: 0 };
      const NUM_HEAD = /(units|rev|revenue|\$|sales|orders|views|glance|price|avg|inventory|skus|products|share|count|total)/i;
      const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws['!ref']) continue;
        const rg = XLSX.utils.decode_range(ws['!ref']);
        const head = {};
        for (let c = rg.s.c; c <= rg.e.c; c++) { const h = ws[XLSX.utils.encode_cell({ r: rg.s.r, c })]; head[c] = h ? String(h.v) : ''; }
        for (let R = rg.s.r; R <= rg.e.r; R++) for (let C = rg.s.c; C <= rg.e.c; C++) {
          const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
          if (!cell) continue;
          out.cells++;
          if (cell.f != null) out.formulas.push(name + '!' + XLSX.utils.encode_cell({ r: R, c: C }));
          if (cell.t === 's') {
            out.textCells++;
            const v = String(cell.v);
            if (/Hostile|Newline|Formula|data-xss|SKU1/.test(v)) out.hostile++;
            if (/^\s*[=+\-@]/.test(v) && !NUMERIC.test(v.trim())) out.formulaText.push(v.slice(0, 40));
            if (R > rg.s.r && NUM_HEAD.test(head[C]) && NUMERIC.test(v.trim())) out.numericAsText.push(name + '!' + head[C] + '=' + v);
          } else if (cell.t === 'n') out.numericCells++;
        }
      }
      return out;
    }, b64);
    xl.push(Object.assign({ file: f }, r));
  }
  pass('XLSX exports reopened (representative set incl. breakdown, clean data, cross-channel, market, opportunity, owned-vs-market)',
       xl.length >= 7, xl.map(x => x.file));
  pass('XLSX: no cell carries a formula; hostile text sits in text cells and cannot start a formula',
       xl.length > 0 && xl.every(x => x.formulas.length === 0 && x.formulaText.length === 0) && xl.some(x => x.hostile > 0),
       xl.map(x => ({ file: x.file, cells: x.cells, formulas: x.formulas.slice(0, 3), formulaText: x.formulaText.slice(0, 3), hostile: x.hostile })));
  pass('XLSX: genuine numbers stay numeric cells (no numeric column written as text)',
       xl.every(x => x.numericCells > 0 && x.numericAsText.length === 0),
       xl.map(x => ({ file: x.file, numeric: x.numericCells, text: x.textCells, numericAsText: x.numericAsText.slice(0, 3) })));

  // ---- failed sign-out ---------------------------------------------------
  await page.click('.tab-btn[data-tab="shopify"]'); await wait(1000);
  await dev('failRevoke=1');
  await page.click('#sb-logout'); await wait(2000);
  const f = await page.evaluate(() => ({
    state: window.SBAuth.state, locked: document.documentElement.classList.contains('sb-locked'),
    retry: getComputedStyle(document.getElementById('sb-logout-retry')).display !== 'none',
    msg: document.getElementById('sb-logout-msg').textContent,
    titlesInDom: /Echeveria|Haworthia/.test(document.querySelector('#tab-shopify').innerText),
    visibleMain: getComputedStyle(document.querySelector('#tab-shopify')).visibility,
    sharedSnaps: snapshots.filter(s => window.sbIsSharedDerived(s)).length,
    privateSettings: !!(window.SBMarketConfig || window.SBVendorMap) || (typeof restrictedListLoaded === 'function' && restrictedListLoaded())
  }));
  pass('failed sign-out is not reported as signed out; page locked, data wiped, retry offered',
       f.state === 'logout_failed' && f.locked && f.retry && /did not complete/.test(f.msg) && !f.titlesInDom && f.visibleMain === 'hidden' && !f.sharedSnaps && !f.privateSettings, f);
  const apiWhileFailed = await page.evaluate(async () => { try { await window.SBShared.api('/v1/reports'); return 'allowed'; } catch (e) { return e.message; } });
  pass('no API use while the sign-out outcome is unknown', /Signed out/.test(apiWhileFailed), apiWhileFailed);
  await page.reload(); await wait(3000);
  pass('after a failed sign-out, a reload restores the still-valid session (honest)', await page.evaluate(() => window.SBAuth.state === 'signed_in'));

  // ---- slow answer after sign-out (in-flight) ----------------------------
  await page.waitForFunction(() => /Sales period/.test(document.querySelector('#sb-data-status')?.innerText || ''), null, { timeout: 30000 });
  await dev('failRevoke=0&delayRowsMs=4000');
  await page.evaluate(() => { snapshots = snapshots.filter(s => !window.sbIsSharedDerived(s)); window.SBDataSettings.refresh(); });
  await wait(800);
  const cookieBefore = (await ctx.cookies()).find(c => c.name === '__Host-sbpb_session');
  await page.click('#sb-logout').catch(() => {});
  await wait(500);
  // the reload after a confirmed sign-out happens here; then wait past the delayed answer
  await wait(5500);
  await dev('delayRowsMs=0');
  const after = await page.evaluate(() => ({
    state: window.SBAuth.state, overlay: getComputedStyle(document.getElementById('sb-login')).display !== 'none',
    sharedSnaps: snapshots.filter(s => window.sbIsSharedDerived(s)).length,
    handUploads: snapshots.filter(s => s.source === 'amazon').length,
    storageKeys: Object.keys(localStorage), sessionKeys: Object.keys(sessionStorage),
    titlesInDom: /Echeveria|Haworthia/.test(document.body.innerText)
  }));
  pass('confirmed sign-out: signed out, overlay shown, no shared data in memory, nothing sensitive rendered', after.state === 'signed_out' && after.overlay && !after.sharedSnaps && !after.titlesInDom, after);
  pass('a slow report answer arriving after sign-out did not repopulate data', after.sharedSnaps === 0);
  pass('hand upload kept; no shared cache left in browser storage',
       after.handUploads >= 1 && !after.storageKeys.some(k => /shared-settings|overrides-shared|shared-store|tracker/.test(k)) && !after.sessionKeys.some(k => /tracker/.test(k)), after);
  const stored = await page.evaluate(() => { try { return JSON.parse(LZString.decompressFromUTF16(localStorage.getItem('sb-analyzer-snapshots-v1-lz')) || '[]').map(s => ({ src: s.source, auto: !!(s.meta && s.meta.auto), shared: !!(s.meta && s.meta.shared) })); } catch (e) { return 'unreadable'; } });
  pass('stored snapshots contain hand uploads only, without links to shared reports', Array.isArray(stored) && stored.every(s => !s.auto && !s.shared), stored);
  if (cookieBefore) await ctx.addCookies([cookieBefore]);
  pass('the old session cookie is refused after sign-out', (await page.evaluate(async () => (await fetch('/api/v1/reports')).status)) === 401);
  pass('no page errors', errors.length === 0, errors.slice(0, 5));
} catch (e) {
  pass('run completed', false, String(e && e.message || e));
} finally {
  R.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'browser-security.json'), JSON.stringify(R, null, 2));
  await browser.close();
  console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL BROWSER SECURITY CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
}
