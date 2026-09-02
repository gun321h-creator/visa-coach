// Mints a short-lived Voice Agent API token so the browser never sees the real key.
export default async function handler(req, res) {
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
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'token mint failed', detail: String(err?.message || err) });
  }
}
