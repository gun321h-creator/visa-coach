// End-to-end smoke test without a microphone.
// 1) mint temp token  2) open Voice Agent WS, expect session.ready  3) LLM Gateway report call
// Never prints the API key or token values — only statuses and field names.
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

// --- 2. WS handshake ---
if (token) {
  await new Promise((resolve) => {
    const seen = [];
    const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => {
      console.log(`[2] TIMEOUT waiting for session.ready; events seen: ${seen.join(', ') || 'none'}`);
      failures++;
      try { ws.close(); } catch {}
      resolve();
    }, 15000);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          system_prompt: 'You are a test agent. Say nothing.',
          greeting: 'test',
          output: { voice: 'ivy' },
        },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        seen.push(msg.type);
        if (msg.type === 'session.ready') {
          console.log(`[2] WS handshake OK — session.ready received (fields: ${Object.keys(msg).join(', ')})`);
          clearTimeout(timer);
          ws.close();
          resolve();
        }
        if (msg.type === 'session.error') {
          console.log(`[2] session.error: ${JSON.stringify(msg).slice(0, 300)}`);
          clearTimeout(timer);
          failures++;
          ws.close();
          resolve();
        }
      } catch {}
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

console.log(failures === 0 ? 'SMOKE: ALL PASS' : `SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
