// One CSV encoder for every export: formula neutralisation plus RFC 4180
// quoting (comma, quote, CR, LF). A title can never become a second row or a
// formula cell.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, readCsv } from './load.mjs';
const require = createRequire(import.meta.url);
const ES = require(path.join(ROOT, 'export-safety.js'));

// strict RFC 4180 parse of a CSV string (reuses the fixture reader)
function parse(text) { const f = path.join(process.env.TMPDIR || '/tmp', 'csv-' + process.pid + '.csv'); fs.writeFileSync(f, text); const r = readCsv(f); fs.rmSync(f); return r; }
const FORMULA = /^[=+\-@\t\r]/;
export const HOSTILE = ['Plant\n=1+1', 'Plant\r\n=HYPERLINK("http://x")', 'a,b', 'say "hi"', '=SUM(A1)', '+1+2', '-x', '@cmd',
  '\t=1', ' =1+1', '\n@x', 'trailing ', '<b data-xss="1">x</b>', 'Ünïcode ✓'];

test('the reported case: "Plant\\n=1+1" stays ONE row and is not a formula', () => {
  const rows = parse(ES.sbCsv([['Plant', 'SKU'], ['Plant\n=1+1', 'S1']]));
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'Plant\n=1+1');
  assert.ok(rows.every(r => r.every(c => !FORMULA.test(c))));
});

test('every hostile value round-trips as one cell, never starting a formula', () => {
  const rows = parse(ES.sbCsv([['v', 'n'], ...HOSTILE.map((v, i) => [v, i])]));
  assert.equal(rows.length, HOSTILE.length + 1);
  rows.slice(1).forEach((r, i) => {
    assert.equal(r.length, 2, 'two columns for ' + JSON.stringify(HOSTILE[i]));
    assert.ok(!FORMULA.test(r[0]), 'neutralised: ' + JSON.stringify(r[0]));
    assert.ok(r[0].endsWith(HOSTILE[i].replace(/^'/, '')) || r[0] === "'" + HOSTILE[i], 'content kept: ' + JSON.stringify(r[0]));
    assert.equal(r[1], String(i));
  });
});

test('numbers stay numbers; negative and signed numeric text is not altered', () => {
  assert.equal(ES.sbCsvCell(-12.5), '-12.5'); assert.equal(ES.sbCsvCell('-12.5'), '-12.5'); assert.equal(ES.sbCsvCell('+3'), '+3');
  assert.equal(ES.sbCsvCell(0), '0'); assert.equal(ES.sbCsvCell(null), ''); assert.equal(ES.sbCsvCell(NaN), '');
});

test('no export builds CSV by hand: every CSV goes through sbDownloadCsv / sbCsvCell', () => {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && f !== 'export-safety.js' && f !== 'inline.js');
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/text\/csv|sheet_to_csv|replace\(\/"\/g,\s*'""'\)|replace\(\/"\/g,\s*"\\"\\""\)/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  // and the download helpers used by every view are the shared ones
  for (const f of ['breakdown-ui.js', 'shopify-views.js', 'data-imports-view.js', 'app.js'])
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /sbDownloadCsv|sbCsvCell/, f);
});

