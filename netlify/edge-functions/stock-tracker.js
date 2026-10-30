// /api/stock-tracker — stock-tracker data with a server-held password.
// The tracker's scrape takes ~30 s; the previous Function gateway cut it off
// with its own 9 s upstream timeout. One 37 s deadline covers the whole
// request; the sign-in check is delegated to /api/session with the caller's
// cookie (server/tracker-core.mjs).
import { trackerCore, trackerReply, sessionProbe } from '../../server/tracker-core.mjs';

export default async (req) => {
  try {
    const get = (k) => (globalThis.Netlify && Netlify.env.get(k)) || '';
    const env = { STOCK_TRACKER_URL: get('STOCK_TRACKER_URL'), STOCK_TRACKER_PASSWORD: get('STOCK_TRACKER_PASSWORD') };
    return await trackerCore(req, { env, authorize: sessionProbe(fetch) });
  } catch { return trackerReply({ ok: false, error: 'server_error' }, 500); }
};
export const config = { path: '/api/stock-tracker' };
