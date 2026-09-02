// Shared request guards for the api/ functions.
// Best-effort abuse protection for a public demo deployment: browser calls must
// come from our own origin, and each client IP gets a small request budget.
// (In-memory limiter is per serverless instance — good enough for a demo;
// set a spend cap on the AssemblyAI account as the real backstop.)

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 12;
const hits = new Map(); // ip -> [timestamps]

export function clientAllowed(req, res) {
  // Same-origin check: browsers always send Origin on cross-site requests.
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    let originHost = '';
    try { originHost = new URL(origin).host; } catch (e) { /* malformed */ }
    if (!originHost || originHost !== host) {
      res.status(403).json({ error: 'cross-origin requests are not allowed' });
      return false;
    }
  }

  // Naive per-IP rate limit.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    res.status(429).json({ error: 'too many requests — slow down' });
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // crude memory bound
  return true;
}
