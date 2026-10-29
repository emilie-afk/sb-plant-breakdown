// tools/sheetjs-parity.mjs — do two SheetJS builds read the same files the same
// way the dashboard reads them? (app.js readFile + sheet_to_json header:1,
// raw:true, defval:"" — the exact call every import uses.)
//   node tools/sheetjs-parity.mjs <old xlsx build> <new xlsx build> <file or dir>...
// Prints counts only (no cell contents), so it can run on private files.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [oldP, newP, ...inputs] = process.argv.slice(2);
if (!oldP || !newP || !inputs.length) { console.error('usage: sheetjs-parity.mjs <old> <new> <file|dir>...'); process.exit(2); }
const OLD = require(path.resolve(oldP)), NEW = require(path.resolve(newP));
const files = [];
const add = (p) => { const st = fs.statSync(p); if (st.isDirectory()) fs.readdirSync(p).forEach(f => add(path.join(p, f))); else if (/\.(csv|xlsx|xls)$/i.test(p)) files.push(p); };
inputs.forEach(add);
function rows(X, file) {
  const buf = fs.readFileSync(file);
  const wb = /\.csv$/i.test(file) ? X.read(new TextDecoder('utf-8').decode(buf), { type: 'string' }) : X.read(buf);
  return wb.SheetNames.map(n => ({ name: n, rows: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
}
let diff = 0;
console.log(`old ${OLD.version} vs new ${NEW.version}`);
for (const f of files) {
  let a, b, err = null;
  try { a = rows(OLD, f); b = rows(NEW, f); } catch (e) { err = e.message; }
  const same = !err && JSON.stringify(a) === JSON.stringify(b);
  let cells = 0, differing = 0;
  if (!err) a.forEach((s, i) => s.rows.forEach((r, ri) => r.forEach((c, ci) => { cells++; const o = b[i] && b[i].rows[ri] && b[i].rows[ri][ci]; if (JSON.stringify(c) !== JSON.stringify(o)) differing++; })));
  if (!same) diff++;
  console.log(`${same ? 'SAME' : 'DIFF'}  ${path.basename(f)}  sheets=${a ? a.length : '?'} cells=${cells}${differing ? ' differing=' + differing : ''}${err ? ' error=' + err : ''}`);
}
console.log(diff ? `${diff} FILE(S) DIFFER` : `ALL ${files.length} FILES READ IDENTICALLY`);
process.exitCode = diff ? 1 : 0;
