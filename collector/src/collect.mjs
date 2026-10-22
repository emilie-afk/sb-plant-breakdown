// collector/src/collect.mjs — one collection run.
//
//   node src/collect.mjs --config config.local.json            periods from config (scheduled use)
//   node src/collect.mjs --period previous-month               one kind of period
//   node src/collect.mjs --start 2026-09-01 --end 2026-09-30   a custom period
//   --dry-run         download and validate, do not upload
//   --from-file X     skip the browser and use an export already on disk
//                     (needs one period; used for retries from quarantine)
//   --headless        run without a window (Shopify may then show a human check)
//   --no-backfill     skip historical months this run
//   --only shopify|market   collect one source only (default: both, when
//                     config.shipstation is set)
//   --retry-shipstation  try the automated ShipStation window once more even
//                     though an earlier run found it signed out (see below)
//
// MARKET: with config.shipstation, the same periods are also collected from
// ShipStation's Insights → Product Sales report (units and item revenue by
// store and SKU; Succulents Box's own stores dropped; no customer data) and
// stored as source "market", so market comparisons always match the period.
//
// A scheduled run collects month-to-date, re-collects recently closed months
// on the configured days (periods.closedMonths), and fills up to
// periods.backfill.maxPerRun missing historical months (periods.backfill),
// newest first. Failures are reported to the Worker so the dashboard shows them.
//
// Exit code: 0 ok, otherwise the first failure (see EXIT in lib.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT, validateConfig, periodsForToday, planPeriods, customPeriod, reportUrl, validateExport, runId as makeRunId,
         backfillPlan, failureCodeFor, validateMarketExport } from './lib.mjs';
import { scrub, safeError, containsSecret } from './redact.mjs';
import { uploadReport, reportFailure, fetchCoverage } from './upload.mjs';

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; }
const flag = name => process.argv.includes('--' + name);
const log = (...a) => console.log(scrub(a.join(' ')));

export async function main() {
  const cfgPath = arg('config') || 'config.local.json';
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { console.error('Cannot read config ' + cfgPath + ': ' + safeError(e)); return EXIT.CONFIG; }
  const cfgErrs = validateConfig(cfg);
  if (cfgErrs.length) { console.error(cfgErrs.join('\n')); return EXIT.CONFIG; }

  let periods;
  const scheduled = !(arg('start') || arg('end') || arg('period') || arg('from-file'));
  try {
    if (arg('start') || arg('end')) periods = [customPeriod(arg('start'), arg('end'))];
    else if (arg('period')) periods = planPeriods(arg('period').split(','), new Date(), cfg.timeZone);
    else periods = periodsForToday(cfg, new Date());
  } catch (e) { console.error(safeError(e)); return EXIT.CONFIG; }
  const only = arg('only');
  if (only && !['shopify', 'market'].includes(only)) { console.error('--only must be shopify or market.'); return EXIT.CONFIG; }
  const wantMarket = only !== 'shopify' && !!(cfg.shipstation && cfg.shipstation.enabled !== false);
  if (only === 'market' && !wantMarket) { console.error('--only market needs a "shipstation" section in the config.'); return EXIT.CONFIG; }
  const wantBackfill = scheduled && !flag('no-backfill') && !flag('dry-run') && cfg.periods && cfg.periods.backfill;
  if (!periods.length && !wantBackfill) { log('Nothing to collect today.'); return EXIT.OK; }
  const fromFile = arg('from-file');
  if (fromFile && periods.length !== 1) { console.error('--from-file needs exactly one period.'); return EXIT.CONFIG; }
  const dryRun = flag('dry-run');
  if (!dryRun && !cfg.workerUrl) { console.error('workerUrl is not set; use --dry-run or set it.'); return EXIT.CONFIG; }

  const { localPaths } = await import('./browser.mjs');
  const paths = localPaths(cfg);
  for (const d of [paths.base, paths.runs, paths.quarantine]) fs.mkdirSync(d, { recursive: true });
  purgeOld(paths.quarantine, 14);

  // one run at a time
  if (fs.existsSync(paths.lock)) {
    const age = Date.now() - fs.statSync(paths.lock).mtimeMs;
    if (age < 3 * 3600000) { log('Another collector run is in progress.'); return EXIT.LOCKED; }
  }
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));

  let secret = null;
  let browser = null;
  let worst = EXIT.OK;
  try {
    if (!dryRun) {
      const { ingestSecret } = await import('./credentials.mjs');
      try { secret = ingestSecret(cfg); }
      catch (e) { console.error(safeError(e)); return EXIT.CONFIG; }
    }
    // Historical months missing from shared storage, where Shopify has data.
    const statePath = path.join(paths.base, 'backfill-state.json');
    let bstate = {};
    try { bstate = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { bstate = {}; }
    if (wantBackfill) {
      try {
        const cov = await fetchCoverage({ workerUrl: cfg.workerUrl, secret });
        const extra = backfillPlan(cov, {
          earliest: cfg.periods.backfill.earliest, maxPerRun: cfg.periods.backfill.maxPerRun ?? 2,
          tz: cfg.timeZone, noDataBefore: bstate.noDataBefore || null, skip: periods.map(p => p.start.slice(0, 7))
        });
        if (extra.length) log('Backfill: ' + extra.map(p => p.start.slice(0, 7)).join(', '));
        periods = periods.concat(extra);
      } catch (e) { log('Backfill skipped: ' + safeError(e)); }
    }
    if (!periods.length) { log('Nothing to collect today.'); return EXIT.OK; }
    const basePeriods = periods.filter(p => p.kind !== 'backfill');
    let backfillStopped = false;
    for (const period of (only === 'market' ? [] : periods)) {
      if (period.kind === 'backfill' && backfillStopped) continue;
      const rid = makeRunId();
      const rec = { runId: rid, kind: 'shopify_total_sales_by_product', period: { start: period.start, end: period.end, kind: period.kind },
                    comparison: period.comparison, startedAt: new Date().toISOString(), dryRun, status: 'started' };
      let code = EXIT.OK;
      try {
        let text, pageTotals = null;
        if (fromFile) {
          text = fs.readFileSync(fromFile, 'utf8');
          rec.download = { via: 'file', bytes: Buffer.byteLength(text) };
        } else {
          browser = browser || await openBrowser(cfg).catch(profileBusy);
          if (browser.code) { code = browser.code; rec.status = browser.status; throw Object.assign(new Error(browser.status), { quiet: true }); }
          const out = await (await import('./browser.mjs')).exportReport(browser.page, reportUrl(cfg, period));
          text = out.text; pageTotals = out.pageTotals;
          rec.download = { via: 'browser', bytes: Buffer.byteLength(text) };
          rec.pageTotals = pageTotals;
        }
        const v = validateExport(text, period, { pageTotals, timeZone: cfg.timeZone, currency: cfg.currency, client: os.hostname(),
                                                 collectedAt: new Date().toISOString() });
        if (!v.ok && period.kind === 'backfill' && v.problems.some(x => /no data rows/i.test(x))) {
          // Shopify has nothing this far back: stop going earlier, now and on later runs.
          rec.status = 'no_history';
          const k = period.start.slice(0, 7); let [yy, mm] = k.split('-').map(Number); mm++; if (mm > 12) { mm = 1; yy++; }
          bstate.noDataBefore = `${yy}-${String(mm).padStart(2, '0')}`;
          fs.writeFileSync(statePath, JSON.stringify(bstate));
          backfillStopped = true;
          log(`${period.start}..${period.end}: Shopify returned no data; history starts after this month. Backfill stops here.`);
        } else if (!v.ok) {
          code = EXIT.VALIDATION_FAILED; rec.status = 'validation_failed'; rec.problems = v.problems;
          log(`${period.start}..${period.end}: refused before upload: ${v.problems.join(' ')}`);
        } else {
          rec.facts = v.facts;
          log(`${period.start}..${period.end}: ${v.facts.rows} rows, ${v.facts.products} products, ${v.facts.units} units, net ${v.facts.net.toFixed(2)} ` +
              `(own store ${v.facts.ownNet.toFixed(2)}, Amazon via Sellbrite ${v.facts.amazonNet.toFixed(2)})`);
          if (dryRun) { rec.status = 'validated_dry_run'; }
          else {
            const up = await uploadReport(v.payload, { workerUrl: cfg.workerUrl, secret });
            rec.ingest = up;
            if (up.ok) {
              rec.status = up.outcome; // succeeded | unchanged
              log(`  uploaded: ${up.outcome}${up.revision ? ' (revision ' + up.revision + ')' : ''}` +
                  (up.overlaps.length ? `, overlaps ${up.overlaps.length} other report(s) — kept separate, never summed` : ''));
            } else {
              code = EXIT.UPLOAD_FAILED; rec.status = 'upload_failed';
              const q = path.join(paths.quarantine, `total_sales_by_product_${period.start}_${period.end}_${rid}.csv`);
              fs.writeFileSync(q, text); rec.quarantine = path.basename(q);
              log(`  upload failed (HTTP ${up.httpStatus}): ${(up.errors || []).map(e => e.message).join(' ') || up.error}. ` +
                  `The export is kept in quarantine for a retry with --from-file.`);
            }
          }
        }
      } catch (e) {
        if (code === EXIT.OK) { code = EXIT.EXPORT_FAILED; rec.status = 'export_failed'; }
        if (!e.quiet) rec.error = safeError(e);
        log(`${period.start}..${period.end}: ${rec.status}${rec.error ? ' — ' + rec.error : ''}`);
      }
      rec.exitCode = code; rec.finishedAt = new Date().toISOString();
      // Tell the dashboard (via the Worker) when a run could not store anything.
      if (code !== EXIT.OK && !dryRun && secret && failureCodeFor(code) && code !== EXIT.UPLOAD_FAILED) {
        const msg = scrub([rec.status, (rec.problems || []).join(' '), rec.error || ''].filter(Boolean).join(': '));
        rec.failureReported = await reportFailure({ period: { start: period.start, end: period.end }, errorCode: failureCodeFor(code),
                                                    message: msg, client: os.hostname() }, { workerUrl: cfg.workerUrl, secret });
      }
      writeRunRecord(paths.runs, rec);
      if (code !== EXIT.OK && worst === EXIT.OK) worst = code;
      if (browser && browser.code) break; // sign-in problems affect every period
    }

    // ---- market data: ShipStation Product Sales for the same periods ----
    if (wantMarket) {
      const MR_SCOPE = 'shipstation_product_sales';
      let mPeriods = basePeriods.slice();
      if (wantBackfill && !fromFile) {
        try {
          const cov = await fetchCoverage({ workerUrl: cfg.workerUrl, secret, source: 'market', scope: MR_SCOPE });
          const bf = cfg.shipstation.backfill || cfg.periods.backfill || {};
          const extra = backfillPlan(cov, { earliest: bf.earliest, maxPerRun: bf.maxPerRun ?? 2, tz: cfg.timeZone,
            noDataBefore: bstate.marketNoDataBefore || null, skip: mPeriods.map(p => p.start.slice(0, 7)) });
          if (extra.length) log('Market backfill: ' + extra.map(p => p.start.slice(0, 7)).join(', '));
          mPeriods = mPeriods.concat(extra);
        } catch (e) { log('Market backfill skipped: ' + safeError(e)); }
      }
      let ss = null;
      // An earlier run found the automated ShipStation window signed out: do
      // not open it again until a person has signed in through the normal
      // window (npm run login:shipstation) or asks for a retry.
      const SSmod = await import('./shipstation.mjs');
      const block = fromFile || flag('retry-shipstation') ? null : SSmod.readSignInBlock(paths.base);
      if (flag('retry-shipstation')) SSmod.clearSignInBlock(paths.base);
      if (block) {
        ss = { code: EXIT.SIGN_IN_NEEDED,
               status: 'ShipStation sign-in needed since ' + block.since.slice(0, 10) +
                       ' (automated window not reopened; run npm run login:shipstation)' };
        log('Market data skipped: ' + ss.status + '.');
      }
      for (const period of mPeriods) {
        const rid = makeRunId();
        const rec = { runId: rid, kind: 'shipstation_product_sales', period: { start: period.start, end: period.end, kind: period.kind },
                      startedAt: new Date().toISOString(), dryRun, status: 'started' };
        let code = EXIT.OK;
        try {
          let text;
          if (fromFile) { text = fs.readFileSync(fromFile, 'utf8'); rec.download = { via: 'file', bytes: Buffer.byteLength(text) }; }
          else {
            ss = ss || await openShipStation(cfg, browser).catch(profileBusy);
            if (ss.code) { code = ss.code; rec.status = ss.status; throw Object.assign(new Error(ss.status), { quiet: true }); }
            const out = await (await import('./shipstation.mjs')).exportProductSales(ss.page, cfg, period);
            text = out.text; rec.download = { via: 'browser', bytes: Buffer.byteLength(text), shownRange: out.shownRange };
          }
          const v = validateMarketExport(text, period, { timeZone: cfg.timeZone, currency: cfg.currency, client: os.hostname(),
                                                         collectedAt: new Date().toISOString() });
          if (!v.ok && v.empty) {
            rec.status = 'no_market_sales';
            log(`market ${period.start}..${period.end}: no market sales in ShipStation for this period.`);
            if (period.kind === 'backfill') { bstate.marketNoDataBefore = period.start.slice(0, 7); fs.writeFileSync(statePath, JSON.stringify(bstate)); }
          } else if (!v.ok) {
            code = EXIT.VALIDATION_FAILED; rec.status = 'validation_failed'; rec.problems = v.problems;
            log(`market ${period.start}..${period.end}: refused before upload: ${v.problems.join(' ')}`);
          } else {
            rec.facts = v.facts;
            log(`market ${period.start}..${period.end}: ${v.facts.rows} rows, ${v.facts.marketUnits} units, item revenue ${v.facts.marketNet.toFixed(2)} ` +
                `from ${v.facts.stores.length} market stores (Succulents Box stores left out)`);
            if (dryRun) rec.status = 'validated_dry_run';
            else {
              const up = await uploadReport(v.payload, { workerUrl: cfg.workerUrl, secret });
              rec.ingest = up;
              if (up.ok) { rec.status = up.outcome; log(`  uploaded: ${up.outcome}${up.revision ? ' (revision ' + up.revision + ')' : ''}`); }
              else {
                code = EXIT.UPLOAD_FAILED; rec.status = 'upload_failed';
                const q = path.join(paths.quarantine, `shipstation_product_sales_${period.start}_${period.end}_${rid}.csv`);
                fs.writeFileSync(q, text); rec.quarantine = path.basename(q);
                log(`  upload failed (HTTP ${up.httpStatus}): ${(up.errors || []).map(e => e.message).join(' ') || up.error}.`);
              }
            }
          }
        } catch (e) {
          if (code === EXIT.OK) { code = EXIT.EXPORT_FAILED; rec.status = 'export_failed'; }
          if (!e.quiet) rec.error = safeError(e);
          log(`market ${period.start}..${period.end}: ${rec.status}${rec.error ? ' — ' + rec.error : ''}`);
        }
        rec.exitCode = code; rec.finishedAt = new Date().toISOString();
        if (code !== EXIT.OK && !dryRun && secret && failureCodeFor(code) && code !== EXIT.UPLOAD_FAILED) {
          const msg = scrub([rec.status, (rec.problems || []).join(' '), rec.error || ''].filter(Boolean).join(': '));
          rec.failureReported = await reportFailure({ source: 'market', reportScope: MR_SCOPE, period: { start: period.start, end: period.end },
            errorCode: failureCodeFor(code), message: msg, client: os.hostname() }, { workerUrl: cfg.workerUrl, secret });
        }
        writeRunRecord(paths.runs, rec);
        if (code !== EXIT.OK && worst === EXIT.OK) worst = code;
        if (ss && ss.code) break;
      }
      if (ss && ss.context && (!browser || ss.context !== browser.context)) await ss.context.close().catch(() => {});
    }
  } finally {
    if (browser && browser.context) await browser.context.close().catch(() => {});
    fs.rmSync(paths.lock, { force: true });
  }
  log(`done (exit ${worst})`);
  return worst;
}

// A page on the ShipStation Product Sales report, signed in. Reuses the
// Shopify browser when it is open (same collector profile).
async function openShipStation(cfg, shopifyBrowser) {
  const B = await import('./browser.mjs');
  const S = await import('./signin.mjs');
  const SS = await import('./shipstation.mjs');
  const headed = !flag('headless');
  let context = shopifyBrowser && shopifyBrowser.context && !shopifyBrowser.code ? shopifyBrowser.context : null;
  if (!context) { S.keepSessionsAcrossRestarts(cfg); ({ context } = await B.launch(cfg, { headed, log })); }
  let page = await context.newPage();
  await page.goto(SS.reportUrl(cfg), { waitUntil: 'domcontentloaded' });
  let s = await SS.settleAuthState(page);
  const base = (await import('./browser.mjs')).localPaths(cfg).base;
  // Did not work: close the automated window now and remember it, so no later
  // run opens it again before a person has signed in (readSignInBlock).
  const failed = async (code, status) => {
    SS.writeSignInBlock(base, status);
    if (!(shopifyBrowser && shopifyBrowser.context === context)) await context.close().catch(() => {});
    else { await page.close().catch(() => {}); }
    return { code, status };
  };
  if (s === 'authenticated') { SS.clearSignInBlock(base); return { context, page }; }
  if (s === 'unknown') return failed(EXIT.UNKNOWN_PAGE, 'unknown_page (ShipStation)');
  const wait = headed ? (cfg.signInWaitMinutes ?? 30) : 0;
  if (shopifyBrowser && shopifyBrowser.context === context) shopifyBrowser.code = shopifyBrowser.code || null;
  await context.close().catch(() => {});
  if (shopifyBrowser && shopifyBrowser.context === context) shopifyBrowser.context = null;
  const status0 = 'ShipStation ' + s;
  if (!wait) { SS.writeSignInBlock(base, status0); return { code: s === 'captcha' ? EXIT.CAPTCHA : EXIT.SIGN_IN_NEEDED, status: status0 }; }
  const closed = await S.signInWithNormalWindow(cfg, wait, log, { url: SS.reportUrl(cfg), label: 'ShipStation' });
  if (!closed) {
    const st = status0 + ' (nobody signed in within ' + wait + ' min)';
    SS.writeSignInBlock(base, st);
    return { code: EXIT.SIGN_IN_NEEDED, status: st };
  }
  // One check that the person's sign-in reached the collector's profile.
  ({ context } = await B.launch(cfg, { headed, log }));
  page = context.pages()[0] || await context.newPage();
  await page.goto(SS.reportUrl(cfg), { waitUntil: 'domcontentloaded' });
  s = await SS.settleAuthState(page);
  if (s === 'authenticated') { SS.clearSignInBlock(base); log('Signed in to ShipStation; continuing.'); return { context, page }; }
  shopifyBrowser = null;
  return failed(s === 'captcha' ? EXIT.CAPTCHA : EXIT.SIGN_IN_NEEDED, 'ShipStation ' + s + ' after the sign-in window');
}

async function openBrowser(cfg) {
  const B = await import('./browser.mjs');
  const S = await import('./signin.mjs');
  const headed = !flag('headless');
  S.keepSessionsAcrossRestarts(cfg);
  let { context, page } = await B.launch(cfg, { headed, log });
  await page.goto(cfg.adminUrl, { waitUntil: 'domcontentloaded' });
  let s = await B.settleAuthState(page);
  if (s === 'authenticated') return { context, page };
  if (s === 'unknown') return { context, page, code: EXIT.UNKNOWN_PAGE, status: 'unknown_page' };

  // Signed out (or a check Shopify wants a person for). The automated window
  // cannot be used to sign in, so close it and open a normal window instead.
  const wait = headed ? (cfg.signInWaitMinutes ?? 30) : 0;
  await context.close().catch(() => {});
  if (!wait) return { code: s === 'captcha' ? EXIT.CAPTCHA : EXIT.SIGN_IN_NEEDED, status: s };
  const closed = await S.signInWithNormalWindow(cfg, wait, log);
  if (!closed) return { code: EXIT.SIGN_IN_NEEDED, status: s + ' (nobody signed in within ' + wait + ' min)' };
  ({ context, page } = await B.launch(cfg, { headed, log }));
  await page.goto(cfg.adminUrl, { waitUntil: 'domcontentloaded' });
  s = await B.settleAuthState(page);
  if (s === 'authenticated') { log('Signed in; continuing.'); return { context, page }; }
  return { context, page, code: s === 'captcha' ? EXIT.CAPTCHA : EXIT.SIGN_IN_NEEDED, status: s + ' after the sign-in window' };
}

// The shared browser profile stayed busy: report it plainly (not a sign-in
// problem, so the ShipStation sign-in block is not touched).
function profileBusy(e) {
  if (e && e.code === 'profile_in_use') return { code: EXIT.PROFILE_BUSY, status: e.message };
  throw e;
}

function writeRunRecord(dir, rec) {
  let json = JSON.stringify(rec, null, 2);
  if (containsSecret(json)) json = JSON.stringify({ runId: rec.runId, exitCode: rec.exitCode, status: rec.status, note: 'details withheld: contained a secret' });
  fs.writeFileSync(path.join(dir, rec.runId + '.json'), json);
}

function purgeOld(dir, days) {
  const cutoff = Date.now() - days * 86400000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(safeError(e)); process.exitCode = EXIT.EXPORT_FAILED; });
}
