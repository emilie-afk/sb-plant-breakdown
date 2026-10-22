// The classification decisions confirmed by the business and the shared
// (central) correction store.
// Synthetic titles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { loadBrowserGlobals, ROOT } from './load.mjs';
import { validateOverrides, planChange, readReviewFile } from '../tools/classification-overrides.mjs';

const require = createRequire(import.meta.url);
const PG = require(path.join(ROOT, 'product-grouping.js'));
const g = loadBrowserGlobals();
const O = { detectGenus: g.detectGenus, detectAllGenera: g.detectAllGenera, detectNonPlantType: g.detectNonPlantType };
const C = (title, ptype = '') => PG.classifyRecord({ title, ptype }, O);

test('single-genus packs stay under their genus and are marked as a pack', () => {
  const c = C('Echeveria Variety Pack (2" Pots) - 12-Pack');
  assert.deepEqual([c.group, c.category, c.pack], ['Echeveria', 'Plants', true]);
  const m = C('Sample Succulent Variety Pack (2" Pots) - 30-Pack');
  assert.deepEqual([m.group, m.pack], ['Mixed variety pack', true]);
  assert.equal(C('Echeveria Lola').pack, false);
  assert.equal(C('Heat Pack').pack, false, 'a heat pack is not a plant pack');
});
test('mystery single plants are Unidentified plant', () => {
  assert.equal(C('Mystery Weird Succulent').group, 'Unidentified plant');
});
test('Indoor Plants is displayed as Houseplants; the raw type is kept', () => {
  const rec = { title: 'Calathea Medallion', ptype: 'Indoor Plants' };
  const c = PG.classifyRecord(rec, O);
  assert.equal(c.ptypeCanonical, 'Houseplants'); assert.equal(rec.ptype, 'Indoor Plants');
  assert.equal(PG.applyScope([{ ptype: 'Indoor Plants' }, { ptype: 'houseplant' }], { ptype: 'Houseplants' }).length, 2);
});
test('Epipremnum is displayed as Pothos; Scindapsus sold as "satin pothos" stays Scindapsus', () => {
  assert.equal(C('Epipremnum aureum Marble Queen').group, 'Pothos');
  assert.equal(C('Golden Pothos - 4" Pot').group, 'Pothos');
  assert.equal(C('Satin Pothos - 4" Pot').group, 'Scindapsus');
  assert.equal(C('Scindapsus pictus Exotica').group, 'Scindapsus');
});
test('snake plants are Sansevieria; other Dracaena stay Dracaena', () => {
  assert.equal(C('Snake Plant Laurentii - 6" Pot').group, 'Sansevieria');
  assert.equal(C('Dracaena trifasciata Moonshine').group, 'Sansevieria');
  assert.equal(C('Sansevieria Starfish').group, 'Sansevieria');
  assert.equal(C('Dracaena Marginata Cane').group, 'Dracaena');
});
test('subscription add-ons are grouped by the item, with the add-on kept as an attribute', () => {
  const plant = C('OCT Subscription Add-On 2-inch succulent');
  assert.deepEqual([plant.group, plant.subscriptionAddOn], ['Unidentified plant', true]);
  assert.equal(C('OCT Subscription Add-On airplant').group, 'Tillandsia');
  assert.equal(C('OCT Subscription Add-On Accessory').group, 'Accessories');
  const heat = C('Heat Pack (Subscription)', 'Fertilizers');
  assert.deepEqual([heat.group, heat.subscriptionAddOn], ['Heat Packs', true]);
  assert.equal(C('Plant add-on for subscribers', 'Subscription').group, 'Subscriptions', 'not an add-on title: the type decides');
  assert.equal(C('2 succulents/ month - 3 month Subscription', 'Subscription').subscriptionAddOn, false);
});
test('unidentified products stay Unclassified rather than guessed', () => {
  assert.equal(C('Custom Tray (40)').group, 'Unclassified');
  assert.equal(C('Walk In - Custom').group, 'Unclassified');
});
test('succulents in a planter are Gifts / arrangements, keeping a genus; a "Heart" cultivar is a plant', () => {
  assert.equal(C('Live Succulent Plants in 8" Concrete Heart-Shaped Planter').group, 'Gifts');
  const ech = C('Echeveria Plants in Reclaimed Wood Planter');
  assert.deepEqual([ech.group, ech.genus], ['Gifts', 'Echeveria']);
  assert.equal(C("Fern 'Heart' - 6\" Pot", 'Dropship').category, 'Plants');
  assert.equal(C('Hoya Kerrii Sweetheart Plant').group, 'Hoya');
});

// ── central corrections ────────────────────────────────────────────────
test('reviewed import: valid entries pass, unknown keys / groups / fields are refused', () => {
  const ok = validateOverrides({
    'shopify␟pid:123': { group: 'Gifts', groupType: 'Product category', title: 'X', source: 'local' },
    'amazon␟B0ABCDEFGH': { group: 'Echeveria', groupType: 'Genus' },
    'market␟Store A␟sku:S-1': { group: 'Mixed variety pack', groupType: 'Product category' }
  });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.clean['market␟Store A␟sku:S-1'].isPlant, true);
  assert.equal('source' in ok.clean['shopify␟pid:123'], false);
  const bad = validateOverrides({
    'nonsense': { group: 'Gifts' },
    'shopify␟pid:1': { group: 'Cool stuff', groupType: 'Product category' },
    'shopify␟pid:2': { group: 'not a genus', groupType: 'Genus' },
    'shopify␟pid:3': { group: 'Gifts', groupType: 'Product category', price: 5 }
  });
  assert.equal(bad.ok, false); assert.equal(bad.errors.length, 4);
});
test('reviewed import: a push adds to the shared copy, never silently drops other entries', () => {
  const current = { 'amazon␟B0ABCDEFGH': { group: 'Echeveria', groupType: 'Genus' }, 'shopify␟pid:9': { group: 'Gifts', groupType: 'Product category' } };
  const file = readReviewFile(JSON.stringify({ kind: 'sb-classification-overrides', overrides: {
    'shopify␟pid:123': { group: 'Gifts', groupType: 'Product category' },
    'shopify␟pid:9': { group: 'Kits', groupType: 'Product category' } }, remove: ['amazon␟B0ABCDEFGH'] }));
  const plan = planChange(current, { overrides: validateOverrides(file.overrides).clean, remove: file.remove });
  assert.deepEqual([plan.added, plan.changed, plan.removed], [['shopify␟pid:123'], ['shopify␟pid:9'], ['amazon␟B0ABCDEFGH']]);
  assert.equal(Object.keys(plan.next).length, 2);
});
test('dashboard: confirmed shared corrections apply for every viewer; local changes stay separate', () => {
  const store = {};
  const sandbox = { console, localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
                    BUI: { esc: s => String(s) } };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'classification-review.js'), 'utf8'), sandbox);
  const SO = sandbox.SBOverrides;
  SO.setShared({ 'shopify␟pid:1': { group: 'Gifts', groupType: 'Product category' } }, 4);
  SO.save({ 'shopify␟pid:2': { group: 'Kits', groupType: 'Product category' } });
  const eff = SO.load();
  assert.equal(eff['shopify␟pid:1'].source, 'shared'); assert.equal(eff['shopify␟pid:2'].source, 'local');
  assert.deepEqual(Object.keys(SO.loadLocal()), ['shopify␟pid:2'], 'local edits never copy the shared layer');
  assert.equal(SO.sharedVersion(), 4);
  assert.deepEqual(Object.keys(SO.exportForReview().overrides), ['shopify␟pid:2']);
  const c = PG.classifyRecord({ channel: 'shopify', productId: '1', title: 'Echeveria Lola', ptype: 'Succulents' },
    Object.assign({ override: PG.makeOverrideLookup(eff) }, O));
  assert.equal(c.group, 'Gifts');
});

