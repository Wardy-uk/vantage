'use strict';

/**
 * The development plan store (29 Oct 2026), on a real temp SQLite file:
 * a reassessment supersedes open actions, and never re-offers one Nick already
 * pushed to NEURO or dismissed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-plan-'));
require('../db').init(path.join(dir, 'v.db'));
const store = require('./perf-store');

test('a reassessment supersedes open actions and never re-offers pushed or dismissed ones', () => {
  store.savePlan('future', 1, [
    { code: 'KNOW', action: 'Publish a KB health report', proves: 'report', priority: 1 },
    { code: 'KNOW', action: 'Retire stale articles', priority: 2 },
    { code: 'WFPL', action: 'Model leave cover in NOVA', priority: 2 },
  ]);
  const first = store.planFor('future');
  assert.equal(first.length, 3);
  store.setPlanState(first.find((i) => i.action === 'Publish a KB health report').id, 'pushed', 77);
  store.setPlanState(first.find((i) => i.action === 'Retire stale articles').id, 'dismissed');

  const added = store.savePlan('future', 2, [
    { code: 'KNOW', action: 'Publish a KB health report.', priority: 1 },
    { code: 'KNOW', action: 'retire stale articles', priority: 2 },
    { code: 'MEAS', action: 'Add an FCR trend to the SMT pack', priority: 1 },
  ]);
  assert.equal(added, 1, 'only the genuinely new action is added');
  const now = store.planFor('future');
  assert.deepEqual(now.filter((i) => i.state === 'open').map((i) => i.action), ['Add an FCR trend to the SMT pack']);
  assert.equal(now.find((i) => i.state === 'pushed').neuroTaskId, 77);
  assert.equal(now.filter((i) => i.state === 'dismissed').length, 1);
  assert.ok(!now.some((i) => i.action === 'Model leave cover in NOVA'), 'the old open action is superseded, not shown');
  assert.equal(store.planFor('current').length, 0, 'plans are per role');
});
