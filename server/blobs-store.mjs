// server/blobs-store.mjs — durable storage for revoked sessions on Netlify
// (Netlify Blobs, strong consistency). Holds only revoked session ids (one
// write per logout, no read-modify-write): no passwords, tokens or report
// data. Sign-in attempt COUNTERS are not kept here: they need atomic updates
// and live in the Worker's database (handlers.mjs workerLimiter).
import { getStore } from '@netlify/blobs';

export function authStore() {
  const s = getStore({ name: 'sb-plant-breakdown-auth', consistency: 'strong' });
  return {
    async get(k) { return (await s.get(k, { type: 'json' })) || null; },
    async set(k, v) { await s.setJSON(k, v); },
    async delete(k) { await s.delete(k); }
  };
}
