// The key built into the dashboard must be the read-only viewer key, and the
// build must never leave a real key in a tracked or unencrypted file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './load.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';
import { classifyKey } from '../tools/check-viewer-key.mjs';

const INGEST = 'i'.repeat(40), DASH = 'd'.repeat(40), VIEW = 'v'.repeat(40);
const env = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), INGEST_SECRET: INGEST, DASHBOARD_SECRET: DASH, VIEWER_SECRET: VIEW };
const fetchImpl = (url, init) => worker.fetch(new Request(url, init), env);

test('the build guard tells the three keys apart without writing anything', async () => {
  const before = env.DB._raw.prepare('SELECT (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM import_runs) AS n').get().n;
  assert.equal((await classifyKey('https://w.example', VIEW, fetchImpl)).role, 'viewer');
  assert.equal((await classifyKey('https://w.example', DASH, fetchImpl)).role, 'dashboard');
  assert.equal((await classifyKey('https://w.example', INGEST, fetchImpl)).role, 'collector');
  assert.equal((await classifyKey('https://w.example', 'x'.repeat(40), fetchImpl)).role, 'rejected');
  const after = env.DB._raw.prepare('SELECT (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM import_runs) AS n').get().n;
  assert.equal(after, before, 'no setting and no import record was written by the probes');
});

test('the viewer key can read history but cannot write reports, settings or failures', async () => {
  const call = (m, p, body) => fetchImpl('https://w.example' + p, { method: m, headers: { authorization: 'Bearer ' + VIEW, 'content-type': 'application/json' }, body });
  assert.equal((await call('GET', '/v1/reports?history=1')).status, 200);
  assert.equal((await call('POST', '/v1/ingest/product-report', '{}')).status, 403);
  assert.equal((await call('PUT', '/v1/settings/classification_overrides', '{"value":{}}')).status, 403);
  assert.equal((await call('POST', '/v1/ingest/collection-failure', '{}')).status, 403);
  assert.equal((await call('GET', '/v1/ingest/coverage')).status, 403);
});

test('build.sh checks the key first and refuses an unencrypted or leaking output', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8');
  assert.ok(sh.indexOf('check-viewer-key.mjs') > 0 && sh.indexOf('check-viewer-key.mjs') < sh.indexOf('node inline.js'), 'key checked before inlining');
  assert.match(sh, /grep -qF "\$SB_SHARED_KEY" dist\/index\.html/);
  assert.match(sh, /staticrypt/i);
  assert.match(sh, /trap 'rm -rf "\$TMP"' EXIT/, 'the unencrypted intermediate is always deleted');
});

test('the key check script exits nonzero for a missing half and skips when nothing is built in', () => {
  const run = (e) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check-viewer-key.mjs')], { env: Object.assign({ PATH: process.env.PATH }, e), encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  assert.equal(run({ SB_SHARED_URL: 'https://w.example' }).status, 1);
  const r = run({ SB_SHARED_URL: 'http://127.0.0.1:9', SB_SHARED_KEY: 'k'.repeat(40) });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout + r.stderr, /k{40}/, 'the key is never printed');
});

test('generated HTML is never tracked', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const p of ['dist/', '_work/', 'worker/wrangler.local.toml', 'collector/config.local.json']) assert.ok(gi.includes(p), p + ' is git-ignored');
  const git = spawnSync('git', ['ls-files', '*.html'], { cwd: ROOT, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) assert.deepEqual(git.stdout.trim().split('\n'), ['index.html']);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /content="__SB_SHARED_KEY__"/, 'the source page holds only the placeholder');
});

test('a build without shared-storage settings still works and keeps the manual-upload fallback', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'lz-string'))) { t.skip('needs `npm install` (lz-string) to run inline.js'); return; }
  const out = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'sbb-')), 'index.html');
  const e = Object.assign({}, process.env); delete e.SB_SHARED_URL; delete e.SB_SHARED_KEY;
  const r = spawnSync(process.execPath, ['inline.js', out], { cwd: ROOT, env: e, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not built in/);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /name="sb-shared-url" content=""/);
  assert.match(html, /name="sb-shared-key" content=""/);
  for (const id of ['shopify-file-input', 'amazon-file-input', 'data-settings-btn', 'di-connect']) {
    assert.ok(html.includes(id), id + ' present: manual upload and connecting by hand still work');
  }
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
});
