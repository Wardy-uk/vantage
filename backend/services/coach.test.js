'use strict';

/**
 * Pins the coaching layer's two load-bearing properties: the prompt says what it
 * is supposed to say, and the store survives a round trip.
 *
 * No model is called. `buildMessages` is pure precisely so the framing can be
 * asserted without spending a token — and the framing is the product.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The store needs `better-sqlite3`, which is built natively on the Pi and does
 * not compile on every dev machine. The prompt tests are the ones that matter
 * most and are pure, so they run everywhere; the store tests skip loudly rather
 * than failing the suite on a machine that was never going to run the service.
 */
let storeReady = true;
let db;
try {
  db = require('../db');
  db.init(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-')), 'test.db'));
} catch (err) {
  storeReady = false;
  console.log(`[skip] store tests: ${err.message.split('\n')[0]}`);
}

const coach = require('./coach');

// ── The prompt ───────────────────────────────────────────────────────────────

test('the coach is told not to be reassuring by default', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // A coach that agrees with him is worth nothing against the doubt he is
  // actually facing. If this drifts, the tool becomes comfortable and useless.
  assert.match(system.content, /Do NOT be reassuring by default/);
  assert.match(system.content, /Notice avoidance specifically/);
  assert.match(system.content, /ONE question at a time/);
});

test('the situation carries the real test, not just the PIP actions', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // \s+ across the line breaks: the prompt is a wrapped template literal, and a
  // regex that only matches one particular wrapping would fail on a reflow that
  // changed nothing about the meaning.
  assert.match(system.content, /survives the\s+removal of scrutiny/);
  assert.match(system.content, /did not surface the review's findings himself/);
});

test('the coach knows the job, not only the trial', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // Without these it reasons about a generic manager under pressure. Production
  // is the one that goes missing first: it is his, it is in the framework, and
  // it appears in none of the PIP paperwork the rest of the prompt is built on.
  assert.match(system.content, /PRODUCTION \(email HTML templates/);
  assert.match(system.content, /LEADERSHIP TEAM delivering projects/);
  assert.match(system.content, /Integrations/);
});

test('the assignment framework is live now, and its day-numbers are never dated', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // Day 15/30/45/60/90 have no anchor date in the source, and Nick's instruction
  // is to demonstrate the lot as of now. So the staging is dropped rather than
  // guessed — a confident false deadline is the worst thing this tool could
  // produce. Pinned rather than trusted to survive an edit.
  assert.match(system.content, /THE STAGING IS DISCARDED/);
  assert.match(system.content, /STANDING EXPECTATION HE MUST BE ABLE TO EVIDENCE NOW/);
  assert.match(system.content, /Never render a\s+day-number and never compute a date from one/);
  // Cuts both ways: it must not become a stick, and must not become permission
  // to park an outcome behind a checkpoint that has no date.
  assert.match(system.content, /not available to you as a reason to let him defer/);
});

test('the SFIA matrix is carried as draft, about roles, never as a verdict on him', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // Same species as the rule this whole repo runs on: a blank cell is a JD that
  // did not evidence a skill, not a man who cannot do it. Quoting a draft
  // capability score at him as an assessment would be the report-going-to-his-
  // manager failure, one surface over.
  assert.match(system.content, /DRAFT, NOT AGREED/);
  assert.match(system.content, /ROLES AS WRITTEN, not people/);
  assert.match(system.content, /blank cell means a JD does not evidence\s+that skill, NOT that he cannot do it/);
});

test('Nick has no SFIA grade, and none may be inferred for him', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // The matrix's Level 5s describe what the ROLE demands. Reading them as his
  // grade would turn a draft mapping exercise into a competence verdict on a man
  // whose competence is currently the subject of a formal process. Grades are to
  // be PROPOSED from evidence later; until then the honest state is "unassessed",
  // which is not the same as low.
  assert.match(system.content, /NICK HAS NO SFIA GRADE/);
  assert.match(system.content, /Not a low one — none has been assessed/);
  assert.match(system.content, /never let a level stand in for a\s+judgement about his competence/);
});

test('FRAMING carries both halves, so a second consumer cannot take only one', () => {
  // brief.js interpolates FRAMING. When this was SITUATION alone, adding the
  // role to the coach would silently have left the brief reasoning without it.
  assert.ok(coach.FRAMING.includes(coach.SITUATION), 'FRAMING lost the situation');
  assert.ok(coach.FRAMING.includes(coach.ROLE), 'FRAMING lost the role');
});

test('the brief prompt gets the role, not just the situation', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'brief.js'), 'utf8');
  // A positive control on the negative: assert it interpolates FRAMING AND that
  // no bare SITUATION interpolation survives anywhere in the file.
  assert.match(src, /\$\{coachSvc\.FRAMING\}/);
  assert.doesNotMatch(src, /\$\{coachSvc\.SITUATION\}/);
});

test('unavailable signals are stated, and inventing numbers is forbidden', () => {
  const [system] = coach.buildMessages({
    mode: 'coach', history: [], signals: { available: false, reason: 'NOVA unreachable' },
  });
  assert.match(system.content, /SERVICE DESK SIGNALS: unavailable \(NOVA unreachable\)/);
  assert.match(system.content, /Do not invent numbers/);
});

test('available signals are included but the coach is told not to recite them', () => {
  const [system] = coach.buildMessages({
    mode: 'coach', history: [],
    signals: { available: true, asOf: '2026-08-18T12:00:00Z', summary: '- Open with no assignee: 9' },
  });
  assert.match(system.content, /Open with no assignee: 9/);
  assert.match(system.content, /he has seen them/);
});

test('each mode contributes its own instruction', () => {
  const prep = coach.buildMessages({ mode: 'prep', history: [], signals: null })[0].content;
  assert.match(prep, /including their strongest\s+objection/, 'prep must not play a soft version of the other person');

  const reflect = coach.buildMessages({ mode: 'reflect', history: [], signals: null })[0].content;
  assert.match(reflect, /you are discounting it/, 'he under-credits delivery');
});

test('history is trimmed but the system prompt always survives', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const msgs = coach.buildMessages({ mode: 'coach', history, signals: null });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs.length < 40, 'old turns are dropped');
  assert.equal(msgs.at(-1).content, 'm59', 'the most recent turn is kept');
});

// ── The store ────────────────────────────────────────────────────────────────

test('sessions and observations round-trip', { skip: !storeReady }, () => {
  const s = coach.createSession({ title: 'Chris 1:1', mode: 'prep' });
  assert.equal(s.mode, 'prep');
  assert.deepEqual(s.messages, []);

  assert.ok(coach.listSessions().some(x => x.id === s.id));

  const o = coach.addObservation({ kind: 'avoidance', note: 'Built a dashboard instead of calling Ricky' });
  assert.equal(o.kind, 'avoidance');
  assert.equal(coach.listObservations({ kind: 'avoidance' }).length, 1);

  coach.deleteSession(s.id);
  assert.equal(coach.getSession(s.id), null);
});

test('an unknown observation kind is refused rather than stored', { skip: !storeReady }, () => {
  assert.throws(() => coach.addObservation({ kind: 'vibes', note: 'x' }), /kind must be one of/);
  assert.throws(() => coach.addObservation({ kind: 'pattern', note: '  ' }), /note is required/);
});

test('an unknown mode is refused — a typo must not silently become "coach"', { skip: !storeReady }, () => {
  assert.throws(() => coach.createSession({ mode: 'therapy' }), /Unknown mode/);
});
