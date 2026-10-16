// Collector: everything except the browser clicks, which need a signed-in
// Shopify session (see collector/README.md for the live acceptance run).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, SAMPLE_FIXTURE, CHANNEL_FIXTURE, FACTS } from './load.mjs';
import * as L from '../collector/src/lib.mjs';
import * as R from '../collector/src/redact.mjs';
import { uploadReport } from '../collector/src/upload.mjs';
import { makeD1 } from './d1shim.mjs';
import worker from '../worker/src/index.js';

const CHANNEL_FIX = CHANNEL_FIXTURE;
const CH = FACTS.channel;
const ADMIN = 'https://admin.shopify.com/store/example-store', REPORT = '123456789';
const money = (v) => v.toFixed(2);
const SEPT = { start: '2026-09-01', end: '2026-09-30', comparison: { start: '2026-08-02', end: '2026-08-31' } };

// ── periods (store calendar = America/Los_Angeles) ─────────────
test('previous period matches Shopify: Sep 1–30 compares to Aug 2–31', () => {
  assert.deepEqual(L.previousPeriod('2026-09-01', '2026-09-30'), { start: '2026-08-02', end: '2026-08-31' });
  assert.deepEqual(L.previousPeriod('2026-10-01', '2026-10-14'), { start: '2026-09-17', end: '2026-09-30' });
});

test('periods follow the Los Angeles calendar, not the PC clock', () => {
  // 08:00 UTC on Oct 15 is 01:00 on Oct 15 in LA (and 15:00 in Vietnam)
  const a = L.planPeriods(['month-to-date', 'previous-month'], new Date('2026-10-15T08:00:00Z'));
  assert.deepEqual(a.map(p => [p.kind, p.start, p.end]), [['month-to-date', '2026-10-01', '2026-10-14'], ['previous-month', '2026-09-01', '2026-09-30']]);
  assert.deepEqual(a[1].comparison, { start: '2026-08-02', end: '2026-08-31' });
  // 05:00 UTC on Oct 15 is still Oct 14 in LA: yesterday is Oct 13
  const b = L.planPeriods(['month-to-date'], new Date('2026-10-15T05:00:00Z'));
  assert.deepEqual([b[0].start, b[0].end], ['2026-10-01', '2026-10-13']);
});

test('month-to-date is skipped on the 1st; the previous month is added on the configured day', () => {
  assert.equal(L.planPeriods(['month-to-date'], new Date('2026-11-01T18:00:00Z')).length, 0);
  const p = L.periodsForToday({ periods: { daily: ['month-to-date'], monthlyOnDay: 2 } }, new Date('2026-11-02T18:00:00Z'));
  assert.deepEqual(p.map(x => [x.kind, x.start, x.end]), [['month-to-date', '2026-11-01', '2026-11-01'], ['previous-month', '2026-10-01', '2026-10-31']]);
  const q = L.periodsForToday({ periods: { daily: ['month-to-date'], monthlyOnDay: 2 } }, new Date('2026-11-03T18:00:00Z'));
  assert.deepEqual(q.map(x => x.kind), ['month-to-date']);
});

test('custom periods are checked', () => {
  assert.throws(() => L.customPeriod('2026-09-30', '2026-09-01'));
  assert.throws(() => L.customPeriod('2026-9-1', '2026-09-30'));
  assert.deepEqual(L.customPeriod('2026-09-01', '2026-09-30').comparison, { start: '2026-08-02', end: '2026-08-31' });
});

// ── query / URL ────────────────────────────────────────────────
test('the query is the saved report with explicit dates, previous period and sales channel', () => {
  const q = L.buildQuery(SEPT);
  assert.match(q, /GROUP BY product_id, product_title, product_vendor, product_type, sales_channel/);
  assert.match(q, /SINCE 2026-09-01 UNTIL 2026-09-30/);
  assert.match(q, /COMPARE TO previous_period/);
  const url = L.reportUrl({ adminUrl: ADMIN, reportId: REPORT }, SEPT);
  assert.ok(url.startsWith(ADMIN + '/analytics/reports/' + REPORT + '?ql='));
  assert.equal(decodeURIComponent(url.split('?ql=')[1]), q);
  assert.throws(() => L.reportUrl({ adminUrl: 'https://evil.example/store/x', reportId: '1' }, SEPT));
});

// ── CSV + validation on the REAL channel export ────────────────
test('CSV parser handles quotes, embedded commas, CRLF and a BOM', () => {
  const rows = L.parseCsv('﻿"a","b, c"\r\n1,"say ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b, c'], ['1', 'say "hi"']]);
});

test('the channel export validates into a payload the Worker accepts', async () => {
  const v = L.validateExport(fs.readFileSync(CHANNEL_FIX, 'utf8'), SEPT, { pageTotals: { units: CH.cur.units, net: CH.cur.net } });
  assert.equal(v.ok, true, (v.problems || []).join(' '));
  assert.equal(v.facts.rows, CH.rows);
  assert.equal(v.facts.products, CH.products);
  assert.equal(v.facts.net, CH.cur.net);
  assert.equal(v.facts.amazonNet, CH.amazon.net);
  assert.equal(v.payload.rows.length, CH.rows);
  assert.equal(v.payload.importedBy, 'collector');
  assert.deepEqual(v.payload.comparison, { start: '2026-08-02', end: '2026-08-31', source: 'Shopify previous_period' });
  const keys = new Set(v.payload.rows.flatMap(r => Object.keys(r)));
  assert.deepEqual([...keys].sort(), ['cur', 'prior', 'productId', 'productType', 'salesChannel', 'title', 'vendor']);
});

test('a file that disagrees with the page Summary is refused before upload', () => {
  const v = L.validateExport(fs.readFileSync(CHANNEL_FIX, 'utf8'), SEPT, { pageTotals: { units: CH.cur.units, net: 1000 } });
  assert.equal(v.ok, false);
  assert.ok(v.problems.join(' ').includes(money(CH.cur.net) + ' net sales; the report page shows 1000.00'));
});

test('an export without product id or sales channel is refused (wrong report)', () => {
  const v = L.validateExport(fs.readFileSync(SAMPLE_FIXTURE, 'utf8'), SEPT);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /No Product ID column/);
  assert.match(v.problems.join(' '), /No Sales channel column/);
});

test('an export with customer-looking columns is refused outright', () => {
  const text = fs.readFileSync(CHANNEL_FIX, 'utf8').replace('"Product title"', '"Customer email"');
  const v = L.validateExport(text, SEPT);
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /customer-looking columns/);
});

test('Summary cells are read as the current-period number', () => {
  assert.equal(L.parseSummaryNumber('1,234 / 1,111'), 1234);
  assert.equal(L.parseSummaryNumber('$12,345.67 / $11,000.00'), 12345.67);
  assert.equal(L.parseSummaryNumber('‑$2,888.18 / ‑$3,902.00'), -2888.18);
  assert.equal(L.parseSummaryNumber(''), null);
  // the live page returns current and previous on two lines
  assert.equal(L.parseSummaryNumber('1,234\n1,111'), 1234);
  assert.equal(L.parseSummaryNumber('$12,345.67\n$11,000.00'), 12345.67);
  assert.equal(L.parseSummaryNumber('‑$375.25\n‑$342.59'), -375.25);
});

test('config: secrets are refused, http only for a local test Worker', () => {
  const base = { adminUrl: ADMIN, reportId: REPORT, workerUrl: 'https://w.example' };
  assert.deepEqual(L.validateConfig(base), []);
  assert.match(L.validateConfig({ ...base, ingestSecret: 'x' }).join(' '), /looks like a secret/);
  assert.deepEqual(L.validateConfig({ ...base, ingestCredentialTarget: 'sb-pb-ingest' }), []);
  assert.match(L.validateConfig({ ...base, workerUrl: 'http://w.example' }).join(' '), /must be https/);
  assert.deepEqual(L.validateConfig({ ...base, workerUrl: 'http://127.0.0.1:8787' }), []);
});

test('redaction keeps secrets, URLs and emails out of logs', () => {
  R._resetForTests();
  R.registerSecret('s3cr3t-value-123');
  assert.equal(R.scrub('key=s3cr3t-value-123'), 'key=<redacted>');
  assert.equal(R.safeError(new Error('fail at https://admin.shopify.com/x for a@b.com s3cr3t-value-123\nstack')),
    'fail at <url> for <email> <redacted>');
  assert.equal(R.containsSecret('{"x":"s3cr3t-value-123"}'), true);
});

// ── upload ─────────────────────────────────────────────────────
test('upload retries 5xx and network errors, but not a refusal', async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error('ECONNRESET'); if (n === 2) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ ok: true, outcome: 'succeeded', revision: 1 }), { status: 200 }); };
  const r = await uploadReport({ x: 1 }, { workerUrl: 'https://w.example', secret: 's', fetchImpl: flaky, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(r.attempts, 3);

  let m = 0;
  const refuse = async () => { m++; return new Response(JSON.stringify({ ok: false, outcome: 'rejected', errors: [{ code: 'totals_mismatch', message: 'no' }] }), { status: 422 }); };
  const q = await uploadReport({ x: 1 }, { workerUrl: 'https://w.example', secret: 's', fetchImpl: refuse, sleep: async () => {} });
  assert.equal(q.ok, false); assert.equal(m, 1); assert.equal(q.errors[0].code, 'totals_mismatch');
});

test('the real Sept export uploads to the real Worker code, then reads back as unchanged', async () => {
  const env = { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), DASHBOARD_SECRET: 'd'.repeat(40), INGEST_SECRET: 'i'.repeat(40) };
  const fetchImpl = (url, init) => worker.fetch(new Request(url, init), env);
  const v = L.validateExport(fs.readFileSync(CHANNEL_FIX, 'utf8'), SEPT, {});
  const a = await uploadReport(v.payload, { workerUrl: 'https://w.example', secret: 'i'.repeat(40), fetchImpl });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.outcome, 'succeeded');
  const b = await uploadReport(v.payload, { workerUrl: 'https://w.example', secret: 'i'.repeat(40), fetchImpl });
  assert.equal(b.outcome, 'unchanged');
  const bad = await uploadReport(v.payload, { workerUrl: 'https://w.example', secret: 'wrong'.repeat(10), fetchImpl });
  assert.equal(bad.ok, false); assert.equal(bad.httpStatus, 401);
});

// ── the CLI, end to end with --from-file ───────────────────────
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pbc-')); }
function writeCfg(dir, extra = {}) {
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ adminUrl: ADMIN, reportId: REPORT,
    workerUrl: null, timeZone: 'America/Los_Angeles', localDir: path.join(dir, 'local') }, extra)));
  return p;
}
const CLI = path.join(ROOT, 'collector', 'src', 'collect.mjs');

test('CLI dry run validates an export and writes a run record without rows', () => {
  const dir = tmpdir();
  const r = spawnSync(process.execPath, [CLI, '--config', writeCfg(dir), '--start', '2026-09-01', '--end', '2026-09-30', '--from-file', CHANNEL_FIX, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(`${CH.rows} rows, ${CH.products} products, ${CH.cur.units} units, net ${money(CH.cur.net)} (own store ${money(CH.own.net)}, Amazon via Sellbrite ${money(CH.amazon.net)})`), r.stdout);
  const runs = fs.readdirSync(path.join(dir, 'local', 'runs'));
  assert.equal(runs.length, 1);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'local', 'runs', runs[0]), 'utf8'));
  assert.equal(rec.status, 'validated_dry_run');
  assert.equal(rec.facts.amazonUnits, CH.amazon.units);
  assert.ok(!JSON.stringify(rec).includes(FACTS.shopify.anchors.spider.title), 'no product rows in the run record');
  assert.equal(fs.existsSync(path.join(dir, 'local', 'collector.lock')), false, 'lock released');
});

test('CLI refuses the wrong report with exit 34 and uploads nothing', () => {
  const dir = tmpdir();
  const r = spawnSync(process.execPath, [CLI, '--config', writeCfg(dir), '--start', '2026-09-01', '--end', '2026-09-30', '--from-file', SAMPLE_FIXTURE, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, L.EXIT.VALIDATION_FAILED, r.stdout + r.stderr);
});

test('CLI respects a fresh lock (exit 5) and rejects a bad config (exit 10)', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'local'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'local', 'collector.lock'), '{}');
  const r = spawnSync(process.execPath, [CLI, '--config', writeCfg(dir), '--start', '2026-09-01', '--end', '2026-09-30', '--from-file', CHANNEL_FIX, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, L.EXIT.LOCKED);
  const d2 = tmpdir();
  const r2 = spawnSync(process.execPath, [CLI, '--config', writeCfg(d2, { adminUrl: 'https://example.com' }), '--dry-run'], { encoding: 'utf8' });
  assert.equal(r2.status, L.EXIT.CONFIG);
});

test('CLI uploads to a local Worker; a refused upload is quarantined (exit 31)', async () => {
  const dir = tmpdir();
  const port = 18000 + Math.floor(Math.random() * 1000);
  const env = { ...process.env, LOCAL_INGEST_SECRET: 'i'.repeat(40), LOCAL_DASHBOARD_SECRET: 'd'.repeat(40) };
  const w = spawn(process.execPath, [path.join(ROOT, 'tools', 'local-worker.mjs'), '--port', String(port), '--db', path.join(dir, 'w.sqlite')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { w.stdout.on('data', d => { if (/local worker on/.test(d)) res(); }); w.on('exit', c => rej(new Error('worker exited ' + c))); });
  try {
    const run = (secret) => new Promise(res => {
      const p = spawn(process.execPath, [CLI, '--config', writeCfg(dir, { workerUrl: `http://127.0.0.1:${port}` }), '--start', '2026-09-01', '--end', '2026-09-30', '--from-file', CHANNEL_FIX],
        { env: { ...process.env, SB_PB_LOCAL_INGEST_SECRET: secret } });
      let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
      p.on('exit', code => res({ code, out }));
    });
    const ok = await run('i'.repeat(40));
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /uploaded: succeeded \(revision 1\)/);
    assert.ok(!ok.out.includes('i'.repeat(40)), 'secret never printed');
    const again = await run('i'.repeat(40));
    assert.match(again.out, /uploaded: unchanged/);
    const bad = await run('x'.repeat(40));
    assert.equal(bad.code, L.EXIT.UPLOAD_FAILED, bad.out);
    assert.equal(fs.readdirSync(path.join(dir, 'local', 'quarantine')).length, 1);
  } finally { w.kill(); }
});
