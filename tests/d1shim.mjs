// A D1-compatible binding backed by Node's built-in SQLite, so the Worker's
// real migrations and real SQL run under test (partial unique index,
// ALTER TABLE, ON CONFLICT, atomic batches) rather than a mock.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function makeD1(migrationsDir, opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  let batchCount = 0;
  const clean = (v) => v === undefined ? null : v;

  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) { return new Stmt(this.sql, p.map(clean)); }
    async run() { return this._run(); }
    _run() { const r = db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: r.changes } }; }
    async all() { return { results: db.prepare(this.sql).all(...this.params) }; }
    async first() { const r = db.prepare(this.sql).get(...this.params); return r === undefined ? null : r; }
  }

  return {
    prepare: (sql) => new Stmt(sql),
    // D1 batches are atomic: all statements commit or none do.
    async batch(stmts) {
      batchCount++;
      if (opts.failOnBatch && batchCount === opts.failOnBatch) {
        throw Object.assign(new Error('simulated D1 failure on batch ' + batchCount), { code: 'simulated_failure' });
      }
      db.exec('BEGIN');
      try { const out = stmts.map(s => s._run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    _raw: db,
    _setFailOnBatch(n) { batchCount = 0; opts.failOnBatch = n; }
  };
}
