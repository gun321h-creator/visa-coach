// Deterministic test of the gateway failure handling in api/report.js.
// The gateway is stubbed, so no network and no API key are needed.
//
//   A. a 429 on the last model is retried once, and a success on the retry
//      produces a normal report (this is what protects a demo recording, where
//      several takes in a row trip AssemblyAI's free-tier throttle)
//   B. a 429 that persists returns 503 with actionable wording, not 502
//   C. no upstream text ever reaches the client — gateway error bodies can echo
//      the credential that was presented
//   D. and it does not reach the server log either: function logs are retained,
//      so the raw body must be summarised, never written down
import handler from '../api/report.js';

process.env.ASSEMBLYAI_API_KEY ||= 'unused-fetch-is-stubbed';
process.env.REPORT_MODEL = 'qwen3.5-4b-32k-fast'; // single-model chain, so the retry is unambiguous

const TRANSCRIPT = [
  { role: 'agent', text: 'Who is paying for this trip?' },
  { role: 'user', text: 'My sister is covering it.' },
];

const GOOD_REPORT = {
  scores: {
    clarity_delivery: 7,
    consistency_credibility: 7,
    home_ties: 7,
    purpose_funding: 7,
    red_flags: 8,
  },
  overall: 7,
  verdict_line: 'Borderline.',
  contradictions: [],
  highlights: [],
  top_fixes: [],
};

const SECRET_BODY = JSON.stringify({
  message: 'too many requests for this action',
  code: 429,
  echoed_credential: 'SUPERSECRETKEYVALUE',
});

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  return res;
}

const req = () => ({
  method: 'POST',
  url: '/api/report',
  headers: {},
  body: { transcript: TRANSCRIPT },
});

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

// --- A: 429 then success ----------------------------------------------------
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  if (calls === 1) {
    return { ok: false, status: 429, text: async () => SECRET_BODY, json: async () => ({}) };
  }
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPORT) } }] }),
  };
};

const t0 = Date.now();
const resA = makeRes();
await handler(req(), resA);
const elapsed = Date.now() - t0;

check('A  429 then success -> 200', resA.statusCode, 200);
check('A  the retry actually happened', calls, 2);
check('A  a real report came back', typeof resA.body?.scores === 'object' && resA.body.scores !== null, true);
console.log(`${elapsed >= 1000 ? 'PASS' : 'FAIL'}  A  backed off before retrying -> ${elapsed}ms (expected >=1000)`);
if (elapsed < 1000) fail++;

// --- B + C: 429 that persists ----------------------------------------------
calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  return { ok: false, status: 429, text: async () => SECRET_BODY, json: async () => ({}) };
};

const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.map(String).join(' ')); };

const resB = makeRes();
await handler(req(), resB);

console.error = realError;
const clientText = JSON.stringify(resB.body);
const logText = logged.join('\n');
console.log(`server log line: ${logText.trim() || '(none)'}`);

check('B  persistent 429 -> 503 not 502', resB.statusCode, 503);
check('B  retried once then gave up', calls, 2);
check('B  wording tells the user to wait', /rate-limited/i.test(clientText), true);
check('C  upstream credential not leaked to client', /SUPERSECRETKEYVALUE/.test(clientText), false);
check('C  upstream body not leaked to client', /too many requests/i.test(clientText), false);
check('D  upstream credential not written to the log', /SUPERSECRETKEYVALUE/.test(logText), false);
check('D  log still says what went wrong', /429/.test(logText), true);

console.log(fail === 0 ? 'GATEWAY: ALL PASS' : `GATEWAY: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
