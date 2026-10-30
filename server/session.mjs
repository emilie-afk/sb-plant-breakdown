// server/session.mjs — server-verified dashboard sessions (Netlify Functions).
//
// The browser never receives a Worker credential. A person signs in with
// Google (server-side OAuth 2.0 authorization-code flow with PKCE, see
// server/google.mjs); only Google accounts on the allow-list get a session,
// and only those on the editor list may change anything. The server then
// issues a signed, expiring session cookie:
//
//   __Host-sbpb_session = base64url(payload) "." base64url(HMAC-SHA256)
//   payload = { v, sid, email, role: "viewer"|"editor", iat, exp, gen }
//
//   - HttpOnly, Secure, SameSite=Strict, Path=/ (the __Host- prefix forbids a
//     Domain attribute, so the cookie is bound to this exact site).
//   - Expiry is enforced here on every request, whatever the browser keeps.
//   - SESSION_SECRET (>= 32 chars) signs; it is separate from the Google client secret.
//   - The allow-list is checked on EVERY request: removing an email (and
//     redeploying) ends that person's sessions; moving it on/off the editor
//     list changes their rights at once.
//   - Invalidation: logout revokes the session id in durable storage;
//     bumping SESSION_GENERATION (or rotating SESSION_SECRET) ends every
//     session at once.
//   - Writes need the CSRF header (HMAC of the session id) AND a same-origin
//     Origin header; the cookie alone never authorizes a change.
//   - Failed sign-ins are counted before they are checked (atomic counters in
//     the Worker, handlers.mjs workerLimiter).
//   - Missing or weak configuration denies access (fail closed).
// Pure functions plus a small storage interface ({get, set, delete}); the
// Netlify wrappers pass Netlify Blobs, the tests pass an in-memory store.
import crypto from 'node:crypto';

export const COOKIE = '__Host-sbpb_session';
export const CSRF_HEADER = 'x-sb-csrf';
const enc = (b) => Buffer.from(b).toString('base64url');
const dec = (s) => Buffer.from(String(s), 'base64url');

// ---- configuration (fail closed) --------------------------------------
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
const emails = (v) => String(v || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
export const GOOGLE_ENDPOINTS = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com']
};
export function loadAuthConfig(env) {
  const e = env || {};
  const problems = [];
  const local = e.ALLOW_LOCAL_OAUTH === '1';      // local harness / tests only
  const secret = String(e.SESSION_SECRET || '');
  if (secret.length < 32) problems.push('SESSION_SECRET');
  const clientId = String(e.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(e.GOOGLE_CLIENT_SECRET || '').trim();
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(clientId) || (!local && !/\.apps\.googleusercontent\.com$/.test(clientId))) problems.push('GOOGLE_CLIENT_ID');
  if (clientSecret.length < 10) problems.push('GOOGLE_CLIENT_SECRET');
  if (secret && clientSecret && secret === clientSecret) problems.push('SESSION_SECRET must differ from GOOGLE_CLIENT_SECRET');
  const editors = emails(e.GOOGLE_EDITOR_EMAILS);
  const allowed = [...new Set(emails(e.GOOGLE_ALLOWED_EMAILS).concat(editors))];   // editors are always allowed
  if (!allowed.length || allowed.some(x => !EMAIL_RE.test(x))) problems.push('GOOGLE_ALLOWED_EMAILS');
  if (editors.some(x => !EMAIL_RE.test(x))) problems.push('GOOGLE_EDITOR_EMAILS');
  const origins = String(e.GOOGLE_REDIRECT_ORIGINS || '').split(/[\s,]+/).map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!origins.length || origins.some(o => !(/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) || (local && LOCAL_ORIGIN.test(o))))) problems.push('GOOGLE_REDIRECT_ORIGINS');
  const google = Object.assign({}, GOOGLE_ENDPOINTS, { clientId, clientSecret, allowed: new Set(allowed), editors: new Set(editors), origins: new Set(origins) });
  if (local) {   // a local fake provider may replace Google's endpoints, never in production
    for (const k of ['authUrl', 'tokenUrl', 'jwksUrl']) {
      const v = e['GOOGLE_' + k.replace('Url', '_URL').toUpperCase()];
      if (v) { if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(v)) problems.push('GOOGLE endpoint override must be local'); else google[k] = v; }
    }
    if (e.GOOGLE_ISSUER) google.issuers = [e.GOOGLE_ISSUER];
  }
  const ttlH = Math.min(Math.max(Number(e.SESSION_TTL_HOURS) || 12, 1), 24);
  return {
    ok: problems.length === 0, problems, secret, google,
    generation: String(e.SESSION_GENERATION || '1').slice(0, 40),
    ttlSec: Math.round(ttlH * 3600),
    perClientFailures: Math.min(Math.max(Number(e.LOGIN_MAX_FAILURES_PER_CLIENT) || 5, 1), 50),
    globalFailures: Math.min(Math.max(Number(e.LOGIN_MAX_FAILURES_GLOBAL) || 30, 5), 1000),
    windowSec: Math.min(Math.max(Number(e.LOGIN_WINDOW_MINUTES) || 15, 1), 1440) * 60
  };
}
// -> 'editor' | 'viewer' | null (not on the allow-list)
export function roleForEmail(cfg, email) {
  const e = String(email || '').toLowerCase();
  if (!cfg || !cfg.ok || !cfg.google.allowed.has(e)) return null;
  return cfg.google.editors.has(e) ? 'editor' : 'viewer';
}

// ---- signed session tokens --------------------------------------------
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();
export function signSession(cfg, { role, email, now = Date.now(), sid } = {}) {
  if (!cfg || !cfg.ok) throw new Error('auth not configured');
  if (role !== 'viewer' && role !== 'editor') throw new Error('bad role');
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw new Error('bad email');
  const iat = Math.floor(now / 1000);
  const payload = { v: 1, sid: sid || crypto.randomBytes(18).toString('base64url'), email: email.toLowerCase(), role, iat, exp: iat + cfg.ttlSec, gen: cfg.generation };
  const body = enc(JSON.stringify(payload));
  return { token: body + '.' + enc(hmac(cfg.secret, 'session:' + body)), payload };
}
// -> payload, or null (bad signature, expired, other generation, malformed)
export function verifySessionToken(cfg, token, now = Date.now()) {
  if (!cfg || !cfg.ok || typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = hmac(cfg.secret, 'session:' + parts[0]);
  let got;
  try { got = dec(parts[1]); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p;
  try { p = JSON.parse(dec(parts[0]).toString('utf8')); } catch { return null; }
  if (!p || p.v !== 1 || typeof p.sid !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.sid)) return null;
  if (p.role !== 'viewer' && p.role !== 'editor') return null;
  if (typeof p.email !== 'string' || !EMAIL_RE.test(p.email)) return null;
  const t = Math.floor(now / 1000);
  if (!Number.isInteger(p.exp) || !Number.isInteger(p.iat) || p.exp <= t || p.iat > t + 60 || p.exp - p.iat > cfg.ttlSec) return null;
  if (p.gen !== cfg.generation) return null;
  return p;
}
export function csrfToken(cfg, sid) { return enc(hmac(cfg.secret, 'csrf:' + sid)); }
export function csrfValid(cfg, sid, header) {
  if (typeof header !== 'string' || !header) return false;
  const want = Buffer.from(csrfToken(cfg, sid));
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---- cookies ---------------------------------------------------------
export function readCookie(req, name = COOKIE) {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}
export function clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }

// ---- origin check for writes ----------------------------------------
export function sameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(req.url).origin; } catch { return false; }
}

// ---- the full check used by every protected endpoint -----------------
// -> { ok:true, session } | { ok:false, status, error }
export async function authorize(req, cfg, store, { write = false, role = 'viewer', now = Date.now() } = {}) {
  if (!cfg || !cfg.ok) return { ok: false, status: 503, error: 'not_configured' };
  const p = verifySessionToken(cfg, readCookie(req), now);
  if (!p) return { ok: false, status: 401, error: 'not_signed_in' };
  if (store && await store.get('revoked/' + p.sid)) return { ok: false, status: 401, error: 'not_signed_in' };
  // the allow-list as configured NOW decides access and role, not the cookie
  const current = roleForEmail(cfg, p.email);
  if (!current) return { ok: false, status: 401, error: 'not_signed_in' };
  p.role = current;
  if (role === 'editor' && p.role !== 'editor') return { ok: false, status: 403, error: 'editor_only' };
  if (write) {
    if (!sameOrigin(req)) return { ok: false, status: 403, error: 'bad_origin' };
    if (!csrfValid(cfg, p.sid, req.headers.get(CSRF_HEADER))) return { ok: false, status: 403, error: 'bad_csrf' };
  }
  return { ok: true, session: p };
}

// ---- sign-in limits: the client bucket key -------------------------
// The counters themselves live in the Worker (atomic SQL); this only names
// the client's bucket. No raw address leaves this function.
export function clientKey(cfg, req, ip) {
  const addr = String(ip || req.headers.get('x-nf-client-connection-ip') || 'unknown').slice(0, 64);
  return enc(hmac(cfg.secret, 'client:' + addr)).slice(0, 32);
}

// ---- short-lived sealed values (OAuth state cookie) -----------------
// AES-256-GCM with a key derived from SESSION_SECRET for this purpose only:
// the PKCE verifier and nonce are unreadable even to the browser holding the
// cookie, and any change is rejected (GCM authentication).
const sealKey = (cfg, purpose) => Buffer.from(crypto.hkdfSync('sha256', cfg.secret, Buffer.alloc(0), 'sbpb:' + purpose, 32));
export function signValue(cfg, purpose, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(cfg, purpose), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return enc(Buffer.concat([iv, c.getAuthTag(), ct]));
}
export function verifyValue(cfg, purpose, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const raw = dec(value);
  if (raw.length < 29) return null;
  let o;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(cfg, purpose), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    o = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
  } catch { return null; }
  if (!o || !Number.isInteger(o.exp) || o.exp <= Math.floor(now / 1000)) return null;
  return o;
}
export const OAUTH_COOKIE = '__Host-sbpb_oauth';
// SameSite=Lax: it must come back on the top-level redirect from Google.
export function oauthCookie(value, maxAgeSec) {
  return `${OAUTH_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}
export function clearOauthCookie() { return `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
export function safeEqualStr(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function memoryStore() {
  const m = new Map();
  return {
    _m: m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); }
  };
}
