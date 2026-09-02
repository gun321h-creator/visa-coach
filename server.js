// Minimal local dev server mirroring Vercel's static + /api layout.
// Usage: ASSEMBLYAI_API_KEY=... node server.js  (then open http://localhost:3000)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import tokenHandler from './api/token.js';
import reportHandler from './api/report.js';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Small shim so Vercel-style (req, res) handlers work on plain node:http.
function wrapRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  wrapRes(res);
  try {
    if (url.pathname === '/api/token') return await tokenHandler(req, res);
    if (url.pathname === '/api/report') {
      req.body = await readBody(req);
      return await reportHandler(req, res);
    }
    // static files
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = normalize(file).replace(/^(\.\.[/\\])+/, '');
    const path = join(PUBLIC_DIR, file);
    const data = await readFile(path);
    res.setHeader('Content-Type', MIME[extname(path)] || 'application/octet-stream');
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') { res.statusCode = 404; res.end('not found'); }
    else { res.statusCode = 500; res.end('server error'); }
  }
}).listen(PORT, () => console.log(`visa-coach dev server → http://localhost:${PORT}`));
