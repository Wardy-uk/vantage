'use strict';

/**
 * Pins the blind-spot lifecycle: a persisting blind spot becomes ONE card with
 * a fixed title, a transient one never does, and a single clear rebuild ends
 * the episode. Every refusal carries a positive control beside it — a test
 * that only asserts "no card" passes just as well against a function that
 * never produces one.
 */

const test = require('node:test');
const assert = require('node:assert');

const bs = require('./blind-spots');

const H = 3_600_000;
const at = h => new Date(Date.parse('2026-09-21T09:00:00Z') + h * H).toISOString();

/** Run a sequence of rebuilds through plan() against an in-memory store. */
function replay(rebuilds) {
  let records = [];
  let nextId = 1;
  let last = null;
  for (const { now, blind } of rebuilds) {
    const { inserts, updates } = bs.plan(records, blind, now);
    for (const row of inserts) records.push({ ...row, id: nextId++ });
    for (const u of updates) records = records.map(r => (r.id === u.id ? { ...r, ...u.patch } : r));
    last = bs.present(records, blind, now);
  }
  return { records, last };
}

const spot = { name: 'nova-health: not evaluated', reason: '1 NOVA check could not be evaluated.' };

test('a blind spot that outlasts every rebuild for PERSIST_DAYS becomes a going-wrong card', () => {
  const hours = Array.from({ length: bs.PERSIST_DAYS * 24 + 1 }, (_, i) => i);
  const { last } = replay(hours.map(h => ({ now: at(h), blind: [spot] })));
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].tense, 'happening');
  assert.equal(last.items[0].title, 'Still blind: nova-health: not evaluated');
  assert.equal(last.blind[0].since, at(0), 'first seen must not move while the episode is open');
  assert.equal(last.blind[0].persisted, true);
});

test('a young blind spot stays in the banner only — positive control is the test above', () => {
  const { last } = replay([{ now: at(0), blind: [spot] }, { now: at(30), blind: [spot] }]);
  assert.equal(last.items.length, 0);
  assert.equal(last.blind.length, 1, 'it is still reported, just not as a card');
});

test('one rebuild that can see it closes the episode, so a flapping source never promotes', () => {
  const { last, records } = replay([
    { now: at(0), blind: [spot] },
    { now: at(40), blind: [] },
    { now: at(80), blind: [spot] },
  ]);
  assert.equal(last.items.length, 0);
  assert.equal(last.blind[0].since, at(80), 'a new episode starts from its own first sighting');
  assert.equal(records.filter(r => r.status === 'closed').length, 1);
});

test('the title does not carry the duration — the findings register pins on title', () => {
  const run = n => replay(Array.from({ length: n }, (_, i) => ({ now: at(i * 24), blind: [spot] }))).last.items[0].title;
  assert.equal(run(4), run(9));
});

test('a weekend with no rebuilds does not close the episode — nobody looked, so nothing cleared', () => {
  // Friday afternoon to Monday morning: no observation in between, and the
  // claim is "every rebuild since Friday", which that record supports.
  const { last } = replay([{ now: at(0), blind: [spot] }, { now: at(80), blind: [spot] }]);
  assert.equal(last.items.length, 1);
  assert.match(last.items[0].detail, /2 of them/);
});

test('remedies: named where the cause is known, absent where it is not', () => {
  assert.match(bs.remedyFor({ name: 'tasks', reason: 'fetch failed' }), /NEURO/);
  assert.match(bs.remedyFor({ name: 'nova-flow', reason: 'NOVA is on build "x"; VANTAGE reads "y". Redeploy NOVA.' }), /deploy\.ps1/);
  assert.match(bs.remedyFor({ name: 'detector A (Net flow divergence)', reason: 'nt_x is missing 2 of the last 35 days' }), /backfilled/);
  assert.equal(bs.remedyFor({ name: 'detector A (Net flow divergence)', reason: 'confidence 0.3 is below the floor' }), null,
    'no honest next step exists for low confidence, so none is invented');
  assert.equal(bs.remedyFor({ name: 'x', reason: 'y', remedy: 'the producer knew' }), 'the producer knew');
});
