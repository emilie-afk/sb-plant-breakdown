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

// Tells the Worker a run failed BEFORE anything could be stored (sign-in
// needed, export failed, file refused by the collector's own checks), so the
// dashboard can say so. A plain code and a short message only, scrubbed by the
// caller; never a file, a URL or a credential. Best effort: never throws.
export const FAILURE_PATH = '/v1/ingest/collection-failure';
export async function reportFailure(info, { workerUrl, secret, fetchImpl = fetch } = {}) {
  try {
    const u = new URL(workerUrl);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !local) return { ok: false, error: 'workerUrl must be https' };
    const res = await fetchImpl(u.origin + FAILURE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + secret },
      body: JSON.stringify({ source: info.source || 'shopify', reportScope: info.reportScope || 'total_sales_by_product', period: info.period || null,
                             errorCode: info.errorCode, message: String(info.message || '').slice(0, 300), client: info.client || null })
    });
    return { ok: res.ok, httpStatus: res.status };
  } catch (e) { return { ok: false, error: 'network' }; }
}

// Which periods shared storage already holds (dates and revision numbers only).
export async function fetchCoverage({ workerUrl, secret, fetchImpl = fetch, source = 'shopify', scope = 'total_sales_by_product' } = {}) {
  const u = new URL(workerUrl);
  const res = await fetchImpl(u.origin + '/v1/ingest/coverage?source=' + encodeURIComponent(source) + '&scope=' + encodeURIComponent(scope), {
    headers: { authorization: 'Bearer ' + secret }
  });
  if (!res.ok) throw new Error('coverage request failed (HTTP ' + res.status + ')');
  const j = await res.json();
  return j.coverage || [];
}
