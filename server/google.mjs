// server/google.mjs — "Sign in with Google" for the dashboard.
//
// Server-side OAuth 2.0 authorization-code flow (OpenID Connect) with PKCE:
//
//   GET /api/auth/google/start     -> 302 to Google, with state, nonce and a
//                                     PKCE challenge; their secrets are kept in
//                                     a signed, 10-minute, HttpOnly cookie
//   GET /api/auth/google/callback  <- Google returns ?code&state; the server
//                                     checks state (login CSRF), exchanges the
//                                     code (client secret + PKCE verifier) for an
//                                     ID token, verifies the token's RS256
//                                     signature against Google's keys and its
//                                     iss / aud / exp / nonce / email_verified,
//                                     then checks the email against the
//                                     allow-list. Only then is a session issued.
//
// The browser never sees the client secret, the code verifier or a token from
// Google; the page only learns the outcome (?signin=<code> when it failed).
// The redirect URI is built only from origins listed in GOOGLE_REDIRECT_ORIGINS
// (each must also be registered in Google Cloud). Failed attempts are counted
// before they are checked (the Worker's atomic counters, as for any sign-in).
import crypto from 'node:crypto';
import * as S from './session.mjs';
import { workerLimiter, reply } from './handlers.mjs';

const CALLBACK = '/api/auth/google/callback';
const STATE_TTL = 600;
const b64u = (b) => Buffer.from(b).toString('base64url');

function redirect(location, cookies = []) {
  const h = new Headers({ location, 'cache-control': 'no-store, private, max-age=0', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
}
const back = (code, cookies = []) => redirect('/?signin=' + encodeURIComponent(code), cookies);

function originOf(req, cfg) {
  let o; try { o = new URL(req.url).origin; } catch { return null; }
  return cfg.google.origins.has(o) ? o : null;
}

export async function googleStart(req, { env, now = Date.now() }) {
  if (req.method !== 'GET') return reply({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET' });
  const cfg = S.loadAuthConfig(env);
  if (!cfg.ok) return back('unavailable');
  const origin = originOf(req, cfg);
  if (!origin) return back('unavailable');
  const state = b64u(crypto.randomBytes(32)), nonce = b64u(crypto.randomBytes(32)), verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const value = S.signValue(cfg, 'oauth', { state, nonce, verifier, origin, exp: Math.floor(now / 1000) + STATE_TTL });
  const q = new URLSearchParams({
    client_id: cfg.google.clientId, redirect_uri: origin + CALLBACK, response_type: 'code', scope: 'openid email',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  });
  return redirect(cfg.google.authUrl + '?' + q, [S.oauthCookie(value, STATE_TTL)]);
}

// ---- ID token verification (RS256, Google's published keys) ------------
const jwksCache = new Map();   // url -> { at, keys }
async function googleKeys(url, fetchImpl, now, force) {
  const c = jwksCache.get(url);
  if (c && !force && now - c.at < 3600e3) return c.keys;
  const r = await fetchImpl(url, { redirect: 'manual', headers: { accept: 'application/json' } });
  if (r.status !== 200) throw new Error('jwks');
  const j = await r.json();
  if (!j || !Array.isArray(j.keys)) throw new Error('jwks');
  jwksCache.set(url, { at: now, keys: j.keys });
  return j.keys;
}
export function _resetJwksCache() { jwksCache.clear(); }
// -> claims, or throws
export async function verifyIdToken(cfg, idToken, nonce, { fetchImpl = fetch, now = Date.now() } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('format');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new Error('format'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('alg');
  let keys = await googleKeys(cfg.google.jwksUrl, fetchImpl, now, false);
  let jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) { keys = await googleKeys(cfg.google.jwksUrl, fetchImpl, now, true); jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA'); }
  if (!jwk) throw new Error('kid');
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('signature');
  const t = Math.floor(now / 1000);
  if (!cfg.google.issuers.includes(claims.iss)) throw new Error('iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.google.clientId) || (aud.length > 1 && claims.azp !== cfg.google.clientId)) throw new Error('aud');
  if (!Number.isInteger(claims.exp) || claims.exp <= t) throw new Error('exp');
  if (Number.isInteger(claims.iat) && claims.iat > t + 300) throw new Error('iat');
  if (!S.safeEqualStr(claims.nonce || '', nonce)) throw new Error('nonce');
  if (!(claims.email_verified === true || claims.email_verified === 'true')) throw new Error('email_verified');
  if (typeof claims.email !== 'string') throw new Error('email');
  return claims;
}

export async function googleCallback(req, { env, ip, fetchImpl = fetch, now = Date.now(), timeoutMs = 9000 }) {
  if (req.method !== 'GET') return reply({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET' });
  const clear = [S.clearOauthCookie()];
  const cfg = S.loadAuthConfig(env);
  if (!cfg.ok) return back('unavailable', clear);
  const origin = originOf(req, cfg);
  if (!origin) return back('unavailable', clear);
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return back('cancelled', clear);          // the person declined at Google
  const code = url.searchParams.get('code') || '', state = url.searchParams.get('state') || '';
  const o = S.verifyValue(cfg, 'oauth', S.readCookie(req, S.OAUTH_COOKIE), now);
  if (!o) return back('expired', clear);                                       // no / stale / forged state cookie
  if (!code || code.length > 2048 || !S.safeEqualStr(state, o.state) || o.origin !== origin) return back('failed', clear);

  const lim = workerLimiter(env, fetchImpl, cfg, timeoutMs);
  if (!lim) return back('unavailable', clear);
  const ck = S.clientKey(cfg, req, ip);
  let r;
  try { r = await lim.reserve(ck); } catch { return back('unavailable', clear); }
  if (r.client.n > cfg.perClientFailures || r.global.n > cfg.globalFailures) return back('too_many', clear);

  let claims;
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), timeoutMs);
    let tok;
    try {
      tok = await fetchImpl(cfg.google.tokenUrl, { method: 'POST', redirect: 'manual', signal: ac.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code, client_id: cfg.google.clientId, client_secret: cfg.google.clientSecret,
          redirect_uri: origin + CALLBACK, grant_type: 'authorization_code', code_verifier: o.verifier }).toString() });
    } finally { clearTimeout(tm); }
    if (tok.status !== 200) return back('failed', clear);
    const j = await tok.json();
    claims = await verifyIdToken(cfg, j && j.id_token, o.nonce, { fetchImpl, now });
  } catch { return back('failed', clear); }

  const email = claims.email.toLowerCase();
  const role = S.roleForEmail(cfg, email);
  if (!role) return back('denied', clear);                                     // stays counted
  try { await lim.release(ck); } catch { /* the count stays until the window ends */ }
  const { token } = S.signSession(cfg, { role, email, now });
  return redirect('/', [S.clearOauthCookie(), S.sessionCookie(token, cfg.ttlSec)]);
}
