// worker/src/vendormap.js — the shared product -> vendor map.
//
// Built by the collector from the Products Master vendor tabs and the store's
// public catalog (vendor-master.js), stored as the setting "vendor_map", read
// by every dashboard with the read-only viewer key. Product ids, titles and
// vendor names only: nothing customer-related is accepted.
//
// A new map never silently replaces a good one with a broken read: when far
// fewer products resolve from the Products Master than in the stored map (a
// tab renamed, a column moved), the upload is refused unless `force` is set.

export const VENDOR_MAP_SCHEMA = "sb-vendor-map/v1";
const MAX_ENTRIES = 50000;
const MAX_REVIEW = 20000;
const MAX_TITLES = 100000;
const BASES = new Set(["keep", "pid", "handle", "sku", "title", "prefix", "type"]);
const CUSTOMER_RE = /(customer|buyer|recipient|e-?mail|phone|address)/i;

const str = (v, n) => String(v == null ? "" : v).slice(0, n);

// -> { ok, errors, value } (value = the cleaned map to store)
export function validateVendorMap(m) {
  const errors = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, errors: ["not an object"] };
  if (m.schema !== VENDOR_MAP_SCHEMA) errors.push("schema must be " + VENDOR_MAP_SCHEMA);
  const keys = Object.keys(m.entries || {});
  if (!keys.length) errors.push("no entries");
  if (keys.length > MAX_ENTRIES) errors.push("too many entries");
  const entries = {};
  for (const id of keys) {
    const e = m.entries[id];
    if (!/^\d{1,20}$/.test(id)) { errors.push("bad product id " + str(id, 30)); break; }
    if (!e || typeof e.v !== "string" || !e.v.trim() || !BASES.has(e.b)) { errors.push("bad entry for " + id); break; }
    entries[id] = { v: str(e.v.trim(), 80), b: e.b, s: str(e.s, 80) };
  }
  const review = Array.isArray(m.review) ? m.review.slice(0, MAX_REVIEW).map(r => ({
    id: str(r && r.id, 20), title: str(r && r.title, 200), shopifyVendor: str(r && r.shopifyVendor, 80),
    basis: ["conflict", "unresolved", "prefix"].includes(r && r.basis) ? r.basis : "unresolved",
    vendor: r && r.vendor ? str(r.vendor, 80) : undefined,
    candidates: Array.isArray(r && r.candidates) ? r.candidates.slice(0, 10).map(c => str(c, 80)) : undefined
  })) : [];
  const tabs = Array.isArray(m.tabs) ? m.tabs.slice(0, 100).map(t => ({
    label: str(t && t.label, 80), vendor: str(t && t.vendor, 80), rows: +t.rows || 0, skus: +t.skus || 0,
    links: +t.links || 0, names: +t.names || 0, problems: Array.isArray(t && t.problems) ? t.problems.slice(0, 5).map(p => str(p, 120)) : []
  })) : [];
  const titles = {};
  const tk = Object.keys(m.titles && typeof m.titles === "object" ? m.titles : {});
  if (tk.length > MAX_TITLES) errors.push("too many titles");
  for (const k of tk.slice(0, MAX_TITLES)) {
    const v = m.titles[k];
    if (typeof v === "string" && v.trim() && k.length <= 200) titles[k] = str(v.trim(), 80);
  }
  const typeVendors = {};
  if (m.typeVendors && typeof m.typeVendors === "object") {
    for (const k of Object.keys(m.typeVendors).slice(0, 50)) {
      if (typeof m.typeVendors[k] === "string" && m.typeVendors[k].trim()) typeVendors[str(k, 80)] = str(m.typeVendors[k].trim(), 80);
    }
  }
  const vendorAliases = {};
  if (m.vendorAliases && typeof m.vendorAliases === "object") {
    for (const k of Object.keys(m.vendorAliases).slice(0, 50)) {
      if (typeof m.vendorAliases[k] === "string" && m.vendorAliases[k].trim()) vendorAliases[str(k, 80)] = str(m.vendorAliases[k].trim(), 80);
    }
  }
  if (JSON.stringify(Object.assign({}, m, { titles: undefined })).match(/"[^"]*"\s*:/g)?.some(k => CUSTOMER_RE.test(k))) errors.push("customer-looking field refused");
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], value: {
    schema: VENDOR_MAP_SCHEMA, generatedAt: str(m.generatedAt, 40), catalogProducts: +m.catalogProducts || 0,
    keepShopifyVendors: Array.isArray(m.keepShopifyVendors) ? m.keepShopifyVendors.slice(0, 20).map(v => str(v, 80)) : [],
    counts: m.counts && typeof m.counts === "object" ? {
      resolved: +m.counts.resolved || 0, kept: +m.counts.kept || 0, byPrefix: +m.counts.byPrefix || 0,
      conflicts: +m.counts.conflicts || 0, unresolved: +m.counts.unresolved || 0 } : {},
    vendorAliases, typeVendors, titles, tabs, entries, review
  } };
}

// Products resolved from the Products Master (not merely kept from Shopify).
const fromMaster = (m) => Object.values((m && m.entries) || {}).filter(e => e.b !== "keep").length;

// -> null when fine, or a reason to refuse.
export function suspiciousDrop(next, previous, minShare = 0.8) {
  const before = fromMaster(previous), after = fromMaster(next);
  if (before > 20 && after < before * minShare) {
    return `only ${after} products resolved from Products Master, down from ${before}; a tab or column may have changed (send force:true to replace anyway)`;
  }
  return null;
}
