// tools/write-headers.mjs — dist/_headers with a hash-based CSP.
// Every inline <script> in dist/index.html is allowed by its SHA-256; nothing
// else inline runs, so markup injected through imported text (a product name,
// a store name) cannot execute script or call the signed-in endpoints.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// SheetJS is no longer loaded from a CDN: a verified copy is served from the
// site itself (vendor/sheetjs/<version>/, checked by tools/verify-vendor.mjs
// and pinned in index.html with an SRI integrity attribute), allowed by 'self'.
// 'self' covers only this site's static files and its functions, which answer
// JSON with X-Content-Type-Options: nosniff (never runnable as script).
export const SELF_SCRIPTS = ["'self'"];
export const CDN_SCRIPTS = ['https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js'];
export function inlineScriptHashes(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push("'sha256-" + crypto.createHash('sha256').update(m[1], 'utf8').digest('base64') + "'");
  return out;
}
export function buildCsp(html) {
  return [
    "default-src 'none'",
    "script-src " + inlineScriptHashes(html).concat(SELF_SCRIPTS, CDN_SCRIPTS).join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // same-origin endpoints, and the store's public catalog (/products.json)
    "connect-src 'self' https://succulentsbox.com",
    "worker-src 'self' blob:",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"
  ].join('; ');
}
export function headersFile(html) {
  return ['/*',
    '  Content-Security-Policy: ' + buildCsp(html),
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Strict-Transport-Security: max-age=31536000',
    '/index.html',
    '  Cache-Control: no-cache',
    // versioned path + checksum-verified content: safe to cache for a year
    '/vendor/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    ''].join('\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2] || 'dist';
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(dir, '_headers'), headersFile(html));
  console.log('  _headers written (' + inlineScriptHashes(html).length + ' inline scripts allowed by hash)');
}
