// Test harness: load the app's browser-global scripts into a sandbox and
// expose them to Node, plus a strict RFC4180 CSV reader so fixtures are read
// exactly as they sit on disk (trailing spaces in headers included).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const FIXTURES = path.join(HERE, 'fixtures');

// genus-data.js and exclusions.js are plain <script> files with top-level
// declarations and no module exports, exactly as the browser loads them.
export function loadBrowserGlobals() {
  const sandbox = { console, window: undefined };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['genus-data.js', 'exclusions.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  // Top-level `const`/`function` in a vm script are lexical: pull the ones the
  // app relies on into the shared object the modules will see.
  const names = ['detectGenus', 'detectAllGenera', 'detectNonPlantType', 'getType', 'getItemType', 'isRestricted', 'GENUS_TYPE'];
  const picked = vm.runInContext('({' + names.map(n => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(',') + '})', ctx);
  Object.assign(sandbox, picked);
  return sandbox;
}

// RFC4180 reader. Returns array-of-arrays, preserving every character inside
// quoted fields and never trimming header cells.
export function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows) {
  return rows.map(r => r.map(c => {
    const s = c == null ? '' : String(c);
    return /[",\n\r]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n') + '\n';
}

// All fixtures are SYNTHETIC, written by tools/make-sample-fixtures.mjs. They
// reproduce the layout of the real exports, not anyone's sales.
export const SAMPLE_FIXTURE = path.join(FIXTURES, 'shopify-total-sales-by-product-sample.csv');
export const CHANNEL_FIXTURE = path.join(FIXTURES, 'shopify-sales-channel-sample.csv');
export const WITH_ID_FIXTURE = path.join(FIXTURES, 'shopify-total-sales-by-product-with-id-sample.csv');
export const CATALOG_FIXTURE = path.join(FIXTURES, 'shopify-catalog-sample.json');
export const AMAZON_V1_FIXTURE = path.join(FIXTURES, 'amazon-metric-data-v1-sample.csv');
export const AMAZON_V2_FIXTURE = path.join(FIXTURES, 'amazon-metric-data-v2-sample.csv');
export const AMAZON_ORDERS_FIXTURE = path.join(FIXTURES, 'amazon-order-extract-sample.csv');

// Expected figures, computed by the generator from its own model (never by the
// parsers under test).
const FACTS_FILE = path.join(FIXTURES, 'sample-facts.json');
export const FACTS = fs.existsSync(FACTS_FILE) ? JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8')) : { shopify: { cur: {} } };

// The figures a person would read off the report screen, used as import controls.
export const SAMPLE_CONTROLS = { units: FACTS.shopify.cur.units, net: FACTS.shopify.cur.net,
                                 tax: FACTS.shopify.cur.tax, total: FACTS.shopify.cur.total };
export const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
