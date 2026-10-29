// /api/v1/* — the allowlisted gateway to the Worker. See server/handlers.mjs.
import { apiHandler, reply } from '../../server/handlers.mjs';
import { authStore } from '../../server/blobs-store.mjs';

export default async (req) => {
  try { return await apiHandler(req, { env: process.env, store: authStore() }); }
  catch { return reply({ ok: false, error: 'server_error' }, 500); }
};
export const config = { path: '/api/v1/*' };
