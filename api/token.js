// Mints a short-lived Voice Agent API token so the browser never sees the real key.
import { clientAllowed } from '../lib/guard.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!clientAllowed(req, res)) return;
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
    res.status(200).json({ token: data.token, expires_in_seconds: data.expires_in_seconds });
  } catch (err) {
    res.status(502).json({ error: 'token mint failed', detail: String(err?.message || err) });
  }
}
