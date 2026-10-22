// tools/classification-overrides.mjs — reviewed import of classification
// corrections into shared storage (Worker setting "classification_overrides").
//
// The dashboard reads confirmed corrections with the read-only viewer key and
// applies them for everyone. Writing them needs the DASHBOARD key, which is
// never built into the site: this tool reads it from Windows Credential
// Manager (target sb-pb-dashboard), shows exactly what would change, and
// writes only with --apply.
//
//   node tools/classification-overrides.mjs pull  --url <worker> --out current.json
//   node tools/classification-overrides.mjs check --url <worker> --file reviewed.json
//   node tools/classification-overrides.mjs push  --url <worker> --file reviewed.json [--apply]
//
// reviewed.json: the file from Data settings → Advanced → "Download for
// review" ({ overrides: {...} }), or a plain { key: entry } map, optionally
// with "remove": [keys]. Keys use stable identifiers:
//   shopify␟pid:<Product ID>   amazon␟<ASIN>   market␟<store>␟sku:<SKU>
// Entries: { group, groupType: "Genus"|"Product category", isPlant?, genus?, title?, note?, setAt? }
// The new shared copy = current shared + file entries − removed keys. A newer
// shared copy than the one read (someone else pushed) is refused, not overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PG = require(path.join(HERE, '..', 'product-grouping.js'));

const SEP = '␟';
const MAX_ENTRIES = 5000;
const KEY_RES = [
  /^shopify␟pid:\d{1,20}$/,
  /^amazon␟[A-Z0-9]{10}$/,
  /^market␟[^␟]{1,120}␟sku:[^␟]{1,80}$/,
  /^(shopify|amazon|market|catalog)␟[^␟]{1,300}␟[^␟]{0,120}␟[^␟]{0,120}$/   // legacy title key
];
const FIELDS = new Set(['group', 'groupType', 'isPlant', 'genus', 'title', 'note', 'setAt', 'source']);
const GENUS_RE = /^[A-Z][a-z]+$/;

export function readReviewFile(text) {
  const j = JSON.parse(String(text).replace(/^﻿/, ''));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('The file is not a JSON object.');
  const overrides = j.overrides && typeof j.overrides === 'object' ? j.overrides : (j.kind ? {} : Object.fromEntries(
    Object.entries(j).filter(([k]) => k !== 'remove')));
  const remove = Array.isArray(j.remove) ? j.remove.map(String) : [];
  return { overrides, remove };
}

// -> { ok, errors: [..], clean: {key: entry} } (the "source" marker is dropped)
export function validateOverrides(map) {
  const errors = [], clean = {};
  const cats = new Set(PG.knownCategories());
  const keys = Object.keys(map || {});
  if (keys.length > MAX_ENTRIES) errors.push(`Too many entries (${keys.length} > ${MAX_ENTRIES}).`);
  for (const k of keys) {
    const e = map[k];
    if (!KEY_RES.some(re => re.test(k))) { errors.push(`${k}: not a recognised key (use shopify␟pid:…, amazon␟ASIN or market␟store␟sku:…).`); continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(`${k}: entry must be an object.`); continue; }
    const extra = Object.keys(e).filter(f => !FIELDS.has(f));
    if (extra.length) errors.push(`${k}: unknown field(s) ${extra.join(', ')}.`);
    const g = typeof e.group === 'string' ? e.group.trim() : '';
    const gt = e.groupType == null ? (e.isPlant && g !== PG.GROUP_MIXED_PACK ? PG.GROUP_TYPE_GENUS : PG.GROUP_TYPE_CATEGORY) : e.groupType;
    if (!g || g.length > 80) { errors.push(`${k}: group is missing or too long.`); continue; }
    if (gt !== PG.GROUP_TYPE_GENUS && gt !== PG.GROUP_TYPE_CATEGORY) { errors.push(`${k}: groupType must be "Genus" or "Product category".`); continue; }
    if (gt === PG.GROUP_TYPE_GENUS && !(GENUS_RE.test(g) || g === PG.GROUP_UNIDENTIFIED_PLANT)) errors.push(`${k}: "${g}" is not a genus name.`);
    if (gt === PG.GROUP_TYPE_CATEGORY && !cats.has(g)) errors.push(`${k}: "${g}" is not a known category (${[...cats].join(', ')}).`);
    if (e.genus != null && e.genus !== '' && !GENUS_RE.test(String(e.genus))) errors.push(`${k}: genus "${e.genus}" is not a genus name.`);
    for (const f of ['title', 'note']) if (e[f] != null && (typeof e[f] !== 'string' || e[f].length > 300)) errors.push(`${k}: ${f} must be text up to 300 characters.`);
    const out = { group: g, groupType: gt, isPlant: gt === PG.GROUP_TYPE_GENUS || g === PG.GROUP_MIXED_PACK };
    if (e.genus) out.genus = String(e.genus);
    if (e.title) out.title = e.title;
    if (e.note) out.note = e.note;
    out.setAt = typeof e.setAt === 'string' ? e.setAt : new Date().toISOString();
    clean[k] = out;
  }
  return { ok: errors.length === 0, errors, clean };
}

// What a push would change. Unchanged entries are not listed.
export function planChange(current, file) {
  const next = Object.assign({}, current || {});
  const added = [], changed = [], removed = [];
  for (const [k, e] of Object.entries(file.overrides || {})) {
    const was = next[k];
    if (!was) added.push(k);
    else if (was.group !== e.group || was.groupType !== e.groupType || (was.genus || '') !== (e.genus || '')) changed.push(k);
    next[k] = e;
  }
  for (const k of file.remove || []) if (next[k]) { removed.push(k); delete next[k]; }
  return { next, added, changed, removed };
}

function describe(plan, current) {
  const line = (k, e) => `  ${k.split(SEP).slice(0, 2).join(' ')}  →  ${e.group}${e.genus ? ' (genus ' + e.genus + ')' : ''}${e.title ? '  — ' + e.title : ''}`;
  const out = [];
  if (plan.added.length) out.push('Add:', ...plan.added.map(k => line(k, plan.next[k])));
  if (plan.changed.length) out.push('Change:', ...plan.changed.map(k => `  ${k.split(SEP).slice(0, 2).join(' ')}  ${current[k].group} → ${plan.next[k].group}`));
  if (plan.removed.length) out.push('Remove:', ...plan.removed.map(k => '  ' + k.split(SEP).slice(0, 2).join(' ')));
  if (!out.length) out.push('Nothing to change.');
  return out.join('\n');
}

// ---- command line --------------------------------------------------------
function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; }
async function key(kind) {
  if (process.env.SB_PB_KEY) return process.env.SB_PB_KEY;          // e.g. a local test Worker
  const { readWindowsCredential } = await import('../collector/src/credentials.mjs');
  return readWindowsCredential(kind === 'write' ? 'sb-pb-dashboard' : 'sb-pb-viewer').secret;
}
async function call(url, k, method = 'GET', body) {
  const r = await fetch(url.replace(/\/$/, '') + '/v1/settings/classification_overrides', {
    method, headers: { authorization: 'Bearer ' + k, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  const cmd = process.argv[2];
  const url = arg('url') || process.env.SB_PB_WORKER_URL;
  if (!['pull', 'check', 'push'].includes(cmd) || !url || !/^https?:\/\//.test(url)) {
    console.error('Usage: node tools/classification-overrides.mjs pull|check|push --url <worker> [--file reviewed.json] [--out file] [--apply]');
    return 2;
  }
  const read = await call(url, await key('read'));
  if (read.status !== 200) { console.error('Could not read the shared corrections (HTTP ' + read.status + ').'); return 3; }
  const current = (read.body.setting && read.body.setting.value) || {};
  const version = (read.body.setting && read.body.setting.version) || 0;
  if (cmd === 'pull') {
    const out = arg('out') || 'classification-overrides-shared.json';
    fs.writeFileSync(out, JSON.stringify({ kind: 'sb-classification-overrides', version, overrides: current }, null, 2));
    console.log(`Saved ${Object.keys(current).length} shared corrections (version ${version}) to ${out}.`);
    return 0;
  }
  const file = arg('file');
  if (!file) { console.error('--file is required.'); return 2; }
  const parsed = readReviewFile(fs.readFileSync(file, 'utf8'));
  const v = validateOverrides(parsed.overrides);
  if (!v.ok) { console.error('The file was refused; nothing was written:\n  ' + v.errors.join('\n  ')); return 4; }
  const plan = planChange(current, { overrides: v.clean, remove: parsed.remove });
  console.log(`Shared corrections: version ${version}, ${Object.keys(current).length} entries.\n` + describe(plan, current));
  if (cmd === 'check' || !process.argv.includes('--apply')) {
    if (cmd === 'push') console.log('\nDry run. Add --apply to write these changes.');
    return 0;
  }
  if (!plan.added.length && !plan.changed.length && !plan.removed.length) return 0;
  const w = await call(url, await key('write'), 'PUT', { value: plan.next, baseVersion: version, updatedBy: 'classification-overrides tool' });
  if (w.status === 409) { console.error('Someone changed the shared corrections meanwhile (now version ' + w.body.currentVersion + '). Run check again.'); return 5; }
  if (w.status !== 200 || !w.body.ok) { console.error('Write refused (HTTP ' + w.status + ').'); return 6; }
  console.log(`Written: shared version ${w.body.version}, ${Object.keys(plan.next).length} entries. Every dashboard applies them on its next load.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(c => { process.exitCode = c; }, e => { console.error(String(e && e.message || e).split('\n')[0]); process.exitCode = 1; });
}
