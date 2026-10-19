// collector/src/browser.mjs — the only file that drives a browser.
//
// Uses a dedicated Playwright profile (never anyone's everyday Chrome
// profile), so the Shopify session lives in
//   %LOCALAPPDATA%\sb-plant-breakdown-collector\profile[-chrome|-msedge]
// A person signs in once with `npm run login`; later runs reuse that session.
// The collector never types a password and never clicks Save on the report.
import fs from 'node:fs';
import path from 'node:path';
import { parseSummaryNumber } from './lib.mjs';

export function localPaths(cfg) {
  const base = cfg.localDir || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'sb-plant-breakdown-collector');
  const suffix = cfg.browserChannel ? '-' + cfg.browserChannel : '';
  return {
    base,
    profile: path.join(base, 'profile' + suffix),
    runs: path.join(base, 'runs'),
    quarantine: path.join(base, 'quarantine'),
    lock: path.join(base, 'collector.lock')
  };
}

export async function launch(cfg, { headed }) {
  const { chromium } = await import('playwright');
  const paths = localPaths(cfg);
  fs.mkdirSync(paths.profile, { recursive: true });
  const opts = { headless: !headed, acceptDownloads: true, viewport: { width: 1400, height: 900 } };
  if (cfg.browserChannel) opts.channel = cfg.browserChannel;
  const context = await chromium.launchPersistentContext(paths.profile, opts);
  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}

// ---- sign-in state ----
//   authenticated | login_required | two_factor_required | captcha | unknown
export async function authState(page) {
  const url = page.url();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* about:blank */ }
  const has = async (sel) => (await page.locator(sel).count().catch(() => 0)) > 0;
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (await has('iframe[src*="hcaptcha"]') || await has('iframe[src*="recaptcha"]') || /just a moment|verify you are human/i.test(text)) return 'captcha';
  if (await has('input#account_tfa_code') || /two-step|verification code|authenticator app/i.test(text)) return 'two_factor_required';
  if (host === 'accounts.shopify.com' || await has('input#account_email') || await has('input#account_password')) return 'login_required';
  if (host === 'admin.shopify.com' && (await has('nav') || /Reports|Analytics/i.test(text))) return 'authenticated';
  return 'unknown';
}

export async function settleAuthState(page, ms = 20000) {
  const end = Date.now() + ms;
  let s = 'unknown';
  while (Date.now() < end) {
    s = await authState(page);
    if (s !== 'unknown') return s;
    await page.waitForTimeout(500);
  }
  return s;
}

// Waits for a person to finish signing in in the open window.
export async function waitForPerson(page, minutes, onWaiting) {
  if (!minutes) return false;
  if (onWaiting) onWaiting();
  const end = Date.now() + minutes * 60000;
  while (Date.now() < end) {
    await page.waitForTimeout(10000);
    if (await authState(page) === 'authenticated') return true;
  }
  return false;
}

// ---- the export ----
// Opens the saved report with the period's query, reads the Summary row off
// the page, exports "All results" as CSV and returns the file text plus the
// page totals, so the file can be checked against what Shopify showed.
export async function exportReport(page, url, { timeoutMs = 120000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const summary = page.locator('[role=row]').filter({ hasText: /^\s*Summary/ }).first();
  await summary.waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500); // let the figures settle after the query runs

  const pageTotals = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('main [role=row]')];
    const sum = rows.find(r => /^\s*Summary/.test(r.innerText || ''));
    if (!sum) return null;
    const cells = [...sum.querySelectorAll('[role=cell],[role=gridcell],[role=rowheader]')].map(c => (c.innerText || '').trim());
    return { cells };
  });
  let totals = null;
  if (pageTotals && pageTotals.cells.length >= 8) {
    const base = pageTotals.cells.length - 7; // SHOW lists 7 measures: units, gross, disc, ret, net, tax, total
    totals = { units: parseSummaryNumber(pageTotals.cells[base]), net: parseSummaryNumber(pageTotals.cells[base + 4]) };
  }

  // Shopify draws these controls with its own web components. Verified on the
  // live report page: the header holds exactly one
  // <s-internal-button>Export</s-internal-button> inside <s-internal-page>, and
  // the dialog is <s-internal-modal heading="Export report"> containing the
  // format / scope radios and its own Export and Cancel buttons. "Export" also
  // appears in a menu and the table toolbar, so every target is scoped.
  // The <s-internal-button> hosts have no box of their own (display:contents);
  // the clickable element is the <button> inside each one's shadow root, which
  // is what getByRole finds. With the dialog closed exactly one is visible
  // (verified with Playwright against the report page).
  const headerExport = page.getByRole('button', { name: /^Export$/ });
  if (await headerExport.count() !== 1) throw new Error('Expected one visible Export button on the report page, found ' + await headerExport.count() + '.');
  await headerExport.click({ timeout: 30000 });
  const modal = page.locator('s-internal-modal[heading="Export report"][open]');
  await modal.waitFor({ state: 'attached', timeout: 15000 });
  await modal.getByRole('radio', { name: /Comma Separated Values/i }).check({ timeout: 10000 });
  await modal.getByRole('radio', { name: /All results from the data query/i }).check({ timeout: 10000 });
  const dlPromise = page.waitForEvent('download', { timeout: timeoutMs });
  await modal.getByRole('button', { name: /^Export$/ }).click({ timeout: 10000 });
  const dl = await dlPromise;
  const p = await dl.path();
  const text = fs.readFileSync(p, 'utf8');
  await dl.delete().catch(() => {});
  return { text, pageTotals: totals };
}
