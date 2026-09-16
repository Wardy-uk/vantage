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
