// /api/auth/google/start and /api/auth/google/callback — Sign in with Google.
// See server/google.mjs.
import { googleStart, googleCallback } from '../../server/google.mjs';
import { reply } from '../../server/handlers.mjs';

export default async (req, context) => {
  try {
    const p = new URL(req.url).pathname;
    const ctx = { env: process.env, ip: context && context.ip };
    if (p === '/api/auth/google/start') return await googleStart(req, ctx);
    if (p === '/api/auth/google/callback') return await googleCallback(req, ctx);
    return reply({ ok: false, error: 'not_found' }, 404);
  } catch { return reply({ ok: false, error: 'server_error' }, 500); }
};
export const config = { path: ['/api/auth/google/start', '/api/auth/google/callback'] };
