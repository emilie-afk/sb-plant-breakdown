// Two Amazon exports, two different periods.
//
// v1 covers one month; v2 is a year-to-date report that contains that month.
// Neither file carries its dates, so the period must be stated at import, and
// the two report types must never replace each other.
//
// Independent referee: an order-report extract for the same month, reduced to
// ASIN / title / units / sales (amazon-order-extract-sample.csv).
//
// All three fixtures are SYNTHETIC (tools/make-sample-fixtures.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readCsv, ROOT, AMAZON_V1_FIXTURE, AMAZON_V2_FIXTURE, AMAZON_ORDERS_FIXTURE, FACTS } from './load.mjs';

const require = createRequire(import.meta.url);
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const AR = require(path.join(ROOT, 'amazon-report.js'));

const v1 = AP.parseAmazonMetricData(readCsv(AMAZON_V1_FIXTURE));
const v2 = AP.parseAmazonMetricData(readCsv(AMAZON_V2_FIXTURE));
const orders = readCsv(AMAZON_ORDERS_FIXTURE).slice(1).filter(r => r[0]);
const byAsin = (prods) => Object.fromEntries(prods.map(p => [p.asin, p.units]));
const u1 = byAsin(v1.products), u2 = byAsin(v2.products);
const uo = Object.fromEntries(orders.map(r => [r[0], Number(r[4])]));
const total = (m) => Object.values(m).reduce((s, u) => s + u, 0);
const AM = FACTS.amazon;

test('the month: v1 equals the order-report referee, ASIN for ASIN', () => {
  assert.equal(total(uo), AM.orders.units);
  assert.equal(total(u1), AM.v1.units);
  assert.equal(total(uo), total(u1));
  for (const a of Object.keys(uo)) assert.equal(u1[a] || 0, uo[a], a);
  const v1Sold = Object.keys(u1).filter(a => u1[a] > 0);
  assert.deepEqual(v1Sold.sort(), Object.keys(uo).sort());
});

test('year to date: v2 is at least the month on every ASIN sold in that month', () => {
  // A year-to-date report of the same store's sales must contain the month.
  // If v2 were another scope (e.g. all sellers) or a disjoint period, some
  // ASIN would fall below its monthly figure. None does.
  for (const a of Object.keys(uo)) assert.ok((u2[a] || 0) >= uo[a], `${a}: YTD ${u2[a]} < month ${uo[a]}`);
  assert.equal(total(u2), AM.v2.units);
});

test('v2 matches the totals on its own Total line', () => {
  const t = v2.totalsRow;
  assert.equal(Math.round(t.units), AM.v2.units);
  assert.equal(Math.round(t.orderItems), AM.v2.orderItems);
  assert.equal(Math.round(t.revenue * 100) / 100, AM.v2.orderedRevenue);
});

test('the two report types still get separate identities', () => {
  // They measure traffic differently, so one must never replace the other,
  // whatever period each is given.
  const a = AR.amazonSnapshotIdentity('2026-09-01', '2026-09-30', v1.capabilities);
  const b = AR.amazonSnapshotIdentity('2026-01-01', '2026-10-10', v2.capabilities);
  const c = AR.amazonSnapshotIdentity('2026-09-01', '2026-09-30', v2.capabilities);
  assert.equal(a.id, 'amazon_2026-09-01_2026-09-30_metric-data-v1');
  assert.equal(b.id, 'amazon_2026-01-01_2026-10-10_metric-data-v2');
  assert.notEqual(a.id, c.id, 'same period, different type: kept side by side');
});

test('re-importing the same report type for the same period revises it', () => {
  const a = AR.amazonSnapshotIdentity('2026-01-01', '2026-10-10', v2.capabilities);
  const b = AR.amazonSnapshotIdentity('2026-01-01', '2026-10-10', { ...v2.capabilities });
  assert.equal(a.id, b.id);
});

test('ordered units mean the same thing in both types; traffic does not', () => {
  assert.equal(v1.capabilities.hasUnits, true);
  assert.equal(v2.capabilities.hasUnits, true);
  assert.notEqual(v1.capabilities.glanceBasis, v2.capabilities.glanceBasis);
  assert.equal(v1.capabilities.hasRevenue, false);
  assert.equal(v2.capabilities.hasRevenue, true);
  assert.equal(AR.amazonSameReportType(v1.capabilities, v2.capabilities), false);
});
