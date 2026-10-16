// The percentage-change convention, stated once and tested exhaustively.
//
//        percentage change = (current − prior) ÷ |prior| × 100
//
// The absolute value in the denominator is the whole point. The conventional
// current/prior − 1 agrees with it for every positive prior and disagrees for
// every negative one. Negative priors are not hypothetical here: a period
// whose only activity on a product was a refund has negative net sales.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, loadBrowserGlobals, SAMPLE_FIXTURE, FACTS, ROOT } from './load.mjs';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const globals = loadBrowserGlobals();
const d = { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType };
const parsed = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify: (r) => PG.classifyRecord(r, d) });

const conventional = (cur, prior) => (cur / prior - 1) * 100;
const ours = (cur, prior) => SR.shopifyChange(cur, prior, true);

// ────────────────────────────────────────────────────────────
// The example asked for, stated explicitly
// ────────────────────────────────────────────────────────────
test('prior -$20.00 to current $0 is +100%, and the two formulas disagree', () => {
  const ch = ours(0, -20);

  // ours: (0 − (−20)) ÷ |−20| × 100 = 20 ÷ 20 × 100 = +100
  assert.equal(ch.pct, 100);
  // conventional: 0 ÷ −20 − 1 = −1 → −100%
  assert.equal(Math.round(conventional(0, -20)), -100);
  assert.notEqual(ch.pct, Math.round(conventional(0, -20)));

  // The dollar change is always available beside it.
  assert.equal(ch.abs, 20);
  assert.equal(ch.state, 'lapsed');
});

test('the export reports +100% for a refund-only prior falling to zero, so ours matches the source', () => {
  const A = FACTS.shopify.anchors.lapsedNegative;
  const r = parsed.records.find(p => p.title === A.title && p.vendor === A.vendor);
  assert.equal(r.cur.net, 0);
  assert.equal(r.prior.net, A.prior.net);
  assert.ok(r.prior.net < 0);
  assert.equal(r.reportedPct.net, 100, "the export's own percentage column");
  assert.equal(ours(r.cur.net, r.prior.net).pct, 100);
});

// ────────────────────────────────────────────────────────────
// Positive priors
// ────────────────────────────────────────────────────────────
const POSITIVE = [
  { cur: 150, prior: 100, pct: 50, abs: 50, state: 'ok' },
  { cur: 50, prior: 100, pct: -50, abs: -50, state: 'ok' },
  { cur: 100, prior: 100, pct: 0, abs: 0, state: 'ok' },
  { cur: 0, prior: 500, pct: -100, abs: -500, state: 'lapsed' },
  { cur: 0.01, prior: 1000, pct: -100, abs: -999.99, state: 'ok' },
  { cur: 300, prior: 100, pct: 200, abs: 200, state: 'ok' },
  { cur: -25, prior: 100, pct: -125, abs: -125, state: 'ok' }
];
test('with a positive prior, ours equals the conventional formula exactly', () => {
  for (const c of POSITIVE) {
    const ch = ours(c.cur, c.prior);
    assert.equal(ch.pct, c.pct, `${c.cur} vs ${c.prior}`);
    assert.equal(ch.abs, c.abs);
    assert.equal(ch.state, c.state);
    assert.ok(Math.abs(ch.pct - conventional(c.cur, c.prior)) < 0.01,
      `formulas must agree for positive prior ${c.prior}`);
  }
});

// ────────────────────────────────────────────────────────────
// Negative priors
// ────────────────────────────────────────────────────────────
const NEGATIVE = [
  { cur: 0, prior: -20, pct: 100, abs: 20, note: 'refund-only period recovers to nothing = improvement' },
  { cur: -50, prior: -100, pct: 50, abs: 50, note: 'half as negative = improvement' },
  { cur: -200, prior: -100, pct: -100, abs: -100, note: 'twice as negative = decline' },
  { cur: 100, prior: -100, pct: 200, abs: 200, note: 'from refunds to real sales' },
  { cur: -100, prior: -100, pct: 0, abs: 0, note: 'unchanged' }
];
test('with a negative prior, the sign follows the direction of travel', () => {
  for (const c of NEGATIVE) {
    const ch = ours(c.cur, c.prior);
    assert.equal(ch.pct, c.pct, c.note);
    assert.equal(ch.abs, c.abs, c.note);
    // Improvement is positive, deterioration is negative — always.
    if (c.abs > 0) assert.ok(ch.pct > 0, c.note);
    if (c.abs < 0) assert.ok(ch.pct < 0, c.note);
  }
});

test('the conventional formula gets the sign wrong whenever prior is negative', () => {
  for (const c of NEGATIVE) {
    if (c.pct === 0) continue;
    const conv = conventional(c.cur, c.prior);
    assert.notEqual(Math.sign(conv), Math.sign(c.pct),
      `conventional formula inverts ${c.cur} vs ${c.prior}`);
  }
});

// ────────────────────────────────────────────────────────────
// Zero priors
// ────────────────────────────────────────────────────────────
test('a zero prior yields no percentage at all, never a division by zero', () => {
  const grew = ours(25.91, 0);
  assert.equal(grew.state, 'new');
  assert.equal(grew.pct, null);
  assert.equal(grew.abs, 25.91);
  assert.equal(SR.shopifyChangeLabel(grew), 'New / no prior sales');

  const nothing = ours(0, 0);
  assert.equal(nothing.state, 'none');
  assert.equal(nothing.pct, null);
  assert.equal(nothing.abs, 0);

  const negFromZero = ours(-34.5, 0);
  assert.equal(negFromZero.state, 'new');
  assert.equal(negFromZero.pct, null);
  assert.equal(negFromZero.abs, -34.5);
});

test('an unknown prior period is distinct from a zero prior', () => {
  const unknown = SR.shopifyChange(100, 0, false);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.pct, null);
  assert.equal(unknown.abs, null, 'no dollar change either, because there is nothing to compare');
  assert.equal(SR.shopifyChangeLabel(unknown), 'no prior period');
  assert.notEqual(unknown.state, ours(100, 0).state);
});

// ────────────────────────────────────────────────────────────
// Agreement with the source, across the whole file
// ────────────────────────────────────────────────────────────
test('across every comparable row, ours matches the percentage Shopify printed', () => {
  let checked = 0, negativePriors = 0;
  for (const r of parsed.records) {
    for (const k of ['units', 'gross', 'net', 'total', 'tax']) {
      const reported = r.reportedPct[k];
      if (reported == null || r.prior[k] === 0) continue;
      const ch = ours(r.cur[k], r.prior[k]);
      assert.ok(Math.abs(ch.pct - reported) <= Math.max(0.05, Math.abs(reported) * 0.01),
        `${r.title} [${k}]: computed ${ch.pct}, Shopify printed ${reported}`);
      if (r.prior[k] < 0) negativePriors++;
      checked++;
    }
  }
  assert.ok(checked > 1500, `only ${checked} cells compared`);
  assert.ok(negativePriors > 0, 'the file must contain negative priors for this to prove anything');
});

test('every percentage in the file is accompanied by an absolute change', () => {
  for (const r of parsed.records) {
    const ch = ours(r.cur.net, r.prior.net);
    if (ch.pct != null) assert.equal(typeof ch.abs, 'number', `${r.title} has a % but no $`);
  }
});
