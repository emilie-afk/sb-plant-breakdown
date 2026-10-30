// SheetJS is served as a verified local copy (official 0.20.3 release), not
// from a CDN. These tests pin the copy, the page reference, the CSP and the
// build check, and exercise imports and exports with the vendored library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ROOT, readCsv, FIXTURES } from './load.mjs';
import { verifyVendor } from '../tools/verify-vendor.mjs';
import { buildCsp } from '../tools/write-headers.mjs';
import { checkScriptSources } from '../tools/check-static-output.mjs';

const require = createRequire(import.meta.url);
const DIR = path.join(ROOT, 'vendor', 'sheetjs', '0.20.3');
const MAN = JSON.parse(fs.readFileSync(path.join(DIR, 'VENDOR.json'), 'utf8'));
const XLSX = require(path.join(DIR, 'xlsx.full.min.js'));
const ES = require(path.join(ROOT, 'export-safety.js'));

test('the vendored copy is the official 0.20.3 release, checksum-pinned, with its licence', () => {
  const buf = fs.readFileSync(path.join(DIR, 'xlsx.full.min.js'));
  const f = MAN.files['xlsx.full.min.js'];
  assert.equal(MAN.version, '0.20.3'); assert.equal(XLSX.version, '0.20.3');
  assert.equal(f.sourceUrl, 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), f.sha256);
  assert.equal('sha384-' + crypto.createHash('sha384').update(buf).digest('base64'), f.integrity);
  assert.equal(MAN.license, 'Apache-2.0');
  assert.match(fs.readFileSync(path.join(DIR, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
  assert.ok(verifyVendor().ok, verifyVendor().problems.join('; '));
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^vendor\/\*\* -text$/m, 'no line-ending conversion of vendored files');
});

test('a modified vendored file is refused by the build check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vend-'));
  fs.cpSync(path.join(ROOT, 'vendor'), path.join(tmp, 'vendor'), { recursive: true });
  fs.appendFileSync(path.join(tmp, 'vendor/sheetjs/0.20.3/xlsx.full.min.js'), '\n/* tampered */');
  const r = verifyVendor(tmp);
  assert.equal(r.ok, false); assert.ok(r.problems.some(p => /sha256/.test(p)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the page loads SheetJS only from the vendored path with the recorded integrity; the CSP allows no SheetJS CDN', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*xlsx[^"]*)"[^>]*>/g)];
  assert.equal(tags.length, 1);
  assert.equal(tags[0][1], 'vendor/sheetjs/0.20.3/xlsx.full.min.js');
  assert.ok(tags[0][0].includes(`integrity="${MAN.files['xlsx.full.min.js'].integrity}"`));
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net\/npm\/xlsx|cdn\.sheetjs\.com/);
  const csp = buildCsp(html), script = csp.split('; ').find(d => d.startsWith('script-src'));
  assert.match(script, /'self'/); assert.doesNotMatch(script, /xlsx|sheetjs|unsafe-inline|unsafe-eval|\*/);
  // the export-safety wrapper must load after SheetJS so every export is wrapped
  assert.ok(html.indexOf('vendor/sheetjs/0.20.3/xlsx.full.min.js') < html.indexOf('export-safety.js'));
});

test('the built output passes the script-source check, and a CDN reference or wrong integrity fails it', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'lz-string'))) { t.skip('needs `npm install`'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbb-'));
  assert.equal(spawnSync(process.execPath, ['inline.js', path.join(dir, 'index.html')], { cwd: ROOT }).status, 0);
  assert.equal(spawnSync(process.execPath, ['tools/verify-vendor.mjs', '--copy', dir], { cwd: ROOT }).status, 0);
  assert.equal(spawnSync(process.execPath, ['tools/write-headers.mjs', dir], { cwd: ROOT }).status, 0);
  const cwd = process.cwd(); process.chdir(ROOT);
  try {
    assert.deepEqual(checkScriptSources(dir), []);
    assert.ok(fs.existsSync(path.join(dir, 'vendor/sheetjs/0.20.3/LICENSE')), 'licence shipped with the code');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    fs.writeFileSync(path.join(dir, 'index.html'), html.replace(/integrity="sha384-[^"]+"/, 'integrity="sha384-AAAA"'));
    assert.ok(checkScriptSources(dir).some(p => /integrity/.test(p)));
    fs.writeFileSync(path.join(dir, 'index.html'), html.replace('vendor/sheetjs/0.20.3/xlsx.full.min.js', 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'));
    assert.ok(checkScriptSources(dir).some(p => /another site|CDN/.test(p)));
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.appendFileSync(path.join(dir, 'vendor/sheetjs/0.20.3/xlsx.full.min.js'), ' ');
    assert.ok(checkScriptSources(dir).some(p => /differs/.test(p)));
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- imports, read exactly as the page reads them (app.js readFile) ----
function pageRows(text) { const wb = XLSX.read(text, { type: 'string' }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' }); }
const AP = require(path.join(ROOT, 'amazon-parse.js'));
const SR = require(path.join(ROOT, 'shopify-report.js'));

test('spreadsheet imports: every CSV fixture reads with the same cells (as text) as the strict reader', () => {
  for (const f of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.csv'))) {
    const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8').replace(/^﻿/, '');
    const a = pageRows(text).map(r => r.map(String)).filter(r => r.some(c => c !== ''));
    const b = readCsv(path.join(FIXTURES, f)).filter(r => r.some(c => c !== ''));
    assert.equal(a.length, b.length, f + ': row count');
    let diffs = 0;
    for (let i = 0; i < b.length; i++) for (let j = 0; j < b[i].length; j++) {
      const x = String(a[i][j] ?? ''), y = b[i][j];
      if (x !== y && !(y.trim() !== '' && !isNaN(Number(y.replace(/[$,%]/g, ''))))) diffs++;   // numbers may be typed
    }
    assert.equal(diffs, 0, f + ': text cells differ');
  }
});

test('spreadsheet imports: Shopify and Amazon fixtures parse to the expected reports through the vendored reader', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sample-facts.json'), 'utf8'));
  const shop = SR.parseShopifyProductReport(pageRows(fs.readFileSync(path.join(FIXTURES, 'shopify-total-sales-by-product-sample.csv'), 'utf8')));
  const strict = SR.parseShopifyProductReport(readCsv(path.join(FIXTURES, 'shopify-total-sales-by-product-sample.csv')));
  assert.equal(shop.records.length, strict.records.length);
  assert.deepEqual(shop.totals, strict.totals);
  assert.ok(facts);
  const az = path.join(FIXTURES, 'amazon-metric-data-v2-sample.csv');
  const viaPage = AP.parseAmazonMetricData ? AP.parseAmazonMetricData(pageRows(fs.readFileSync(az, 'utf8'))) : null;
  const viaStrict = AP.parseAmazonMetricData ? AP.parseAmazonMetricData(readCsv(az)) : null;
  if (viaPage) {
    assert.equal(viaPage.ok, viaStrict.ok);
    assert.equal((viaPage.products || viaPage.records || []).length, (viaStrict.products || viaStrict.records || []).length);
  }
});

test('spreadsheet imports: an .xlsx file (as uploaded) reads back the same cells and numbers', () => {
  const rows = readCsv(path.join(FIXTURES, 'amazon-metric-data-2026-09.csv'));
  const typed = rows.map((r, i) => i === 0 ? r : r.map(c => (c !== '' && !isNaN(Number(c)) ? Number(c) : c)));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(typed), 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.utils.sheet_to_json(XLSX.read(buf).Sheets.Sheet1, { header: 1, raw: true, defval: '' });
  assert.deepEqual(back, typed);
});

test('XLSX exports through the safety wrapper: no formulas, hostile text neutralised, numbers stay numeric', () => {
  ES.sbWrapXlsx(XLSX);
  const rows = [
    { Title: '=HYPERLINK("http://x","y")', SKU: '@SUM(1,2)', Note: 'Plant\n=1+1', Store: '<b data-xss="1">x</b>', Units: 12, Revenue: 345.67, Neg: -3.5, Signed: '-12.5' },
    { Title: '+cmd', SKU: '-x', Note: '\t=1', Store: 'ok', Units: 0, Revenue: 0, Neg: -0.01, Signed: '+3' }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'A');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['h1', 'h2'], ['=1+1', 5]]), 'B');
  const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { cellFormula: true });
  let cells = 0;
  for (const name of back.SheetNames) {
    const ws = back.Sheets[name];
    for (const ref of Object.keys(ws).filter(k => k[0] !== '!')) {
      const c = ws[ref]; cells++;
      assert.equal(c.f, undefined, `${name}!${ref} has a formula`);
      if (c.t === 's') assert.ok(!/^\s*[=+\-@\t]/.test(c.v) || /^[+-]?\d+(\.\d+)?$/.test(c.v), `${name}!${ref} text can start a formula: ${JSON.stringify(c.v)}`);
    }
  }
  const A = back.Sheets.A;
  assert.equal(A.E2.t, 'n'); assert.equal(A.E2.v, 12);
  assert.equal(A.F2.t, 'n'); assert.equal(A.F2.v, 345.67);
  assert.equal(A.G2.t, 'n'); assert.equal(A.G2.v, -3.5);
  assert.equal(A.A2.v, '\'=HYPERLINK("http://x","y")');
  assert.equal(A.H2.v, '-12.5', 'numeric text kept as is');
  assert.equal(back.Sheets.B.B2.t, 'n');
  assert.ok(cells > 20);
});
