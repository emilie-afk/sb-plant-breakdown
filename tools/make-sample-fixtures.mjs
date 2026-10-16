// tools/make-sample-fixtures.mjs
//
// Builds the SYNTHETIC test fixtures in tests/fixtures/. Every store, vendor,
// product, figure, product id and ASIN in them is invented. They reproduce the
// LAYOUT of the real exports (column names and order, the repeated
// "(previous_period)" headers, Amazon's Total line, ...) and the situations the
// parsers must handle, not anyone's sales.
//
//   node tools/make-sample-fixtures.mjs
//
// Output is deterministic (seeded). tests/fixtures/sample-facts.json records the
// expected figures, computed here from the generator's own model — never from
// the parsers under test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrowserGlobals } from '../tests/load.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'fixtures');
const G = loadBrowserGlobals();

// ---- deterministic randomness ------------------------------------------
let s = 0x5eed2026;
function rnd() { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ---- money in integer cents ----------------------------------------------
const M = ['units', 'gross', 'disc', 'ret', 'net', 'tax', 'total'];
const zero = () => ({ units: 0, gross: 0, disc: 0, ret: 0, net: 0, tax: 0, total: 0 });
const isZero = (f) => M.every(k => f[k] === 0);
function figures(sold, returned, price, discRate, taxRate) {
  const gross = sold * price;
  const disc = -Math.round(gross * discRate);
  const ret = -returned * price;
  const net = gross + disc + ret;
  const tax = net > 0 ? Math.round(net * taxRate) : 0;
  return { units: sold - returned, gross, disc, ret, net, tax, total: net + tax };
}
const add = (a, b) => { const o = {}; for (const k of M) o[k] = a[k] + b[k]; return o; };
const money = (c) => String(Math.round(c) / 100);          // 918 / -99.44 / 37.5
const val = (f, k) => (k === 'units' ? String(f[k]) : money(f[k]));

// ---- the invented store -----------------------------------------------------
const OWN = 'Own Label', DROP = 'Dropship Supplier A', GIFT = 'Gift Maker Co', AIR = 'Air Plant Co',
      WHOLE = 'Wholesale Greenhouse', TREE = 'Tree Nursery B', MEM = 'Memorial Gifts Co', SHOPC = 'Houseplant Shop C', ROUTE = 'Route';

const CULTIVARS = ['Lola', 'Blue Bird', 'Perle', 'Raindrops', 'Black Prince', 'Topsy Turvy', 'Moonstone', 'Ice Queen', 'Sunset', 'Frosty',
  'Ruby', 'Coral', 'Jade', 'Velvet', 'Snow', 'Ember', 'Twilight', 'Aurora', 'Saffron', 'Cobalt', 'Opal', 'Pearl', 'Copper', 'Mint',
  'Lilac', 'Ivory', 'Onyx', 'Garnet', 'Citrine', 'Amber', 'Sapphire', 'Willow', 'Fable', 'Harbor', 'Meadow', 'Canyon', 'Glacier',
  'Prairie', 'Summit', 'Lagoon', 'Juniper', 'Marble', 'Cinder', 'Dune', 'Orchard', 'Tundra', 'Breeze', 'Ripple', 'Comet', 'Nova'];
const SIZES = ['2 inch', '3 inch', '4 inch', '6 inch'];
const SUCCULENT_GENERA = ['Echeveria', 'Haworthia', 'Sedum', 'Crassula', 'Senecio', 'Aloe', 'Gasteria', 'Kalanchoe', 'Graptoveria',
  'Pachyphytum', 'Sempervivum', 'Aeonium', 'Mammillaria', 'Opuntia', 'Euphorbia', 'Agave', 'Cotyledon', 'Adromischus', 'Lithops',
  'Ferocactus', 'Gymnocalycium', 'Echinopsis', 'Portulacaria', 'Anacampseros', 'Sedeveria', 'Graptopetalum', 'Mangave', 'Othonna'];
const HOUSE_GENERA = ['Philodendron', 'Monstera', 'Calathea', 'Maranta', 'Hoya', 'Peperomia', 'Dracaena', 'Ficus', 'Alocasia',
  'Anthurium', 'Spathiphyllum', 'Tradescantia', 'Aglaonema', 'Syngonium', 'Begonia', 'Scindapsus', 'Schefflera', 'Pilea',
  'Epipremnum', 'Zamioculcas', 'Nephrolepis', 'Asplenium', 'Chamaedorea', 'Codiaeum', 'Fittonia', 'Stromanthe', 'Pachira'];

const products = [];
let nextId = 0;
function product(title, vendor, ptype, o = {}) {
  nextId++;
  const p = { id: String(7100000000000 + nextId * 1013), title, vendor, ptype, kind: o.kind || 'plant',
              price: o.price || ri(600, 3200), channels: o.channels || null, published: o.published !== false,
              amazon: !!o.amazon, fixed: o.fixed || null };
  products.push(p);
  return p;
}

// Named anchors the tests refer to (all invented).
const A = {};
A.spider = product('Spider Plant Variegated 4 inch', DROP, 'Houseplants', { price: 1700,
  fixed: { cur: figures(40, 0, 1700, 0.10, 0.05), prior: figures(32, 0, 1700, 0.05, 0.05) } });
A.negative = product("Pothos 'Marble Queen' 4 inch", DROP, 'Houseplants', { price: 2950,
  fixed: { cur: figures(0, 1, 2950, 0, 0), prior: figures(3, 0, 2950, 0, 0.05) } });
A.lapsedNeg = product("Gasteria 'Little Warty'", DROP, 'Succulents', { price: 1800,
  fixed: { cur: zero(), prior: figures(0, 1, 1800, 0, 0) } });
A.dupTitles = ['String of Pearls - Senecio rowleyanus', 'Living Stones - Lithops Mix', 'String of Hearts - Ceropegia woodii', "Gasteria 'Little Warty'"];
A.pearlsOwn = product(A.dupTitles[0], OWN, 'Succulents', { price: 1400, amazon: true,
  fixed: { cur: figures(30, 0, 1400, 0.08, 0.04), prior: figures(22, 0, 1400, 0.05, 0.04) } });
A.pearlsDrop = product(A.dupTitles[0], DROP, 'Succulents', { price: 2200,
  fixed: { cur: figures(2, 0, 2200, 0.1, 0.05), prior: zero() } });
product(A.dupTitles[1], OWN, 'Succulents', { price: 1300 });
product(A.dupTitles[1], DROP, 'Succulents', { price: 2600 });
product(A.dupTitles[2], OWN, 'Succulents', { price: 1600 });
product(A.dupTitles[2], DROP, 'Succulents', { price: 2400 });
product(A.dupTitles[3], OWN, 'Succulents', { price: 900 });
A.blankPlant = product("Epiphyllum 'Zig Zag' Cactus", DROP, '', { price: 3400,
  fixed: { cur: figures(4, 0, 3400, 0.1, 0.05), prior: figures(2, 0, 3400, 0, 0.05) } });
A.blankPot = product('Glazed Ceramic Pot', OWN, '', { kind: 'pot', price: 1500 });
A.blankFert = product('Succulent Fertilizer (8 oz)', OWN, '', { kind: 'fert', price: 899 });
for (const t of ['Haworthia Fasciata Zebra 3 inch', "Crassula 'Hobbit'", 'Tillandsia Bulbosa Single', 'Mystery Cutting Bundle', 'Snake Plant Laurentii 6 inch'])
  product(t, pick([OWN, DROP]), '', { price: ri(800, 2400) });
product('Bonsai Jade Tree', TREE, '', { price: 4200 });
product('Peace Lily 6 inch', SHOPC, '', { price: 2700 });
A.unidentified = product('Pink Starlight', OWN, 'Succulents', { price: 1100 });
A.flagSub = product('Warming Pack (Subscription)', OWN, 'Fertilizers', { kind: 'acc', price: 450 });
A.flagCard = product('Gift Card - $25 | Plant Gift Card', OWN, 'Greeting Card', { kind: 'card', price: 2500 });
A.giftHeart = product('Heart Succulent Arrangement', GIFT, 'Gift', { kind: 'gift', price: 8200 });
A.giftWood = product('Wooden Planter Succulent Arrangement', GIFT, 'Gift', { kind: 'gift', price: 8000 });
A.route = product('Shipping Protection by Route', ROUTE, 'Insurance', { kind: 'route', price: 140, published: false,
  fixed: { cur: figures(310, 0, 140, 0.07, 0.001), prior: figures(298, 0, 140, 0.07, 0.001) } });
A.ambiguous = [product("Peperomia 'Pixie' 4 inch", DROP, 'Houseplants', { price: 1700 }),
               product("Dracaena 'Sunray' 6 inch", DROP, 'Houseplants', { price: 2600 })];

// Own Label: succulents (plenty of Echeveria, so search reaches past page 1),
// subscriptions, pots, accessories, fertilizer, tools, soil, cards, gift cards.
const ownTarget = 500;
const subTitles = ['1 Succulent / Month | Subscription Box', '2 Succulents / Month | Subscription Box', '3 Succulents / Month | Subscription Box',
  '4 Succulents / Month | Subscription Box', '1 Air Plant / Month | Subscription Box', '2 Succulents 2 Clay Pots / Month | Subscription Box'];
for (const base of subTitles) for (const plan of ['', ' - 3 month plan', ' - 6 month plan', ' - 12 month plan'])
  product(base + plan, OWN, 'Subscription', { kind: 'sub', price: ri(1400, 3600), published: false });
for (const t of ['Terracotta Pot 2.5 inch', 'Terracotta Pot 4 inch', 'Speckled Ceramic Planter', 'Hanging Planter Set', 'Concrete Planter Small',
  'Concrete Planter Large', 'Glazed Pot with Saucer', 'Self Watering Planter', 'Woven Basket Planter', 'Geometric Pot', 'Mini Pot Set of 6', 'Bamboo Planter'])
  product(t, OWN, 'Pots & Planters', { kind: 'pot', price: ri(500, 3200) });
for (const t of ['Macrame Plant Hanger', 'Moisture Meter', 'Wooden Plant Stand', 'Grow Light Clip', 'Plant Humidifier', 'Saucer Set'])
  product(t, OWN, 'Accessories', { kind: 'acc', price: ri(700, 3900) });
for (const t of ['Cactus Fertilizer 4 oz', 'Liquid Plant Food']) product(t, OWN, 'Fertilizers', { kind: 'fert', price: ri(600, 1400) });
for (const t of ['Succulent Tool Set', 'Long Tweezers', 'Repotting Mat']) product(t, OWN, 'Tools', { kind: 'tool', price: ri(600, 2400) });
for (const t of ['Gritty Succulent Soil Mix', 'Top Dressing Pebbles']) product(t, OWN, 'Soil', { kind: 'soil', price: ri(700, 1600) });
for (const t of ['Plant Care Greeting Card', 'Botanical Postcard Set']) product(t, OWN, 'Greeting Card', { kind: 'card', price: ri(300, 900) });
for (const t of ['Gift Card - $50', 'Gift Card - $100']) product(t, OWN, 'Gift Card', { kind: 'card', price: t.includes('100') ? 10000 : 5000 });
for (const t of ['Succulent Starter Kit', 'Terrarium Kit']) product(t, OWN, 'Kits', { kind: 'kit', price: ri(2500, 4500) });
let echeveriaLeft = 46;
let c = 0;
while (products.filter(p => p.vendor === OWN).length < ownTarget) {
  const genus = echeveriaLeft-- > 0 ? 'Echeveria' : SUCCULENT_GENERA[c % SUCCULENT_GENERA.length];
  const title = `${genus} '${CULTIVARS[c % CULTIVARS.length]}' ${SIZES[c % SIZES.length]}${c >= 200 ? ' Cluster' : ''}`;
  c++;
  if (products.some(p => p.title === title && p.vendor === OWN)) continue;
  product(title, OWN, rnd() < 0.85 ? 'Succulents' : 'Cactus', { price: ri(500, 2600), amazon: rnd() < 0.4 });
}
// Dropship Supplier A: houseplants plus a few accessories.
for (const t of ['Organic Insecticide', 'Clip-on Grow Light', 'USB Humidifier']) product(t, DROP, 'Accessories', { kind: 'acc', price: ri(1500, 4500) });
c = 0;
while (products.filter(p => p.vendor === DROP).length < 240) {
  const genus = HOUSE_GENERA[c % HOUSE_GENERA.length];
  const title = `${genus} '${CULTIVARS[(c * 7) % CULTIVARS.length]}' ${SIZES[(c + 1) % SIZES.length]}${c >= 300 ? ' Hanging' : ''}`;
  c++;
  if (products.some(p => p.title === title && p.vendor === DROP)) continue;
  product(title, DROP, pick(['Houseplants', 'Houseplants', 'Indoor Plants']), { price: ri(1200, 6500), amazon: rnd() < 0.2 });
}
// Small vendors.
for (const t of ['Mini Succulent Favors', 'Driftwood Succulent Arrangement', 'Rosette Arrangement with Dish', 'Moss Bowl Arrangement',
  'Terracotta Trio Arrangement', 'Large Round Arrangement', 'Tabletop Garden Arrangement']) product(t, GIFT, 'Gift', { kind: 'gift', price: ri(2400, 9500) });
const airTypes = ['Air Plant', 'Air Plants', 'Air PLants', 'AirPlant'];
c = 0;
while (products.filter(p => p.vendor === AIR).length < 31) {
  if (c < 4) product(['Hanging Glass Globe', 'Ceramic Hanging Planter', 'Metal Pendant Holder', 'Shell Display Dish'][c], AIR, 'Pots & Planters', { kind: 'pot', price: ri(800, 2400) });
  else if (c < 7) product(['Air Plant Terrarium Gift Box', 'Beach Terrarium Gift Set', 'Air Plant Bowl Gift Box'][c - 4], AIR, 'Gift', { kind: 'gift', price: ri(1800, 4400) });
  else product(`Tillandsia ${['Ionantha', 'Xerographica', 'Bulbosa', 'Caput-Medusae', 'Streptophylla', 'Tectorum', 'Juncea', 'Capitata'][c % 8]} ${['Single', 'Trio', 'Large', 'Red', 'Fuego'][c % 5]}`,
    AIR, airTypes[c % 4], { price: ri(400, 2500), amazon: rnd() < 0.3 });
  c++;
}
for (const t of ['Christmas Cactus 4 inch', 'Croton Petra 6 inch', 'Syngonium Red Arrow', 'Chinese Evergreen Siam', 'Crown of Thorns', 'Pothos Manjula'])
  product(t, WHOLE, pick(['Houseplants', 'Indoor Plants', 'Succulents']), { price: ri(1600, 5800) });
for (const t of ['Bird of Paradise Large', 'Fiddle Leaf Fig 10 inch', 'Olive Tree 8 inch', 'Money Tree Braided', 'Norfolk Pine 6 inch'])
  product(t, TREE, 'Indoor Plants', { price: ri(6000, 14000) });
for (const t of ['Dog Memorial Gift Box', 'Cat Memorial Gift Box', 'Birthday Succulent Gift Box', 'Sympathy Gift Box', 'Get Well Gift Box', 'Teacher Thank You Gift Box', 'Nurse Appreciation Gift Box'])
  product(t, MEM, 'Gift', { kind: 'gift', price: ri(3800, 6200) });
for (const t of ['African Violet Pink', 'Philodendron Red Heart']) product(t, SHOPC, 'Houseplants', { price: ri(1800, 3200) });
// A few products that sold but are not published to the Online Store.
for (const t of ['Retired Echeveria Sampler', 'Wholesale Rosette Flat']) product(t, OWN, 'Succulents', { published: false, price: ri(2000, 6000) });

// ---- figures for every product ------------------------------------------
const plantGenus = (t) => G.detectGenus(t);
let returnsBudget = 22;
for (const p of products) {
  if (p.fixed) { p.cur = p.fixed.cur; p.prior = p.fixed.prior; continue; }
  const r = rnd();
  const disc = pick([0, 0, 0.05, 0.08, 0.1, 0.15]);
  const tax = pick([0, 0.04, 0.06, 0.0725, 0.08]);
  const soldPrior = ri(1, p.kind === 'sub' ? 40 : 12);
  const soldCur = ri(1, p.kind === 'sub' ? 45 : 14);
  let ret = 0;
  if (returnsBudget > 0 && r > 0.45 && rnd() < 0.08) { ret = 1; returnsBudget--; }
  if (r < 0.27) { p.cur = zero(); p.prior = figures(soldPrior, 0, p.price, disc, tax); }          // stopped selling this period
  else if (r < 0.45) { p.cur = figures(soldCur, 0, p.price, disc, tax); p.prior = zero(); }        // new this period
  else { p.cur = figures(soldCur, ret, p.price, disc, tax); p.prior = figures(soldPrior, rnd() < 0.05 ? 1 : 0, p.price, pick([0, 0.05, 0.1]), tax); }
}

// ---- sales channels --------------------------------------------------------
const CH = ['Online Store', 'Sellbrite', 'Recharge Subscriptions', 'Facebook & Instagram', 'TikTok', 'Shop', 'Draft Orders'];
function weightsFor(p) {
  if (p.kind === 'sub') return { 'Recharge Subscriptions': 9, 'Online Store': 1 };
  if (p.kind === 'route') return { 'Online Store': 1 };
  const w = { 'Online Store': 70, 'Facebook & Instagram': 8, 'TikTok': 4, 'Shop': 4, 'Draft Orders': 2 };
  if (p.amazon) w.Sellbrite = 30;
  return w;
}
// Largest-remainder split of an integer over weights.
function splitInt(total, weights) {
  const keys = Object.keys(weights); const W = keys.reduce((a, k) => a + weights[k], 0);
  const raw = keys.map(k => total * weights[k] / W); const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < left; i++) base[order[i % order.length][1]]++;
  return Object.fromEntries(keys.map((k, i) => [k, base[i]]));
}
function splitFigures(f, p) {
  if (isZero(f)) return {};
  if (f.units <= 0 || f.net <= 0) return { 'Online Store': f };
  const u = splitInt(f.units, weightsFor(p));
  const active = Object.fromEntries(Object.entries(u).filter(([, v]) => v > 0));
  const out = {};
  const parts = {};
  for (const k of ['gross', 'disc', 'ret', 'tax']) {
    const sign = f[k] < 0 ? -1 : 1;
    parts[k] = splitInt(Math.abs(f[k]), active);
    for (const ch of Object.keys(active)) parts[k][ch] *= sign;
  }
  for (const ch of Object.keys(active)) {
    const g = parts.gross[ch], d = parts.disc[ch], r = parts.ret[ch], t = parts.tax[ch];
    out[ch] = { units: active[ch], gross: g, disc: d, ret: r, net: g + d + r, tax: t, total: g + d + r + t };
  }
  return out;
}
for (const p of products) {
  const c1 = splitFigures(p.cur, p), c0 = splitFigures(p.prior, p);
  p.byChannel = {};
  for (const ch of new Set([...Object.keys(c1), ...Object.keys(c0)])) p.byChannel[ch] = { cur: c1[ch] || zero(), prior: c0[ch] || zero() };
  if (!Object.keys(p.byChannel).length) p.byChannel['Online Store'] = { cur: zero(), prior: zero() };
}

// ---- CSV writing -------------------------------------------------------------
const q = (sv) => '"' + String(sv).replace(/"/g, '""') + '"';
const line = (cells) => cells.join(',');
const HEAD = ['Net items sold', 'Gross sales', 'Discounts', 'Sales reversals', 'Net sales', 'Taxes', 'Total sales'];
function pct(cur, prev, k) {
  if (prev === 0) return '';
  const p = (cur - prev) / Math.abs(prev) * 100;
  return String(k === 'units' ? p : Number(p.toFixed(3)));
}
const byTotalDesc = (a, b) => (b.cur.total - a.cur.total) || (b.prior.total - a.prior.total) || a.title.localeCompare(b.title) || a.vendor.localeCompare(b.vendor);

// 1) Shopify built-in "Total sales by product", compared to the previous period.
{
  const head = ['Product title', 'Product vendor', 'Product type'].concat(HEAD, HEAD.map(h => h + ' (previous_period)'), HEAD.map(h => h + ' (previous_period) '));
  const rows = products.slice().sort(byTotalDesc).map(p => line([q(p.title), q(p.vendor), q(p.ptype)]
    .concat(M.map(k => val(p.cur, k)), M.map(k => val(p.prior, k)), M.map(k => pct(p.cur[k], p.prior[k], k)))));
  fs.writeFileSync(path.join(OUT, 'shopify-total-sales-by-product-sample.csv'), line(head.map(q)) + '\n' + rows.join('\n') + '\n');
}
// 2) The saved "+ ID" report (another period, no comparison).
const idPeriod = new Map();
{
  for (const p of products) {
    if (p.kind === 'route') { idPeriod.set(p, figures(330, 0, 140, 0.07, 0.001)); continue; }
    if (rnd() < 0.27) continue;
    idPeriod.set(p, figures(ri(1, p.kind === 'sub' ? 45 : 15), 0, p.price, pick([0, 0.05, 0.1]), pick([0, 0.05, 0.08])));
  }
  const head = ['Product ID', 'Product title', 'Product vendor', 'Product type'].concat(HEAD);
  const rows = [...idPeriod.entries()].sort((a, b) => b[1].total - a[1].total).map(([p, f]) =>
    line([p.id, q(p.title), q(p.vendor), q(p.ptype)].concat(M.map(k => val(f, k)))));
  fs.writeFileSync(path.join(OUT, 'shopify-total-sales-by-product-with-id-sample.csv'), line(head.map(q)) + '\n' + rows.join('\n') + '\n');
}
// 3) The saved report grouped by sales channel, same period as (1).
const channelRows = [];
{
  for (const p of products) for (const [ch, f] of Object.entries(p.byChannel)) channelRows.push({ p, ch, cur: f.cur, prior: f.prior });
  channelRows.sort((a, b) => (b.cur.total - a.cur.total) || a.p.id.localeCompare(b.p.id) || a.ch.localeCompare(b.ch));
  const head = ['Product ID', 'Product title', 'Product vendor', 'Product type', 'Sales channel'].concat(HEAD, HEAD.map(h => h + ' (previous_period)'));
  const rows = channelRows.map(r => line([r.p.id, q(r.p.title), q(r.p.vendor), q(r.p.ptype), q(r.ch)].concat(M.map(k => val(r.cur, k)), M.map(k => val(r.prior, k)))));
  fs.writeFileSync(path.join(OUT, 'shopify-sales-channel-sample.csv'), line(head.map(q)) + '\n' + rows.join('\n') + '\n');
}
// 4) Storefront catalog (slimmed products.json): published products, a few
//    duplicated title+vendor pairs, catalog-only products, repeated SKUs.
const catalog = { schema: 'shopify-storefront-products/v1', source: 'https://example-store.myshopify.com/products.json',
  fetchedAt: '2026-01-15T00:00:00.000Z', scope: 'Products published to the Online Store sales channel only', limits: 2, products: [] };
{
  let sku = 1000, vid = 0;
  const skuPool = [];
  const variantsFor = (n) => Array.from({ length: n }, (_, i) => {
    vid++;
    let code = 'SKU-' + (sku++);
    if (skuPool.length > 3 && rnd() < 0.06) code = pick(skuPool); else skuPool.push(code);
    return { id: String(4200000000000 + vid * 7), sku: code, title: ['Default Title', 'Small', 'Medium', 'Large'][i % 4] };
  });
  const handle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const p of products) if (p.published)
    catalog.products.push({ id: p.id, handle: handle(p.title + '-' + p.vendor), title: p.title, vendor: p.vendor, productType: p.ptype,
      publishedAt: '2025-06-01T00:00:00Z', variants: variantsFor(ri(1, 4)) });
  for (const p of A.ambiguous) {      // a second catalog product with the same title and vendor
    nextId++;
    catalog.products.push({ id: String(7100000000000 + nextId * 1013), handle: handle(p.title) + '-copy', title: p.title, vendor: p.vendor,
      productType: p.ptype, publishedAt: '2025-06-01T00:00:00Z', variants: variantsFor(1) });
  }
  for (let i = 0; i < 400; i++) {     // listed but not in these reports
    nextId++;
    const t = `${pick(SUCCULENT_GENERA.concat(HOUSE_GENERA))} '${pick(CULTIVARS)}' Catalog Item ${i + 1}`;
    catalog.products.push({ id: String(7100000000000 + nextId * 1013), handle: handle(t), title: t, vendor: pick([OWN, DROP, AIR]),
      productType: 'Succulents', publishedAt: '2025-06-01T00:00:00Z', variants: variantsFor(ri(1, 3)) });
  }
  catalog.productCount = catalog.products.length;
  catalog.variantCount = catalog.products.reduce((a, p) => a + p.variants.length, 0);
  fs.writeFileSync(path.join(OUT, 'shopify-catalog-sample.json'), JSON.stringify(catalog));
}

// ---- Amazon -------------------------------------------------------------------
// Listing titles are keyword-heavy like real marketplace titles. Every plant
// title is checked against the app's genus detector so coverage is real.
const AMZ_GENERA = SUCCULENT_GENERA.concat(HOUSE_GENERA, ['Tillandsia', 'Sansevieria', 'Chlorophytum', 'Aechmea', 'Guzmania',
  'Rhipsalis', 'Ceropegia', 'Dudleya', 'Faucaria', 'Pleiospilos', 'Titanopsis', 'Stapelia', 'Huernia', 'Orostachys', 'Delosperma',
  'Astrophytum', 'Parodia', 'Rebutia', 'Cereus', 'Pachypodium', 'Adenium', 'Yucca', 'Beaucarnea', 'Hedera', 'Saxifraga', 'Ludisia']);
const SUFFIX = ['Live Plant in Grower Pot, Easy Care Indoor Plant', 'Live Succulent, Rare Variety, Great Gift Ideas for Plant Lovers',
  'Real Live Plant for Home and Office Decor', 'Fully Rooted Live Plant, Ships in Pot', 'Low Light Indoor Plant, Air Purifying'];
const NONPLANT_TITLES = ['Terracotta Pots with Saucer, Set of 6 Small Clay Pots for Succulents', 'Gritty Succulent Soil Mix, 2 Quart Potting Mix for Cactus',
  'Ceramic Planter with Drainage Hole, 4 inch White Pot', 'Succulent Fertilizer, Slow Release Plant Food 8 oz', 'Hanging Planter Set of 3, Macrame Hangers Included'];
const amz = [];
let asinN = 0;
const asin = () => 'B0SMPL' + (asinN++).toString(36).toUpperCase().padStart(4, '0');
for (let i = 0; amz.length < 360; i++) {
  const g = AMZ_GENERA[i % AMZ_GENERA.length];
  const t = i % 9 === 4 ? NONPLANT_TITLES[(i / 9 | 0) % NONPLANT_TITLES.length] + ` (${CULTIVARS[i % CULTIVARS.length]})`
                        : `${g} '${CULTIVARS[(i * 3) % CULTIVARS.length]}' ${SIZES[i % SIZES.length]}, ${SUFFIX[i % SUFFIX.length]}`;
  if (i % 9 !== 4 && plantGenus(t) === '') throw new Error('genus not detected for generated title: ' + t);
  amz.push({ asin: asin(), title: t });
}
// v1 (one month): featured-offer glance views, no revenue, no inventory.
// v2 (year to date, contains that month): glance views, revenue, all-zero inventory.
const sellbriteUnits = channelRows.filter(r => r.ch === 'Sellbrite').reduce((a, r) => a + r.cur.units, 0);
const v1Target = sellbriteUnits + 7;            // Seller Central and Sellbrite differ slightly
const v1Sold = amz.filter((_, i) => i % 3 !== 2).slice(0, 140);
const v1Units = new Map(amz.map(a => [a.asin, 0]));
for (let u = 0; u < v1Target; u++) { const a = v1Sold[u % v1Sold.length]; v1Units.set(a.asin, v1Units.get(a.asin) + 1); }
const v1 = amz.slice(0, 300).map(a => {
  const units = v1Units.get(a.asin) || 0;
  const glance = units ? units * ri(18, 45) : (rnd() < 0.5 ? ri(0, 9) : 0);
  const shipped = Math.max(0, units - (rnd() < 0.08 ? 1 : 0));
  return { ...a, units, glance, shipped, conv: glance ? units / glance : 0, foRate: glance ? Number((0.8 + rnd() * 0.2).toFixed(2)) : 0 };
});
for (const a of v1Sold) if (!v1.find(x => x.asin === a.asin)) throw new Error('v1 sold ASIN outside v1 rows');
const v1T = v1.reduce((t, r) => ({ units: t.units + r.units, glance: t.glance + r.glance, shipped: t.shipped + r.shipped }), { units: 0, glance: 0, shipped: 0 });
{
  const head = ['ASIN', 'Item name', 'Conversion rate (%)', 'Featured Offer glance views', 'Featured Offer rate', 'Ordered units', 'Shipped units'];
  const rows = [line(['Total', '', String(Number((v1T.units / v1T.glance).toFixed(4))), String(v1T.glance), '0.96', String(v1T.units), String(v1T.shipped)])]
    .concat(v1.map(r => line([r.asin, q(r.title), String(Number(r.conv.toFixed(4))), String(r.glance), String(r.foRate), String(r.units), String(r.shipped)])));
  fs.writeFileSync(path.join(OUT, 'amazon-metric-data-v1-sample.csv'), line(head) + '\n' + rows.join('\n') + '\n');
}
const priceOf = new Map(amz.map(a => [a.asin, ri(600, 3500)]));
const v2 = amz.map((a, i) => {
  const units = (v1Units.get(a.asin) || 0) + (rnd() < 0.85 ? ri(0, 25) : 0);
  const glance = units ? units * ri(20, 50) : ri(1, 30);
  const shipped = units + (rnd() < 0.1 ? 1 : 0) - (units && rnd() < 0.1 ? 1 : 0);
  const price = priceOf.get(a.asin);
  const rev = units * price, shippedRev = shipped * price;
  const orderItems = units ? Math.max(1, units - ri(0, Math.floor(units / 4))) : 0;
  return { ...a, units, glance, shipped, rev, shippedRev, orderItems, asp: shipped ? Math.round(shippedRev / shipped) : 0 };
});
// Named v2 anchor: ordered and shipped figures differ.
A.amzIvy = v2[5];
Object.assign(A.amzIvy, { units: Math.max(4, (v1Units.get(A.amzIvy.asin) || 0)), shipped: 6, orderItems: 3 });
A.amzIvy.rev = A.amzIvy.units * 890; A.amzIvy.shippedRev = 5340; A.amzIvy.asp = 890; A.amzIvy.glance = A.amzIvy.units * 25;
const v2T = v2.reduce((t, r) => ({ units: t.units + r.units, glance: t.glance + r.glance, shipped: t.shipped + r.shipped,
  rev: t.rev + r.rev, shippedRev: t.shippedRev + r.shippedRev, orderItems: t.orderItems + r.orderItems }),
  { units: 0, glance: 0, shipped: 0, rev: 0, shippedRev: 0, orderItems: 0 });
{
  const head = ['ASIN', 'Item name', 'Glance views', 'Conversion rate (%)', 'Shipped units', 'Average selling price ($)', 'Shipped revenue ($)',
    'Available Inventory Units', 'Ordered revenue ($)', 'Total order items', 'Units per Order Item', 'Ordered units'];
  const conv = (u, g) => String(g ? Number((u / g).toFixed(4)) : 0);
  const rows = [line(['Total', '', String(v2T.glance), conv(v2T.units, v2T.glance), String(v2T.shipped), money(Math.round(v2T.shippedRev / v2T.shipped)),
    money(v2T.shippedRev), '0', money(v2T.rev), String(v2T.orderItems), String(Number((v2T.units / v2T.orderItems).toFixed(2))), String(v2T.units)])]
    .concat(v2.map(r => line([r.asin, q(r.title), String(r.glance), conv(r.units, r.glance), String(r.shipped), money(r.asp), money(r.shippedRev), '0',
      money(r.rev), String(r.orderItems), r.orderItems ? String(Number((r.units / r.orderItems).toFixed(2))) : '0', String(r.units)])));
  fs.writeFileSync(path.join(OUT, 'amazon-metric-data-v2-sample.csv'), line(head) + '\n' + rows.join('\n') + '\n');
}
// Referee: an order-report extract for the v1 month (ASIN, title, units, sales only).
const orders = v1.filter(r => r.units > 0).map(r => ({ asin: r.asin, title: r.title, units: r.units, avg: priceOf.get(r.asin) }));
{
  const head = ['ASIN', 'Item name', 'Glance Views', 'Unit Session Percentage', 'Units Ordered', 'Average Sales Price', 'Ordered Product Sales', 'Available Inventory'];
  const rows = orders.map(o => line([o.asin, q(o.title), '', '', String(o.units), money(o.avg), money(o.units * o.avg), '']));
  fs.writeFileSync(path.join(OUT, 'amazon-order-extract-sample.csv'), line(head) + '\n' + rows.join('\n') + '\n');
}

// ---- facts (from the model, not from the parsers) ---------------------------
const tot = (list, f) => list.reduce((t, x) => add(t, f(x)), zero());
const cents = (f) => Object.fromEntries(M.map(k => [k, k === 'units' ? f[k] : f[k] / 100]));
const curT = tot(products, p => p.cur), priorT = tot(products, p => p.prior);
const incl = products.filter(p => p.vendor !== ROUTE);
const vendors = {};
for (const p of products) {
  const v = vendors[p.vendor] || (vendors[p.vendor] = { rows: 0, net: 0 });
  v.rows++; v.net += p.cur.net;
}
for (const v of Object.values(vendors)) v.net /= 100;
const anchor = (p) => ({ id: p.id, title: p.title, vendor: p.vendor, ptype: p.ptype, cur: cents(p.cur), prior: cents(p.prior) });
const own = channelRows.filter(r => r.ch !== 'Sellbrite'), sb = channelRows.filter(r => r.ch === 'Sellbrite');
const sortedRows = products.slice().sort(byTotalDesc);
const idList = [...idPeriod.entries()];
const idT = tot(idList, ([, f]) => f);
const published = new Set(catalog.products.map(p => p.id));
const notInCatalogId = idList.filter(([p]) => !published.has(p.id)).length;
const skuCount = {};
for (const p of catalog.products) for (const v of p.variants) skuCount[v.sku] = (skuCount[v.sku] || 0) + 1;
const facts = {
  _note: 'Computed by tools/make-sample-fixtures.mjs from its own model. All data is synthetic.',
  shopify: {
    rows: products.length, included: incl.length, cur: cents(curT), prior: cents(priorT),
    includedNet: tot(incl, p => p.cur).net / 100, routeNet: A.route.cur.net / 100, routeUnits: A.route.cur.units,
    firstRowUnits: sortedRows[0].cur.units,
    zeroRows: products.filter(p => p.cur.units === 0 && p.cur.net === 0).length,
    returnRows: products.filter(p => p.cur.ret !== 0).length,
    blankTypes: products.filter(p => !p.ptype).length,
    newRows: products.filter(p => p.prior.net === 0 && p.cur.net !== 0).length,
    vendors, vendorCount: Object.keys(vendors).length,
    anchors: { spider: anchor(A.spider), negative: anchor(A.negative), lapsedNegative: anchor(A.lapsedNeg),
      pearlsOwn: anchor(A.pearlsOwn), pearlsDrop: anchor(A.pearlsDrop), blankPlant: anchor(A.blankPlant),
      blankPot: anchor(A.blankPot), blankFert: anchor(A.blankFert), unidentified: anchor(A.unidentified),
      flagSub: anchor(A.flagSub), flagCard: anchor(A.flagCard), giftHeart: anchor(A.giftHeart), giftWood: anchor(A.giftWood),
      route: anchor(A.route), ambiguous: A.ambiguous.map(p => p.title).sort() },
    duplicateTitles: A.dupTitles, vendorNames: { own: OWN, drop: DROP, gift: GIFT, air: AIR, route: ROUTE }
  },
  withId: { rows: idList.length, cur: cents(idT), notInCatalog: notInCatalogId, matchedById: idList.length - notInCatalogId },
  channel: { rows: channelRows.length, products: products.length, cur: cents(tot(channelRows, r => r.cur)), prior: cents(tot(channelRows, r => r.prior)),
    own: cents(tot(own, r => r.cur)), amazon: cents(tot(sb, r => r.cur)), amazonRows: sb.length,
    amazonProducts: new Set(sb.map(r => r.p.id)).size, ownProducts: new Set(own.map(r => r.p.id)).size,
    channels: [...new Set(channelRows.map(r => r.ch))].sort() },
  catalog: { products: catalog.products.length, duplicatedSkus: Object.values(skuCount).filter(n => n > 1).length,
    septNotInCatalog: products.filter(p => !p.published).length, septAmbiguous: A.ambiguous.length },
  amazon: {
    v1: { rows: v1.length, units: v1T.units, glance: v1T.glance, shipped: v1T.shipped, conv: Number((v1T.units / v1T.glance).toFixed(4)), firstAsin: v1[0].asin },
    v2: { rows: v2.length, units: v2T.units, glance: v2T.glance, shipped: v2T.shipped, orderItems: v2T.orderItems,
      orderedRevenue: v2T.rev / 100, shippedRevenue: v2T.shippedRev / 100, conv: Number((v2T.units / v2T.glance).toFixed(4)),
      withTraffic: v2.filter(r => r.glance > 0).length,
      ivy: { asin: A.amzIvy.asin, rev: A.amzIvy.rev / 100, units: A.amzIvy.units, shippedRev: A.amzIvy.shippedRev / 100, shipped: A.amzIvy.shipped, orderItems: A.amzIvy.orderItems } },
    orders: { rows: orders.length, units: orders.reduce((a, o) => a + o.units, 0) },
    sellbriteUnits
  }
};
fs.writeFileSync(path.join(OUT, 'sample-facts.json'), JSON.stringify(facts, null, 2) + '\n');
console.log('written:', fs.readdirSync(OUT).filter(f => /sample/.test(f)).join(', '));
console.log('shopify rows', facts.shopify.rows, 'net', facts.shopify.cur.net, '| channel rows', facts.channel.rows, '| amazon v1', facts.amazon.v1.units, 'v2', facts.amazon.v2.units);
