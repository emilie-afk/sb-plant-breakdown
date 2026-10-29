// /api/session — sign in, session status, sign out. See server/session.mjs.
import { sessionHandler, reply } from '../../server/handlers.mjs';
import { authStore } from '../../server/blobs-store.mjs';

export default async (req, context) => {
  try { return await sessionHandler(req, { env: process.env, store: authStore(), ip: context && context.ip }); }
  catch { return reply({ ok: false, error: 'server_error' }, 500); }
};
export const config = { path: '/api/session' };
