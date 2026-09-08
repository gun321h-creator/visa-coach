// Behaviour test for the free-tier throttle cooldown in public/app.js.
//
// It does not re-implement the logic: it slices the real cooldown block out of
// the shipped file and executes it against a fake clock and a fake DOM. If the
// block is deleted, renamed, or tuned below the measured window, this fails.
//
// Why it matters: the gateway's free tier allows ~2 scoring calls then 429s for
// ~62s (measured 2026-09-08). Re-enabling "End interview" straight after a 503
// invites a press that is guaranteed to fail and re-arms the window — during a
// recorded demo that reads as a broken product.
//
// The block must stay ABOVE `async function end()` in app.js; the slice below
// ends there. Move it and this file throws rather than silently testing nothing.
//
// It uses `new Function` on that slice. The interpolated text is our own
// repository file, never user input, and this file is a dev-time test that is
// not part of the deployed bundle (Vercel ships `public/` only). Executing the
// real source is the whole point: a re-implementation would pass while the
// shipped code was broken.
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

const START = '/* ── free-tier throttle cooldown';
const END = 'async function end() {';
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.log('FAIL  cooldown block not found in public/app.js');
  process.exitCode = 1;
  throw new Error('cooldown block missing');
}
const block = src.slice(from, to);

// --- fake clock + fake DOM ---------------------------------------------------
let now = 0;
const timers = new Map();
let nextId = 1;
const fakeSetInterval = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, next: now + ms }); return id; };
const fakeClearInterval = (id) => timers.delete(id);
const tick = (seconds) => {
  for (let s = 0; s < seconds; s++) {
    now += 1000;
    for (const t of [...timers.values()]) while (t.next <= now) { t.next += t.ms; t.fn(); }
  }
};

// The countdown is deadline-driven, so it reads the clock as well as the timer.
const fakeDate = { now: () => now };

const els = { end: { disabled: false } };
let status = { text: '', cls: '' };
const setStatus = (text, cls = '') => { status = { text, cls }; };

const mod = new Function(
  'els', 'setStatus', 'setInterval', 'clearInterval', 'Date',
  `${block}\nreturn { startCooldown, cancelCooldown, THROTTLE_COOLDOWN_S };`,
)(els, setStatus, fakeSetInterval, fakeClearInterval, fakeDate);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${JSON.stringify(got)} (expected ${JSON.stringify(want)})`);
};

// A: the window itself. 62s measured; anything shorter re-enables into a 429.
check('A  cooldown covers the measured ~62s window', mod.THROTTLE_COOLDOWN_S >= 62, true);

// B: the button is locked immediately and the user is told how long.
mod.startCooldown('The scoring service is rate-limited.');
check('B  End is disabled at once', els.end.disabled, true);
check('B  the wait is visible', /Ready to retry in \d+s\./.test(status.text), true);
// Without this, dropping ${message} from the template passes every other check
// while silently losing the half that says WHY the button is locked.
check('B  the reason survives', status.text.startsWith('The scoring service is rate-limited.'), true);
check('B  it reads as an error', status.cls, 'err');

// C: it counts down rather than sitting on one number.
const first = status.text;
tick(1);
check('C  the countdown advances', status.text !== first, true);

// C2: starting a cooldown while one runs replaces it. Nothing in the app does
//     this today (end() disables the button synchronously), but a leaked second
//     interval would fire the release path twice and free the button early.
mod.startCooldown('again.');
check('C2 a restart leaves exactly one timer', timers.size, 1);
check('C2 the restart re-armed the full window', /Ready to retry in 6[0-9]s\./.test(status.text), true);
mod.cancelCooldown();
els.end.disabled = false;
mod.startCooldown('The scoring service is rate-limited.');

// D: still locked one second before the window closes.
tick(mod.THROTTLE_COOLDOWN_S - 1);
check('D  still locked at T-1s', els.end.disabled, true);

// E: released exactly once the window has passed, with a usable prompt.
tick(1);
check('E  End is usable again', els.end.disabled, false);
check('E  the user is told they can retry', /End interview/.test(status.text), true);
check('E  no timer left running', timers.size, 0);

// F: leaving the session cancels the countdown instead of leaking a timer that
//    would later re-enable a button on a screen the user already left.
els.end.disabled = true;
mod.startCooldown('again');
check('F  a second cooldown is running', timers.size, 1);
mod.cancelCooldown();
check('F  cancel stops the timer', timers.size, 0);
tick(mod.THROTTLE_COOLDOWN_S + 5);
check('F  cancelled cooldown never re-enables the button', els.end.disabled, true);

// --- wiring, checked against the source ---------------------------------------
// The block above can be perfect and still never run. These are source
// assertions, not behaviour: they prove end() routes a 503 into it. Each one is
// scoped to a single function body — sliced to the closing brace at column 0 —
// so a check cannot be satisfied by an identical line somewhere else.
function fnBody(name) {
  const head = `function ${name}(`;
  const at = src.indexOf(head);
  if (at === -1) return '';
  const close = src.indexOf('\n}', at);
  return close === -1 ? src.slice(at) : src.slice(at, close);
}

const wired = [
  ['G  503 is tagged as a throttle', /err\.throttled\s*=\s*r\.status === 503/.test(src)],
  ['G  the catch routes a throttle to the cooldown', /if \(e\.throttled\) \{\s*startCooldown\(/.test(src)],
  ['G  leaving the session cancels it', fnBody('resetSessionUI').includes('cancelCooldown();')],
  // The throttle path un-hides #report-foot, whose "Practice again" button calls
  // openIntake — the one nav path that does NOT go through resetSessionUI. A
  // countdown surviving it would repaint the landing status line once a second,
  // because setStatus writes to every .js-status element on the page.
  ['G  the intake path cancels it too', fnBody('openIntake').includes('cancelCooldown();')],
  // And a cooldown that expired on another view must not leave End clickable
  // when the next session opens with an empty transcript.
  ['G  and opens the next session with End disabled', fnBody('openIntake').includes('els.end.disabled = true;')],
];
for (const [label, ok] of wired) {
  if (!ok) { fail++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} -> ${ok} (expected true)`);
}

// Ordering, which no presence check can see: the stale-response guard must run
// BEFORE the cooldown is armed, or a 503 arriving after the user walked away
// arms a countdown on a view that has no End button. Scoped to the catch block,
// so the identical guard in the try block cannot satisfy it by accident.
{
  const body = fnBody('end');
  const cat = body.indexOf('} catch (e) {');
  const scope = cat === -1 ? '' : body.slice(cat);
  const guard = scope.indexOf('if (epoch !== navEpoch) return;');
  const arm = scope.indexOf('startCooldown(');
  const ok = guard !== -1 && arm !== -1 && guard < arm;
  if (!ok) { fail++; }
  console.log(`${ok ? 'PASS' : 'FAIL'}  G  the stale-response guard runs before the cooldown is armed -> ${ok} (expected true)`);
}

console.log(fail === 0 ? 'COOLDOWN: ALL PASS' : `COOLDOWN: ${fail} FAILURE(S)`);
process.exitCode = fail === 0 ? 0 : 1;
