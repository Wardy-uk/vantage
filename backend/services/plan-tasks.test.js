'use strict';

/**
 * The pure half of plan-tasks: the origin stamp.
 *
 * It is the recovery path. A task VANTAGE creates carries
 * `origin_path: vantage://plan/T3`, and if this store is ever lost or rebuilt
 * that stamp is the only thing that can put 35 links back. A parser that is
 * slightly too eager would adopt unrelated tasks into the plan; one slightly too
 * strict would silently recover nothing, which looks exactly like "no tasks
 * exist" — the failure this repo keeps making.
 *
 * The linking half touches SQLite and is covered by the store tests.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The overview tests need the store; the rest are pure. Same split as
// coach.test.js — skip loudly on a machine that was never going to run VANTAGE.
let storeReady = true;
try {
  require('../db').init(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-plan-')), 'test.db'));
} catch (err) {
  storeReady = false;
  console.log(`[skip] plan-tasks store tests: ${err.message.split('\n')[0]}`);
}

const planTasks = require('./plan-tasks');
const plan = require('./plan');
const neuro = require('./neuro');

test('the origin stamp round-trips for every plan id', () => {
  for (const item of plan.PLAN) {
    assert.equal(planTasks.planIdFromOrigin(planTasks.originPath(item.id)), item.id);
  }
});

test('a foreign origin path is not adopted into the plan', () => {
  // Vault-sourced tasks are the common case, and adopting one would attach a
  // meeting commitment to a Support Review action it has nothing to do with.
  assert.equal(planTasks.planIdFromOrigin('Meetings/2026-08-18 – One-on-One.md'), null);
  assert.equal(planTasks.planIdFromOrigin('vantage://finding/12'), null);
  assert.equal(planTasks.planIdFromOrigin(null), null);
  assert.equal(planTasks.planIdFromOrigin(undefined), null);
  assert.equal(planTasks.planIdFromOrigin(42), null);
});

/**
 * The matching pass, driven through a stubbed model.
 *
 * The point of these is not that the model is clever — it is that nothing it
 * says is trusted. A pair naming a task that does not exist would put a link on
 * screen to nothing; a pair naming an action that was not asked about would
 * attach work to the wrong row of a document going to Nick's manager.
 */
const planMatch = require('./plan-match');
const openrouter = require('./openrouter');

const CATALOGUE = {
  tasks: [{ id: 7, text: 'Restart weekly one to ones', dueDate: null, source: 'manual', microsoft: null }],
  microsoft: [{ msId: 'ms-121', text: 'Re-instate reglar 121s with team', dueDate: '2026-08-21', source: 'MS Planner' }],
};

function withModel(text, fn) {
  const realComplete = openrouter.complete;
  const realConfigured = openrouter.isConfigured;
  openrouter.complete = async () => ({ text });
  openrouter.isConfigured = () => true;
  return fn().finally(() => {
    openrouter.complete = realComplete;
    openrouter.isConfigured = realConfigured;
  });
}

test('a proposal naming a candidate that does not exist is discarded, not shown', async () => {
  const res = await withModel(JSON.stringify({
    pairs: [
      { plan: 'Q6', candidate: 'm:ms-121', confidence: 'high', why: 'same job' },
      { plan: 'Q3', candidate: 'n:9999', confidence: 'high', why: 'invented task' },
      { plan: 'ZZ9', candidate: 'n:7', confidence: 'high', why: 'invented action' },
    ],
  }), () => planMatch.propose(CATALOGUE));

  assert.equal(res.available, true);
  assert.deepEqual(Object.keys(res.pairs), ['Q6']);
  assert.equal(res.pairs.Q6.kind, 'microsoft');
  assert.equal(res.pairs.Q6.ref, 'ms-121');
  // Counted, so the screen can say how much was thrown away rather than imply
  // the model was precise.
  assert.equal(res.dropped, 2);
});

test('one candidate cannot back two actions', async () => {
  const res = await withModel(JSON.stringify({
    pairs: [
      { plan: 'Q6', candidate: 'n:7', confidence: 'high', why: 'first' },
      { plan: 'Q3', candidate: 'n:7', confidence: 'high', why: 'same task again' },
    ],
  }), () => planMatch.propose(CATALOGUE));

  assert.deepEqual(Object.keys(res.pairs), ['Q6']);
  assert.equal(res.dropped, 1);
});

test('an unreadable answer is a failure, but an empty one is a finding', async () => {
  const broken = await withModel('the model apologises and explains itself', () => planMatch.propose(CATALOGUE));
  assert.equal(broken.available, false, 'unparseable must not read as "nothing matched"');
  assert.match(broken.reason, /readable/);

  const empty = await withModel('{"pairs": []}', () => planMatch.propose(CATALOGUE));
  assert.equal(empty.available, true, 'a genuine "nothing matched" is available and empty');
  assert.deepEqual(empty.pairs, {});
});

test('nothing to match against is stated, never reported as no matches', async () => {
  const res = await withModel('{"pairs": []}', () =>
    planMatch.propose({ tasks: [], microsoft: [] }));
  assert.equal(res.available, false);
  assert.match(res.reason, /no tasks or Planner items/i);
});

test('an unset confidence degrades to low rather than being trusted', async () => {
  const res = await withModel(JSON.stringify({
    pairs: [{ plan: 'Q6', candidate: 'n:7', confidence: 'certain', why: 'made-up level' }],
  }), () => planMatch.propose(CATALOGUE));
  assert.equal(res.pairs.Q6.confidence, 'low');
});

/**
 * Caught live, not by the suite (20 Aug 2026): the suggestion filter read
 * `m.task.id` on every match, and a Planner match has no `task` — it is not a
 * NEURO task yet, which is the entire reason it is being offered. The throw was
 * caught and turned into a HALF response with no counts and no catalogue, so
 * the screen then failed on the missing fields and reported the wrong problem.
 *
 * Two assertions, therefore: the Planner match survives the filter, and a
 * failure anywhere in matching still returns a whole payload.
 */
function stubNeuro({ tasks = [], todos = [], match }) {
  const real = { allTasks: neuro.allTasks, todos: neuro.todos, matchTasks: neuro.matchTasks, isConfigured: neuro.isConfigured };
  neuro.isConfigured = () => true;
  neuro.allTasks = async () => ({ tasks });
  neuro.todos = async () => ({ todos });
  neuro.matchTasks = match;
  return () => Object.assign(neuro, real);
}

test('a Planner suggestion survives the filter that checks linked tasks', { skip: !storeReady }, async () => {
  const restore = stubNeuro({
    tasks: [],
    todos: [{ ms_id: 'ms-121', text: 'Re-instate reglar 121s with team', source: 'MS Planner', done: false }],
    match: async () => ({
      results: [{ id: 'Q6', matches: [{ score: 0.8, confidence: 'strong', kind: 'microsoft', ms: { ms_id: 'ms-121', text: 'Re-instate reglar 121s with team', ms_source: 'MS Planner' } }] }],
    }),
  });
  try {
    const res = await planTasks.overview({ match: false });
    assert.equal(res.suggestionsAvailable, true, `matching threw: ${res.suggestionsReason}`);
    assert.equal(res.items.Q6.suggestions.length, 1);
    assert.equal(res.items.Q6.suggestions[0].kind, 'microsoft');
  } finally { restore(); }
});

test('matching failing still returns a whole payload', { skip: !storeReady }, async () => {
  const restore = stubNeuro({
    tasks: [],
    todos: [],
    match: async () => { throw new Error('NEURO /api/task-dedupe/match returned 404'); },
  });
  try {
    const res = await planTasks.overview({ match: false });
    assert.equal(res.available, true);
    assert.equal(res.suggestionsAvailable, false);
    assert.match(res.suggestionsReason, /404/);
    // The fields the screen reads unconditionally must all still be there.
    assert.ok(res.counts, 'counts missing — the screen would fail on the wrong thing');
    assert.ok(res.catalogue, 'catalogue missing — the picker would fail to open');
    assert.equal(typeof res.plannerScope, 'string');
  } finally { restore(); }
});

test('the Planner scope caveat is stated, not implied', () => {
  // NEURO reads /me/planner/tasks — assigned to Nick only. If this text ever
  // disappears, the UI starts implying an absence it cannot see.
  assert.match(planTasks.PLANNER_SCOPE, /assigned to you/i);
});
