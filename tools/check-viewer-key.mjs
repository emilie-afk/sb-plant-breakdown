// Build-time guard: the key built into the dashboard (SB_SHARED_KEY) must be
// the Worker's READ-ONLY viewer key. Anyone who unlocks the page can extract
// it, so a collector (ingest) or dashboard (write) key must never be built in.
//
//   node tools/check-viewer-key.mjs            uses SB_SHARED_URL / SB_SHARED_KEY
//
// How the role is told apart, without writing anything:
//   PUT /v1/settings/classification_overrides with an empty body
//       viewer -> 403   collector -> 403   dashboard -> 400 (refused, nothing stored)
//   GET /v1/reports
//       viewer -> 200   collector -> 403   dashboard -> 200
// Only the viewer key answers 403 then 200. The key is never printed.
// Exit codes: 0 viewer key (or nothing to check), 1 wrong or rejected key, 2 Worker unreachable.
export async function classifyKey(url, key, fetchImpl = fetch) {
  const base = String(url).replace(/\/+$/, '');
  const h = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const put = await fetchImpl(base + '/v1/settings/classification_overrides', { method: 'PUT', headers: h, body: '{}' });
  const get = await fetchImpl(base + '/v1/reports', { headers: { authorization: 'Bearer ' + key } });
  if (put.status === 401 || get.status === 401) return { role: 'rejected', put: put.status, get: get.status };
  if (put.status === 403 && get.status === 200) return { role: 'viewer', put: put.status, get: get.status };
  if (put.status === 403 && get.status === 403) return { role: 'collector', put: put.status, get: get.status };
  if (put.status === 400 && get.status === 200) return { role: 'dashboard', put: put.status, get: get.status };
  return { role: 'unknown', put: put.status, get: get.status };
}

async function main() {
  const url = (process.env.SB_SHARED_URL || '').trim();
  const key = (process.env.SB_SHARED_KEY || '').trim();
  if (!url && !key) { console.log('  Shared storage key check: nothing built in, skipped.'); return 0; }
  if (!url || !key) { console.error('!!! Set both SB_SHARED_URL and SB_SHARED_KEY, or neither.'); return 1; }
  let r;
  try { r = await classifyKey(url, key); }
  catch (e) { console.error('!!! Could not reach the Worker at SB_SHARED_URL to check SB_SHARED_KEY.'); return 2; }
  if (r.role === 'viewer') { console.log('  Shared storage key check: read-only viewer key confirmed (writes refused).'); return 0; }
  const why = {
    rejected: 'the Worker rejects SB_SHARED_KEY (401). Is VIEWER_SECRET set on the Worker?',
    collector: 'SB_SHARED_KEY is the COLLECTOR (ingest) key. Never build it into the page.',
    dashboard: 'SB_SHARED_KEY is the DASHBOARD (write) key. Never build it into the page.',
    unknown: `unexpected answers (settings ${r.put}, reports ${r.get}).`
  }[r.role];
  console.error('!!! Build stopped: ' + why + ' Use the read-only viewer key (Credential Manager: sb-pb-viewer).');
  return 1;
}

import { pathToFileURL } from 'node:url';
import path from 'node:path';
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(c => { process.exitCode = c; });
}
