// collector/src/vendormap.mjs — the product -> vendor map from the Products Master.
//
// Once a day (config vendorMaster.refreshHours, default 20) the collector:
//   1. reads the configured vendor tabs of the Products Master Google Sheet
//      (its public CSV export; no Google sign-in, no API key),
//   2. reads the store's public catalog (/products.json: product ids, handles,
//      titles, current Shopify vendor, variant SKUs),
//   3. builds the map with vendor-master.js and uploads it to the Worker
//      (POST /v1/ingest/vendor-map, stored as the setting "vendor_map").
// Every dashboard then shows each product under its Products Master vendor,
// keeping the Shopify vendor beside it. A failure here never stops the sales
// collection: the previous map stays in use and the dashboard shows its age.
// The sheet id and tab ids live in config.local.json only, never in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VM = require(path.join(HERE, '..', '..', 'vendor-master.js'));

export const VENDOR_MAP_PATH = '/v1/ingest/vendor-map';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function validateVendorMasterConfig(vm) {
  const errs = [];
  if (vm == null) return errs;
  if (typeof vm !== 'object') return ['vendorMaster must be an object.'];
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(vm.sheetId || ''))) errs.push('vendorMaster.sheetId must be the Google Sheet id.');
  try { if (new URL(vm.storeUrl).protocol !== 'https:') errs.push('vendorMaster.storeUrl must be https.'); }
  catch { errs.push('vendorMaster.storeUrl must be the storefront URL (https://...).'); }
  if (!Array.isArray(vm.tabs) || !vm.tabs.length) errs.push('vendorMaster.tabs must list the vendor tabs.');
  else vm.tabs.forEach((t, i) => {
    if (!/^\d{1,12}$/.test(String(t.gid || ''))) errs.push(`vendorMaster.tabs[${i}].gid must be the tab's numeric gid.`);
    if (!t.vendor || typeof t.vendor !== 'string') errs.push(`vendorMaster.tabs[${i}].vendor is required.`);
    if (![].concat(t.sku || [], t.name || [], t.link || []).length) errs.push(`vendorMaster.tabs[${i}] needs sku, name or link columns.`);
  });
  if (vm.keepShopifyVendors != null && !Array.isArray(vm.keepShopifyVendors)) errs.push('vendorMaster.keepShopifyVendors must be a list.');
  if (vm.typeVendors != null && (typeof vm.typeVendors !== 'object' || Array.isArray(vm.typeVendors))) errs.push('vendorMaster.typeVendors must map a product type to a vendor.');
  if (vm.vendorAliases != null && (typeof vm.vendorAliases !== 'object' || Array.isArray(vm.vendorAliases) ||
      Object.values(vm.vendorAliases).some(v => typeof v !== 'string' || !v.trim()))) errs.push('vendorMaster.vendorAliases must map a Shopify vendor name to the vendor to show.');
  return errs;
}

// One tab as CSV. A private or missing sheet answers with an HTML page, which
// is refused rather than read as data.
export async function fetchSheetTab(sheetId, gid, fetchImpl = fetch) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Products Master tab ${gid}: HTTP ${res.status}`);
  const ct = String(res.headers.get('content-type') || '');
  const text = await res.text();
  if (!/text\/csv/i.test(ct) || /^\s*<!doctype html|<html/i.test(text)) throw new Error(`Products Master tab ${gid}: not a CSV (is the sheet still shared publicly?)`);
  return text;
}

export async function fetchStoreCatalog(storeUrl, fetchImpl = fetch, { pageSize = 250, maxPages = 200, pauseMs = 400 } = {}) {
  const base = String(storeUrl).replace(/\/+$/, '');
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    let res, attempt = 0;
    for (;;) {
      res = await fetchImpl(`${base}/products.json?limit=${pageSize}&page=${page}`, { headers: { Accept: 'application/json' } });
      if ((res.status === 429 || res.status >= 500) && ++attempt <= 4) { await sleep(1500 * attempt); continue; }
      break;
    }
    if (!res.ok) throw new Error(`products.json page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.products)) throw new Error(`products.json page ${page}: unexpected shape`);
    if (!body.products.length) break;
    for (const p of body.products) {
      all.push({ id: String(p.id), handle: p.handle || '', title: String(p.title || '').trim(), vendor: String(p.vendor || '').trim(),
                 productType: String(p.product_type || '').trim(),
                 variants: (p.variants || []).map(v => ({ sku: v.sku ? String(v.sku).trim() : '' })) });
    }
    if (body.products.length < pageSize) break;
    await sleep(pauseMs);
  }
  return all;
}

export async function buildVendorMapFromSources(vm, { fetchImpl = fetch, now = new Date() } = {}) {
  const tabs = [];
  for (const t of vm.tabs) {
    const text = await fetchSheetTab(vm.sheetId, t.gid, fetchImpl);
    tabs.push({ label: t.label || t.vendor, vendor: t.vendor, sku: t.sku, name: t.name, link: t.link, skuPrefix: t.skuPrefix,
                rows: VM.vendorParseCsv(text) });
  }
  const catalog = await fetchStoreCatalog(vm.storeUrl, fetchImpl);
  if (!catalog.length) throw new Error('the store catalog came back empty');
  const map = VM.buildVendorMap(catalog, tabs, { keepShopifyVendors: vm.keepShopifyVendors || [], vendorAliases: vm.vendorAliases || {}, typeVendors: vm.typeVendors || {}, now: now.toISOString() });
  const problems = VM.checkVendorMap(map, null);
  return { map, problems };
}

export async function uploadVendorMap(map, { workerUrl, secret, fetchImpl = fetch, force = false }) {
  const u = new URL(workerUrl);
  const res = await fetchImpl(u.origin + VENDOR_MAP_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
    body: JSON.stringify({ map, force })
  });
  let json = null; try { json = await res.json(); } catch { /* not json */ }
  return { ok: res.ok && !!(json && json.ok), httpStatus: res.status, version: json && json.version,
           error: json && !json.ok ? (json.message || json.error) : null };
}

// Called at the start of a run. Never throws; returns a short status line.
export async function refreshVendorMap(cfg, { secret, dryRun, baseDir, log = () => {}, fetchImpl = fetch, now = new Date(), force = false }) {
  const vm = cfg.vendorMaster;
  if (!vm) return { status: 'not_configured' };
  const statePath = path.join(baseDir, 'vendor-map-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, '')); } catch { state = {}; }
  const hours = vm.refreshHours ?? 20;
  if (!force && state.uploadedAt && (now - Date.parse(state.uploadedAt)) < hours * 3600000) return { status: 'fresh', uploadedAt: state.uploadedAt };
  try {
    const { map, problems } = await buildVendorMapFromSources(vm, { fetchImpl, now });
    const c = map.counts;
    log(`Vendor map: ${c.resolved} products from Products Master (${c.byPrefix} by SKU prefix), ${c.kept} kept from Shopify, ` +
        `${c.conflicts} conflicts, ${c.unresolved} not in Products Master.`);
    if (problems.length) { log('Vendor map not uploaded: ' + problems.join('; ')); return { status: 'refused', problems }; }
    if (dryRun) return { status: 'built_dry_run', counts: c };
    const up = await uploadVendorMap(map, { workerUrl: cfg.workerUrl, secret, fetchImpl });
    if (!up.ok) { log(`Vendor map upload refused (HTTP ${up.httpStatus}): ${up.error}`); return { status: 'upload_failed', error: up.error }; }
    fs.writeFileSync(statePath, JSON.stringify({ uploadedAt: now.toISOString(), version: up.version, counts: c }));
    log(`  vendor map stored (version ${up.version}).`);
    return { status: 'uploaded', version: up.version, counts: c };
  } catch (e) {
    log('Vendor map skipped: ' + String(e && e.message || e).split('\n')[0].slice(0, 200));
    return { status: 'failed', error: String(e && e.message || e).slice(0, 200) };
  }
}
