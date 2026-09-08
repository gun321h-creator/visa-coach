// Deterministic test of the gateway failure handling in api/report.js.
// The gateway is stubbed, so no network and no API key are needed.
//
//   A. a 429 is retried once after a backoff, and a success on the retry
//      produces a normal report — this is what protects a demo recording,
//      where several takes in a row trip AssemblyAI's free-tier throttle
//   B. a 429 that persists returns 503 with actionable wording, not 502
//   C. no upstream text reaches the client
//   D. and none reaches the server log either: function logs are retained, and
//      a gateway auth failure echoes the presented credential in `message` —
//      the one field worth logging. The secret in this test lives THERE, not in
//      a field the summariser ignores, or the assertion would prove nothing.
//   E. the OpenAI-compatible nested shape {error:{message}} is read, not
//      stringified into "[object Object]"
//   F. exactly one backoff per request, not one per model in the chain
//   G. a model that rejects response_format and then gets throttled is retried
//      with the body that was actually in flight, so the real 429 is not masked
import handler from '../api/report.js';

process.env.ASSEMBLYAI_API_KEY ||= 'unused-fetch-is-stubbed';

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

const SECRET = 'aai1234567890abcdefSECRET';
// The credential lands in `message`, which is exactly where a real gateway puts
// it and exactly what upstreamSummary() extracts.
const RATE_LIMIT_BODY = JSON.stringify({ message: `too many requests for ${SECRET}`, code: 429 });
const NESTED_AUTH_BODY = JSON.stringify({
  error: { message: `Invalid API key: ${SECRET}`, type: 'invalid_request_error' },
});

const ok = () => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => ({ choices: [{ message: { content: JSON.stringify(GOOD_REPORT) } }] }),
});
const err = (status, body) => ({ ok: false, status, text: async () => body, json: async () => ({}) });

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  return res;
}

const req = () => ({ method: 'POST', url: '/api/report', headers: {}, body: { transcript: TRANSCRIPT } });

let fail = 0;
const check = (label, got, want) => {
  const isOk = JSON.stringify(got) === JSON.stringify(want);
  if (!isOk) fail++;
  console.log(`${isOk ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

/** Run the handler with a scripted fetch, capturing console.error. */
async function run(fetchImpl) {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return fetchImpl(sent.length);
  };
  const logged = [];
  const realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  const res = makeRes();
  const t0 = Date.now();
  await handler(req(), res);
  const elapsed = Date.now() - t0;
  console.error = realError;
  return { res, sent, log: logged.join('\n'), elapsed };
}

// --- A: 429 then success (single-model chain) -------------------------------
process.env.REPORT_MODEL = 'qwen3.5-4b-32k-fast';
const a = await run((n) => (n === 1 ? err(429, RATE_LIMIT_BODY) : ok()));
check('A  429 then success -> 200', a.res.statusCode, 200);
check('A  retried exactly once', a.sent.length, 2);
check('A  a real report came back', typeof a.res.body?.scores === 'object' && a.res.body.scores !== null, true);
console.log(`${a.elapsed >= 1000 ? 'PASS' : 'FAIL'}  A  backed off before retrying -> ${a.elapsed}ms (expected >=1000)`);
if (a.elapsed < 1000) fail++;

// --- B/C/D: persistent 429 --------------------------------------------------
const b = await run(() => err(429, RATE_LIMIT_BODY));
const clientText = JSON.stringify(b.res.body);
console.log(`server log: ${b.log.trim() || '(none)'}`);
check('B  persistent 429 -> 503 not 502', b.res.statusCode, 503);
check('B  retried once then gave up', b.sent.length, 2);
check('B  wording tells the user to wait', /rate-limited/i.test(clientText), true);
check('C  upstream text not leaked to client', /too many requests/i.test(clientText) || clientText.includes(SECRET), false);
check('D  credential not written to the log', b.log.includes(SECRET), false);
check('D  log still says what went wrong', /429/.test(b.log), true);

// --- E: nested {error:{message}} shape --------------------------------------
const e = await run(() => err(401, NESTED_AUTH_BODY));
console.log(`server log: ${e.log.trim() || '(none)'}`);
check('E  nested message read, not [object Object]', /\[object Object\]/.test(e.log), false);
check('E  nested message is redacted', e.log.includes(SECRET), false);
check('E  nested message still identifiable', /Invalid API key/i.test(e.log), true);

// --- F: one backoff per request across a two-model chain --------------------
delete process.env.REPORT_MODEL; // default chain: preferred + qwen fallback
const f = await run(() => err(429, RATE_LIMIT_BODY));
check('F  two models, still one retry only', f.sent.length, 3); // m1, m1-retry, m2
console.log(`${f.elapsed < 2 * 1000 ? 'PASS' : 'FAIL'}  F  slept once, not once per model -> ${f.elapsed}ms (expected <2000)`);
if (f.elapsed >= 2 * 1000) fail++;

// --- G: response_format rejection then 429 ----------------------------------
process.env.REPORT_MODEL = 'qwen3.5-4b-32k-fast';
const g = await run((n) => {
  if (n === 1) return err(400, JSON.stringify({ message: 'response_format is not supported' }));
  return err(429, RATE_LIMIT_BODY); // the plain retry, and then the backoff retry
});
check('G  three calls: format retry then one backoff', g.sent.length, 3);
check('G  the backoff resent the body that was in flight', g.sent[2].response_format ?? null, null);
check('G  the real 429 is surfaced, not the 400', g.res.statusCode, 503);

console.log(fail === 0 ? 'GATEWAY: ALL PASS' : `GATEWAY: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
