// The built page carries no secret: no Worker key, no storage address, no
// third-party password, no private source location. Data is reached only
// through the signed-in same-origin endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './load.mjs';
import { scan, SERVER_ONLY_VARS } from '../tools/check-static-output.mjs';
import { buildCsp, inlineScriptHashes, headersFile } from '../tools/write-headers.mjs';

const SECRETS = {
  SESSION_SECRET: 's'.repeat(48), WORKER_VIEWER_SECRET: 'v'.repeat(48), WORKER_UPLOAD_SECRET: 'u'.repeat(48),
  WORKER_SETTINGS_SECRET: 'e'.repeat(48), WORKER_URL: 'https://example-worker.invalid', STOCK_TRACKER_PASSWORD: 'tracker-pass-xyz',
  SB_SHARED_KEY: 'k'.repeat(48), SB_MCG_PASSWORD: 'old-mcg-pass-xyz'
};

test('the source page holds no secret placeholder and no key meta tag', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /__SB_[A-Z_]+__/);
  assert.doesNotMatch(html, /sb-shared-key|sb-shared-url|sb-mcg-password/);
  const inline = fs.readFileSync(path.join(ROOT, 'inline.js'), 'utf8');
  assert.doesNotMatch(inline, /process\.env\.(SB_SHARED|SB_MCG|WORKER_|SESSION_)/, 'inline.js reads no secret from the environment');
});

test('a production-like build with every secret set leaks none of them', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'lz-string'))) { t.skip('needs `npm install`'); return; }
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sbb-'));
  const out = path.join(dir, 'index.html');
  const r = spawnSync(process.execPath, ['inline.js', out], { cwd: ROOT, env: Object.assign({}, process.env, SECRETS), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  for (const [k, v] of Object.entries(SECRETS)) assert.ok(!html.includes(v), k + ' is not in the page');
  assert.deepEqual(scan([['index.html', html]], SECRETS), []);
  for (const id of ['shopify-file-input', 'amazon-file-input', 'data-settings-btn', 'sb-login-form', 'sb-logout']) assert.ok(html.includes(id), id);
  fs.writeFileSync(path.join(dir, '_headers'), headersFile(html));
  const cp = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'verify-vendor.mjs'), '--copy', dir], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(cp.status, 0, cp.stdout + cp.stderr);
  const chk = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check-static-output.mjs'), dir], { cwd: ROOT, env: Object.assign({}, process.env, SECRETS), encoding: 'utf8' });
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the output check refuses a leaked secret, placeholder, sheet or Worker address, without printing it', (t) => {
  const bad = scan([['a.html', 'x ' + SECRETS.WORKER_VIEWER_SECRET], ['b.html', '__SB_SHARED_KEY__'],
    ['c.js', 'https://docs.google.com/spreadsheets/d/' + 'A'.repeat(40)], ['d.js', 'https://sb-x.acct.workers.dev']], SECRETS);
  assert.equal(bad.length, 4);
  assert.ok(bad.every(p => !p.includes(SECRETS.WORKER_VIEWER_SECRET)), 'values are never printed');
  for (const v of ['WORKER_VIEWER_SECRET', 'SESSION_SECRET', 'SB_SHARED_KEY', 'SB_MCG_PASSWORD']) assert.ok(SERVER_ONLY_VARS.includes(v));
});

test('CSP allows only the page\'s own inline scripts (by hash) and pinned libraries; no unsafe-inline scripts', () => {
  const html = '<script>var a=1;</script><script src="x.js"></script><script>var b=2;</script>';
  assert.equal(inlineScriptHashes(html).length, 2);
  const csp = buildCsp(html);
  const script = csp.split('; ').find(d => d.startsWith('script-src'));
  assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /connect-src 'self'/); assert.match(csp, /object-src 'none'/);
});

test('build.sh no longer injects or encrypts keys; it checks the output; no pass-through proxy remains', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8');
  assert.doesNotMatch(sh, /SB_SHARED|staticrypt|APP_PASSWORD|SB_MCG/i);
  assert.ok(sh.indexOf('check-static-output.mjs') > sh.indexOf('node inline.js'));
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.doesNotMatch(toml, /\[\[redirects\]\]/, 'no redirect forwards requests to another site');
  assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'check-viewer-key.mjs')));
});

test('generated and private files are never tracked', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const p of ['dist/', '_work/', 'worker/wrangler.local.toml', 'collector/config.local.json', '_private_acceptance/', '.netlify/']) assert.ok(gi.includes(p), p + ' is git-ignored');
  const git = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0) {
    const files = git.stdout.trim().split('\n');
    assert.deepEqual(files.filter(f => f.endsWith('.html')), ['index.html']);
    assert.ok(!files.some(f => /^dist\/|^_private|config\.local\.json$|\.sqlite$/.test(f)));
  }
});
