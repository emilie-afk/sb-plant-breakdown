// tools/verify-vendor.mjs — vendored third-party files are served from the
// site itself (no CDN), and only if they are byte-identical to what was
// reviewed: every file listed in a vendor/**/VENDOR.json must match its
// recorded sha256 (and its SRI integrity, when one is recorded).
//
//   node tools/verify-vendor.mjs            verify only
//   node tools/verify-vendor.mjs --copy dist  verify, then copy into dist/vendor/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (alg, buf, enc = 'hex') => crypto.createHash(alg).update(buf).digest(enc);

export function manifests(root = ROOT) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name === 'VENDOR.json') out.push(p);
  } };
  if (fs.existsSync(path.join(root, 'vendor'))) walk(path.join(root, 'vendor'));
  return out;
}
// -> { ok, problems: [...], files: [{rel, sha256, integrity}] }
export function verifyVendor(root = ROOT) {
  const problems = [], files = [];
  for (const m of manifests(root)) {
    const dir = path.dirname(m);
    let man; try { man = JSON.parse(fs.readFileSync(m, 'utf8')); } catch (e) { problems.push(path.relative(root, m) + ': not valid JSON'); continue; }
    if (!man.version || !man.license || !man.licenseFile || !fs.existsSync(path.join(dir, man.licenseFile))) problems.push(path.relative(root, m) + ': version, license and license file are required');
    for (const [name, f] of Object.entries(man.files || {})) {
      const p = path.join(dir, name), rel = path.relative(root, p).split(path.sep).join('/');
      if (!fs.existsSync(p)) { problems.push(rel + ': missing'); continue; }
      const buf = fs.readFileSync(p);
      if (!f.sourceUrl || !/^https:\/\//.test(f.sourceUrl)) problems.push(rel + ': no https source URL recorded');
      if (sha('sha256', buf) !== f.sha256) problems.push(rel + ': sha256 does not match VENDOR.json (file changed?)');
      if (f.bytes != null && buf.length !== f.bytes) problems.push(rel + ': size does not match VENDOR.json');
      if (f.integrity && f.integrity !== 'sha384-' + sha('sha384', buf, 'base64')) problems.push(rel + ': integrity does not match VENDOR.json');
      files.push({ rel, sha256: f.sha256, integrity: f.integrity || null, version: man.version });
    }
  }
  if (!files.length) problems.push('no vendored files found');
  return { ok: problems.length === 0, problems, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = verifyVendor();
  if (!r.ok) { console.error('!!! ' + r.problems.join('\n!!! ')); process.exit(1); }
  const i = process.argv.indexOf('--copy');
  if (i > 0) {
    const out = path.resolve(process.argv[i + 1] || 'dist');
    for (const f of r.files) {
      const dst = path.join(out, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f.rel), dst);
    }
    // the licence travels with the code it covers
    for (const m of manifests()) {
      const man = JSON.parse(fs.readFileSync(m, 'utf8'));
      const rel = path.relative(ROOT, path.join(path.dirname(m), man.licenseFile));
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(out, rel));
    }
  }
  console.log('  vendored files verified: ' + r.files.map(f => f.rel + ' (sha256 ' + f.sha256.slice(0, 12) + '…)').join(', '));
}
