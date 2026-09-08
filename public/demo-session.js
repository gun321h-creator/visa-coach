// Pre-scripted sample interview used by the "Watch a sample session" replay.
//
// This runs entirely in the browser: no microphone, no WebSocket, no /api call.
// It exists so the product can be demonstrated when the mic is unavailable,
// the API is cold, or a reviewer just wants to see the shape of the output.
// It is always labelled "Sample replay" in the UI and must never be presented
// as a live session.
//
// The point of the script is the mechanic: this applicant FILED one thing and
// SAYS another, twice, and the officer names both divergences out loud.
//
// Turn fields:
//   role         'agent' | 'user'
//   text         the full line as it would appear in the live transcript
//   pauseBefore  ms of dead air before the line starts (thinking / handover)
//   cps          characters per second while the line types in
//   interruptAt  (agent lines only) 0-1 — fraction of the line spoken before
//                the applicant barges in and cuts the officer's audio off
//   bargeIn      (user lines only) true if this line began as an interruption

export const DEMO_SESSION = {
  id: 'sample-bkk-family-visit',
  label: 'Sample replay',
  summary: 'Registered nurse from Bangkok · three-week family visit to Chicago',
  questionTarget: 11,

  // The interview length this sample was recorded at. Keys match MODES in persona.js.
  mode: 'full',

  // The short-form DS-160 this applicant filed before the window opened.
  // Keys match FORM_FIELDS in persona.js. The officer has this on screen.
  form: {
    purpose: 'Visiting family',
    occupation: 'Registered nurse, Bumrungrad Hospital, Bangkok — 4 years',
    trip_length: '3 weeks',
    who_pays: 'My sister in Chicago is paying for the trip',
    us_relatives: 'Sibling',
    prior_travel: 'Asia only',
    return_plan: '23 November — I am back on the ward rota on the 25th',
    home_ties: "Permanent contract at Bumrungrad until March 2028; my mother lives with me in Nonthaburi; halfway through a master's at Mahidol",
  },

  turns: [
    {
      role: 'agent',
      text: 'Good morning. Please pass me your passport. What is the purpose of your trip to the United States?',
      pauseBefore: 500,
      cps: 17,
    },
    {
      role: 'user',
      text: "Good morning. I'm visiting my older sister in Chicago. She had a baby in July, so I'm going to help her for a few weeks.",
      pauseBefore: 550,
      cps: 19,
    },
    {
      role: 'agent',
      text: 'How long do you intend to stay?',
      pauseBefore: 400,
      cps: 17,
    },
    {
      role: 'user',
      text: 'Three weeks. I fly on November second and return on the twenty-third.',
      pauseBefore: 400,
      cps: 19,
    },
    {
      role: 'agent',
      text: 'And what do you do in Thailand?',
      pauseBefore: 380,
      cps: 17,
    },
    {
      role: 'user',
      text: "I'm a registered nurse at Bumrungrad Hospital in Bangkok. Four years now, in the cardiac ward.",
      pauseBefore: 420,
      cps: 19,
    },

    // ── the divergence the whole product exists to catch ──
    {
      role: 'agent',
      text: 'Who is paying for this trip?',
      pauseBefore: 380,
      cps: 17,
    },
    {
      role: 'user',
      text: 'Um, my company is, uh, my employer is covering it. It counts as professional leave.',
      pauseBefore: 900,
      cps: 13,
    },
    {
      role: 'agent',
      text: 'Your form says your sister in Chicago is paying. You just said your employer. Which is it?',
      pauseBefore: 260,
      cps: 18,
    },
    {
      role: 'user',
      text: "Sorry — my sister bought the plane ticket. My hospital gave me an allowance for the days off. I mean, I have savings as well.",
      pauseBefore: 850,
      cps: 15,
    },
    {
      role: 'agent',
      text: 'The allowance is not on your form. Why did you leave it off?',
      pauseBefore: 300,
      cps: 18,
    },
    {
      role: 'user',
      text: "I didn't think it counted as someone paying.",
      pauseBefore: 900,
      cps: 14,
    },

    {
      role: 'agent',
      text: 'Is your sister a U.S. citizen?',
      pauseBefore: 380,
      cps: 17,
    },
    {
      role: 'user',
      text: "She has a green card. Her husband is American. They've lived in Chicago six years.",
      pauseBefore: 400,
      cps: 19,
    },
    {
      role: 'agent',
      text: 'What ties do you have to Thailand?',
      pauseBefore: 380,
      cps: 17,
    },
    {
      role: 'user',
      text: "My job, of course. And my family, you know, they're all there.",
      pauseBefore: 500,
      cps: 18,
    },
    {
      role: 'agent',
      text: 'Be specific. What obligations bring you back?',
      pauseBefore: 280,
      cps: 18,
    },
    {
      role: 'user',
      text: "I'm under contract with the hospital until March 2028, my mother lives with me in Nonthaburi and I manage her dialysis schedule, and I'm halfway through a master's in nursing at Mahidol.",
      pauseBefore: 900,
      cps: 21,
    },

    // ── second divergence, caught through a barge-in ──
    {
      role: 'agent',
      text: 'Your form says you have only travelled in Asia. Is that complete?',
      pauseBefore: 380,
      cps: 17,
      interruptAt: 0.62,
    },
    {
      role: 'user',
      text: 'Yes — Japan, Korea, and Australia last October. I returned on time every time.',
      pauseBefore: 120,
      cps: 21,
      bargeIn: true,
    },
    {
      role: 'agent',
      text: 'Australia is not Asia. What else on this form is not complete?',
      pauseBefore: 260,
      cps: 18,
    },
    {
      role: 'user',
      text: "Nothing else. I just ticked the closest option on the list.",
      pauseBefore: 950,
      cps: 15,
    },
    {
      role: 'agent',
      text: 'Thank you, that completes the practice interview. Press End Interview to see your feedback.',
      pauseBefore: 600,
      cps: 18,
    },
  ],

  // Same JSON shape that POST /api/report returns — including contradictions,
  // form_consistency, refusal_reasons_found and honesty_note — so the sample and
  // the live session go through exactly one renderer.
  report: {
    scores: {
      clarity_delivery: 6,
      consistency_credibility: 4,
      home_ties: 7,
      purpose_funding: 4,
      red_flags: 5,
      form_consistency: 3,
    },
    overall: 4.8,
    contradictions: [
      {
        field: 'who_pays',
        filed: 'My sister in Chicago is paying for the trip',
        said: 'Um, my company is, uh, my employer is covering it. It counts as professional leave.',
        why_it_matters:
          'An officer reads a funding source that appears at the window but not on the form as something you chose not to declare. Once one answer moves, he stops trusting the rest of the page.',
      },
      {
        field: 'prior_travel',
        filed: 'Asia only',
        said: 'Yes — Japan, Korea, and Australia last October. I returned on time every time.',
        why_it_matters:
          'Your strongest asset is a clean travel record, and you filed it wrong. A correctable slip still reads as carelessness with a sworn form.',
      },
    ],
    refusal_reasons_found: 3,
    honesty_note:
      'Rewrites only reorganise what you actually said — they never add facts. Never say anything untrue at the window.',
    form_provided: true,
    filler_word_count: 4,
    filler_words_detail: { 'you know': 1, 'i mean': 1, um: 1, uh: 1 },
    verdict_line:
      'Likely refusal. You contradicted your own form twice, and the first time you could not explain the gap — the ties answer that should have saved you arrived far too late.',
    highlights: [
      {
        quote: 'Um, my company is, uh, my employer is covering it. It counts as professional leave.',
        issue:
          'You filed that your sister is paying and then said your employer is. That is the single most expensive sentence in this interview: it turns a funding question into a credibility question about the whole form.',
        better:
          'My sister bought the plane ticket. My hospital gave me an allowance for the days off, and I cover everything else from my savings.',
      },
      {
        quote: "I didn't think it counted as someone paying.",
        issue:
          'This explains the gap but it also confirms it: you decided for yourself what the form was asking. An officer hears that as discretion you were not entitled to take.',
        better:
          'There is nothing to rewrite here — the fix is upstream. Declare every source of money on the form, including an employer allowance, so the question never comes up.',
      },
      {
        quote: 'Yes — Japan, Korea, and Australia last October. I returned on time every time.',
        issue:
          'A strong answer that contradicted your own form, which had "Asia only". You handed the officer a second reason to doubt the paperwork while trying to prove you are reliable.',
        better:
          'Same words, correct form. File the full travel history — Japan, Korea and Australia — and this becomes your best answer instead of your second contradiction.',
      },
      {
        quote: "My job, of course. And my family, you know, they're all there.",
        issue:
          'The rehearsed answer every applicant gives. It contains no fact an officer can check, and "of course" reads as if the question were beneath you.',
        better:
          "I'm under contract at Bumrungrad until March 2028, I'm my mother's carer for her dialysis, and I have two semesters left on my master's at Mahidol.",
      },
    ],
    top_fixes: [
      'Fix the form before you fix the answers. Every payer, every country, every relative — if it is true, it goes on the page.',
      'Name the whole funding picture in one unprompted sentence: who bought the ticket, what your employer contributed, what you hold yourself.',
      'Lead with your hardest ties — contract end date, dependent parent, degree in progress — the first time you are asked, not the second.',
      'Cut the hedges. "Some of it", "you know" and "of course" each spent credibility you had already earned.',
    ],
  },
};

export default DEMO_SESSION;
