// Market data from ShipStation's "Product Sales" export. SYNTHETIC rows only:
// the layout matches the real export (Store,SKU,Description,Category,QtySold,
// TotalSales), the stores and products are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';
import * as L from '../collector/src/lib.mjs';

const require = createRequire(import.meta.url);
const MR = require(path.join(ROOT, 'market-report.js'));
const PE = require(path.join(ROOT, 'period-engine.js'));

const CSV = [
  'Store,SKU,Description,Category,QtySold,TotalSales',
  '"Mountain Crest Gardens (BigC)","S2AA0001","Echeveria \'Sample One\'","","10","69.90"',
  '"Mountain Crest Gardens (BigC)"," S2AA0002","Sedum Example [large]","","4","35.96"',
  '"Mountain Crest Gardens (BigC)","","Trailing Replacement ","","50","-120.00"',
  '"Amazon (MCG)","S2AA0001","Echeveria \'Sample One\'","","3","27.00"',
  '"Faire (MCG)","TAKM0001-25","Echeveria Bulk Pack (25-50 Plants, 2"" Pots)","","2","85.00"',
  '"Leaf & Clay (Shopify)","","Mystery Colorful Succulent - 2""","","2","13.98"',
  '"Leaf & Clay (Shopify)","","CODE20","","5","-25.00"',
  '"Succulents Box (Shopify)","SB-0001","Our own arrangement","","7","140.00"',
  '"Succulents Box (Shopify)","","OWN10","","3","-12.00"',
  '"Manual Orders","X1","Sample replacement","","1","0.00"'
].join('\n');
const SEPT = { start: '2026-09-01', end: '2026-09-30' };

test('the Product Sales export is recognised and parsed by header', () => {
  const rows = L.parseCsv(CSV);
  assert.equal(MR.marketIsProductSalesExport(rows), true);
  const r = MR.marketParseProductSales(rows);
  assert.equal(r.ok, true, r.errors.join(' '));
  assert.equal(r.records.length, 6, 'market products, including a product without SKU and a $0 manual row');
  assert.equal(r.records.find(x => x.sku === 'S2AA0002').title, 'Sedum Example [large]', 'whitespace in SKU is trimmed');
});

test('Succulents Box stores are you, not the market; coupons and adjustments are not products', () => {
  const r = MR.marketParseProductSales(L.parseCsv(CSV));
  assert.ok(r.records.every(x => !/Succulents Box/.test(x.store)));
  assert.equal(r.own.length, 1);
  assert.equal(r.totals.own.net, 140);
  assert.deepEqual(r.adjustments.map(a => a.label).sort(), ['CODE20', 'OWN10', 'Trailing Replacement']);
  assert.equal(r.totals.market.net, 231.84);
  assert.equal(r.totals.market.units, 22);
  assert.equal(r.totals.all.net, Math.round((231.84 + 140 - 157) * 100) / 100, 'every row is accounted for once');
  assert.equal(MR.marketStoreGroup('Amazon (MCG)'), 'Mountain Crest Gardens');
  assert.equal(MR.marketStoreGroup('TEMU (Leaf & Clay)'), 'Leaf & Clay');
});

test('an export with customer or order columns is refused', () => {
  const bad = CSV.replace('Store,SKU,', 'Store,Order Number,SKU,');
  assert.equal(MR.marketParseProductSales(L.parseCsv(bad)).ok, false);
  const bad2 = CSV.replace('TotalSales', 'TotalSales,Recipient');
  assert.match(MR.marketParseProductSales(L.parseCsv(bad2)).errors[0], /customer or order columns/);
});

test('the collector payload stores market products only and reconciles to the cent', async () => {
  const v = L.validateMarketExport(CSV, SEPT, { timeZone: 'America/Los_Angeles', currency: 'USD' });
  assert.equal(v.ok, true, (v.problems || []).join(' '));
  const p = v.payload;
  assert.equal(p.source, 'market'); assert.equal(p.reportScope, 'shipstation_product_sales');
  assert.ok(!p.rows.some(r => /Succulents Box/.test(r.vendor)), 'own-store rows are never stored');
  assert.equal(p.includedTotals.net, 231.84);
  assert.equal(p.excludedTotals.net, -145, 'market-store adjustments only');
  assert.ok(!JSON.stringify(p).match(/order ?(number|#|id)|customer|recipient|address/i));
  const env = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), INGEST_SECRET: 'i'.repeat(40), VIEWER_SECRET: 'v'.repeat(40) };
  const call = (m, u, key, body) => worker.fetch(new Request('https://w.example' + u, { method: m,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), env).then(r => r.json());
  const up = await call('POST', '/v1/ingest/product-report', 'i'.repeat(40), p);
  assert.equal(up.outcome, 'succeeded', JSON.stringify(up));
  assert.equal((await call('POST', '/v1/ingest/product-report', 'i'.repeat(40), Object.assign({}, p, { collectedAt: new Date().toISOString() }))).outcome, 'unchanged');
  const reps = (await call('GET', '/v1/reports?source=market', 'v'.repeat(40))).reports;
  assert.equal(reps.length, 1);
  const rows = (await call('GET', '/v1/reports/' + encodeURIComponent(reps[0].id) + '/rows', 'v'.repeat(40))).rows;
  assert.equal(rows.find(r => r.title === 'Sedum Example [large]').sku, 'S2AA0002');
  // Back in the dashboard: the External Stores snapshot shape, with actual revenue.
  const snap = MR.marketExternalSnapshotFromShared(reps[0], rows, { detectGenus: (t) => /Echeveria/.test(t) ? 'Echeveria' : '' });
  assert.equal(snap.source, 'external');
  assert.equal(snap.products.length, 6, 'adjustments are not products');
  assert.equal(Math.round(snap.products.reduce((t, x) => t + x.estRev, 0) * 100) / 100, 231.84);
  assert.equal(snap.startDate, '2026-09-01'); assert.equal(snap.endDate, '2026-09-30');
  assert.equal(snap.products.find(x => x.sku === 'S2AA0001' && x.rawStore === 'Amazon (MCG)').store, 'Mountain Crest Gardens');
  // Months combine for quarters exactly like sales reports do.
  const auth = PE.periodAuthoritativeMonths(reps, { source: 'market', scope: 'shipstation_product_sales' });
  assert.ok(auth.months['2026-09']);
});

test('a period with no market sales is reported as empty, not as a failure', () => {
  const own = 'Store,SKU,Description,Category,QtySold,TotalSales\n"Succulents Box (Shopify)","SB-1","Ours","","1","10.00"';
  const v = L.validateMarketExport(own, SEPT, {});
  assert.equal(v.ok, false); assert.equal(v.empty, true);
});
