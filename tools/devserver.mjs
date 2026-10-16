// Minimal static server for local verification of the un-built app.
// Usage: node tools/devserver.mjs [port]   (serves the repo root)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8777);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml'
};

// Optional: --proxy http://127.0.0.1:8787 forwards /v1/* to a local worker so
// the dashboard can talk to it from the same origin (for browsers that can only
// reach the page's own port). Development only.
const pi = process.argv.indexOf('--proxy');
const PROXY = pi > 0 ? process.argv[pi + 1] : null;

http.createServer(async (req, res) => {
  if (PROXY && (req.url || '').startsWith('/v1/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers.origin;
    try {
      const r = await fetch(PROXY + req.url, { method: req.method, headers,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502).end('{"ok":false,"error":"proxy_unreachable"}'); }
    return;
  }
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT));
