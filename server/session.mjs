// server/session.mjs — server-verified dashboard sessions (Netlify Functions).
//
// The browser never receives a Worker credential. A person signs in with the
// dashboard password; the server checks it against a scrypt hash, then issues a
// signed, expiring session cookie:
//
//   __Host-sbpb_session = base64url(payload) "." base64url(HMAC-SHA256)
//   payload = { v, sid, role: "viewer"|"editor", iat, exp, gen }
//
//   - HttpOnly, Secure, SameSite=Strict, Path=/ (the __Host- prefix forbids a
//     Domain attribute, so the cookie is bound to this exact site).
//   - Expiry is enforced here on every request, whatever the browser keeps.
//   - SESSION_SECRET (>= 32 chars) signs; it is separate from the passwords.
//   - Invalidation: logout revokes the session id in durable storage;
//     bumping SESSION_GENERATION (or rotating SESSION_SECRET) ends every
//     session at once.
//   - Writes need the CSRF header (HMAC of the session id) AND a same-origin
//     Origin header; the cookie alone never authorizes a change.
//   - Sign-in attempts are counted per client and in total BEFORE the password
//     is checked, with atomic counters in the Worker's database (see
//     handlers.mjs workerLimiter); concurrent attempts cannot slip past.
//   - Missing or weak configuration denies access (fail closed).
// Pure functions plus a small storage interface ({get, set, delete}); the
// Netlify wrappers pass Netlify Blobs, the tests pass an in-memory store.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(crypto.scrypt);

export const COOKIE = '__Host-sbpb_session';
export const CSRF_HEADER = 'x-sb-csrf';
const enc = (b) => Buffer.from(b).toString('base64url');
const dec = (s) => Buffer.from(String(s), 'base64url');

// ---- configuration (fail closed) --------------------------------------
export function loadAuthConfig(env) {
  const e = env || {};
  const problems = [];
  const secret = String(e.SESSION_SECRET || '');
  if (secret.length < 32) problems.push('SESSION_SECRET');
  const viewerHash = String(e.DASHBOARD_VIEWER_PASSWORD_HASH || '');
  const editorHash = String(e.DASHBOARD_EDITOR_PASSWORD_HASH || '');
  if (!parseHash(viewerHash) && !parseHash(editorHash)) problems.push('DASHBOARD_*_PASSWORD_HASH');
  if (viewerHash && !parseHash(viewerHash)) problems.push('DASHBOARD_VIEWER_PASSWORD_HASH');
  if (editorHash && !parseHash(editorHash)) problems.push('DASHBOARD_EDITOR_PASSWORD_HASH');
  if (secret && (secret === viewerHash || secret === editorHash)) problems.push('SESSION_SECRET must differ from the password hashes');
  const ttlH = Math.min(Math.max(Number(e.SESSION_TTL_HOURS) || 12, 1), 24);
  return {
    ok: problems.length === 0, problems,
    secret, viewerHash, editorHash,
    generation: String(e.SESSION_GENERATION || '1').slice(0, 40),
    ttlSec: Math.round(ttlH * 3600),
    perClientFailures: Math.min(Math.max(Number(e.LOGIN_MAX_FAILURES_PER_CLIENT) || 5, 1), 50),
    globalFailures: Math.min(Math.max(Number(e.LOGIN_MAX_FAILURES_GLOBAL) || 30, 5), 1000),
    windowSec: Math.min(Math.max(Number(e.LOGIN_WINDOW_MINUTES) || 15, 1), 1440) * 60
  };
}

// ---- passwords (scrypt) ------------------------------------------------
// Stored form: scrypt$N$r$p$<salt b64url>$<hash b64url>
const SCRYPT_DEFAULT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashPassword(password, { N = SCRYPT_DEFAULT.N, r = SCRYPT_DEFAULT.r, p = SCRYPT_DEFAULT.p, salt } = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const s = salt || crypto.randomBytes(16);
  const h = crypto.scryptSync(password, s, SCRYPT_DEFAULT.keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, enc(s), enc(h)].join('$');
}
function parseHash(stored) {
  const m = /^scrypt\$(\d{4,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/.exec(String(stored || ''));
  if (!m) return null;
  const N = +m[1], r = +m[2], p = +m[3];
  if (N < 16384 || (N & (N - 1)) !== 0 || r < 8 || p < 1) return null;
  return { N, r, p, salt: dec(m[4]), hash: dec(m[5]) };
}
// Async: a check does not block other requests handled by the same instance.
export async function verifyPassword(password, stored) {
  const h = parseHash(stored);
  if (!h || typeof password !== 'string' || !password || password.length > 512) return false;
  const got = await scryptAsync(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: 64 * 1024 * 1024 });
  return got.length === h.hash.length && crypto.timingSafeEqual(got, h.hash);
}

// ---- signed session tokens --------------------------------------------
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();
export function signSession(cfg, { role, now = Date.now(), sid } = {}) {
  if (!cfg || !cfg.ok) throw new Error('auth not configured');
  if (role !== 'viewer' && role !== 'editor') throw new Error('bad role');
  const iat = Math.floor(now / 1000);
  const payload = { v: 1, sid: sid || crypto.randomBytes(18).toString('base64url'), role, iat, exp: iat + cfg.ttlSec, gen: cfg.generation };
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

// -> 'editor' | 'viewer' | null. Both hashes are always checked so timing
// does not reveal which password matched.
export async function roleForPassword(cfg, password) {
  const [ed, vw] = await Promise.all([cfg.editorHash ? verifyPassword(password, cfg.editorHash) : false,
                                      cfg.viewerHash ? verifyPassword(password, cfg.viewerHash) : false]);
  return ed ? 'editor' : vw ? 'viewer' : null;
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
