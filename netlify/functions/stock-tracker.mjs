// /api/stock-tracker — stock-tracker data with a server-held password.
import { trackerHandler, reply } from '../../server/handlers.mjs';
import { authStore } from '../../server/blobs-store.mjs';

export default async (req) => {
  try { return await trackerHandler(req, { env: process.env, store: authStore() }); }
  catch { return reply({ ok: false, error: 'server_error' }, 500); }
};
export const config = { path: '/api/stock-tracker' };
