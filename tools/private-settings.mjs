// tools/private-settings.mjs — reviewed import of private business
// configuration into the Worker's protected settings.
//
// Private values (the restricted-items list, market store grouping) are not
// in the public repository. They live as Worker settings and reach the
// dashboard only through the signed-in gateway.
//
//   node tools/private-settings.mjs pull  <key> --url <worker> [--out file.json]
//   node tools/private-settings.mjs check <key> --url <worker> --file file.json
//   node tools/private-settings.mjs push  <key> --url <worker> --file file.json [--apply]
//
//   <key>: restricted_items | market_config
//
// Keys come from Windows Credential Manager: reads use sb-pb-viewer; writes
// use sb-pb-settings (the Worker's SETTINGS_SECRET), falling back to
// sb-pb-dashboard. Nothing is written without --apply, the value is checked
// with the Worker's own rules first, and a newer shared copy is never
// overwritten (version check). Keys and values are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSettingValue } from '../worker/src/store.js';

export const PRIVATE_KEYS = new Set(['restricted_items', 'market_config']);

export function summarize(key, value) {
  if (!value) return 'empty';
  if (key === 'restricted_items') return `${(value.items || []).length} items`;
  if (key === 'market_config') return `${(value.storeGroups || []).length} store groups, ${(value.focusStores || []).length} focus stores, ${(value.filenameStores || []).length} filename rules`;
  return 'value';
}

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; }
async function key(kind) {
  if (process.env.SB_PB_KEY) return process.env.SB_PB_KEY;   // local test Worker only
  const { readWindowsCredential } = await import('../collector/src/credentials.mjs');
  if (kind === 'read') return readWindowsCredential('sb-pb-viewer').secret;
  try { return readWindowsCredential('sb-pb-settings').secret; }
  catch { return readWindowsCredential('sb-pb-dashboard').secret; }
}
async function call(url, k, name, method = 'GET', body) {
  const u = new URL(url);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !local) throw new Error('The Worker URL must be https.');
  const r = await fetch(u.origin + '/v1/settings/' + name, { method, redirect: 'error',
    headers: { authorization: 'Bearer ' + k, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const url = arg('url') || process.env.SB_PB_WORKER_URL;
  if (!['pull', 'check', 'push'].includes(cmd) || !PRIVATE_KEYS.has(name) || !url) {
    console.error('Usage: node tools/private-settings.mjs pull|check|push restricted_items|market_config --url <worker> [--file f] [--out f] [--apply]');
    return 2;
  }
  const cur = await call(url, await key('read'), name);
  if (cur.status !== 200) { console.error('Could not read the shared setting (HTTP ' + cur.status + ').'); return 3; }
  const setting = cur.body.setting;
  const version = setting ? setting.version : 0;
  if (cmd === 'pull') {
    const out = arg('out') || name + '.json';
    fs.writeFileSync(out, JSON.stringify(setting ? setting.value : null, null, 2));
    console.log(`Saved ${name} (version ${version}, ${summarize(name, setting && setting.value)}) to ${out}. Keep it out of the repository.`);
    return 0;
  }
  const file = arg('file');
  if (!file) { console.error('--file is required.'); return 2; }
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const problem = checkSettingValue(name, value);
  if (problem) { console.error('Refused before sending: ' + problem); return 4; }
  console.log(`Shared ${name}: version ${version}, ${summarize(name, setting && setting.value)}.`);
  console.log(`File:   ${summarize(name, value)}.`);
  if (cmd === 'check' || !process.argv.includes('--apply')) { if (cmd === 'push') console.log('Dry run. Add --apply to write.'); return 0; }
  const w = await call(url, await key('write'), name, 'PUT', { value, baseVersion: version, updatedBy: 'private-settings tool' });
  if (w.status === 409) { console.error('The shared copy changed meanwhile. Pull and check again.'); return 5; }
  if (w.status !== 200 || !w.body.ok) { console.error('Write refused (HTTP ' + w.status + ').'); return 6; }
  console.log(`Written: ${name} version ${w.body.version}. Dashboards apply it on their next load.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(c => { process.exitCode = c; }, e => { console.error(String(e && e.message || e).split('\n')[0]); process.exitCode = 1; });
}
