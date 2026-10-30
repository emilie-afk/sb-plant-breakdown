// Guard: no view puts an untrusted field into HTML without escaping it.
// (The hostile-data browser check, tools/browser-security-check.mjs, proves
// the behaviour end to end; this catches regressions in the source.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './load.mjs';

const FIELD = '(?:title|asin|sku|store|rawStore|genus|label|vendor|vendorImported|ptype|productType|yourSources|storeFilter|fileName|yourSku|theirSku|t|g)';
// (column / card specs `c` and `v` hold code constants, not data)
const OBJ = '(?:p|r|g|s|st|x|sn|snap|curSnap|priSnap|cmpSnap|aSnap|sSnap|top|topP|b|it|item|row|rec|map\\.(?:am|sh|ex)|data\\.(?:am|sh|ex))';
const NOT_OUTPUT = '(?!\\s*(?:===|!==|==|!=|\\.length|\\.(?:toLowerCase|indexOf|includes)\\())';
const TEMPLATE = new RegExp('\\$\\{\\s*' + OBJ + '\\.' + FIELD + '\\b' + NOT_OUTPUT + '[^}]*\\}');
const CONCAT = new RegExp("['\"]\\s*\\+\\s*\\(?\\s*" + OBJ + '\\.' + FIELD + '\\b(?![\\w(])' + NOT_OUTPUT + '[^+]*\\+\\s*[\'"]');

test('no unescaped imported/shared field inside HTML in any view', () => {
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.js') && !['inline.js', 'export-safety.js'].includes(f));
  const hits = [];
  for (const f of files) {
    fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (!/<[a-z\/]/i.test(line)) return;                          // not building HTML
      if (/sbDownloadCsv|\.download\s*=|XLSX\.|console\.|alert\(|confirm\(/.test(line)) return;
      const t = line.match(TEMPLATE), c = line.match(CONCAT);
      for (const m of [t, c]) if (m && !/\b(?:H|esc|BUI\.esc|sbHtml)\(\s*$/.test(line.slice(0, m.index + m[0].indexOf(m[0].match(/[a-zA-Z]/)[0])))) hits.push(`${f}:${i + 1}: ${m[0].slice(0, 60)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the escaper used by app.js escapes all five HTML characters', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(src, /const H = \(v\) =>/);
  const ES = require0('export-safety.js');
  assert.equal(ES.sbHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});
import { createRequire } from 'node:module';
function require0(f) { return createRequire(import.meta.url)(path.join(ROOT, f)); }
