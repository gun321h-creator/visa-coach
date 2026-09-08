// Mints a short-lived Voice Agent API token so the browser never sees the real key.
import { clientAllowed } from '../lib/guard.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!clientAllowed(req, res, 'token')) return;
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });
  try {
    const r = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=300', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      return res.status(502).json({ error: `token mint failed (${r.status})` });
    }
    const data = await r.json();
    // Field name has moved before; hedge across the shapes we have seen rather
    // than returning HTTP 200 with an undefined token (a green server, a dead app).
    const token = data?.token || data?.temp_token || data?.value;
    if (typeof token !== 'string' || !token) {
      // Log field NAMES only — never a token value.
      console.error('[token] upstream response carried no recognised token field; keys:', Object.keys(data || {}).join(','));
      return res.status(502).json({ error: 'token mint failed' });
    }
    res.status(200).json({ token, expires_in_seconds: data.expires_in_seconds });
  } catch (err) {
    // A malformed upstream body makes r.json() throw a SyntaxError quoting that
    // body, so err.message can carry upstream text. Log it, keep the reply generic.
    console.error('[token] token mint failed:', String(err?.stack || err?.message || err));
    res.status(502).json({ error: 'token mint failed' });
  }
}
