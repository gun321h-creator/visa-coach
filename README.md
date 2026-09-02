# 🛂 Visa Coach

**Practice your U.S. B1/B2 visa interview with a realistic AI consular officer — by voice, in real time — and get scored like a real applicant.**

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon) (lablab.ai, Sep 2026).

## Why

Millions of people take the B1/B2 interview every year. It lasts 2–4 minutes, and most applicants have never heard what a real consular window sounds like: fast, brisk, one probing question after another. Visa Coach recreates that pressure safely — the AI officer asks adaptive questions, probes vague answers, and never coaches you mid-interview. When you press **End Interview**, a former-officer-persona LLM scores you on the five dimensions consular officers actually weigh, highlights the exact sentences that hurt you, and tells you how to fix them.

## How it works

```
browser mic ──24kHz PCM──▶ AssemblyAI Voice Agent API (one WebSocket)
                            ├─ Universal-3 Pro streaming STT
                            ├─ LLM (officer persona, adaptive questions)
                            ├─ neural turn detection + barge-in
                            └─ TTS voice out ──▶ browser playback
End Interview ──transcript──▶ AssemblyAI LLM Gateway (Claude) ──▶ 5-dimension score report
```

Where AssemblyAI is used:

| Piece | AssemblyAI product |
|---|---|
| Real-time speech-to-text | Voice Agent API (Universal-3 Pro streaming) |
| Turn-taking / barge-in | Voice Agent API neural turn detection |
| Officer voice replies | Voice Agent API TTS |
| Post-interview scoring | LLM Gateway (`/v1/chat/completions`) |

## Run locally

```bash
cp .env.example .env        # put your AssemblyAI API key in .env
node --env-file=.env server.js
# open http://localhost:3000, press Start Interview
```

Requires Node ≥ 20 and a browser with mic access (Chrome recommended).

## Deploy

The repo is Vercel-ready: static `public/` + serverless `api/` functions.
Set `ASSEMBLYAI_API_KEY` in the Vercel project env and deploy.

## Smoke test (no mic needed)

```bash
node --env-file=.env scripts/smoke.mjs
```

Verifies: temp-token minting → Voice Agent WebSocket handshake (`session.ready`) → LLM Gateway report generation.

## Scoring rubric (5 dimensions)

1. **Clarity & delivery** — concise, confident answers; filler words counted
2. **Consistency & credibility** — no contradictions across answers
3. **Ties to home country** — job, family, property, studies
4. **Purpose & funding** — specific itinerary, credible sponsor
5. **Red flags** — immigration-intent signals a real officer would probe (INA 214(b))

## Disclaimer

Practice tool only. Not affiliated with the U.S. Department of State; not legal advice.

## License

MIT
