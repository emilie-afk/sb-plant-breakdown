// Uploads a validated report to the Worker. Retries only what can succeed on a
// retry (network errors, 429, 5xx); a 4xx refusal is final and reported.
export const INGEST_PATH = '/v1/ingest/product-report';

export async function uploadReport(payload, { workerUrl, secret, fetchImpl = fetch, attempts = 4, backoffMs = 5000, sleep } = {}) {
  const u = new URL(workerUrl);
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !local) throw new Error('workerUrl must be https.');
  const url = u.origin + INGEST_PATH;
  const body = JSON.stringify(payload);
  const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  let last = { ok: false, httpStatus: 0, attempts: 0, error: 'not attempted' };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
        body
      });
      let json = null; try { json = await res.json(); } catch { /* not json */ }
      last = {
        ok: res.ok && !!(json && json.ok), httpStatus: res.status, attempts: i,
        outcome: json && json.outcome, reportId: json && json.reportId, revision: json && json.revision,
        runId: json && json.runId, overlaps: (json && json.overlaps) || [],
        errors: json && json.errors ? json.errors.map(e => ({ code: e.code, message: e.message })) : null,
        error: json && !json.ok ? (json.error || json.outcome) : null
      };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { ok: false, httpStatus: 0, attempts: i, error: 'network: ' + String(e && e.message || e).split('\n')[0].slice(0, 120) };
    }
    if (i < attempts) await wait(backoffMs * 2 ** (i - 1));
  }
  return last;
}
