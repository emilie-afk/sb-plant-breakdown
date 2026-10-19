// Regression tests for the Shopify "Total sales by product" parser.
// The fixture is SYNTHETIC (tools/make-sample-fixtures.mjs) in the exact layout
// of Shopify's export, including the repeated "(previous_period)" headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readCsv, toCsv, loadBrowserGlobals, SAMPLE_FIXTURE, SAMPLE_CONTROLS, FACTS, ROOT } from './load.mjs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const globals = loadBrowserGlobals();
const F = FACTS.shopify, A = F.anchors;

const classify = (rec) => PG.classifyRecord(rec, {
  detectGenus: globals.detectGenus,
  detectNonPlantType: globals.detectNonPlantType
});

const rows = readCsv(SAMPLE_FIXTURE);
const parsed = SR.parseShopifyProductReport(rows, { classify });
const find = (a, recs = parsed.records) => recs.find(r => r.title === a.title && r.vendor === a.vendor);

// ────────────────────────────────────────────────────────────
// Headers
// ────────────────────────────────────────────────────────────
test('the fixture repeats the previous-period headers like the real export', () => {
  const header = rows[0];
  assert.equal(header.length, 24);
  const prev = header.filter(h => /previous_period/i.test(h));
  assert.equal(prev.length, 14, 'seven measures x two repeated groups');
  // The only textual difference between the two groups is a trailing space.
  assert.ok(header.includes('Net sales (previous_period)'));
  assert.ok(header.includes('Net sales (previous_period) '));
});

test('parses without errors and reports no untrusted columns', () => {
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.capabilities.hasPrior, true);
});

test('resolves columns by position, not by trimmed name', () => {
  const { cols } = parsed.columnReport;
  assert.equal(cols.cur.net, 7);
  assert.equal(cols.prev.net, 14);   // first (previous_period) group: absolute prior
  assert.equal(cols.pct.net, 21);    // second group: percentage change
});

test('verifies empirically which repeated group holds prior values', () => {
  assert.equal(parsed.prevRoles.verified, true);
  assert.equal(parsed.prevRoles.swapped, false);
  assert.ok(parsed.prevRoles.samples > 100);
  assert.ok(parsed.prevRoles.agreement > 0.95);
});

test('a percentage column is never read as a prior value', () => {
  const s = find(A.spider);
  assert.equal(s.cur.units, A.spider.cur.units);
  assert.equal(s.prior.units, A.spider.prior.units);   // NOT the % change
  assert.equal(s.cur.net, A.spider.cur.net);
  assert.equal(s.prior.net, A.spider.prior.net);
  // The reported percentage is kept only for audit.
  const want = (A.spider.cur.units - A.spider.prior.units) / A.spider.prior.units * 100;
  assert.ok(Math.abs(s.reportedPct.units - want) < 1e-9);
  assert.notEqual(s.prior.units, s.reportedPct.units);
});

test('a file whose two repeated groups are swapped is detected', () => {
  const header = rows[0].slice();
  const swapped = [header.slice(0, 10).concat(header.slice(17, 24), header.slice(10, 17))];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    swapped.push(r.slice(0, 10).concat(r.slice(17, 24), r.slice(10, 17)));
  }
  const p = SR.parseShopifyProductReport(swapped, { classify });
  assert.equal(p.prevRoles.swapped, true);
  assert.equal(find(A.spider, p.records).prior.units, A.spider.prior.units, 'prior values still come from the absolute group');
});

test('a file with no comparison columns parses, and comparisons say so', () => {
  const trimmed = rows.map(r => r.slice(0, 10));
  const p = SR.parseShopifyProductReport(trimmed, { classify });
  assert.equal(p.ok, true);
  assert.equal(p.capabilities.hasPrior, false);
  const ch = SR.shopifyChange(100, 0, p.records[0].priorKnown);
  assert.equal(ch.state, 'unknown');
  assert.equal(SR.shopifyChangeLabel(ch), 'no prior period');
});

test('a previous-period copy cannot stand in for a missing current column', () => {
  // Drop the real "Net sales" column. Because the suffix is stripped when
  // matching headers, the "(previous_period)" copy would otherwise slide into
  // its place and last period's figures would be reported as this period's.
  const broken = rows.map(r => r.filter((_, i) => i !== 7));
  const p = SR.parseShopifyProductReport(broken, { classify });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /Net sales.*only previous-period copies/);
  assert.equal(p.records.length, 0);
  assert.equal(p.totals.current.net, 0);
});

test('a missing required column is a hard error, not a silent shift', () => {
  const broken = rows.map(r => r.filter((_, i) => i !== 1)); // drop Product vendor
  const p = SR.parseShopifyProductReport(broken, { classify });
  assert.equal(p.ok, false);
  assert.match(p.errors.join(' '), /Product vendor/);
  assert.equal(p.records.length, 0);
});

// ────────────────────────────────────────────────────────────
// Totals / reconciliation
// ────────────────────────────────────────────────────────────
test('totals reconcile to the figures shown on the source report', () => {
  const rec = SR.shopifyReconcile(parsed.totals.current, SAMPLE_CONTROLS);
  assert.ok(rec.ok, JSON.stringify(rec.checks, null, 2));
  for (const k of ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total']) assert.equal(parsed.totals.current[k], F.cur[k], k);
  for (const k of ['units', 'net', 'total']) assert.equal(parsed.totals.prior[k], F.prior[k], 'prior ' + k);
});

test('the controls are a check, not a constant baked into the dashboard', () => {
  // Change one row; reconciliation must now FAIL rather than report the control.
  const edited = rows.map(r => r.slice());
  edited[1][3] = String(F.firstRowUnits - 10);
  const p = SR.parseShopifyProductReport(edited, { classify });
  const rec = SR.shopifyReconcile(p.totals.current, SAMPLE_CONTROLS);
  assert.equal(rec.ok, false);
  assert.equal(p.totals.current.units, F.cur.units - 10);
});

test('internal arithmetic of the export holds', () => {
  const t = parsed.totals.current;
  assert.ok(Math.abs((t.gross + t.disc + t.ret) - t.net) < 0.01);
  assert.ok(Math.abs((t.net + t.tax) - t.total) < 0.01);
  assert.equal(parsed.warnings.filter(w => /does not equal/.test(w)).length, 0);
});

// ────────────────────────────────────────────────────────────
// Signs, negatives, reversals, zero rows
// ────────────────────────────────────────────────────────────
test('discounts and sales reversals keep their negative sign', () => {
  assert.ok(parsed.totals.current.disc < 0, 'discounts are negative');
  assert.ok(parsed.totals.current.ret < 0, 'sales reversals are negative');
  assert.equal(parsed.totals.current.disc, F.cur.disc);
  assert.equal(parsed.totals.current.ret, F.cur.ret);
});

test('a product with negative net sales survives the import', () => {
  const r = find(A.negative);
  assert.ok(r, 'the negative row is present');
  assert.ok(r.cur.units < 0 && r.cur.net < 0);
  assert.equal(r.cur.units, A.negative.cur.units);
  assert.equal(r.cur.ret, A.negative.cur.ret);
  assert.equal(r.cur.net, A.negative.cur.net);
});

test('rows with non-zero sales reversals are kept and counted', () => {
  assert.equal(parsed.records.filter(r => r.cur.ret !== 0).length, F.returnRows);
});

test('zero-sales rows are kept, not dropped', () => {
  const zero = parsed.records.filter(r => r.cur.units === 0 && r.cur.net === 0);
  assert.equal(zero.length, F.zeroRows);
  assert.ok(zero.length > 100);
  assert.equal(parsed.records.length, F.rows);
});

// ────────────────────────────────────────────────────────────
// Identity: same title under different vendors
// ────────────────────────────────────────────────────────────
test('the same title under two vendors stays two products', () => {
  for (const title of F.duplicateTitles) {
    const hits = parsed.records.filter(r => r.title === title);
    assert.equal(hits.length, 2, `${title} should survive as two rows`);
    assert.deepEqual(hits.map(h => h.vendor).sort(), [F.vendorNames.drop, F.vendorNames.own].sort());
  }
});

test('neither vendor copy overwrites the other', () => {
  const own = find(A.pearlsOwn), drop = find(A.pearlsDrop);
  assert.equal(own.cur.units, A.pearlsOwn.cur.units); assert.equal(own.cur.net, A.pearlsOwn.cur.net);
  assert.equal(drop.cur.units, A.pearlsDrop.cur.units); assert.equal(drop.cur.net, A.pearlsDrop.cur.net);
});

test('vendor-split products sum correctly into their genus', () => {
  const groups = PG.aggregateByGroup(parsed.records);
  const senecio = groups.find(g => g.group === 'Senecio');
  const summed = parsed.records.filter(r => r.title === A.pearlsOwn.title).reduce((s, p) => s + p.cur.net, 0);
  assert.ok(senecio.cur.net >= summed - 0.01, 'genus total includes both vendor rows');
});

test('the grouping key is recorded as a fallback identity, not a product id', () => {
  assert.ok(parsed.records.every(r => r.identityBasis === 'title+vendor+type'));
  assert.equal(parsed.capabilities.hasSku, false);
  assert.equal(parsed.capabilities.hasProductId, false);
  assert.equal(parsed.capabilities.hasVariantId, false);
  assert.equal(parsed.capabilities.hasDailyDates, false);
});

test('repeated rows inside one title+vendor+type key are summed, not overwritten', () => {
  const idx = rows.findIndex(r => r[0] === A.spider.title && r[1] === A.spider.vendor);
  const dup = rows.slice(0, idx + 1).concat([rows[idx].slice()], rows.slice(idx + 1));
  const p = SR.parseShopifyProductReport(dup, { classify });
  assert.equal(p.aggregatedRows, 1);
  assert.match(p.warnings.join(' '), /Aggregated 2 rows sharing title \+ vendor \+ product type/);
  const s = find(A.spider, p.records);
  assert.equal(s.cur.units, A.spider.cur.units * 2);
  assert.equal(s.sourceRows, 2);
});

// ────────────────────────────────────────────────────────────
// Blank product types
// ────────────────────────────────────────────────────────────
test('a blank product type becomes Unclassified and is flagged', () => {
  const blanks = parsed.records.filter(r => r.ptypeBlank);
  assert.equal(blanks.length, F.blankTypes);
  assert.ok(blanks.every(r => r.ptype === 'Unclassified'));
});

test('a blank product type does not hide the product', () => {
  const r = find(A.blankPlant);
  assert.equal(r.ptype, 'Unclassified');
  assert.equal(r.cur.net, A.blankPlant.cur.net);
  // Still classified as a plant from its title.
  assert.equal(r.isPlant, true);
  assert.equal(r.group, 'Epiphyllum');
});

// ────────────────────────────────────────────────────────────
// Change calculation
// ────────────────────────────────────────────────────────────
test('zero prior sales reports "New / no prior sales", never a percentage', () => {
  const news = parsed.records.filter(r => r.prior.net === 0 && r.cur.net !== 0);
  assert.equal(news.length, F.newRows);
  assert.ok(news.length > 50);
  for (const r of news) {
    const ch = SR.shopifyChange(r.cur.net, r.prior.net, r.priorKnown);
    assert.equal(ch.state, 'new');
    assert.equal(ch.pct, null);
    assert.equal(SR.shopifyChangeLabel(ch), 'New / no prior sales');
  }
});

test('zero current and zero prior is neither growth nor decline', () => {
  const ch = SR.shopifyChange(0, 0, true);
  assert.equal(ch.state, 'none');
  assert.equal(ch.pct, null);
  assert.equal(ch.abs, 0);
});

test('a product that stopped selling reports -100%, not "new"', () => {
  const ch = SR.shopifyChange(0, 500, true);
  assert.equal(ch.state, 'lapsed');
  assert.equal(ch.pct, -100);
  assert.equal(ch.abs, -500);
});

test('changes are computed from values, and match Shopify where Shopify states one', () => {
  let compared = 0;
  for (const r of parsed.records) {
    const reported = r.reportedPct.net;
    if (reported == null || r.prior.net === 0) continue;
    const ch = SR.shopifyChange(r.cur.net, r.prior.net, true);
    assert.ok(Math.abs(ch.pct - reported) <= Math.max(0.05, Math.abs(reported) * 0.01),
      `${r.title}: computed ${ch.pct} vs reported ${reported}`);
    compared++;
  }
  assert.ok(compared > 400, `compared ${compared} rows`);
});

test('a negative prior value still yields a sane percentage', () => {
  const ch = SR.shopifyChange(-50, -100, true);
  assert.equal(ch.abs, 50);
  assert.equal(ch.pct, 50);   // (-50 - -100) / 100
});

test('falling to zero from a NEGATIVE prior is +100%, as Shopify reports it', () => {
  // A refund-only prior period followed by no activity. A blanket
  // "current is 0 therefore -100%" rule would invert the sign.
  const r = find(A.lapsedNegative);
  assert.equal(r.cur.net, 0);
  assert.ok(r.prior.net < 0);
  assert.equal(r.prior.net, A.lapsedNegative.prior.net);
  const ch = SR.shopifyChange(r.cur.net, r.prior.net, true);
  assert.equal(ch.state, 'lapsed');
  assert.equal(ch.pct, 100);
  assert.equal(r.reportedPct.net, 100);
});

// ────────────────────────────────────────────────────────────
// Parsing edge cases
// ────────────────────────────────────────────────────────────
test('blank cells are not confused with zero', () => {
  assert.equal(SR.shopifyNum(''), null);
  assert.equal(SR.shopifyNum('  '), null);
  assert.equal(SR.shopifyNum(0), 0);
  assert.equal(SR.shopifyNum('0'), 0);
  assert.equal(SR.shopifyNum('-34.50'), -34.5);
  assert.equal(SR.shopifyNum('$1,234.56'), 1234.56);
  assert.equal(SR.shopifyNum('(99.44)'), -99.44);
  assert.equal(SR.shopifyNum('10.2%'), 10.2);
});

test('Shopify\'s own Total row is ignored rather than double counted', () => {
  const t = F.cur;
  const withTotal = rows.slice();
  withTotal.push(['Total', '', '', String(t.units), String(t.gross), String(t.disc), String(t.ret), String(t.net), String(t.tax), String(t.total),
                  '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
  const p = SR.parseShopifyProductReport(withTotal, { classify });
  assert.equal(p.totals.current.net, t.net);
  assert.equal(p.records.length, F.rows);
});

test('the report is recognised by its headers', () => {
  assert.equal(SR.isShopifyProductReport(rows), true);
  assert.equal(SR.isShopifyProductReport([['Handle', 'Title', 'Variant SKU']]), false);
  assert.equal(SR.isShopifyProductReport([]), false);
});

test('a CSV round-trip through the reader preserves the trailing-space headers', () => {
  const again = readCsv(SAMPLE_FIXTURE);
  assert.deepEqual(again[0], rows[0]);
  const re = toCsv([rows[0]]).trim();
  assert.ok(re.includes('"Net sales (previous_period) "'));
});
