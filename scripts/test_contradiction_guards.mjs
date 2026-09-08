// Deterministic test of the contradiction guards in api/report.js.
//
// The contradictions panel is the one claim this product makes that a
// competitor cannot: the officer holds the form you filed and catches you
// diverging from it. Anything false in that panel discredits the whole thing,
// so the guards below must not regress. Run: `npm run guards`.
//
// The gateway is stubbed, so no network and no API key are needed.
//
//   A. a second entry for a field already reported is dropped (dedupe by field)
//   B. a quote the applicant never said is dropped (quote provenance)
//   C. a genuine divergence survives
//   D. refusal_reasons_found is derived from what survived, not echoed
//   E. a real quote answering a DIFFERENT question is dropped (subject match)
//   F. a terse answer still survives when the officer's question carries the
//      field's vocabulary — the subject guard must not be trigger-happy
import handler from '../api/report.js';

process.env.ASSEMBLYAI_API_KEY ||= 'unused-fetch-is-stubbed';

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
  { role: 'agent', text: 'And who bought the ticket?' },
  { role: 'user', text: 'My sister bought that part, actually.' },
  { role: 'agent', text: 'What keeps you in Thailand?' },
  { role: 'user', text: 'My job, of course. And my family, they are all there.' },
  { role: 'agent', text: 'How long will you stay?' },
  { role: 'user', text: 'About five, maybe six.' },
];

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
      // C — genuine, on-topic, really said
      field: 'who_pays',
      filed: 'My sister in Chicago is paying for the trip',
      said: 'Um, my employer is covering it. It counts as professional leave.',
      why_it_matters: 'The funding source changed.',
    },
    {
      // A — same field again, also on-topic and really said, but padding
      field: 'who_pays',
      filed: 'My sister in Chicago is paying for the trip',
      said: 'My sister bought that part, actually.',
      why_it_matters: 'Padding — the field is already reported.',
    },
    {
      // B — never said by anyone
      field: 'prior_travel',
      filed: 'Asia only',
      said: 'I went to Canada and Brazil in 2024 for a conference.',
      why_it_matters: 'Invented quote.',
    },
    {
      // E — real quote, but it answers "what keeps you in Thailand", not the
      // return date. The applicant simply never mentioned the date.
      field: 'return_plan',
      filed: '23 November — back on the ward rota on the 25th',
      said: 'My job, of course. And my family, they are all there.',
      why_it_matters: 'Silence mistaken for divergence.',
    },
    {
      // F — the answer alone carries no field vocabulary, but the officer's
      // preceding question does ("How long will you stay?"). Must survive.
      field: 'trip_length',
      filed: '3 weeks',
      said: 'About five, maybe six.',
      why_it_matters: 'Filed three weeks, said five or six.',
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

const req = {
  method: 'POST',
  url: '/api/report',
  headers: {},
  body: { transcript: TRANSCRIPT, form: FORM },
};
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
const fields = c.map((x) => x.field);
console.log('contradictions kept:', JSON.stringify(c.map((x) => ({ field: x.field, said: x.said })), null, 1));

check('C  genuine divergence survives', fields.includes('who_pays'), true);
check('A  duplicate field dropped', fields.filter((f) => f === 'who_pays').length, 1);
check('B  fabricated quote dropped', fields.includes('prior_travel'), false);
check('E  off-subject quote dropped', fields.includes('return_plan'), false);
check('F  terse answer kept via officer question', fields.includes('trip_length'), true);
check('   exactly two survive', c.length, 2);
// 2 contradictions + failing dims <= 3, excluding form_consistency
// (consistency_credibility 2, purpose_funding 1, red_flags 3) = 2 + 3 = 5
check('D  count derived, model 9 ignored', res.body?.refusal_reasons_found, 5);

console.log(fail === 0 ? 'GUARDS: ALL PASS' : `GUARDS: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
