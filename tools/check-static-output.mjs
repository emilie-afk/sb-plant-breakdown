// tools/check-static-output.mjs — refuse a build whose public files contain a
// server secret, a placeholder, or a private source location.
//   node tools/check-static-output.mjs dist
// Every value of the server-only environment variables listed below is looked
// for verbatim (never printed). Their names are listed, not their values.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SERVER_ONLY_VARS = ['SESSION_SECRET', 'DASHBOARD_VIEWER_PASSWORD_HASH', 'DASHBOARD_EDITOR_PASSWORD_HASH',
  'WORKER_VIEWER_SECRET', 'WORKER_UPLOAD_SECRET', 'WORKER_SETTINGS_SECRET', 'WORKER_AUTH_SECRET', 'WORKER_URL',
  'STOCK_TRACKER_PASSWORD', 'STOCK_TRACKER_URL',
  // retired build-time variables: must not leak if still set on Netlify
  'SB_SHARED_KEY', 'SB_SHARED_URL', 'SB_MCG_PASSWORD', 'APP_PASSWORD'];
const PATTERNS = [
  [/__SB_[A-Z_]+__/, 'a secret placeholder'],
  [/sb-shared-key|sb-mcg-password/, 'a key meta tag'],
  [/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/, 'a Google Sheet location'],
  [/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i, 'a Worker address'],
  [/Bearer\s+[A-Za-z0-9_\-.]{24,}/, 'a bearer token']
];
export function scan(files, env = process.env) {
  const problems = [];
  for (const [file, text] of files) {
    for (const v of SERVER_ONLY_VARS) {
      const val = String(env[v] || '');
      if (val.length >= 8 && text.includes(val)) problems.push(`${file}: contains the value of ${v}`);
    }
    for (const [re, what] of PATTERNS) if (re.test(text)) problems.push(`${file}: contains ${what}`);
  }
  return problems;
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}
// Script sources of the built page: SheetJS only from the verified vendored
// copy (path + SRI equal to its VENDOR.json), never from a CDN; the copy in
// dist byte-identical to the reviewed file; the CSP allows no SheetJS CDN.
export function checkScriptSources(dir) {
  const problems = [];
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m => ({ tag: m[0], src: m[1] }));
  const sheet = tags.filter(t => /xlsx/i.test(t.src));
  if (sheet.length !== 1) problems.push(`index.html: expected exactly one SheetJS script, found ${sheet.length}`);
  for (const t of sheet) {
    if (/^https?:|^\/\//.test(t.src)) problems.push('index.html: SheetJS is loaded from another site: ' + t.src);
    const manPath = path.join(path.dirname(t.src), 'VENDOR.json');
    let man = null; try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) { problems.push('no VENDOR.json for ' + t.src); }
    const f = man && man.files && man.files[path.basename(t.src)];
    const integ = (t.tag.match(/\bintegrity="([^"]+)"/) || [])[1];
    if (f && integ !== f.integrity) problems.push('index.html: SheetJS integrity attribute does not match VENDOR.json');
    const built = path.join(dir, t.src);
    if (!fs.existsSync(built)) problems.push('dist: ' + t.src + ' missing');
    else if (f && crypto.createHash('sha256').update(fs.readFileSync(built)).digest('hex') !== f.sha256) problems.push('dist: ' + t.src + ' differs from the reviewed file');
    if (man && !fs.existsSync(path.join(dir, path.dirname(t.src), man.licenseFile))) problems.push('dist: SheetJS licence file missing');
  }
  for (const t of tags) if (/^https?:|^\/\//.test(t.src) && !/^https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@\d+\.\d+\.\d+\//.test(t.src)) problems.push('index.html: unexpected external script ' + t.src);
  const hdr = fs.existsSync(path.join(dir, '_headers')) ? fs.readFileSync(path.join(dir, '_headers'), 'utf8') : '';
  if (/cdn\.sheetjs\.com|npm\/xlsx@/.test(hdr)) problems.push('_headers: the CSP still allows a SheetJS CDN');
  if (/cdn\.sheetjs\.com|cdn\.jsdelivr\.net\/npm\/xlsx/.test(html)) problems.push('index.html: still references a SheetJS CDN');
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] || 'dist';
  // third-party library code is checked by checksum, not scanned as text
  const files = walk(dir).filter(f => !/[\\/]vendor[\\/]/.test(f)).map(f => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]);
  const problems = scan(files).concat(checkScriptSources(dir));
  if (problems.length) { console.error('!!! ' + problems.join('\n!!! ')); process.exit(1); }
  console.log('  ' + files.length + ' public file(s): no secret value, placeholder, or private location');
}
