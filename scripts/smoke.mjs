// End-to-end smoke test without a microphone.
// 1) mint temp token  2) open Voice Agent WS, wait for session.ready AND real TTS audio
// 3) LLM Gateway reachability  4) full /api/report scoring path with a hand-counted transcript
// Never prints the API key, token values, or audio content — only statuses, field names, byte counts.
import reportHandler from '../api/report.js';

const key = process.env.ASSEMBLYAI_API_KEY?.trim();
if (!key) { console.error('FAIL: ASSEMBLYAI_API_KEY not set'); process.exit(1); }

let failures = 0;

// --- 1. token mint ---
const tr = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=300', {
  headers: { Authorization: `Bearer ${key}` },
});
console.log(`[1] token mint: HTTP ${tr.status}`);
let token = null;
if (tr.ok) {
  const data = await tr.json();
  console.log(`[1] token response fields: ${Object.keys(data).join(', ')}`);
  token = data.token || data.temp_token || data.value;
  console.log(`[1] token extracted: ${token ? 'yes' : 'NO — adjust field name'}`);
  if (!token) failures++;
} else {
  console.log(await tr.text().then((t) => `[1] body: ${t.slice(0, 200)}`));
  failures++;
}

// --- 2. WS handshake + greeting TTS ---
// session.ready alone proves nothing about voice/TTS, so we hold the socket open
// until the agent actually speaks (>=1 reply.audio chunk).
if (token) {
  await new Promise((resolve) => {
    const seen = [];
    let ready = false;
    let audioChunks = 0;
    let audioBytes = 0;
    let done = false;
    const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);

    const finish = (label, isFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log(`[2] ${label}`);
      console.log(`[2] events seen: ${seen.join(', ') || 'none'}`);
      console.log(`[2] session.ready: ${ready ? 'yes' : 'NO'} | reply.audio chunks: ${audioChunks} | decoded audio bytes: ${audioBytes}`);
      if (isFailure) failures++;
      try { ws.close(); } catch {}
      resolve();
    };

    const timer = setTimeout(() => {
      finish('TIMEOUT (20s) — did not receive session.ready + reply.audio', true);
    }, 20000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: 'You are a U.S. consular officer in a practice interview. Keep replies to one short sentence.',
          greeting: 'Good morning. What is the purpose of your trip to the United States?',
          output: { voice: 'ivy' },
        },
      }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!seen.includes(msg.type)) seen.push(msg.type);
      if (msg.type === 'session.ready') {
        ready = true;
        return; // keep the socket open — wait for the agent to actually speak
      }
      if (msg.type === 'reply.audio') {
        audioChunks++;
        if (typeof msg.data === 'string') {
          // length only — never the audio content itself
          audioBytes += Buffer.from(msg.data, 'base64').length;
        }
        if (ready && audioChunks >= 1) {
          finish(`WS OK — session.ready received and voice 'ivy' produced TTS audio`, false);
        }
        return;
      }
      if (msg.type === 'session.error') {
        console.log(`[2] session.error: ${JSON.stringify(msg).slice(0, 300)}`);
        finish('session.error received', true);
      }
    };

    ws.onerror = () => {
      console.log('[2] WS error');
    };
  });
} else {
  console.log('[2] skipped (no token)');
}

// --- 3. LLM Gateway report (same fallback chain as api/report.js) ---
const preferred = process.env.REPORT_MODEL || 'claude-sonnet-5';
const chain = preferred === 'qwen3.5-4b-32k-fast' ? [preferred] : [preferred, 'qwen3.5-4b-32k-fast'];
let gatewayOk = false;
for (const model of chain) {
  const gr = await fetch('https://llm-gateway.assemblyai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with ONLY this JSON: {"ok": true}' }],
      max_tokens: 20,
    }),
  });
  if (gr.ok) {
    const data = await gr.json();
    console.log(`[3] LLM gateway OK via ${model} | content: ${(data.choices?.[0]?.message?.content || '').slice(0, 40)}`);
    gatewayOk = true;
    break;
  }
  console.log(`[3] ${model} -> HTTP ${gr.status} (${(await gr.text()).slice(0, 120)}) — trying fallback`);
}
if (!gatewayOk) failures++;

// --- 4. scoring path: call the real /api/report handler with a canned transcript ---
// Hand count of fillers in the APPLICANT (role 'user') turns only:
//   turn 1: "Um"(1) "so"(1) "uh"(1) "you know"(1) "like"(1)          = 5
//   turn 2: "Actually"(1) "I mean"(1) "kind of"(1) "right?"(1)       = 4
//   agent turn fillers must NOT be counted                            -> total 9
const EXPECTED_FILLERS = 9;
const CANNED = [
  { role: 'agent', text: 'So, um, good morning. You know, what is the purpose of your trip?' },
  { role: 'user', text: 'Um, so I want to visit, uh, my sister in Boston, you know, like for two weeks.' },
  { role: 'agent', text: 'Who is paying for the trip?' },
  { role: 'user', text: 'Actually, I mean, my job, kind of, requires me to come back, right?' },
];

// Same (req, res) shim shape server.js uses for these Vercel-style handlers.
function fakeReq(body) {
  return {
    method: 'POST',
    url: '/api/report',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    body,
  };
}

function fakeRes() {
  const out = { statusCode: 0, payload: null };
  const res = {};
  let settle;
  out.done = new Promise((r) => { settle = r; });
  res.status = (code) => { out.statusCode = code; return res; };
  res.setHeader = () => {};
  res.json = (obj) => { out.payload = obj; settle(out); return res; };
  res.end = () => { settle(out); return res; };
  return { res, out };
}

{
  const { res, out } = fakeRes();
  await reportHandler(fakeReq({ transcript: CANNED }), res);
  await out.done;
  console.log(`[4] /api/report handler: HTTP ${out.statusCode}`);
  const rep = out.payload || {};
  if (out.statusCode !== 200) {
    console.log(`[4] body: ${JSON.stringify(rep).slice(0, 300)}`);
    failures++;
  } else {
    const dims = ['clarity_delivery', 'consistency_credibility', 'home_ties', 'purpose_funding', 'red_flags'];
    const missing = dims.filter((d) => typeof rep.scores?.[d] !== 'number' || rep.scores[d] < 0 || rep.scores[d] > 10);
    console.log(`[4] scores: ${dims.map((d) => `${d}=${rep.scores?.[d]}`).join(' ')}`);
    console.log(`[4] overall: ${rep.overall} | verdict_line present: ${typeof rep.verdict_line === 'string' && rep.verdict_line.length > 0}`);
    console.log(`[4] filler_word_count: ${rep.filler_word_count} (expected ${EXPECTED_FILLERS}) | detail: ${JSON.stringify(rep.filler_words_detail)}`);
    if (missing.length) { console.log(`[4] FAIL missing/out-of-range dimensions: ${missing.join(', ')}`); failures++; }
    if (typeof rep.overall !== 'number' || rep.overall < 0 || rep.overall > 10) { console.log('[4] FAIL overall missing or out of range'); failures++; }
    const expectedOverall = Math.round((dims.reduce((a, d) => a + (rep.scores?.[d] || 0), 0) / dims.length) * 10) / 10;
    if (rep.overall !== expectedOverall) { console.log(`[4] FAIL overall ${rep.overall} != mean of dimensions ${expectedOverall}`); failures++; }
    if (rep.filler_word_count !== EXPECTED_FILLERS) { console.log(`[4] FAIL filler count ${rep.filler_word_count} != ${EXPECTED_FILLERS}`); failures++; }
  }
}

console.log(failures === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
