// Deterministic test of the contradiction guards in api/report.js.
// Stubs the LLM gateway so the model output is fixed, then asserts that:
//   A. a second entry for a field already reported is dropped (dedupe by field)
//   B. a quote the applicant never said is dropped (quote provenance)
//   C. a genuine divergence survives
//   D. refusal_reasons_found is derived from what survived, not from the model
import handler from '../api/report.js';

process.env.ASSEMBLYAI_API_KEY ||= 'test-key-not-used-because-fetch-is-stubbed';

const FORM = {
  purpose: 'Visiting family',
  occupation: 'Registered nurse, Bangkok',
  trip_length: '3 weeks',
  who_pays: 'My sister in Chicago is paying for the trip',
  us_relatives: 'Sibling',
  prior_travel: 'Asia only',
  return_plan: '23 November — back on the ward rota on the 25th',
  home_ties: 'Permanent contract until March 2028',
};

const TRANSCRIPT = [
  { role: 'agent', text: 'Who is paying for this trip?' },
  { role: 'user', text: 'Um, my employer is covering it. It counts as professional leave.' },
  { role: 'agent', text: 'What keeps you in Thailand?' },
  { role: 'user', text: 'My job, of course. And my family, they are all there.' },
];

// What the model returns: one real divergence, one duplicate of the same field,
// one paired against an unrelated answer, and one quote nobody ever said.
const MODEL_REPORT = {
  scores: {
    clarity_delivery: 4,
    consistency_credibility: 2,
    home_ties: 7,
    purpose_funding: 1,
    red_flags: 3,
    form_consistency: 1,
  },
  overall: 9,
  refusal_reasons_found: 9, // must be ignored
  verdict_line: 'Likely refusal.',
  contradictions: [
    {
      field: 'who_pays',
      filed: 'My sister in Chicago is paying for the trip',
      said: 'Um, my employer is covering it. It counts as professional leave.',
      why_it_matters: 'The funding source changed.',
    },
    {
      field: 'who_pays', // B-duplicate: same field, different quote
      filed: 'My sister in Chicago is paying for the trip',
      said: 'My job, of course. And my family, they are all there.',
      why_it_matters: 'Padding.',
    },
    {
      field: 'prior_travel', // fabricated quote — never said
      filed: 'Asia only',
      said: 'I went to Canada and Brazil in 2024 for a conference.',
      why_it_matters: 'Invented.',
    },
  ],
  highlights: [],
  top_fixes: [],
};

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(MODEL_REPORT) } }] }),
  text: async () => '',
});

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.setHeader = () => {};
  return res;
}

const req = { method: 'POST', url: '/api/report', headers: {}, body: { transcript: TRANSCRIPT, form: FORM } };
const res = makeRes();
await handler(req, res);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

console.log(`handler status: ${res.statusCode}`);
const c = res.body?.contradictions ?? [];
console.log('contradictions returned:', JSON.stringify(c.map((x) => ({ field: x.field, said: x.said })), null, 1));

check('C  genuine divergence survives (1 entry)', c.length, 1);
check('   surviving field is who_pays', c[0]?.field, 'who_pays');
check('A  duplicate field dropped', c.filter((x) => x.field === 'who_pays').length, 1);
check('B  fabricated quote dropped', c.some((x) => x.field === 'prior_travel'), false);
// 1 contradiction + failing dims <=3 excluding form_consistency
// (consistency_credibility 2, purpose_funding 1, red_flags 3) = 1 + 3 = 4
check('D  refusal count derived, model 9 ignored', res.body?.refusal_reasons_found, 4);

console.log(fail === 0 ? 'GUARDS: ALL PASS' : `GUARDS: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
