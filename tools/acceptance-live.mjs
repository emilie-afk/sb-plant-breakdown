// Live acceptance of the deployed dashboard (run by hand on a PC with Chrome).
//
//   node tools/acceptance-live.mjs https://<site>.netlify.app [outDir]
//
// Opens the site in a FRESH Chrome profile (no saved data, no key), in a
// visible window. A PERSON types the site password into the real StatiCrypt
// screen; this script never handles that password or any Worker key. Then it
// checks, without uploading anything:
//   - the latest saved Shopify report loads by itself; no file input is shown
//   - report history lists revisions; a CSV download matches the stored row count
//   - quarter and year views: combined totals equal the sum of the monthly
//     reports used, and missing months are named
//   - after a reload, the sales period, collection timestamps and any
//     collection failure are still shown
// Results go to <outDir>/acceptance.json plus screenshots. Needs Playwright
// (the collector's node_modules has it): set PW_FROM to collector/package.json.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const site = (process.argv[2] || '').replace(/\/+$/, '');
const outDir = path.resolve(process.argv[3] || '_work/acceptance');
// http://127.0.0.1 is accepted only for testing this script against a local build.
const localTest = /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(site);
if (!/^https:\/\//.test(site) && !localTest) { console.error('Usage: node tools/acceptance-live.mjs https://<site> [outDir]'); process.exit(10); }
fs.mkdirSync(outDir, { recursive: true });
const require = createRequire(process.env.PW_FROM || path.resolve('collector/package.json'));
const { chromium } = require(process.env.PW_MODULE || 'playwright');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acceptance-'));
const launch = localTest && process.env.CHROME
  ? { executablePath: process.env.CHROME, headless: true, args: ['--no-sandbox'] }
  : { channel: 'chrome', headless: false };
const ctx = await chromium.launchPersistentContext(profile, Object.assign(launch, { acceptDownloads: true, viewport: { width: 1400, height: 950 } }));
const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const R = { site, startedAt: new Date().toISOString(), checks: {} };
const pass = (name, ok, detail) => { R.checks[name] = { ok: !!ok, detail }; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); };
const text = async (sel) => (await page.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
const shot = (n) => page.screenshot({ path: path.join(outDir, n + '.png') });

async function waitUnlocked(label) {
  console.log(`[${label}] If the site password screen is showing, type the password in the Chrome window (up to 10 minutes)...`);
  // Local test build only: its throwaway test password comes from the test harness.
  if (localTest && process.env.LOCAL_TEST_SITEPW && await page.locator('input[type=password]').count()) {
    await page.fill('input[type=password]', process.env.LOCAL_TEST_SITEPW); await page.keyboard.press('Enter');
  }
  await page.waitForSelector('#sb-data-status', { timeout: 600000 });
  await page.waitForFunction(() => /Sales period|No saved Shopify report|not connected/.test(document.querySelector('#sb-data-status')?.innerText || ''), null, { timeout: 60000 });
  await page.waitForTimeout(2000);
}

try {
  await page.goto(site + (localTest ? '/dist/index.html' : '/'));
  const pw = await page.locator('input[type=password]').count();
  const appBefore = await page.evaluate(() => typeof window.periodPlan === 'function');
  pass('site password screen shown first; app code not readable before unlocking', pw > 0 && !appBefore, { passwordFields: pw });
  await waitUnlocked('first visit');

  const ls = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('sb-shared-store-v1') || 'null'); } catch (e) { return 'error'; } });
  const status1 = await text('#sb-data-status');
  pass('connected without entering a Worker key', ls === null && !/not connected/i.test(status1), { savedKeyInBrowser: ls !== null });
  pass('latest saved report loads without a file upload', /Sales period:/.test(status1) && (await page.locator('input[type=file]:visible').count()) === 0,
       { status: status1.slice(0, 260) });
  pass('no Data & imports tab in the navigation', (await page.locator('[data-tab="data"]').count()) === 0);
  pass('sales period, revision, collection time and import time are shown separately',
       /Sales period:/.test(status1) && /Revision \d+/.test(status1) && /collected \d/.test(status1) && /imported \d/.test(status1) && /Last updated/.test(status1),
       { status: status1.slice(0, 400) });
  pass('a running or incomplete period is labelled partial', !/month to date/.test(status1) || /partial/.test(status1));
  if (!/Sales period:/.test(status1)) throw new Error('No saved report is on screen (is the built-in read-only connection in this deploy?); the remaining checks need one.');
  // All product types: the default scope covers every product type in the report.
  const types = await page.evaluate(() => {
    const snap = snapshots.find(s => s.id === state.shopify.snapshotId);
    const inReport = new Set(snap.products.map(p => p.ptype));
    const opts = [...document.querySelectorAll('#sb-ptype option')].map(o => o.value).filter(v => v !== 'All');
    return { selected: document.querySelector('#sb-ptype').value, inReport: inReport.size, inFilter: opts.length,
             groupScope: document.querySelector('#sb-plantscope').value };
  });
  pass('Shopify analysis covers all product types by default', types.selected === 'All' && types.groupScope === 'all' && types.inFilter >= types.inReport - 1, types);
  await page.click('[data-tab="vendors"]'); await page.waitForTimeout(2500);
  const vend = await page.evaluate(() => ({ ptype: document.querySelector('#vn-ptype').value, scope: document.querySelector('#vn-plantscope').value,
                                           cards: (document.querySelector('#vn-cards')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200) }));
  pass('vendor analytics covers all product types by default', vend.ptype === 'All' && vend.scope === 'all' && /VENDORS/i.test(vend.cards), vend);
  await shot('1b-vendors');
  await page.click('[data-tab="shopify"]'); await page.waitForTimeout(1500);
  await shot('1-opened');

  // Quarter and year: combined totals equal the sum of the monthly reports used.
  const checkCombined = async (label) => page.evaluate((label) => {
    const snap = snapshots.find(s => s.id === state.shopify.snapshotId);
    const reps = window.SBAutoLoad.reports || [];
    const used = snap.meta.period ? snap.meta.period.revisionsUsed : [];
    const sumReports = used.reduce((a, u) => a + (reps.find(r => r.id === u.reportId)?.totals.net || 0), 0);
    const sumRecords = snap.products.filter(p => !p.onlyInComparison).reduce((a, p) => a + p.cur.net, 0);
    return { label: snap.meta.period ? snap.meta.period.label : snap.label, months: used.map(u => u.month + ' r' + u.revision),
             missing: snap.meta.period ? snap.meta.period.missing : [], sumReports: Math.round(sumReports * 100) / 100,
             sumRecords: Math.round(sumRecords * 100) / 100, distinctProducts: snap.meta.distinctProducts };
  }, label);
  for (const kind of ['quarter', 'year']) {
    await page.selectOption('[data-pv-kind="shopify"]', kind);
    await page.waitForTimeout(6000);
    const options = await page.locator('[data-pv-which="shopify"] option').allInnerTexts();
    for (const opt of options.slice(0, kind === 'quarter' ? 3 : 2)) {
      const val = await page.locator('[data-pv-which="shopify"] option', { hasText: opt }).first().getAttribute('value');
      const disabled = await page.locator('[data-pv-which="shopify"] option', { hasText: opt }).first().getAttribute('disabled');
      if (disabled !== null) { pass(`${kind} ${opt}: no report, not selectable`, true); continue; }
      await page.selectOption('[data-pv-which="shopify"]', val);
      await page.waitForTimeout(6000);
      const c = await checkCombined(opt);
      const labelsMissing = c.missing.length === 0 || c.missing.every(m => c.label.includes(new Date(m + '-15').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })));
      pass(`${kind} ${opt}: totals = sum of monthly reports; missing months named`, Math.abs(c.sumReports - c.sumRecords) < 0.02 && labelsMissing, c);
    }
    await shot('2-' + kind);
  }

  // Data settings, report history, CSV download.
  await page.click('#data-settings-btn');
  await page.waitForSelector('#ds-history-panel tbody tr', { timeout: 30000 });
  const sources = await text('#ds-sources');
  const advOpen = await page.evaluate(() => document.getElementById('ds-advanced').open);
  const conn = await page.evaluate(() => (document.getElementById('ds-connection')?.textContent || '').replace(/\s+/g, ' '));
  pass('Data settings opens: Shopify connected, technical details folded away, built-in read-only connection',
       await page.locator('#data-settings-modal').isVisible() && /Shopify connected · Updates automatically/.test(sources) && !advOpen &&
       /read-only connection built into/.test(conn), { sources: sources.slice(0, 200), advancedOpen: advOpen });
  const rows = await page.locator('#ds-history-panel tbody tr').count();
  pass('report history lists stored revisions', rows > 0, { revisions: rows, superseded: (await text('#ds-history-panel')).includes('superseded') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#ds-history-panel [data-hist-dl]').first().click()]);
  const file = path.join(outDir, dl.suggestedFilename());
  await dl.saveAs(file);
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const hdr = lines.findIndex(l => l.startsWith('product_id,'));
  const dataRows = hdr >= 0 ? lines.length - hdr - 1 : -1;
  const expect = await page.evaluate(() => { const h = (window.SBDataImports.history || []).filter(r => r.source === 'shopify'); return h.length ? h[0].row_count : null; });
  pass('CSV download of a revision matches the stored row count', dataRows === expect, { file: dl.suggestedFilename(), dataRows, storedRows: expect,
       meta: lines.slice(0, 7) });
  await shot('3-history');
  // Open the oldest stored revision on its own, for inspection.
  const openBtns = page.locator('#ds-history-panel [data-hist-open]');
  await openBtns.nth((await openBtns.count()) - 1).click();
  await page.waitForTimeout(5000);
  const opened = await text('#sb-data-status');
  pass('a historical report opens from the history', /Sales period:/.test(opened), { status: opened.slice(0, 220) });
  await shot('3b-opened-history');

  // Reload: period, timestamps and any failure survive.
  await page.selectOption('[data-pv-kind="shopify"]', 'month'); await page.waitForTimeout(4000);
  const before = await text('#sb-data-status');
  await page.reload();
  await waitUnlocked('after reload');
  const after = await text('#sb-data-status');
  const strip = (s) => s.replace(/checked [^·⛔⚠]*/, '').replace(/Refresh.*$/, '').trim();
  pass('after a reload the sales period, timestamps and failures are unchanged', strip(before) === strip(after),
       { before: strip(before).slice(0, 300), after: strip(after).slice(0, 300), failureShown: /collection failed/.test(after) });
  await shot('4-after-reload');
} catch (e) {
  pass('acceptance run completed', false, String(e && e.message || e).split('\n')[0]);
} finally {
  R.errors = errors;
  R.finishedAt = new Date().toISOString();
  R.allPassed = Object.values(R.checks).every(c => c.ok);
  fs.writeFileSync(path.join(outDir, 'acceptance.json'), JSON.stringify(R, null, 2));
  console.log(R.allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED', '→', path.join(outDir, 'acceptance.json'));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = R.allPassed ? 0 : 1;
}
