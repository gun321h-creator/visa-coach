// Scores the finished interview transcript against a 5-dimension consular rubric
// via AssemblyAI's LLM Gateway (OpenAI-compatible chat completions).
const GATEWAY_URL = 'https://llm-gateway.assemblyai.com/v1/chat/completions';

const RUBRIC_PROMPT = `You are a former U.S. consular officer who now coaches B1/B2 visitor-visa applicants.
You are given the transcript of a PRACTICE visa interview (roles: officer = the AI interviewer, applicant = the user).

Score the applicant on five dimensions, each 1-10:
1. clarity_delivery — clear, confident, concise answers; penalize rambling and filler words (um, uh, like, you know).
2. consistency_credibility — answers are internally consistent and believable; no contradictions between answers.
3. home_ties — how convincingly the applicant shows strong ties to their home country (job, family, property, studies, obligations to return).
4. purpose_funding — specific, verifiable trip purpose and clear, credible funding source.
5. red_flags — 10 means NO red flags; lower the score for immigration-intent signals, vague sponsors, rehearsed-sounding or evasive answers, or anything a real officer would probe as a 214(b) risk.

Also count filler words used by the applicant.

Respond with ONLY valid JSON, no markdown fences, in this exact shape:
{
  "scores": {"clarity_delivery": n, "consistency_credibility": n, "home_ties": n, "purpose_funding": n, "red_flags": n},
  "filler_word_count": n,
  "overall": n,
  "verdict_line": "one blunt sentence: would a real officer likely approve, and why",
  "highlights": [{"quote": "what the applicant said", "issue": "why it hurt them", "better": "a stronger way to say it"}],
  "top_fixes": ["fix 1", "fix 2", "fix 3"]
}
Limit highlights to the 3-5 most important moments. Be direct and specific, not polite.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });

  const { transcript } = req.body || {};
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: 'transcript (non-empty array) required' });
  }

  const convo = transcript
    .map((t) => `${t.role === 'agent' ? 'officer' : 'applicant'}: ${t.text}`)
    .join('\n');

  // Preferred model first; free-tier accounts fall back automatically.
  const models = [process.env.REPORT_MODEL || 'claude-sonnet-5', 'qwen3.5-4b-32k-fast'];

  try {
    let r = null;
    let lastBody = '';
    for (const model of models) {
      r = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: RUBRIC_PROMPT },
            { role: 'user', content: `Interview transcript:\n\n${convo}` },
          ],
          max_tokens: 1500,
          temperature: 0.2,
        }),
      });
      if (r.ok) break;
      lastBody = await r.text();
      if (!lastBody.includes('does not have access')) break; // real error — stop retrying
    }
    if (!r.ok) {
      return res.status(502).json({ error: `LLM gateway failed (${r.status})`, detail: lastBody.slice(0, 300) });
    }
    const data = await r.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    let report;
    try {
      report = JSON.parse(raw.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch {
      return res.status(502).json({ error: 'report was not valid JSON', raw: raw.slice(0, 500) });
    }
    res.status(200).json(report);
  } catch (err) {
    res.status(502).json({ error: 'report generation failed', detail: String(err?.message || err) });
  }
}
