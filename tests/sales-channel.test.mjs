// Sales channel: marketplace orders pushed into Shopify by Sellbrite appear in
// Shopify reports under the "Sellbrite" sales channel. The saved report groups
// by sales_channel, so those orders can be kept apart from own-store sales and
// are never counted twice next to the Amazon report.
//
// Fixture: tests/fixtures/shopify-sales-channel-sample.csv — SYNTHETIC
// (tools/make-sample-fixtures.mjs), one row per product per channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readCsv, loadBrowserGlobals, ROOT, SAMPLE_FIXTURE, CHANNEL_FIXTURE, FACTS, r2 } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';

const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'shopify-report.js'));
const PG = require(path.join(ROOT, 'product-grouping.js'));
const SS = require(path.join(ROOT, 'shared-sync.js'));
const globals = loadBrowserGlobals();
const classify = (r) => PG.classifyRecord(r, { detectGenus: globals.detectGenus, detectNonPlantType: globals.detectNonPlantType });
const parse = () => SR.parseShopifyProductReport(readCsv(CHANNEL_FIXTURE), { classify });
const sum = (rs, f) => r2(rs.reduce((s, r) => s + f(r), 0));
const CH = FACTS.channel;

// A product that sold through both an own-store channel and Sellbrite.
const res0 = parse();
const both = (() => {
  const by = {};
  for (const r of res0.records) (by[r.productKey] = by[r.productKey] || []).push(r);
  return Object.values(by).find(rs => rs.some(r => r.salesChannel === 'Sellbrite' && r.cur.net > 0) &&
                                      rs.some(r => r.salesChannel !== 'Sellbrite' && r.cur.net > 0));
})();

test('Sellbrite (and anything named Amazon) is the Amazon channel; the rest is own store', () => {
  assert.equal(SR.shopifyChannelGroupOf('Sellbrite'), 'amazon');
  assert.equal(SR.shopifyChannelGroupOf('Amazon'), 'amazon');
  assert.equal(SR.shopifyChannelGroupOf('Online Store'), 'own');
  assert.equal(SR.shopifyChannelGroupOf('Recharge Subscriptions'), 'own');
  assert.equal(SR.shopifyChannelGroupOf('TikTok'), 'own');
  assert.equal(SR.shopifyChannelGroupOf(''), '');
});

test('a channel export keeps one record per product per channel and splits the totals', () => {
  const res = parse();
  assert.equal(res.ok, true, res.errors.join(' '));
  assert.equal(res.capabilities.hasSalesChannel, true);
  assert.equal(res.capabilities.hasProductId, true);
  assert.equal(res.records.length, CH.rows, 'channel rows are not merged at import');
  assert.equal(res.aggregatedRows, 0);
  assert.ok(both, 'the sample has a product sold through own store and Sellbrite');
  assert.ok(both.every(r => r.productKey === both[0].productKey));

  const ct = res.channelTotals;
  assert.equal(ct.amazon.units, CH.amazon.units);
  assert.equal(ct.amazon.net, CH.amazon.net);
  assert.equal(ct.own.units, CH.own.units);
  assert.equal(ct.own.net, CH.own.net);
  assert.equal(r2(ct.own.net + ct.amazon.net), res.totals.current.net, 'own + amazon = report total');
  assert.equal(ct.channels.find(c => c.channel === 'Sellbrite').group, 'amazon');
});

test('own-store scope drops Sellbrite rows; all-channel scope merges a product across channels', () => {
  const recs = parse().records.map(SR.shopifyToSnapshotProduct);
  const own = PG.filterChannel(recs, 'own');
  const amz = PG.filterChannel(recs, 'amazon');
  const all = PG.filterChannel(recs, 'all');

  assert.equal(own.length, CH.ownProducts);
  assert.equal(amz.length, CH.amazonProducts);
  assert.equal(all.length, CH.products, 'one row per product once channels are merged');
  assert.equal(r2(sum(own, r => r.cur.net) + sum(amz, r => r.cur.net)), sum(all, r => r.cur.net));
  assert.equal(sum(all, r => r.cur.net), sum(recs, r => r.cur.net), 'merging never changes the total');

  const key = both[0].productKey;
  const m = all.find(r => r.productKey === key);
  assert.equal(m.cur.units, both.reduce((s, r) => s + r.cur.units, 0));
  assert.equal(m.cur.net, sum(both, r => r.cur.net));
  assert.equal(m.prior.net, sum(both, r => r.prior.net));
  assert.deepEqual(m.salesChannels.slice().sort(), both.map(r => r.salesChannel).sort());
  assert.equal(m.units, m.cur.units, 'legacy flat fields follow the merged figures');
  assert.equal(m.rev, m.cur.total);
  assert.equal(m.channelGroup, 'own');
  assert.equal(amz.find(r => r.productKey === key).channelGroup, 'amazon');

  // inputs untouched
  assert.equal(recs.filter(r => r.productKey === key).length, both.length);
});

test('classification and percentages work on merged rows', () => {
  const recs = parse().records.map(SR.shopifyToSnapshotProduct);
  const own = PG.filterChannel(recs, 'own');
  const g = PG.aggregateByGroup(own.map(r => Object.assign(r, classify(r))));
  assert.ok(g.length > 10);
  // A product with no own-store prior must read "new" in the own-store scope,
  // never borrow the Sellbrite prior.
  const ownOnly = own.find(r => r.prior.net === 0 && r.cur.net > 0);
  assert.ok(ownOnly);
  assert.equal(SR.shopifyChange(ownOnly.cur.net, ownOnly.prior.net, true).state, 'new');
});

test('a report without a channel column passes through unchanged and is flagged from March 2026', () => {
  const plain = SR.parseShopifyProductReport(readCsv(SAMPLE_FIXTURE), { classify });
  const recs = plain.records.map(SR.shopifyToSnapshotProduct);
  assert.equal(plain.capabilities.hasSalesChannel, false);
  assert.equal(PG.filterChannel(recs, 'own').length, recs.length);
  const st = SR.shopifyChannelStatus({ products: recs, startDate: '2026-09-01', endDate: '2026-09-30', meta: { capabilities: plain.capabilities } });
  assert.equal(st.hasChannel, false);
  assert.equal(st.mayIncludeAmazon, true);
  const feb = SR.shopifyChannelStatus({ products: recs, startDate: '2026-02-01', endDate: '2026-02-28', meta: {} });
  assert.equal(feb.mayIncludeAmazon, false, 'before the configured start date there is nothing to separate');
});

test('channel status of a snapshot reports the own / Amazon split', () => {
  const res = parse();
  const snap = { products: res.records.map(SR.shopifyToSnapshotProduct), startDate: '2026-09-01', endDate: '2026-09-30',
                 meta: { capabilities: res.capabilities } };
  const st = SR.shopifyChannelStatus(snap);
  assert.equal(st.hasChannel, true);
  assert.equal(st.mayIncludeAmazon, false);
  assert.equal(st.totals.amazon.units, CH.amazon.units);
});

// ── shared storage ─────────────────────────────────────────────
const DASH = 'd'.repeat(40);
async function call(e, method, p, body) {
  const res = await worker.fetch(new Request('https://w.example' + p, {
    method, headers: { authorization: 'Bearer ' + DASH, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), e);
  return res.json();
}

test('channel rows round-trip through shared storage with their channel', async () => {
  const e = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), DASHBOARD_SECRET: DASH, INGEST_SECRET: 'i'.repeat(40) };
  const res = parse();
  const snap = { id: 'shopify_2026-09-01_2026-09-30', source: 'shopify', startDate: '2026-09-01', endDate: '2026-09-30',
                 products: res.records.map(SR.shopifyToSnapshotProduct),
                 meta: { capabilities: res.capabilities, comparison: { start: '2026-08-02', end: '2026-08-31', source: 'stated' } } };
  const conv = SS.sharedPayloadFromSnapshot(snap);
  assert.equal(conv.payload.rows.filter(r => r.salesChannel === 'Sellbrite').length, CH.amazonRows);
  const up = await call(e, 'POST', '/v1/ingest/product-report', conv.payload);
  assert.equal(up.outcome, 'succeeded', JSON.stringify(up.errors));
  assert.equal((await call(e, 'POST', '/v1/ingest/product-report', conv.payload)).outcome, 'unchanged');

  const rep = (await call(e, 'GET', '/v1/reports')).reports[0];
  assert.equal(rep.capabilities.hasSalesChannel, true);
  const rows = (await call(e, 'GET', '/v1/reports/' + encodeURIComponent(rep.id) + '/rows?limit=5000')).rows;
  assert.equal(rows.length, CH.rows);
  const back = SS.sharedSnapshotFromReport(rep, rows, { classify, toSnapshotProduct: SR.shopifyToSnapshotProduct });
  const st = SR.shopifyChannelStatus(back);
  assert.equal(st.hasChannel, true);
  assert.equal(st.totals.amazon.net, CH.amazon.net);
  assert.equal(PG.filterChannel(back.products, 'own').length, CH.ownProducts);
});
