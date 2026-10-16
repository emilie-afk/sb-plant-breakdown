// tools/local-worker.mjs — DEVELOPMENT ONLY.
// Runs the real Worker code (worker/src/index.js) on this PC against a local
// SQLite file, so the dashboard's Data & imports view and the collector can be
// exercised end to end without deploying anything to Cloudflare.
//
//   node tools/local-worker.mjs [--port 8787] [--db _work/local-worker.sqlite]
//        [--origin http://127.0.0.1:8783]
//
// Keys come from LOCAL_INGEST_SECRET / LOCAL_DASHBOARD_SECRET (each >= 32
// characters). They are throwaway values for a local test database, never the
// production keys, and they are never printed.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8787));
const DBFILE = path.resolve(ROOT, arg('db', '_work/local-worker.sqlite'));
const ORIGIN = arg('origin', 'http://127.0.0.1:8783');

fs.mkdirSync(path.dirname(DBFILE), { recursive: true });
const raw = new DatabaseSync(DBFILE);
raw.exec('PRAGMA foreign_keys = ON');
raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
const MIG = path.join(ROOT, 'worker', 'migrations');
for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort()) {
  if (raw.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(f)) continue;
  raw.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
  raw.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  console.log('applied migration', f);
}

// Minimal D1 binding over node:sqlite.
const clean = v => v === undefined ? null : v;
class Stmt {
  constructor(sql, p = []) { this.sql = sql; this.p = p; }
  bind(...p) { return new Stmt(this.sql, p.map(clean)); }
  _run() { const r = raw.prepare(this.sql).run(...this.p); return { success: true, meta: { changes: r.changes } }; }
  async run() { return this._run(); }
  async all() { return { results: raw.prepare(this.sql).all(...this.p) }; }
  async first() { const r = raw.prepare(this.sql).get(...this.p); return r === undefined ? null : r; }
}
const DB = {
  prepare: sql => new Stmt(sql),
  async batch(stmts) {
    raw.exec('BEGIN');
    try { const o = stmts.map(s => s._run()); raw.exec('COMMIT'); return o; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  }
};

for (const k of ['LOCAL_INGEST_SECRET', 'LOCAL_DASHBOARD_SECRET']) {
  if (!process.env[k] || process.env[k].length < 32) {
    console.error(`Set ${k} (>= 32 characters) before starting the local worker.`);
    process.exit(2);
  }
}
const env = {
  DB,
  INGEST_SECRET: process.env.LOCAL_INGEST_SECRET,
  DASHBOARD_SECRET: process.env.LOCAL_DASHBOARD_SECRET,
  ALLOWED_ORIGINS: ORIGIN
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request('http://127.0.0.1:' + PORT + req.url, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
  });
  try {
    const r = await worker.fetch(request, env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'local_runner_error' }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('local worker on http://127.0.0.1:' + PORT + '  db=' + DBFILE + '  origin=' + ORIGIN);
});
