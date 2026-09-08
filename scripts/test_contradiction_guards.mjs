// Deterministic test of the contradiction guards in api/report.js.
//
// The contradictions panel is the one claim this product makes that a
// competitor cannot: the officer holds the form you filed and catches you
// diverging from it. Anything false in that panel discredits the whole thing,
// so the guards below must not regress. Run: `npm run guards`.
//
// The gateway is stubbed, so no network and no API key are needed.
//
// Scenario 1 — one model response carrying every failure mode at once:
//   A. a second entry for a field already reported is dropped (dedupe by field)
//   B. a quote the applicant never said is dropped (provenance)
//   C. a genuine divergence survives
//   D. refusal_reasons_found is derived from what survived, not echoed
//   E. a real quote answering a DIFFERENT question is dropped (subject match)
//   F. a terse answer survives when the officer's question carries the field's
//      vocabulary — the subject guard must not be trigger-happy
//   G. a field name the model wrote in prose ("return date") is dropped, because
//      an unresolved key disables every other guard and lets `filed` fall back
//      to model-invented text
//   H. a real quote with a fabricated tail appended is dropped — checking only
//      the start of a quote let a model put words in the applicant's mouth
//   I. an expanded contraction still counts as traceable — ordinary quoting
//      behaviour is not fabrication
//
// Scenario 2 — every contradiction dropped, form_consistency still failing:
//   J. the headline must not read "0 refusal reasons" above a red form bar
import handler from '../api/report.js';

process.env.ASSEMBLYAI_API_KEY ||= 'unused-fetch-is-stubbed';

const FORM = {
  purpose: 'Visiting family',
  occupation: 'Registered nurse, Bumrungrad Hospital, Bangkok',
  trip_length: '3 weeks',
  who_pays: 'My sister in Chicago is paying for the trip',
  us_relatives: 'Sibling in Boston',
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
  { role: 'agent', text: 'What do you do for work?' },
  { role: 'user', text: 'I work at a private hospital in Bangkok.' },
  { role: 'agent', text: 'Do you have relatives in the United States?' },
  { role: "user", text: "My sister's living in Chicago." },
];

const SCORES = {
  clarity_delivery: 4,
  consistency_credibility: 2,
  home_ties: 7,
  purpose_funding: 1,
  red_flags: 3,
  form_consistency: 1,
};

const MODEL_REPORT = {
  scores: SCORES,
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
    {
      // G — field written in prose. Unresolvable, and note `filed` here is a
      // value the applicant never entered on any form.
      field: 'return date',
      filed: 'INVENTED filed value the user never typed',
      said: 'My job, of course. And my family, they are all there.',
      why_it_matters: 'Should never render.',
    },
    {
      // H — starts with a real sentence, then puts words in their mouth
      field: 'occupation',
      filed: 'Registered nurse, Bumrungrad Hospital, Bangkok',
      said: 'I work at a private hospital in Bangkok, and I plan to resign before I leave so nothing ties me back home.',
      why_it_matters: 'Fabricated tail.',
    },
    {
      // I — expanded contraction of a real turn ("My sister's living…")
      field: 'us_relatives',
      filed: 'Sibling in Boston',
      said: 'My sister is living in Chicago',
      why_it_matters: 'Filed Boston, said Chicago.',
    },
  ],
  highlights: [],
  top_fixes: [],
};

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  return res;
}

const stubGateway = (report) => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(report) } }] }),
    text: async () => '',
  });
};

const run = async (report) => {
  stubGateway(report);
  const res = makeRes();
  await handler(
    { method: 'POST', url: '/api/report', headers: {}, body: { transcript: TRANSCRIPT, form: FORM } },
    res,
  );
  return res;
};

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

// --- scenario 1 -------------------------------------------------------------
const res1 = await run(MODEL_REPORT);
const cards = res1.body?.contradictions ?? [];
const fields = cards.map((x) => x.field);
console.log(`scenario 1 status: ${res1.statusCode}`);
console.log('kept:', JSON.stringify(cards.map((x) => ({ field: x.field, said: x.said })), null, 1));

check('C  genuine divergence survives', fields.includes('who_pays'), true);
check('A  duplicate field dropped', fields.filter((f) => f === 'who_pays').length, 1);
check('B  fabricated quote dropped', fields.includes('prior_travel'), false);
check('E  off-subject quote dropped', fields.includes('return_plan'), false);
check('F  terse answer kept via officer question', fields.includes('trip_length'), true);
check('G  prose field name dropped', fields.some((f) => /return.?date/i.test(f)), false);
check('G  no invented "filed" value rendered', JSON.stringify(cards).includes('INVENTED'), false);
check('H  fabricated tail dropped', fields.includes('occupation'), false);
check('I  expanded contraction kept', fields.includes('us_relatives'), true);
check('   exactly three survive', cards.length, 3);
// 3 contradictions + dims <= 3 excluding form_consistency
// (consistency_credibility 2, purpose_funding 1, red_flags 3) = 3 + 3 = 6
check('D  count derived, model 9 ignored', res1.body?.refusal_reasons_found, 6);

// --- scenario 2: nothing survived, but the form bar is still red ------------
const res2 = await run({
  ...MODEL_REPORT,
  contradictions: [MODEL_REPORT.contradictions[2]], // the fabricated one only
});
const cards2 = res2.body?.contradictions ?? [];
check('J  no contradictions rendered', cards2.length, 0);
// 0 contradictions -> form_consistency (1) now counts, plus the same three
check('J  red form bar still counted', res2.body?.refusal_reasons_found, 4);

console.log(fail === 0 ? 'GUARDS: ALL PASS' : `GUARDS: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
