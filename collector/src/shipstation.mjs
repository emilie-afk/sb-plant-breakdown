// collector/src/shipstation.mjs — ShipStation "Product Sales" export.
//
// Insights → Reports → Product Sales: units and item revenue by store and SKU
// for a date range. Product level only: no order numbers, no customer data.
// The collector drives the same screen a person uses, on the collector's own
// browser profile; a person signs in to ShipStation once in a normal window
// (the collector never types credentials). Nothing in ShipStation is changed:
// no orders are touched, no export format is created or edited.
import fs from 'node:fs';

const mdY = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; };
// The calendar day of an ISO instant in a timezone (ShipStation sends the
// chosen days as midnight in the account's timezone).
export function dayIn(iso, tz = 'America/Los_Angeles') {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

export function reportUrl(cfg) {
  const base = (cfg.shipstation && cfg.shipstation.baseUrl) || 'https://ship.shipstation.com';
  const u = new URL(base);
  if (!/(^|\.)shipstation\.com$/.test(u.hostname)) throw new Error('shipstation.baseUrl must be on shipstation.com');
  return u.origin + '/dashboard/reports/ProductSales';
}

// ---- "the automated window did not work" --------------------------------
// When the automated ShipStation window is not signed in (a sign-in page, a
// human check, an unexpected page), it is closed and NOT opened again by later
// runs: ShipStation's sign-in page refuses automated browsers, so reopening it
// only puts an unusable window in front of a person. Market collection waits,
// the dashboard shows "ShipStation sign-in needed", and the block is lifted
// when a person signs in through the normal window:
//   npm run login:shipstation      (or: node src/login.mjs --config config.local.json --shipstation)
// or for a one-off retry: node src/collect.mjs --config config.local.json --retry-shipstation
export const SIGNIN_BLOCK_FILE = 'shipstation-signin.json';
export function readSignInBlock(baseDir) {
  try {
    const j = JSON.parse(fs.readFileSync(baseDir + '/' + SIGNIN_BLOCK_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return j && j.blocked ? j : null;
  } catch { return null; }
}
export function writeSignInBlock(baseDir, reason, now = new Date()) {
  const prev = readSignInBlock(baseDir);
  const rec = { blocked: true, since: prev ? prev.since : now.toISOString(), lastSeen: now.toISOString(), reason: String(reason || '').slice(0, 200) };
  fs.writeFileSync(baseDir + '/' + SIGNIN_BLOCK_FILE, JSON.stringify(rec, null, 2));
  return rec;
}
export function clearSignInBlock(baseDir) {
  try { fs.rmSync(baseDir + '/' + SIGNIN_BLOCK_FILE, { force: true }); } catch { /* nothing to clear */ }
}

//   authenticated | login_required | captcha | unknown
export async function authState(page) {
  let url;
  try { url = new URL(page.url()); } catch { return 'unknown'; }
  const has = async (sel) => (await page.locator(sel).count().catch(() => 0)) > 0;
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (await has('iframe[src*="hcaptcha"]') || await has('iframe[src*="recaptcha"]') || /verify you are human|just a moment/i.test(text)) return 'captcha';
  if (/login|signin|sign-in|auth\./i.test(url.hostname + url.pathname) || await has('input[type=password]')) return 'login_required';
  if (/(^|\.)shipstation\.com$/.test(url.hostname) && /\/dashboard\/reports\/ProductSales/i.test(url.pathname) && /Product Sales/.test(text)) return 'authenticated';
  return 'unknown';
}
export async function settleAuthState(page, ms = 30000) {
  const end = Date.now() + ms; let s = 'unknown';
  while (Date.now() < end) { s = await authState(page); if (s !== 'unknown') return s; await page.waitForTimeout(700); }
  return s;
}

// Runs the report for one period and exports it as CSV. Returns
// { text, shownRange } once ShipStation's own request has been checked to ask
// for exactly the period's dates.
export async function exportProductSales(page, cfg, period, { timeoutMs = 120000 } = {}) {
  await page.goto(reportUrl(cfg), { waitUntil: 'domcontentloaded' });
  if (await settleAuthState(page) !== 'authenticated') throw Object.assign(new Error('ShipStation is not signed in.'), { code: 'sign_in' });

  // Date Range → Custom Range → two date fields → Apply
  // Buttons are named by their text (verified on the live page): the date
  // button shows the current range, the store button "All Stores".
  const dateBtn = page.getByRole('button', { name: /^\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}$/ });
  if (await dateBtn.count() !== 1) throw new Error('Expected one date-range button, found ' + await dateBtn.count() + '.');
  await dateBtn.click({ timeout: 20000 });
  await page.getByText('Custom Range', { exact: true }).click({ timeout: 10000 });
  const dates = page.getByPlaceholder('Select a Date');
  if (await dates.count() !== 2) throw new Error('Expected two custom-range date fields, found ' + await dates.count() + '.');
  await dates.nth(0).fill(mdY(period.start));
  await dates.nth(1).fill(mdY(period.end));
  await page.getByRole('button', { name: /^Apply$/ }).click({ timeout: 10000 });

  // All stores, products by SKU (the defaults); checked rather than assumed.
  if (await page.getByRole('button', { name: 'All Stores', exact: true }).count() !== 1) throw new Error('The Store filter is not "All Stores".');
  if (await page.getByRole('button', { name: 'Product Record SKU', exact: true }).count() !== 1) throw new Error('"Show Products By" is not "Product Record SKU".');

  // The report is drawn in a separate frame, so the dates are checked on the
  // request ShipStation itself sends: {startDate, endDate} are the chosen
  // calendar days (inclusive) at midnight in the account's timezone.
  const isGen = (r) => /\/api\/report\/generate/.test(r.url()) && r.method() === 'POST';
  const checkDates = (req) => {
    let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch { /* not JSON */ }
    const got = { start: dayIn(b.startDate, cfg.timeZone), end: dayIn(b.endDate, cfg.timeZone) };
    if (b.reportType !== 'ProductSales' || got.start !== period.start || got.end !== period.end) {
      throw new Error(`ShipStation was asked for ${b.reportType || '?'} ${got.start}..${got.end}, not ${period.start}..${period.end}.`);
    }
    return b;
  };
  const runReq = page.waitForRequest(isGen, { timeout: 30000 });
  await page.getByRole('button', { name: /^Run Report$/ }).click({ timeout: 10000 });
  checkDates(await runReq);
  await page.waitForTimeout(3000);

  await page.getByRole('button', { name: /^Export to/ }).click({ timeout: 10000 });
  const dlPromise = page.waitForEvent('download', { timeout: timeoutMs });
  const csvReq = page.waitForRequest(isGen, { timeout: 30000 }).catch(() => null);
  await page.getByRole('button', { name: /^CSV$/ }).click({ timeout: 10000 });
  const r2 = await csvReq;
  if (r2) checkDates(r2);
  const dl = await dlPromise;
  const p = await dl.path();
  const text = fs.readFileSync(p, 'utf8');
  await dl.delete().catch(() => {});
  const want = `${period.start}..${period.end}`;
  return { text, shownRange: want };
}
