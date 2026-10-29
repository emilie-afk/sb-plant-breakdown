// A stand-in for Google's OAuth endpoints, for tests: it signs ID tokens with
// its own RSA key and serves the matching key at Google's real JWKS URL, so
// server/google.mjs is tested with its PRODUCTION configuration (real Google
// endpoint URLs, real issuer), only the network is replaced.
import crypto from 'node:crypto';
import path from 'node:path';
import worker from '../worker/src/index.js';
import { makeD1 } from './d1shim.mjs';
import { ROOT } from './load.mjs';
import { GOOGLE_ENDPOINTS } from '../server/session.mjs';

export const ORIGIN = 'https://dash.example';
export const CLIENT_ID = '1234-test.apps.googleusercontent.com';
export const AUTH_KEY = 'a'.repeat(40);
export const ENV = {
  SESSION_SECRET: 'x'.repeat(40),
  GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'google-client-secret-123',
  GOOGLE_ALLOWED_EMAILS: 'viewer@example.com, Viewer2@Example.com', GOOGLE_EDITOR_EMAILS: 'editor@example.com',
  GOOGLE_REDIRECT_ORIGINS: ORIGIN,
  WORKER_URL: 'https://worker.example', WORKER_AUTH_SECRET: AUTH_KEY
};
const b64u = (x) => Buffer.from(x).toString('base64url');

export function makeGoogle({ delay = 0, wenv } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  // a fresh key id per instance, as Google uses when it rotates keys
  const KID = 'k-' + crypto.randomBytes(6).toString('hex');
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: KID, alg: 'RS256', use: 'sig' });
  const codes = new Map();
  const e = wenv || { DB: makeD1(path.join(ROOT, 'worker', 'migrations')), AUTH_SECRET: AUTH_KEY };
  const G = { codes, calls: [], overrides: {}, wenv: e };
  G.sign = (claims, key = privateKey, kid = KID) => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })), p = b64u(JSON.stringify(claims));
    return h + '.' + p + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), key).toString('base64url');
  };
  G.rogueKey = rogue;
  // Google's consent step: remember what the start redirect asked for, hand back a code
  G.approve = (authLocation, email) => {
    const u = new URL(authLocation);
    const code = b64u(crypto.randomBytes(16));
    codes.set(code, { email, nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), redirect: u.searchParams.get('redirect_uri') });
    return { code, state: u.searchParams.get('state') };
  };
  G.fetch = async (url, init = {}) => {
    if (delay) await new Promise(r => setTimeout(r, Math.random() * delay));
    url = String(url);
    G.calls.push(url);
    if (url.startsWith('https://worker.example')) return worker.fetch(new Request(url, init), e);
    if (url === GOOGLE_ENDPOINTS.jwksUrl) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    if (url === GOOGLE_ENDPOINTS.tokenUrl) {
      const f = new URLSearchParams(init.body);
      const c = codes.get(f.get('code')); codes.delete(f.get('code'));
      const pkce = c && b64u(crypto.createHash('sha256').update(f.get('code_verifier') || '').digest()) === c.challenge;
      if (!c || !pkce || f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== ENV.GOOGLE_CLIENT_SECRET || f.get('redirect_uri') !== c.redirect || f.get('grant_type') !== 'authorization_code')
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      const t = Math.floor(Date.now() / 1000);
      const claims = Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: b64u(c.email), email: c.email, email_verified: true, nonce: c.nonce, iat: t, exp: t + 3600 }, G.overrides.claims || {});
      return new Response(JSON.stringify({ id_token: G.overrides.token ? G.overrides.token(claims) : G.sign(claims) }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  return G;
}
export const cookieValue = (setCookies, name) => {
  for (const c of setCookies) if (c.startsWith(name + '=')) return c.split(';')[0];
  return null;
};
