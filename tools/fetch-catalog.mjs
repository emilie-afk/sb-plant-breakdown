// tools/fetch-catalog.mjs
// Fetch the store's public catalog from the Online Store's /products.json and
// write a slim, validated catalog snapshot.
//
//   node tools/fetch-catalog.mjs --store https://your-store.example [--out catalog.json]
//
// No Shopify API, no app, no token: /products.json is the storefront's own
// public JSON. That also defines its limits, which travel with the output:
//   - Only products PUBLISHED TO THE ONLINE STORE appear. Drafts, archived
//     products and products sold only on other channels are absent, so "not
//     in this catalog" never means "does not exist".
//   - A variant's `available` means purchasable right now, not a stock count.
//     It is kept, labelled as such, and never used as inventory.
//   - body_html, images and options are dropped; nothing about customers is
//     ever present in this endpoint.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
if (!args.store || args.store === true) { console.error('Usage: node tools/fetch-catalog.mjs --store https://your-store.example [--out catalog.json]'); process.exit(2); }
const STORE = String(args.store).replace(/\/+$/, '');
const OUT = path.resolve(String(args.out || 'catalog.json'));
const PAGE_SIZE = 250;          // the endpoint's maximum
const MAX_PAGES = 200;          // 50,000 products; a guard against an endless loop
const PAUSE_MS = 400;           // be polite to the storefront

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function slimProduct(p) {
  return {
    id: String(p.id),
    handle: p.handle || '',
    title: String(p.title || '').trim(),
    vendor: String(p.vendor || '').trim(),
    productType: String(p.product_type || '').trim(),
    tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',').map(t => t.trim()).filter(Boolean),
    publishedAt: p.published_at || null,
    createdAt: p.created_at || null,
    updatedAt: p.updated_at || null,
    variants: (p.variants || []).map(v => ({
      id: String(v.id),
      title: v.title || '',
      sku: v.sku ? String(v.sku).trim() : '',
      price: v.price != null ? Number(v.price) : null,
      purchasableNow: !!v.available,       // NOT inventory
      grams: v.grams != null ? Number(v.grams) : null
    }))
  };
}

export function validateCatalog(products) {
  const errors = [], warnings = [];
  const ids = new Set(), handles = new Set();
  for (const p of products) {
    if (!/^\d+$/.test(p.id)) errors.push(`Product without a numeric id: "${p.title}"`);
    if (ids.has(p.id)) errors.push(`Duplicate product id ${p.id}`);
    ids.add(p.id);
    if (p.handle && handles.has(p.handle)) warnings.push(`Duplicate handle ${p.handle}`);
    handles.add(p.handle);
    if (!p.title) warnings.push(`Product ${p.id} has no title`);
    if (!p.variants.length) warnings.push(`Product ${p.id} has no variants`);
  }
  const skus = products.flatMap(p => p.variants.map(v => v.sku)).filter(Boolean);
  const dupSkus = [...new Set(skus.filter((s, i) => skus.indexOf(s) !== i))];
  if (dupSkus.length) warnings.push(`${dupSkus.length} SKU(s) appear on more than one variant, e.g. ${dupSkus.slice(0, 5).join(', ')}`);
  return { ok: errors.length === 0, errors, warnings, duplicateSkus: dupSkus };
}

export async function fetchCatalog(store = STORE, fetchImpl = fetch) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${store}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    let res, attempt = 0;
    for (;;) {
      res = await fetchImpl(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'sb-plant-breakdown catalog fetch' } });
      if (res.status === 429 || res.status >= 500) {
        if (++attempt > 4) throw new Error(`products.json page ${page}: HTTP ${res.status} after retries`);
        await sleep(1500 * attempt);
        continue;
      }
      break;
    }
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.products)) throw new Error(`products.json page ${page}: unexpected shape`);
    if (!body.products.length) break;
    all.push(...body.products.map(slimProduct));
    if (body.products.length < PAGE_SIZE) break;
    await sleep(PAUSE_MS);
  }
  return all;
}

async function main() {
  const started = new Date().toISOString();
  const products = await fetchCatalog(STORE);
  const check = validateCatalog(products);
  const snapshot = {
    schema: 'shopify-storefront-products/v1',
    source: `${STORE}/products.json`,
    fetchedAt: started,
    scope: 'Products published to the Online Store sales channel only',
    limits: [
      'Drafts, archived products and products not published to the Online Store are absent.',
      'variants[].purchasableNow is storefront availability, not an inventory count.'
    ],
    productCount: products.length,
    variantCount: products.reduce((s, p) => s + p.variants.length, 0),
    validation: check,
    products
  };
  fs.writeFileSync(OUT, JSON.stringify(snapshot));
  console.log(JSON.stringify({
    out: OUT, products: snapshot.productCount, variants: snapshot.variantCount,
    ok: check.ok, errors: check.errors.slice(0, 5), warnings: check.warnings.slice(0, 5)
  }, null, 2));
  if (!check.ok) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(path.basename(process.argv[1] || ''))) {
  main().catch(e => { console.error('catalog fetch failed:', e.message); process.exitCode = 1; });
}
