// Shared request guards for the api/ functions.
// Best-effort abuse protection for a public demo deployment: browser calls must
// carry our custom client header and come from our own origin, and each client
// IP gets a small request budget.
// (In-memory limiter is per serverless instance — good enough for a demo;
// set a spend cap on the AssemblyAI account as the real backstop.)
import { IncomingMessage } from 'node:http';

const WINDOW_MS = 60_000;

// Separate budgets per route: minting a temp token is cheap and happens on every
// page load / demo restart, while a report call costs an LLM completion.
const BUDGETS = { token: 30, report: 10 };
const DEFAULT_BUCKET = 'report'; // unknown route -> strictest budget

// Our own front end sets this on every /api call. A cross-origin page cannot set
// a custom header without a CORS preflight, which we never approve (no OPTIONS
// handler, no CORS response headers), and plain curl does not send it by
// default — so this is what stops an unauthenticated caller minting a live
// Voice Agent token. The Origin check below stays as defence in depth for the
// cases where Origin *is* present; it cannot be the primary gate because
// browsers legitimately omit Origin on same-origin GETs.
const CLIENT_HEADER = 'x-op-client';
const CLIENT_HEADER_VALUE = '1';

const MAX_TRACKED = 5000; // memory bound on the limiter map

const hits = new Map(); // `${bucket}|${ip}` -> [timestamps], least-recently-used first

function headerValue(headers, name) {
  const v = headers?.[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

function bucketFor(req, explicit) {
  if (explicit && Object.prototype.hasOwnProperty.call(BUDGETS, explicit)) return explicit;
  const url = typeof req?.url === 'string' ? req.url : '';
  if (url.includes('report')) return 'report';
  if (url.includes('token')) return 'token';
  return DEFAULT_BUCKET;
}

/**
 * True only for a handler invoked directly in-process (scripts/smoke.mjs calls
 * the report handler with a hand-rolled req object rather than over HTTP).
 * Anything that actually arrived over the network is an http.IncomingMessage —
 * on Vercel's Node runtime as well as on the local dev server — and any real
 * HTTP/1.1 request also carries a Host header, so both conditions must hold.
 */
function isInProcessCall(req) {
  if (req instanceof IncomingMessage) return false;
  const headers = req?.headers || {};
  return !headerValue(headers, 'host') && !headerValue(headers, 'x-forwarded-host');
}

/**
 * Rate-limit identity. `x-forwarded-for` is client-controlled — anyone can send
 * one — so prefer the headers the platform sets itself. On Vercel
 * `x-vercel-forwarded-for` is always present and is the real client IP, so that
 * is what we use in production.
 *
 * Raw `x-forwarded-for` is only meaningful when a proxy we actually trust
 * appended to it, and nothing in the request itself distinguishes a
 * proxy-appended entry from a forged one. So it is consulted only when the
 * operator declares a proxy is in front (TRUST_PROXY=1), and even then we take
 * the LAST entry (appended by the nearest proxy) rather than the first (fully
 * attacker-controlled). Otherwise the socket address — the only value a client
 * cannot choose — is the identity.
 */
function clientIp(req) {
  const headers = req?.headers || {};
  const vercel = headerValue(headers, 'x-vercel-forwarded-for').split(',').pop().trim();
  if (vercel) return vercel;
  if (process.env.TRUST_PROXY === '1') {
    const real = headerValue(headers, 'x-real-ip').trim();
    if (real) return real;
    const forwarded = headerValue(headers, 'x-forwarded-for').split(',').pop().trim();
    if (forwarded) return forwarded;
  }
  return req?.socket?.remoteAddress || 'unknown';
}

/**
 * Memory bound. Never a blanket clear: that would let a flood of spoofed
 * identities wipe the counters of legitimate clients too. Drop only entries
 * whose window has already expired, and only if that is still not enough, drop
 * the least recently used.
 */
function evictIfNeeded(now) {
  if (hits.size <= MAX_TRACKED) return;
  for (const [key, timestamps] of hits) {
    const last = timestamps[timestamps.length - 1];
    if (last === undefined || now - last >= WINDOW_MS) hits.delete(key);
  }
  if (hits.size <= MAX_TRACKED) return;
  let excess = hits.size - MAX_TRACKED;
  for (const key of hits.keys()) {
    if (excess-- <= 0) break;
    hits.delete(key);
  }
}

export function clientAllowed(req, res, bucketName) {
  const headers = req?.headers || {};
  const inProcess = isInProcessCall(req);

  // Custom-header gate: required for every request that came over the network.
  if (!inProcess && headerValue(headers, CLIENT_HEADER).trim() !== CLIENT_HEADER_VALUE) {
    res.status(403).json({ error: 'cross-origin requests are not allowed' });
    return false;
  }

  // Same-origin check: browsers always send Origin on cross-site requests.
  const origin = headerValue(headers, 'origin');
  if (origin) {
    const host = headerValue(headers, 'x-forwarded-host') || headerValue(headers, 'host') || '';
    let originHost = '';
    try { originHost = new URL(origin).host; } catch (e) { /* malformed */ }
    if (!originHost || originHost !== host) {
      res.status(403).json({ error: 'cross-origin requests are not allowed' });
      return false;
    }
  }

  // Naive per-IP rate limit, counted separately per route bucket.
  const bucket = bucketFor(req, bucketName);
  const max = BUDGETS[bucket];
  const ip = clientIp(req);
  const cacheKey = `${bucket}|${ip}`;
  const now = Date.now();
  const recent = (hits.get(cacheKey) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= max) {
    res.status(429).json({ error: 'too many requests — slow down' });
    return false;
  }
  recent.push(now);
  // delete+set keeps Map iteration order least-recently-used first, which is
  // what evictIfNeeded() relies on when it has to drop the oldest entries.
  hits.delete(cacheKey);
  hits.set(cacheKey, recent);
  evictIfNeeded(now);
  return true;
}
