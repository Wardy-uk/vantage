'use strict';

/**
 * Pins the outcome definition — the thing that turned out to matter more than
 * any detector.
 *
 * V1 scored everything against RAG crossings and reported a median lead of 11
 * days. Two thirds of those "events" were a series that lives above its own red
 * line dipping under and coming back, and some occurred while the stock was
 * FALLING. The lead time was real warnings averaged with coin-flips.
 *
 * So these tests are mostly about what does NOT count as a problem arriving.
 */

const test = require('node:test');
const assert = require('node:assert');

const episodes = require('./episodes');

const DAY = 86_400_000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** greenMax 75, amberMax 90 — so the green-to-red span is 15, as Production's is. */
function stock(values, { key = 'nt_production', start = '2026-01-01', greenMax = 75, amberMax = 90 } = {}) {
  return {
    key,
    rag: { greenMax, amberMax },
    points: values.map((v, i) => ({ day: addDays(start, i), value: v, rag: v <= greenMax ? 'green' : v <= amberMax ? 'amber' : 'red', target: greenMax, source: 'jira' })),
  };
}

test('a climb of the whole green-to-red span inside the window is an episode', () => {
  // 60 -> 76 over 14 days: a rise of 16 against a span of 15.
  const vals = Array.from({ length: 30 }, (_, i) => (i < 14 ? 60 : 60 + (i - 13) * 1.2));
  const eps = episodes.forSeries(stock(vals));
  assert.ok(eps.length >= 1);
  assert.equal(eps[0].kpi, 'nt_production');
  assert.ok(eps[0].rose >= 15);
});

test('a series sitting high and flat is NOT an episode, however red it is', () => {
  // Permanently red, never rising. This is the state nt_production is in most
  // of the time, and the old label called every wobble here an event.
  const eps = episodes.forSeries(stock(Array(40).fill(120)));
  assert.deepEqual(eps, []);
});

test('a series crossing the red line while FALLING is not an episode', () => {
  // The 2026-08-11 case: Production fell into its own red run. The old label
  // scored that as a problem arriving; it is the opposite.
  const vals = Array.from({ length: 30 }, (_, i) => 120 - i);
  assert.deepEqual(episodes.forSeries(stock(vals)), []);
});

test('a slow drift that never covers the span inside the window is not an episode', () => {
  // +0.5/day: it will cross eventually, but it is not the kind of move the
  // band width says is the difference between healthy and failing.
  const vals = Array.from({ length: 60 }, (_, i) => 60 + i * 0.5);
  assert.deepEqual(episodes.forSeries(stock(vals)), []);
});

test('one long climb is ONE episode, not one per day it continues', () => {
  // Counting a month-long climb daily would let a detector that fired once
  // look as though it had warned twenty times.
  const vals = Array.from({ length: 60 }, (_, i) => 60 + i * 2);
  const eps = episodes.forSeries(stock(vals));
  assert.ok(eps.length <= 4, `expected a handful of episodes, got ${eps.length}`);
  for (let i = 1; i < eps.length; i += 1) {
    const gap = (Date.parse(eps[i].day) - Date.parse(eps[i - 1].day)) / DAY;
    assert.ok(gap > episodes.EPISODE_GAP_DAYS, 'episodes must be separated');
  }
});

test('the episode is dated when the climb COMPLETES, not when it began', () => {
  // Dating it from the start would credit a detector for seeing something that
  // had not finished happening.
  const vals = Array.from({ length: 30 }, (_, i) => (i < 10 ? 60 : 60 + (i - 9) * 2));
  const eps = episodes.forSeries(stock(vals));
  assert.ok(eps.length >= 1);
  const firstRiseDay = addDays('2026-01-01', 10);
  assert.ok(eps[0].day > firstRiseDay, 'the episode day is after the climb starts');
});

test('a series with no RAG bands produces nothing, and says it cannot', () => {
  // "No episodes" and "this KPI can never produce one" are different answers.
  const s = { key: 'nt_x', points: [{ day: '2026-01-01', value: 5 }] };
  assert.equal(episodes.usable(s), false);
  assert.deepEqual(episodes.forSeries(s), []);
});

test('only stock KPIs are scanned — flow KPIs cross their target constantly', () => {
  const seriesByKey = {
    nt_production: stock(Array.from({ length: 30 }, (_, i) => (i < 14 ? 60 : 60 + (i - 13) * 1.2))),
    nt_new_tickets: stock(Array.from({ length: 30 }, (_, i) => (i < 14 ? 60 : 60 + (i - 13) * 1.2)), { key: 'nt_new_tickets' }),
  };
  const all = episodes.all(seriesByKey);
  assert.ok(all.length >= 1);
  assert.ok(all.every(e => e.kpi !== 'nt_new_tickets'), 'a flow KPI must never produce an episode');
});
