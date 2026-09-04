'use strict';

/**
 * Pins the competency-3 measure.
 *
 * The dangerous assertions here are about a named person's record, so the tests
 * lean on the three that could do real harm: calling something undocumented when
 * it is only unconfirmed, scoring a conversation from before confirming was
 * possible, and calling something late before its window has passed.
 */

const test = require('node:test');
const assert = require('node:assert');

const conv = require('./conversations');

const rec = (over = {}) => ({
  kind: 'session', id: 1, agentName: 'Sebastian Broome', accountId: '712020:45d6d',
  conversationType: 'one_to_one', typeLabel: '1-2-1',
  occurredOn: '2026-09-04', startedAt: '2026-09-04T13:02:21.000Z',
  completedAt: '2026-09-04T13:50:00.000Z',
  title: null, summaryExcerpt: null, hasTranscript: true,
  peoplehrLogged: false, peoplehrLoggedAt: null,
  ...over,
});

const at = iso => Date.parse(iso);

// ── Working days ─────────────────────────────────────────────────────────────

test('working days skip the weekend', () => {
  // Friday 4 Sep 2026 → Monday 7 Sep is one working day, not three.
  assert.equal(conv.workingDaysBetween('2026-09-04T10:00:00Z', '2026-09-07T10:00:00Z'), 1);
  assert.equal(conv.workingDaysBetween('2026-09-04T10:00:00Z', '2026-09-08T10:00:00Z'), 2);
  assert.equal(conv.workingDaysBetween('2026-09-04T10:00:00Z', '2026-09-04T23:00:00Z'), 0);
});

// ── The window ───────────────────────────────────────────────────────────────

test('a conversation held today is not late', () => {
  // Saying otherwise is the loudest possible way to lose his trust in the number.
  const a = conv.classify([rec()], at('2026-09-04T18:00:00Z'));
  assert.equal(a.overdueUnconfirmed.length, 0);
  assert.equal(a.pending.length, 1);
});

test('unconfirmed becomes actionable only once two working days have passed', () => {
  const inside = conv.classify([rec()], at('2026-09-08T09:00:00Z'));
  assert.equal(inside.overdueUnconfirmed.length, 0, '2 working days is within the standard');
  const past = conv.classify([rec()], at('2026-09-09T09:00:00Z'));
  assert.equal(past.overdueUnconfirmed.length, 1);
  assert.equal(past.overdueUnconfirmed[0].ageWorkingDays, 3);
});

test('logged inside the window is on time; logged after it is late but logged', () => {
  const onTime = conv.classify(
    [rec({ peoplehrLoggedAt: '2026-09-08T09:00:00.000Z' })], at('2026-09-10T09:00:00Z'));
  assert.equal(onTime.onTime.length, 1);
  assert.equal(onTime.lateLogged.length, 0);

  const late = conv.classify(
    [rec({ peoplehrLoggedAt: '2026-09-11T09:00:00.000Z' })], at('2026-09-14T09:00:00Z'));
  assert.equal(late.lateLogged.length, 1);
  // Logged late is NOT in the actionable set — it is done, and telling him to
  // do it again would be the tool failing to notice he already had.
  assert.equal(late.overdueUnconfirmed.length, 0);
});

// ── The series ───────────────────────────────────────────────────────────────

test('conversations from before the column existed are shown but never scored', () => {
  // They could not have been confirmed, so scoring them reports a failure that
  // was structurally unavailable to him.
  const a = conv.classify([
    rec({ id: 9, occurredOn: '2026-08-20', completedAt: '2026-08-20T10:00:00.000Z' }),
    rec(),
  ], at('2026-09-30T09:00:00Z'));
  assert.equal(a.preSeries, 1);
  assert.equal(a.scored, 1);
  assert.equal(a.overdueUnconfirmed.every(r => r.occurredOn >= conv.MEASURED_FROM), true);
});

// ── The clock runs from when it happened ─────────────────────────────────────

test('a wizard-completed session is measured from completedAt, not the booked date', () => {
  // Stephen's live session was dated 2 July and still in_progress in September.
  // Measuring from occurredOn would report a same-day write-up as sixty days late.
  const a = conv.classify([rec({
    occurredOn: '2026-09-03', completedAt: '2026-09-28T15:00:00.000Z',
    peoplehrLoggedAt: '2026-09-29T09:00:00.000Z',
  })], at('2026-09-30T09:00:00Z'));
  assert.equal(a.onTime.length, 1, 'logged the next working day after it actually happened');
  assert.equal(a.all[0].basis, 'completedAt');
});

test('with no completedAt the occurred date is used, and the record says so', () => {
  const a = conv.classify([rec({ kind: 'conversation', completedAt: null })], at('2026-09-04T18:00:00Z'));
  assert.equal(a.all[0].basis, 'occurredOn');
});

// ── Absence ──────────────────────────────────────────────────────────────────

test('the card never says undocumented, and never offers to tick', () => {
  const p = {
    available: true, measuredFrom: conv.MEASURED_FROM,
    attribution: { ok: true, error: null, data: { unattributed: 0, lastSweepAt: '2026-09-09', measured: true } },
    assessment: conv.classify([rec()], at('2026-09-11T09:00:00Z')),
  };
  const [card] = conv.toRadarItems(p);
  assert.match(card.detail, /unconfirmed means unconfirmed, not undocumented/);
  // Not a blunt /undocumented/: the card deliberately uses the word to deny it.
  // What must never appear is the ASSERTION — "N are undocumented".
  assert.doesNotMatch(card.detail, /(are|is|were|was) undocumented/);
  assert.doesNotMatch(card.title, /undocumented/);
  assert.doesNotMatch(JSON.stringify(card), /tick it for you|VANTAGE will tick/);
  // The remedy is to write the note, not to tick a box.
  assert.match(card.remedy, /in PeopleHR/);
  assert.match(card.remedy, /The note is the evidence/);
});

test('an unmeasured attribution count is a floor, not a zero', () => {
  const unmeasured = {
    available: true,
    attribution: { ok: true, error: null, data: { unattributed: 0, lastSweepAt: null, measured: false } },
  };
  assert.match(conv.floorNote(unmeasured), /NOT a report of zero/);
  assert.match(conv.floorNote(unmeasured), /floor/);

  const failed = { available: true, attribution: { ok: false, error: 'timeout', data: null } };
  assert.match(conv.floorNote(failed), /could NOT be read/);

  const clean = {
    available: true,
    attribution: { ok: true, error: null, data: { unattributed: 0, lastSweepAt: '2026-09-09', measured: true } },
  };
  assert.match(conv.floorNote(clean), /Nothing was dropped/);
});

test('a dropped-conversation count travels with the figures', () => {
  const p = {
    available: true, measuredFrom: conv.MEASURED_FROM,
    attribution: { ok: true, error: null, data: { unattributed: 18, lastSweepAt: '2026-09-09T08:00:00Z', measured: true } },
    assessment: conv.classify([rec()], at('2026-09-11T09:00:00Z')),
  };
  const [card] = conv.toRadarItems(p);
  assert.match(card.detail, /18 conversation\(s\) could not be attributed/);
  assert.match(card.detail, /FLOOR/);
});

test('a failed conversations section produces no cards and no invented assessment', () => {
  assert.deepEqual(conv.toRadarItems({ available: true, assessment: null }), []);
  assert.deepEqual(conv.toRadarItems({ available: false, reason: 'NOVA returned 502' }), []);
  assert.equal(conv.summarise({ available: false, reason: 'x' }), null);
});

test('nothing here computes or reports cadence', () => {
  // The two tables stay two. A welfare check does not discharge a 1:1, and this
  // reader must never be the thing that says one is due — that is one-to-ones.js
  // reading /121/state, and it is the only thing allowed to.
  const src = require('fs').readFileSync(require('path').join(__dirname, 'conversations.js'), 'utf8');
  assert.doesNotMatch(src, /cadenceDays|lastHeld|overdueBy|bookedAhead/);
});

test('the expected build is the one NOVA shipped', () => {
  assert.equal(conv.BUILD_EXPECTED, '2026-09-03-conversations-b');
  assert.equal(conv.LOG_WITHIN_WORKING_DAYS, 2);
});
