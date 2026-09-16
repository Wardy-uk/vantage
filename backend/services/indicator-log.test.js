'use strict';

/**
 * Pins the lifecycle — the half that stops five detectors becoming fifty cards.
 *
 * The behaviours under test are the ones that fail SILENTLY when they regress.
 * A broken dedupe does not throw, it quietly produces a second card; a broken
 * decay does not throw, it either leaves a solved problem on the screen for
 * ever or removes a live one inside an hour. Neither is visible without these.
 *
 * ⚠ These run against `plan()` and `present()`, the pure half, driven through a
 * ten-line in-memory store. That is deliberate. The first version of this file
 * called `reconcile()` and needed `better-sqlite3`, which is built natively on
 * the Pi and does not compile here — so every one of these tests SKIPPED, and
 * the two functions that fail silently would have shipped never having been
 * run on any machine. A skipped test and an absent test differ only in how
 * honest the output is.
 */

const test = require('node:test');
const assert = require('node:assert');

const log = require('./indicator-log');

/**
 * The store, in ten lines. Applies exactly what `plan()` returns, the way
 * `reconcile()` does — so what is exercised here is the real sequence, not a
 * paraphrase of it.
 */
function makeStore() {
  let rows = [];
  let nextId = 1;
  return {
    all: () => rows.map(r => ({ ...r })),
    apply(fired, day) {
      const { inserts, updates } = log.plan(rows, fired, day);
      for (const row of inserts) rows.push({ ...row, id: nextId++ });
      for (const u of updates) {
        rows = rows.map(r => (r.id === u.id ? { ...r, ...u.patch } : r));
      }
      return log.present(rows, fired, day);
    },
  };
}

const card = (key, over = {}) => ({
  key, detector: 'A', severity: 'medium', title: `${key} is happening`,
  confidence: { score: 0.9, level: 'high', basis: [] }, ...over,
});

test('the same indicator on two days is ONE record, strengthened', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  const out = s.apply([card('net-flow')], '2026-09-02');

  assert.equal(s.all().length, 1, 'a recurrence must update, not duplicate');
  assert.equal(out.active[0].sightings, 2);
  assert.equal(out.active[0].firstSeenOn, '2026-09-01', 'the first sighting date does not move');
  assert.equal(out.active[0].strengthened, true);
  assert.match(out.active[0].standing, /Seen on 2 days/);
});

test('a first sighting does not claim to be a pattern', () => {
  const out = makeStore().apply([card('net-flow')], '2026-09-01');
  assert.equal(out.active[0].strengthened, false);
  assert.equal(out.active[0].standing, 'First sighting.');
});

test('reconciling twice in one day does not double-count or age anything', () => {
  // The radar is polled. State advanced per call would inflate the run length
  // all morning and close a live indicator inside an hour.
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  const out = s.apply([card('net-flow')], '2026-09-01');
  assert.equal(out.active[0].sightings, 1);

  s.apply([], '2026-09-02');
  s.apply([], '2026-09-02');
  s.apply([], '2026-09-02');
  assert.equal(s.all()[0].quietDays, 1, 'three calls on one quiet day is one quiet day');
});

test('three quiet days closes it as normalised, and it is REPORTED, not deleted', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  s.apply([], '2026-09-02');
  s.apply([], '2026-09-03');
  const out = s.apply([], '2026-09-04');

  assert.equal(s.all()[0].status, 'normalised');
  assert.equal(out.normalised.length, 1, 'what went back to normal is the only good news this screen ever gives');
  assert.equal(out.normalised[0].closedOn, '2026-09-04');
  // The wording is load-bearing. The evidence normalising is not the same as
  // anybody having done something about it, and reading the second from the
  // first is exactly the inference this codebase keeps getting wrong.
  assert.match(out.normalised[0].note, /That is the number moving, not a record of what was done/);
});

test('one quiet day does not close it', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  s.apply([], '2026-09-02');
  assert.equal(s.all()[0].status, 'open', 'a short week or a late series must not close a live indicator');
});

test('a quiet day followed by a return resets the decay', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  s.apply([], '2026-09-02');
  const out = s.apply([card('net-flow')], '2026-09-03');
  assert.equal(s.all()[0].quietDays, 0);
  assert.equal(out.active[0].sightings, 2);
});

test('severity that improves does not erase how bad it has been', () => {
  const s = makeStore();
  s.apply([card('net-flow', { severity: 'high' })], '2026-09-01');
  s.apply([card('net-flow', { severity: 'low' })], '2026-09-02');
  const rec = s.all()[0];
  assert.equal(rec.lastSeverity, 'low');
  assert.equal(rec.peakSeverity, 'high', 'a problem that eased is not a problem that was never serious');
});

test('a normalised indicator that returns opens a NEW run rather than resurrecting the old', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) s.apply([], d);
  const out = s.apply([card('net-flow')], '2026-09-20');

  assert.equal(s.all().length, 2, 'a problem that came back a fortnight later is a second occurrence');
  assert.equal(out.active[0].firstSeenOn, '2026-09-20');
  assert.equal(out.active[0].sightings, 1);
});

test('normalised indicators fall off the screen after the display window', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) s.apply([], d);

  assert.equal(log.present(s.all(), [], '2026-09-10').normalised.length, 1);
  assert.equal(log.present(s.all(), [], '2026-10-10').normalised.length, 0,
    'a win from six weeks ago is history, not news');
});

test('different keys are different indicators', () => {
  const s = makeStore();
  s.apply([card('net-flow'), card('ageing:development', { detector: 'B' })], '2026-09-01');
  assert.equal(s.all().length, 2);
});

test('a long run is reported as a run, not as a fresh warning', () => {
  // The thing worth knowing on day nine is not "here is a warning", it is "this
  // is the ninth day of the same warning" — which is a different sentence and
  // calls for a different response.
  const s = makeStore();
  let out;
  for (let i = 1; i <= 9; i += 1) out = s.apply([card('net-flow')], `2026-09-0${i}`);
  assert.equal(out.active[0].sightings, 9);
  assert.equal(out.active[0].runDays, 9);
  assert.match(out.active[0].standing, /Seen on 9 days, first on 2026-09-01/);
});

test('worse() keeps the higher severity whichever way round it is given', () => {
  assert.equal(log.worse('high', 'low'), 'high');
  assert.equal(log.worse('low', 'high'), 'high');
  assert.equal(log.worse(null, 'medium'), 'medium');
});

// ── Outcome labelling ────────────────────────────────────────────────────────
//
// This is how a detector will eventually be judged on live evidence instead of
// on history that has already been looked at. The rules that matter are the
// ones about when NOT to label: scoring a warning before the thing it predicted
// has had time to happen makes any detector look bad, and leaving the window
// open until something does makes any detector look good.

const rec = (over = {}) => ({
  id: 1, key: 'net-flow', detector: 'A', status: 'open',
  firstSeenOn: '2026-09-01', lastSeenOn: '2026-09-01', sightings: 1, quietDays: 0,
  subject: 'nt_production', outcome: null, outcomeSource: null, ...over,
});
const ep = (day, kpi = 'nt_production') => ({ kpi, day, rose: 20 });

test('an episode after the warning, inside the window, is a USEFUL warning with its lead', () => {
  const u = log.observeOutcomes([rec()], [ep('2026-09-13')], '2026-09-20');
  assert.equal(u.length, 1);
  assert.equal(u[0].patch.outcome, 'useful');
  assert.equal(u[0].patch.actualLeadDays, 12);
  assert.equal(u[0].patch.outcomeSource, 'auto');
});

test('an episode on the day the warning first fired is INCONCLUSIVE, not a hit', () => {
  // Zero lead is description, not warning — but it is not a false alarm either,
  // and calling it one would punish a detector for being right too late.
  const u = log.observeOutcomes([rec()], [ep('2026-09-01')], '2026-09-20');
  assert.equal(u[0].patch.outcome, 'inconclusive');
  assert.equal(u[0].patch.actualLeadDays, 0);
});

test('an OPEN warning whose window has not elapsed is left alone', () => {
  // The single easiest way to make a detector look bad is to score it early.
  assert.deepEqual(log.observeOutcomes([rec()], [], '2026-09-05'), []);
});

test('a CLOSED warning whose window elapsed with no episode is a FALSE positive', () => {
  const u = log.observeOutcomes([rec({ status: 'normalised' })], [], '2026-09-30');
  assert.equal(u[0].patch.outcome, 'false');
  assert.equal(u[0].patch.actualLeadDays, null);
});

test('a closed warning is still not scored until the window elapses', () => {
  // Closed early does not mean wrong: the evidence normalised, and the episode
  // it warned about may still be days away.
  assert.deepEqual(log.observeOutcomes([rec({ status: 'normalised' })], [], '2026-09-10'), []);
});

test('an episode for a DIFFERENT subject does not settle the warning', () => {
  assert.deepEqual(log.observeOutcomes([rec()], [ep('2026-09-10', 'nt_development')], '2026-09-30'), []);
});

test('a warning that claims no subject can be settled by any episode', () => {
  // A detector about the department generally, rather than one queue.
  const u = log.observeOutcomes([rec({ subject: null })], [ep('2026-09-10', 'nt_development')], '2026-09-30');
  assert.equal(u[0].patch.outcome, 'useful');
});

test('a human verdict is never overwritten by the automatic one', () => {
  // The automatic label cannot see that Nick read the card and stopped the
  // thing happening — which registers as a false positive and would punish the
  // warnings that worked best.
  const settled = rec({ outcome: 'useful', outcomeSource: 'human' });
  assert.deepEqual(log.observeOutcomes([settled], [], '2026-10-30'), []);
});

test('a settled record is not re-settled', () => {
  assert.deepEqual(log.observeOutcomes([rec({ outcome: 'false', outcomeSource: 'auto' })], [ep('2026-09-10')], '2026-09-30'), []);
});

test('a rota claim is never auto-settled by a backlog episode', () => {
  // Detector E predicts a thin day, not a queue rise. Scoring it against stock
  // episodes would mark it false every time the department coped — which is
  // the outcome it warned about being avoided.
  const r = rec({ detector: 'E', settledBy: 'human', subject: null });
  assert.deepEqual(log.observeOutcomes([r], [ep('2026-09-10')], '2026-09-30'), []);
  assert.deepEqual(log.observeOutcomes([{ ...r, status: 'normalised' }], [], '2026-10-30'), []);
});

test('a live card carries the ledger row it can be judged against', () => {
  // Without recordId the card and its record are joined only by a title
  // string, and the verdict button would post against the wrong row the first
  // time a title was reworded.
  const s = makeStore();
  const out = s.apply([card('net-flow')], '2026-09-01');
  assert.equal(out.active[0].recordId, 1);
  assert.equal(out.active[0].outcome, null, 'unjudged, and saying so');
});

test('a card that has already been judged says so instead of asking again', () => {
  const s = makeStore();
  s.apply([card('net-flow')], '2026-09-01');
  const rows = s.all();
  rows[0].outcome = 'useful';
  rows[0].outcomeSource = 'human';
  rows[0].actionTaken = 'acted on it';
  const out = log.present(rows, [card('net-flow')], '2026-09-02');
  assert.equal(out.active[0].outcome, 'useful');
  assert.equal(out.active[0].outcomeSource, 'human');
  assert.equal(out.active[0].actionTaken, 'acted on it');
});
