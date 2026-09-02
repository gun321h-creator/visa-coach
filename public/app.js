import { OFFICER_PROMPT, GREETING, VOICE } from './persona.js';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const SAMPLE_RATE = 24000;

const els = {
  start: document.getElementById('btn-start'),
  end: document.getElementById('btn-end'),
  status: document.getElementById('status'),
  transcript: document.getElementById('transcript'),
  report: document.getElementById('report'),
  live: document.getElementById('live-panel'),
};

let ws = null;
let audioCtx = null;
let micStream = null;
let workletNode = null;
let playbackTime = 0;
let scheduledSources = [];
let partialEl = null;
let sessionLive = false;   // session.ready received, not yet ended
let endingByUser = false;  // deliberate hang-up in progress
const transcript = []; // {role: 'user'|'agent', text}

function setStatus(text, cls = '') {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function addLine(role, text) {
  transcript.push({ role, text });
  const div = document.createElement('div');
  div.className = `line ${role}`;
  div.innerHTML = `<span class="who">${role === 'agent' ? 'Officer' : 'You'}</span>${escapeHtml(text)}`;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function showPartial(text) {
  if (!partialEl) {
    partialEl = document.createElement('div');
    partialEl.className = 'line user partial';
    els.transcript.appendChild(partialEl);
  }
  partialEl.innerHTML = `<span class="who">You</span>${escapeHtml(text)}`;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function clearPartial() {
  if (partialEl) partialEl.remove();
  partialEl = null;
}

// ---- audio playback (24kHz PCM16 chunks, scheduled back-to-back) ----
function playChunk(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);

  const buf = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;

  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  const startAt = Math.max(audioCtx.currentTime, playbackTime);
  src.start(startAt);
  playbackTime = startAt + buf.duration;
  scheduledSources.push(src);
  src.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  for (const s of scheduledSources) {
    try { s.stop(); } catch (e) { /* already stopped */ }
  }
  scheduledSources = [];
  playbackTime = 0;
}

// Tear down mic, audio context, and socket. Safe to call from any state.
async function teardown() {
  sessionLive = false;
  stopPlayback();
  if (workletNode) { try { workletNode.disconnect(); } catch (e) { /* ignore */ } workletNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (ws) { try { ws.close(); } catch (e) { /* ignore */ } ws = null; }
  if (audioCtx) { try { await audioCtx.close(); } catch (e) { /* ignore */ } audioCtx = null; }
}

function resetSessionUI() {
  transcript.length = 0;
  clearPartial();
  els.transcript.replaceChildren();
  els.report.replaceChildren();
  els.report.classList.remove('active');
}

// ---- session ----
async function start() {
  els.start.disabled = true;
  endingByUser = false;
  resetSessionUI();

  setStatus('Requesting microphone…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    setStatus('Microphone permission denied', 'err');
    els.start.disabled = false;
    return;
  }

  setStatus('Connecting…');
  try {
    const tokenRes = await fetch('/api/token');
    if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
    const tokenData = await tokenRes.json();
    const token = tokenData.token;
    if (!token) throw new Error('token response missing token field');

    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioCtx.audioWorklet.addModule('./worklet.js');

    ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    wireSocket(ws);
  } catch (e) {
    await teardown();
    setStatus(`Could not start session: ${e.message}`, 'err');
    els.start.disabled = false;
  }
}

function wireSocket(sock) {
  sock.onopen = () => {
    sock.send(JSON.stringify({
      type: 'session.update',
      session: {
        system_prompt: OFFICER_PROMPT,
        greeting: GREETING,
        output: { voice: VOICE },
        input: {
          turn_detection: {
            vad_threshold: 0.5,
            min_silence: 700,
            max_silence: 1600,
            interrupt_response: true,
          },
        },
      },
    }));
  };

  sock.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    switch (msg.type) {
      case 'session.ready':
        try {
          startMic();
        } catch (e) {
          await teardown();
          setStatus('Your browser could not capture 24kHz audio — please use Chrome or Edge.', 'err');
          els.start.disabled = false;
          return;
        }
        sessionLive = true;
        setStatus('Interview in progress — speak naturally', 'live');
        els.end.disabled = false;
        els.live.classList.add('active');
        break;
      case 'transcript.user.delta':
        showPartial(msg.text || msg.delta || '');
        break;
      case 'transcript.user':
        clearPartial();
        if (msg.text) addLine('user', msg.text);
        break;
      case 'transcript.agent':
        if (msg.text) addLine('agent', msg.text);
        break;
      case 'reply.audio':
        if (msg.data && audioCtx) playChunk(msg.data);
        break;
      case 'reply.done':
        if (msg.status === 'interrupted') stopPlayback();
        break;
      case 'session.error':
        setStatus(`Session error: ${msg.error || 'unknown'}`, 'err');
        break;
    }
  };

  sock.onclose = () => {
    if (sessionLive && !endingByUser) {
      sessionLive = false;
      setStatus('Connection lost — press End Interview to score what was recorded', 'err');
    }
  };
  sock.onerror = () => {
    if (!sessionLive && !endingByUser) setStatus('WebSocket error', 'err');
  };
}

function startMic() {
  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
  workletNode.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const bytes = new Uint8Array(e.data);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(bin) }));
    }
  };
  source.connect(workletNode);
}

async function end() {
  els.end.disabled = true;
  endingByUser = true;
  await teardown();

  if (transcript.filter((t) => t.role === 'user').length === 0) {
    setStatus('No answers recorded — nothing to score', 'err');
    els.start.disabled = false;
    return;
  }

  setStatus('Scoring your interview…');
  try {
    const r = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    if (!r.ok) throw new Error(`report endpoint returned ${r.status}`);
    renderReport(await r.json());
    setStatus('Interview complete — press Start to practice again', 'done');
  } catch (e) {
    setStatus(`Report generation failed: ${e.message}`, 'err');
  } finally {
    els.start.disabled = false;
  }
}

function renderReport(rep) {
  const dims = [
    ['clarity_delivery', 'Clarity & delivery'],
    ['consistency_credibility', 'Consistency & credibility'],
    ['home_ties', 'Ties to home country'],
    ['purpose_funding', 'Purpose & funding'],
    ['red_flags', 'Red flags (10 = none)'],
  ];
  const scores = rep.scores || {};
  const num = (x, max) => Math.max(0, Math.min(max, Number(x) || 0));
  const bars = dims.map(([k, label]) => {
    const v = num(scores[k], 10);
    const cls = v >= 7 ? 'sg' : v >= 4 ? 'sy' : 'sr';
    return `<div class="dim"><span>${label}</span>` +
      `<div class="bar"><div class="fill ${cls}" style="width:${v * 10}%"></div></div>` +
      `<b>${v}/10</b></div>`;
  }).join('');

  const highlights = (rep.highlights || []).map((h) =>
    `<li><blockquote>&ldquo;${escapeHtml(h.quote || '')}&rdquo;</blockquote>` +
    `<p class="issue">${escapeHtml(h.issue || '')}</p>` +
    `<p class="better">Try: ${escapeHtml(h.better || '')}</p></li>`).join('');

  const fixes = (rep.top_fixes || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');

  els.report.innerHTML =
    `<h2>Interview Report</h2>` +
    `<p class="verdict">${escapeHtml(rep.verdict_line || '')}</p>` +
    `<div class="overall">Overall: <b>${num(rep.overall, 10)}/10</b> · Filler words: <b>${num(rep.filler_word_count, 999)}</b></div>` +
    bars +
    `<h3>Key moments</h3><ul class="highlights">${highlights}</ul>` +
    `<h3>Top fixes before the real interview</h3><ol class="fixes">${fixes}</ol>`;
  els.report.classList.add('active');
  els.report.scrollIntoView({ behavior: 'smooth' });
}

els.start.addEventListener('click', start);
els.end.addEventListener('click', end);
