import {
  FORM_FIELDS,
  MODES,
  normalizeMode,
  MAX_FORM_FIELD_CHARS,
  sanitizeForm,
  buildOfficerPrompt,
  buildGreeting,
  VOICE,
} from './persona.js';
import { DEMO_SESSION } from './demo-session.js';

const WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const SAMPLE_RATE = 24000;

// The window is the default because it is what a real post actually does.
const DEFAULT_UI_MODE = 'window';

const $ = (id) => document.getElementById(id);

const els = {
  landing: $('view-landing'),
  intake: $('view-intake'),
  session: $('view-session'),

  topics: $('topics'),
  formFields: $('form-fields'),
  modeChoices: $('mode-choices'),
  sampleNote: $('intake-sample-note'),

  start: $('btn-start'),
  demo: $('btn-demo'),
  file: $('btn-file'),
  skipForm: $('btn-skip-form'),
  intakeBack: $('btn-intake-back'),
  end: $('btn-end'),
  skip: $('btn-skip'),
  exit: $('btn-exit'),
  exit2: $('btn-exit-2'),
  restart: $('btn-restart'),

  statuses: Array.from(document.querySelectorAll('.js-status')),

  pill: $('state-pill'),
  stateLabel: $('state-label'),
  modeChip: $('mode-chip'),
  formChip: $('form-chip'),
  sampleBadge: $('sample-badge'),
  qCounter: $('q-counter'),
  qTarget: $('q-target'),
  timer: $('timer'),
  officer: $('officer-card'),
  officerSub: $('officer-sub'),
  bargeCue: $('barge-cue'),

  transcript: $('transcript'),
  scoring: $('scoring'),
  scoringStep: $('scoring-step'),
  report: $('report'),
  reportFoot: $('report-foot'),
};

const OFFICER_SUB_LIVE = 'U.S. consular officer · non-immigrant visas';
const OFFICER_SUB_DEMO = 'Sample replay · no microphone, no network';

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

let questionCount = 0;
let timerHandle = null;
let timerStart = 0;
let bargeCueHandle = null;
let demoToken = 0;         // bumped to cancel an in-flight replay
let demoRunning = false;
let activeStreamLine = null; // half-typed replay line, discarded when skipping

// ── intake state ──
const fieldEls = new Map();   // form key -> input/select element
const liveDraft = {};         // what the human typed, preserved across sample previews
let intakeIntent = 'live';    // 'live' | 'sample'
let intakeLocked = false;     // true while showing the sample applicant's filed form
let filedForm = {};           // the sanitized form handed to the officer and the report
let sessionMode = DEFAULT_UI_MODE;

// Bumped whenever the user navigates away from a session. An in-flight report
// fetch compares against it so a late response cannot paint over the landing.
let navEpoch = 0;

/* ── small helpers ─────────────────────────────────────────────────────── */

function setStatus(text, cls = '') {
  for (const el of els.statuses) {
    el.textContent = text;
    el.className = `status js-status${el.id === 'status-session' ? ' console-status' : ''} ${cls}`.trim();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showView(name) {
  els.landing.hidden = name !== 'landing';
  els.intake.hidden = name !== 'intake';
  els.session.hidden = name !== 'session';
  window.scrollTo({ top: 0, behavior: name === 'session' ? 'auto' : 'smooth' });
}

const FIELD_LABELS = new Map(FORM_FIELDS.map((f) => [f.key, f.label]));

/* ── landing: the topic list is generated from the form itself ─────────── */

function renderTopics() {
  if (!els.topics) return;
  els.topics.replaceChildren(...FORM_FIELDS.map((f, i) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 't-n';
    n.textContent = String(i + 1);
    li.append(n, document.createTextNode(f.label));
    return li;
  }));
}

/* ── intake: the short-form DS-160 ─────────────────────────────────────── */

function renderFormFields() {
  const frag = document.createDocumentFragment();

  FORM_FIELDS.forEach((field, i) => {
    const id = `f-${field.key}`;
    const wrap = document.createElement('div');
    wrap.className = 'gov-field';

    const label = document.createElement('label');
    label.className = 'gov-label';
    label.htmlFor = id;
    const num = document.createElement('span');
    num.className = 'gov-num';
    num.textContent = String(i + 1).padStart(2, '0');
    label.append(num, document.createTextNode(field.label));

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = field.placeholder || 'Select…';
      input.appendChild(ph);
      for (const opt of field.options || []) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.placeholder = field.placeholder || '';
      input.maxLength = MAX_FORM_FIELD_CHARS;
    }
    input.id = id;
    input.className = 'gov-input';
    input.name = field.key;
    fieldEls.set(field.key, input);

    wrap.append(label, input);

    // Visible character budget on the free-text fields.
    if (field.type !== 'select') {
      const meta = document.createElement('p');
      meta.className = 'gov-count';
      const used = document.createElement('b');
      used.textContent = '0';
      meta.append(used, document.createTextNode(` / ${MAX_FORM_FIELD_CHARS}`));
      wrap.appendChild(meta);

      const sync = () => {
        const n = input.value.length;
        used.textContent = String(n);
        meta.classList.toggle('near', n > MAX_FORM_FIELD_CHARS - 40);
        meta.classList.toggle('full', n >= MAX_FORM_FIELD_CHARS);
      };
      input.addEventListener('input', sync);
      input._syncCount = sync;
    }

    input.addEventListener('input', () => {
      if (!intakeLocked) liveDraft[field.key] = input.value;
    });
    input.addEventListener('change', () => {
      if (!intakeLocked) liveDraft[field.key] = input.value;
    });

    frag.appendChild(wrap);
  });

  els.formFields.replaceChildren(frag);
}

function renderModes() {
  const frag = document.createDocumentFragment();
  for (const [key, mode] of Object.entries(MODES)) {
    const id = `mode-${key}`;
    const label = document.createElement('label');
    label.className = 'mode';
    label.htmlFor = id;

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mode';
    radio.id = id;
    radio.value = key;
    radio.checked = key === DEFAULT_UI_MODE;

    const body = document.createElement('span');
    body.className = 'mode-body';

    const head = document.createElement('span');
    head.className = 'mode-head';
    const strong = document.createElement('strong');
    strong.textContent = mode.label;
    head.appendChild(strong);
    if (key === DEFAULT_UI_MODE) {
      const rec = document.createElement('span');
      rec.className = 'mode-rec';
      rec.textContent = 'Recommended';
      head.appendChild(rec);
    }

    const blurb = document.createElement('span');
    blurb.className = 'mode-blurb';
    blurb.textContent = mode.blurb;

    const cap = document.createElement('span');
    cap.className = 'mode-cap';
    cap.textContent = `Hard stop at ${mode.maxQuestions} questions`;

    body.append(head, blurb, cap);
    label.append(radio, body);
    frag.appendChild(label);
  }
  els.modeChoices.replaceChildren(frag);
}

function readMode() {
  const picked = els.modeChoices.querySelector('input[name="mode"]:checked');
  return normalizeMode(picked ? picked.value : DEFAULT_UI_MODE);
}

function setMode(mode) {
  const m = normalizeMode(mode);
  const radio = els.modeChoices.querySelector(`input[name="mode"][value="${m}"]`);
  if (radio) radio.checked = true;
}

function setIntakeLocked(locked) {
  intakeLocked = locked;
  for (const input of fieldEls.values()) {
    if (input.tagName === 'SELECT') input.disabled = locked;
    else input.readOnly = locked;
    input.classList.toggle('locked', locked);
  }
  els.modeChoices.querySelectorAll('input[name="mode"]').forEach((r) => { r.disabled = locked; });
  els.modeChoices.querySelectorAll('.mode').forEach((m) => m.classList.toggle('locked', locked));
}

function writeFields(values) {
  for (const [key, input] of fieldEls) {
    input.value = values[key] || '';
    if (typeof input._syncCount === 'function') input._syncCount();
  }
}

/** Read the visible form and cage it through the same sanitizer the prompt uses. */
function collectForm() {
  const raw = {};
  for (const [key, input] of fieldEls) raw[key] = input.value;
  return sanitizeForm(raw);
}

function openIntake(intent) {
  cancelDemo();
  navEpoch += 1;
  intakeIntent = intent;

  if (intent === 'sample') {
    setIntakeLocked(false);          // unlock so writeFields is not fighting readOnly
    writeFields(DEMO_SESSION.form || {});
    setMode(DEMO_SESSION.mode);
    setIntakeLocked(true);
    els.sampleNote.textContent =
      'This is the sample applicant’s filed form — read only. She runs the longer Full practice mode so you can watch every probe; a real window is three to five questions.';
    els.sampleNote.hidden = false;
    els.file.textContent = 'Start the sample replay';
    els.skipForm.hidden = true;
  } else {
    setIntakeLocked(false);
    writeFields(liveDraft);
    els.sampleNote.hidden = true;
    els.sampleNote.textContent = '';
    els.file.textContent = 'File form & open the window';
    els.skipForm.hidden = false;
  }

  showView('intake');
}

function submitIntake({ skipForm = false } = {}) {
  filedForm = skipForm ? {} : collectForm();
  sessionMode = intakeIntent === 'sample' ? normalizeMode(DEMO_SESSION.mode) : readMode();
  if (intakeIntent === 'sample') runDemo();
  else start();
}

/* ── live-state indicators ─────────────────────────────────────────────── */

const STATE_LABEL = {
  idle: 'Standing by',
  connecting: 'Connecting',
  waiting: 'Your turn — speak',
  listening: 'Listening to you',
  thinking: 'Officer considering',
  speaking: 'Officer is speaking',
  interrupted: 'You cut in',
  ended: 'Interview closed',
};

function setState(state) {
  const label = STATE_LABEL[state] || STATE_LABEL.idle;
  els.pill.dataset.state = state === 'waiting' ? 'idle' : state;
  els.stateLabel.textContent = label;
  els.officer.classList.toggle('speaking', state === 'speaking');
  els.officer.classList.toggle('listening', state === 'listening');
}

// The console header mirrors the chosen mode's budget rather than a fixed 8-12.
function applyModeToConsole() {
  const mode = MODES[normalizeMode(sessionMode)];
  els.qTarget.textContent = `/ up to ${mode.maxQuestions}`;
  els.modeChip.textContent = mode.label;
  els.modeChip.hidden = false;
  const filed = Object.keys(filedForm).length;
  els.formChip.textContent = filed ? `Form on screen · ${filed}/${FORM_FIELDS.length} fields` : 'No form filed';
  els.formChip.classList.toggle('empty', filed === 0);
  els.formChip.hidden = false;
  els.qCounter.classList.remove('over');
}

function showBargeCue() {
  els.bargeCue.hidden = false;
  clearTimeout(bargeCueHandle);
  bargeCueHandle = setTimeout(() => { els.bargeCue.hidden = true; }, 2600);
}

function bumpQuestionCount(text) {
  if (!text || !text.includes('?')) return;
  questionCount += 1;
  els.qCounter.textContent = String(questionCount);
  els.qCounter.classList.toggle('over', questionCount > MODES[normalizeMode(sessionMode)].maxQuestions);
}

function startTimer() {
  stopTimer();
  timerStart = Date.now();
  els.timer.textContent = '00:00';
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    els.timer.textContent =
      `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

/* ── transcript rendering ──────────────────────────────────────────────── */

function addLine(role, text) {
  transcript.push({ role, text });
  const div = document.createElement('div');
  div.className = `line ${role}`;
  div.innerHTML = `<span class="who">${role === 'agent' ? 'Officer' : 'You'}</span>${escapeHtml(text)}`;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (role === 'agent') bumpQuestionCount(text);
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

// Streaming line used by the sample replay. Text is written with textContent,
// so nothing here can inject markup.
function openStreamingLine(role) {
  const div = document.createElement('div');
  div.className = `line ${role}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'agent' ? 'Officer' : 'You';
  const body = document.createElement('span');
  const caret = document.createElement('span');
  caret.className = 'caret';
  div.append(who, body, caret);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return { div, body, caret };
}

/* ── audio playback (24kHz PCM16 chunks, scheduled back-to-back) ───────── */

// One malformed frame must never kill the message handler: bad base64 throws in
// atob, and an odd byte length throws RangeError in the Int16Array view. Both are
// contained here so a corrupt chunk is skipped and the session keeps running.
function playChunk(b64) {
  if (typeof b64 !== 'string' || !audioCtx) return false;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // PCM16 needs whole samples — drop a trailing odd byte rather than throw.
    const samples = Math.floor(bytes.length / 2);
    if (samples === 0) return false;
    const pcm = new Int16Array(bytes.buffer, 0, samples);

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
    return true;
  } catch (e) {
    return false; // skip the bad frame
  }
}

function stopPlayback() {
  for (const s of scheduledSources) {
    try { s.stop(); } catch (e) { /* already stopped */ }
  }
  scheduledSources = [];
  playbackTime = 0;
}

// Tear down mic, audio context, and socket. Safe to call from any state.
// The module-level refs are detached synchronously *before* the first await, so a
// slow audioCtx.close() can never null a newer session's objects, and callers that
// do not await this (backToLanding) still leave a clean slate behind them.
async function teardown() {
  sessionLive = false;
  stopPlayback();
  const node = workletNode;
  const stream = micStream;
  const sock = ws;
  const ctx = audioCtx;
  workletNode = null;
  micStream = null;
  ws = null;
  audioCtx = null;

  if (node) { try { node.disconnect(); } catch (e) { /* ignore */ } }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (sock) { try { sock.close(); } catch (e) { /* ignore */ } }
  if (ctx) { try { await ctx.close(); } catch (e) { /* ignore */ } }
}

function resetSessionUI() {
  transcript.length = 0;
  clearPartial();
  els.transcript.replaceChildren();
  els.report.replaceChildren();
  els.report.hidden = true;
  els.reportFoot.hidden = true;
  els.scoring.hidden = true;
  els.bargeCue.hidden = true;
  questionCount = 0;
  els.qCounter.textContent = '0';
  els.qCounter.classList.remove('over');
  els.timer.textContent = '00:00';
  setState('idle');
  applyModeToConsole();
}

/* ── live session ──────────────────────────────────────────────────────── */

async function start() {
  cancelDemo();
  els.start.disabled = true;
  els.demo.disabled = true;
  endingByUser = false;

  showView('session');
  resetSessionUI();
  els.sampleBadge.hidden = true;
  els.skip.hidden = true;
  els.officerSub.textContent = OFFICER_SUB_LIVE;
  setState('connecting');

  setStatus('Requesting microphone…');
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    setStatus('Microphone permission denied — you can still watch the sample replay', 'err');
    setState('idle');
    els.start.disabled = false;
    els.demo.disabled = false;
    showView('landing');
    return;
  }

  setStatus('Connecting…');
  try {
    const tokenRes = await fetch('/api/token', { headers: { 'X-OP-Client': '1' } });
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
    setState('idle');
    setStatus(`Could not start session: ${e.message}`, 'err');
    els.start.disabled = false;
    els.demo.disabled = false;
  }
}

function wireSocket(sock) {
  // A socket that dies — refused connect, expired token, dropped line, or a fatal
  // session.error — must always stop the microphone and hand the UI back. This runs
  // regardless of `sessionLive`, because the wedged case is precisely the one where
  // the session never reached ready and `sessionLive` is still false.
  let downHandled = false;

  const handleSocketDown = async ({ liveText, deadText }) => {
    if (downHandled) return;
    // A socket from an earlier session, or the user's own hang-up, is not a failure.
    if (sock !== ws || endingByUser) return;
    downHandled = true;

    const reachedReady = sessionLive;
    stopTimer();
    await teardown();   // stops mic tracks, closes the worklet, socket and context

    els.start.disabled = false;
    els.demo.disabled = false;

    if (reachedReady) {
      // There is a transcript worth scoring, so stay on the console.
      setState('ended');
      els.end.disabled = !transcript.some((t) => t.role === 'user');
      setStatus(liveText, 'err');
    } else {
      setState('idle');
      els.end.disabled = true;
      showView('landing');
      setStatus(deadText, 'err');
    }
  };

  let sawSocketError = false;

  sock.onopen = () => {
    sock.send(JSON.stringify({
      type: 'session.update',
      session: {
        system_prompt: buildOfficerPrompt(filedForm, sessionMode),
        greeting: buildGreeting(sessionMode),
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
          setState('idle');
          els.start.disabled = false;
          els.demo.disabled = false;
          showView('landing');
          return;
        }
        sessionLive = true;
        setStatus('Interview in progress — speak naturally', 'live');
        setState('waiting');
        startTimer();
        els.end.disabled = false;
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

      // ── live state indicators ──
      case 'input.speech.started':
        clearPartial();
        setState('listening');
        break;
      case 'input.speech.stopped':
        setState('thinking');
        break;
      case 'reply.started':
        setState('speaking');
        break;
      case 'interrupt_response':
        stopPlayback();
        setState('interrupted');
        showBargeCue();
        break;

      case 'reply.audio':
        if (msg.data && audioCtx) playChunk(msg.data);
        break;
      case 'reply.done':
        if (msg.status === 'interrupted') {
          stopPlayback();
          setState('interrupted');
          showBargeCue();
        } else if (sessionLive) {
          setState('waiting');
        }
        break;
      case 'session.error': {
        // Fatal server-side error: treat it exactly like a close rather than
        // leaving the timer running and the socket open behind a status line.
        const text = `Session error: ${msg.error || 'unknown'}`;
        await handleSocketDown({
          liveText: `${text} — press End interview to score what was recorded`,
          deadText: text,
        });
        break;
      }
    }
  };

  sock.onclose = () => {
    handleSocketDown({
      liveText: 'Connection lost — press End interview to score what was recorded',
      deadText: sawSocketError
        ? 'Could not reach the interview service — the connection failed before the interview started. Try again, or watch the sample replay.'
        : 'The interview service closed the connection before the interview started — the session token may have expired. Try again, or watch the sample replay.',
    });
  };
  sock.onerror = () => {
    sawSocketError = true;
    handleSocketDown({
      liveText: 'Connection lost — press End interview to score what was recorded',
      deadText: 'Could not reach the interview service — the connection failed before the interview started. Try again, or watch the sample replay.',
    });
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
  const epoch = navEpoch;
  els.end.disabled = true;
  endingByUser = true;
  stopTimer();
  setState('ended');
  await teardown();

  if (transcript.filter((t) => t.role === 'user').length === 0) {
    setStatus('No answers recorded — nothing to score', 'err');
    els.start.disabled = false;
    els.demo.disabled = false;
    return;
  }

  setStatus('');
  const stopSteps = beginScoring();
  try {
    const r = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OP-Client': '1' },
      body: JSON.stringify({ transcript, form: filedForm }),
    });
    if (!r.ok) {
      // The server writes wording the user can act on — a 503 means the free-tier
      // gateway is throttled and the answer is "wait a minute and press End
      // interview again", which a bare status code does not tell anyone. It is
      // our own text, never upstream text; the API is careful about that.
      let detail = '';
      try {
        const body = await r.json();
        if (body && typeof body.error === 'string') detail = body.error;
      } catch {
        /* not JSON — fall back to the status code */
      }
      throw new Error(detail || `report endpoint returned ${r.status}`);
    }
    const rep = await r.json();
    stopSteps();
    // The user pressed Back while the report was in flight — do not paint a stale
    // report over the landing view, and do not overwrite the landing status.
    if (epoch !== navEpoch) return;
    endScoring();
    renderReport(rep, { sample: false });
    setStatus('Interview complete', 'done');
  } catch (e) {
    stopSteps();
    if (epoch !== navEpoch) return;
    endScoring();
    setStatus(`Report generation failed: ${e.message}`, 'err');
    // The transcript is still in memory, and a 503 tells the user to wait and
    // press End interview again — so the button that does that has to come
    // back. Without this the only affordance left restarts and discards it.
    els.end.disabled = false;
    els.reportFoot.hidden = false;
  } finally {
    els.start.disabled = false;
    els.demo.disabled = false;
  }
}

/* ── scoring wait state ────────────────────────────────────────────────── */

const SCORING_STEPS = [
  'Reading the transcript…',
  'Comparing every answer against your filed form…',
  'Checking what a real officer would probe…',
  'Writing your fixes…',
];

function beginScoring() {
  els.report.hidden = true;
  els.reportFoot.hidden = true;
  els.scoring.hidden = false;
  els.scoringStep.textContent = SCORING_STEPS[0];
  els.scoring.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  let i = 0;
  const h = setInterval(() => {
    i = Math.min(i + 1, SCORING_STEPS.length - 1);
    els.scoringStep.textContent = SCORING_STEPS[i];
  }, 1400);
  return () => clearInterval(h);
}

function endScoring() {
  els.scoring.hidden = true;
}

/* ── report ────────────────────────────────────────────────────────────── */

// Label text here is authored markup, not user data — the entities are intentional.
const DIMENSIONS = [
  ['form_consistency', 'Form consistency', 'Does what you said match what you filed?'],
  ['clarity_delivery', 'Clarity &amp; delivery', 'Concise, confident, no rambling'],
  ['consistency_credibility', 'Consistency &amp; credibility', 'Answers hold together and sound true'],
  ['home_ties', 'Ties to home country', 'Reasons an officer believes you go back'],
  ['purpose_funding', 'Purpose &amp; funding', 'Specific trip, verifiable money'],
  ['red_flags', 'Red-flag check', 'Higher is better — 10 means the officer found nothing to probe'],
];

const band = (v) => (v >= 7 ? 'sg' : v >= 4 ? 'sy' : 'sr');
const RING_C = 326.7; // 2 * pi * 52

function renderContradictions(rep) {
  const list = Array.isArray(rep.contradictions) ? rep.contradictions : [];

  if (list.length) {
    const items = list.map((c) => {
      const label = FIELD_LABELS.get(c && c.field) || (c && c.field) || 'Form field';
      return `<li class="contra">` +
        `<p class="contra-field">${escapeHtml(label)}</p>` +
        `<div class="contra-cols">` +
          `<div class="contra-col filed"><span class="ck">On your form</span>` +
            `<p>${escapeHtml((c && c.filed) || '')}</p></div>` +
          `<div class="contra-col said"><span class="ck">At the window</span>` +
            `<p>&ldquo;${escapeHtml((c && c.said) || '')}&rdquo;</p></div>` +
        `</div>` +
        ((c && c.why_it_matters)
          ? `<p class="contra-why"><span class="why-k">Why it matters</span>${escapeHtml(c.why_it_matters)}</p>`
          : '') +
        `</li>`;
    }).join('');

    return `<section class="rep-section contra-section reveal">` +
      `<h3 class="rep-h">What you filed vs what you said</h3>` +
      `<p class="contra-lead">${list.length === 1 ? 'One answer' : `${list.length} answers`} did not match the form the officer had in front of him. This is the part that decides cases.</p>` +
      `<ul class="contras">${items}</ul></section>`;
  }

  if (rep.form_provided === false) {
    return `<section class="rep-section contra-section empty reveal">` +
      `<h3 class="rep-h">What you filed vs what you said</h3>` +
      `<p class="contra-none">No form was filed for this session, so there was nothing to cross-examine. ` +
      `File the short DS-160 next time — the divergence between the form and the window is where most refusals actually come from.</p>` +
      `</section>`;
  }

  return `<section class="rep-section contra-section clean reveal">` +
    `<h3 class="rep-h">What you filed vs what you said</h3>` +
    `<p class="contra-none">Nothing you said contradicted your filed form. That is the single hardest part of the window, and you held it.</p>` +
    `</section>`;
}

function renderReport(rep, { sample = false } = {}) {
  const scores = rep.scores || {};
  // The gateway sometimes returns fractional scores (e.g. 4.4) — clamp, then
  // round to one decimal so the gauge never prints 6.666666666.
  const num = (x, max) => Math.round(Math.max(0, Math.min(max, Number(x) || 0)) * 10) / 10;
  const overall = num(rep.overall, 10);

  const refusals = Math.round(num(rep.refusal_reasons_found, 99));

  // A dimension the model did not score comes back as null. Drawing that as a red
  // 0/10 would tell the user they failed something they were never scored on, so
  // the bar is omitted entirely and the note below says how many are missing.
  const scoredDims = DIMENSIONS.filter(([k]) => {
    const v = scores[k];
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  });

  const bars = scoredDims.map(([k, label, hint]) => {
    const v = num(scores[k], 10);
    return `<div class="dim${k === 'form_consistency' ? ' dim-key' : ''}">` +
      `<span class="dim-label">${label}<small>${hint}</small></span>` +
      `<div class="bar"><div class="fill ${band(v)}" data-w="${v * 10}"></div></div>` +
      `<b class="dim-val">${v}/10</b></div>`;
  }).join('');

  // form_consistency is only offered when a form was filed, so "missing" means a
  // dimension that was offered and came back unscored.
  const offeredDims = DIMENSIONS.filter(([k]) => Object.prototype.hasOwnProperty.call(scores, k)).length;
  const unscored = Math.max(0, offeredDims - scoredDims.length);
  const scorecardNote = scoredDims.length === 0
    ? `<p class="rep-note">No dimension came back scored for this transcript, so there is no scorecard to show. The findings above still stand.</p>`
    : `<p class="rep-note">Every scale runs the same direction: <b>10 is best</b>. ` +
      `A low red-flag score means an officer found things worth probing.` +
      (unscored ? ` ${unscored === 1 ? 'One dimension was' : `${unscored} dimensions were`} not scored for this transcript and ${unscored === 1 ? 'is' : 'are'} left out rather than shown as zero.` : '') +
      `</p>`;

  const highlights = (rep.highlights || []).map((h) =>
    `<li><blockquote>&ldquo;${escapeHtml((h && h.quote) || '')}&rdquo;</blockquote>` +
    `<p class="issue"><span class="hl-k">Cost you</span><span>${escapeHtml((h && h.issue) || '')}</span></p>` +
    `<p class="better"><span class="hl-k">Say instead</span><span>${escapeHtml((h && h.better) || '')}</span></p></li>`).join('');

  const fixes = (rep.top_fixes || []).map((f) => `<li><span>${escapeHtml(f)}</span></li>`).join('');

  const answered = transcript.filter((t) => t.role === 'user').length;

  const honesty = rep.honesty_note
    ? `<aside class="honesty reveal">` +
        `<span class="honesty-k">The honesty rule</span>` +
        `<p>${escapeHtml(rep.honesty_note)}</p></aside>`
    : '';

  els.report.innerHTML =
    `<div class="rep-head reveal">` +
      `<p class="rep-kicker">${sample ? 'Sample interview report' : 'Interview report'}</p>` +
      `<div class="rep-lead">` +
        `<p class="refusal ${refusals === 0 ? 'zero' : 'some'}">` +
          `<span class="refusal-n">${refusals}</span>` +
          `<span class="refusal-k">likely refusal reason${refusals === 1 ? '' : 's'} found</span>` +
        `</p>` +
        `<p class="rep-verdict">${escapeHtml(rep.verdict_line || '')}</p>` +
        `<p class="rep-caveat">A count of problems in this practice transcript &mdash; not a prediction of any real decision.</p>` +
      `</div>` +
      `<div class="rep-underline">` +
        `<div class="ring-wrap ring-sm">` +
          `<svg viewBox="0 0 120 120" aria-hidden="true">` +
            `<circle class="ring-track" cx="60" cy="60" r="52"></circle>` +
            `<circle class="ring-fill ${band(overall)}" cx="60" cy="60" r="52" ` +
              `style="stroke-dasharray:${RING_C}; stroke-dashoffset:${RING_C}"></circle>` +
          `</svg>` +
          `<div class="ring-label"><b>${overall}</b><span>/10</span></div>` +
        `</div>` +
        `<div class="rep-facts">` +
          `<span>Overall coaching score <b>${overall}</b></span>` +
          `<span>Questions asked <b>${questionCount}</b></span>` +
          `<span>Answers given <b>${answered}</b></span>` +
          `<span>Filler words <b>${Math.round(num(rep.filler_word_count, 999))}</b></span>` +
        `</div>` +
      `</div>` +
    `</div>` +
    `<div class="rep-body">` +
      renderContradictions(rep) +
      `<section class="rep-section reveal"><h3 class="rep-h">Scorecard</h3>${bars}` +
        scorecardNote + `</section>` +
      (highlights ? `<section class="rep-section reveal"><h3 class="rep-h">Key moments</h3><ul class="highlights">${highlights}</ul></section>` : '') +
      (fixes ? `<section class="rep-section reveal"><h3 class="rep-h">Fix these before the real interview</h3><ol class="fixes">${fixes}</ol></section>` : '') +
      honesty +
    `</div>`;

  els.report.hidden = false;
  els.reportFoot.hidden = false;

  // staggered reveal + bar/ring animation, after layout has settled
  requestAnimationFrame(() => {
    const ring = els.report.querySelector('.ring-fill');
    if (ring) ring.style.strokeDashoffset = String(RING_C * (1 - overall / 10));
    els.report.querySelectorAll('.reveal').forEach((sec, i) => {
      setTimeout(() => sec.classList.add('in'), 60 * i);
    });
    els.report.querySelectorAll('.fill[data-w]').forEach((f, i) => {
      setTimeout(() => { f.style.width = `${f.dataset.w}%`; }, 180 + 90 * i);
    });
  });

  els.report.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── sample replay (no mic, no socket, no API) ─────────────────────────── */

function cancelDemo() {
  demoToken += 1;
  demoRunning = false;
  activeStreamLine = null;
  els.skip.hidden = true;
}

// The scripted turns carry near-real speech rates (~17-21 chars/sec). A demo
// video cannot afford three minutes of that, so the replay runs at DEMO_SPEED x
// while keeping each turn's *relative* pacing — the hesitant funding answer is
// still visibly slower than the confident travel-history one.
const DEMO_SPEED = 2.8;
const DEMO_PAUSE = 0.5;

async function typeInto(node, text, cps, token) {
  const perChar = Math.max(6, 1000 / ((cps || 18) * DEMO_SPEED));
  let i = 0;
  while (i < text.length) {
    const step = text.length > 90 ? 2 : 1; // long lines type in pairs, keeps pacing sane
    i = Math.min(text.length, i + step);
    node.textContent = text.slice(0, i);
    els.transcript.scrollTop = els.transcript.scrollHeight;
    await sleep(perChar * step);
    if (token !== demoToken) return false;
  }
  return true;
}

async function runDemo() {
  cancelDemo();
  const token = ++demoToken;
  demoRunning = true;

  showView('session');
  resetSessionUI();
  els.sampleBadge.hidden = false;
  els.skip.hidden = false;
  els.end.disabled = true;
  els.demo.disabled = true;
  els.officerSub.textContent = OFFICER_SUB_DEMO;
  setStatus('Sample replay — scripted transcript, no microphone and no network calls.');
  setState('idle');
  startTimer();

  for (const turn of DEMO_SESSION.turns) {
    await sleep((turn.pauseBefore || 350) * DEMO_PAUSE);
    if (token !== demoToken) return;

    if (turn.role === 'agent') {
      setState('speaking');
      const { div, body, caret } = openStreamingLine('agent');
      activeStreamLine = div;
      const cut = typeof turn.interruptAt === 'number';
      const spoken = cut
        ? turn.text.slice(0, Math.max(1, Math.floor(turn.text.length * turn.interruptAt)))
        : turn.text;
      const finished = await typeInto(body, spoken, turn.cps, token);
      if (!finished) return;
      caret.remove();
      activeStreamLine = null;
      if (cut) {
        body.textContent = `${spoken.trimEnd()}—`;
        div.classList.add('cut');
        setState('interrupted');
        showBargeCue();
      }
      transcript.push({ role: 'agent', text: turn.text });
      bumpQuestionCount(turn.text);
      if (!cut) setState('waiting');
    } else {
      setState('listening');
      const { div, body, caret } = openStreamingLine('user');
      activeStreamLine = div;
      const finished = await typeInto(body, turn.text, turn.cps, token);
      if (!finished) return;
      caret.remove();
      activeStreamLine = null;
      transcript.push({ role: 'user', text: turn.text });
      setState('thinking');
    }
  }

  await finishDemo(token);
}

async function finishDemo(token) {
  if (token !== demoToken) return;
  stopTimer();
  setState('ended');
  els.skip.hidden = true;
  setStatus('');

  const stopSteps = beginScoring();
  await sleep(2400);
  stopSteps();
  if (token !== demoToken) { endScoring(); return; }
  endScoring();

  renderReport(DEMO_SESSION.report, { sample: true });
  setStatus('Sample replay complete — a live interview scores your own answers the same way.', 'done');
  demoRunning = false;
  els.demo.disabled = false;
}

function skipDemo() {
  if (!demoRunning) return;
  const token = ++demoToken;   // cancel the typing loop
  demoRunning = true;
  // fill in whatever the replay had not reached yet, so the transcript is whole
  const seen = transcript.length;
  if (activeStreamLine) { activeStreamLine.remove(); activeStreamLine = null; }
  els.transcript.querySelectorAll('.caret').forEach((c) => c.remove());
  for (let i = seen; i < DEMO_SESSION.turns.length; i++) {
    const t = DEMO_SESSION.turns[i];
    addLine(t.role, t.text);
  }
  finishDemo(token);
}

function backToLanding() {
  cancelDemo();
  navEpoch += 1;   // any report still in flight becomes a no-op
  stopTimer();
  teardown();      // detaches mic/socket/context refs synchronously
  resetSessionUI();
  els.start.disabled = false;
  els.demo.disabled = false;
  els.end.disabled = true;
  setStatus('Microphone required for a live interview. The sample replay needs nothing.');
  showView('landing');
}

/* ── wiring ────────────────────────────────────────────────────────────── */

renderTopics();
renderFormFields();
renderModes();

els.start.addEventListener('click', () => openIntake('live'));
els.demo.addEventListener('click', () => openIntake('sample'));
els.file.addEventListener('click', () => submitIntake());
els.skipForm.addEventListener('click', () => submitIntake({ skipForm: true }));
els.intakeBack.addEventListener('click', () => showView('landing'));
els.end.addEventListener('click', end);
els.skip.addEventListener('click', skipDemo);
els.exit.addEventListener('click', backToLanding);
els.exit2.addEventListener('click', backToLanding);
els.restart.addEventListener('click', () => openIntake('live'));
document.querySelectorAll('[data-demo-trigger]').forEach((b) => b.addEventListener('click', () => openIntake('sample')));
