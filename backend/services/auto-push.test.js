'use strict';

/**
 * VANTAGE acting on its own (item 18).
 *
 * Decision 2 approved unattended writes into NEURO. What has to hold is that
 * "unattended" stays narrow: only the direct route travels, nothing is sent
 * twice, and nothing reaches the document that goes to Chris.
 *
 * `selectFor` is pure, so all of that pins without a timer, a clock or a
 * network.
 */

const test = require('node:test');
const assert = require('node:assert');

const { selectFor, alreadySent, MAX_PER_PASS } = require('./auto-push');

const finding = (over = {}) => ({
  id: 1, title: 'Portal contacts unbranded', detail: 'x', severity: 'high',
  tense: 'happened', source: 'radar', status: 'open', found_on: '2026-09-01', ...over,
});

test('a severe, already-happened finding is picked up', () => {
  assert.strictEqual(selectFor([finding()]).length, 1);
});

test('only the DIRECT route travels unattended', () => {
  // A pending suggestion is by definition one that can wait for Nick. Pushing
  // those from a screen he has not opened fills the approval queue, which is
  // how a queue built to be read stops being read.
  const waiting = [
    finding({ id: 2, severity: 'high', tense: 'could' }),
    finding({ id: 3, severity: 'medium', tense: 'happening' }),
    finding({ id: 4, severity: 'low', tense: 'happened' }),
    finding({ id: 5, severity: undefined }),
  ];
  assert.deepStrictEqual(selectFor(waiting), []);
});

test('a finding already handed over by ANY route is never sent again', () => {
  for (const marker of ['neuro_auto_pushed_on', 'neuro_task_id', 'neuro_action_id', 'neuro_escalated_on']) {
    const f = finding({ [marker]: marker === 'neuro_task_id' ? 12 : '2026-09-02T10:00:00Z' });
    assert.strictEqual(alreadySent(f), true, marker);
    assert.deepStrictEqual(selectFor([f]), [], `${marker} must stop a second push`);
  }
});

test('a resolved or accepted finding is not live work', () => {
  for (const status of ['resolved', 'resolved_pending', 'accepted']) {
    assert.deepStrictEqual(selectFor([finding({ status })]), [], status);
  }
});

test('the oldest qualifying finding goes first', () => {
  const out = selectFor([
    finding({ id: 1, found_on: '2026-09-02' }),
    finding({ id: 2, found_on: '2026-08-20' }),
    finding({ id: 3, found_on: '2026-09-01' }),
  ]);
  assert.deepStrictEqual(out.map(f => f.id), [2, 3, 1]);
});

test('the cap is small on purpose', () => {
  // The value of an unattended write is that the one thing that matters is
  // already in his list, not that a screenful arrived while he was in a meeting.
  assert.ok(MAX_PER_PASS <= 5, `${MAX_PER_PASS} is too many to arrive unannounced`);
});

test('nothing here can touch the weekly risk report', () => {
  // Putting a line in front of Chris stays a thing Nick does. A task appearing
  // in his list unasked is recoverable in a click; a line on a document that
  // leaves the building is not.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'auto-push.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /weeklyRisk/);
  // A CALL, not the word — `neuro_escalated_on` is a field it must read.
  assert.doesNotMatch(src, /escalate\s*\(/);
  assert.doesNotMatch(src, /setWeeklyRiskManual/);
  // Positive control: the scan is looking at real code.
  assert.match(src, /proposeWork/);
});

test('nothing here re-words, resolves or re-severities a finding', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'auto-push.js'), 'utf-8');
  // The only write to the register is the ledger stamp.
  const updates = src.match(/db\.update\(/g) || [];
  assert.strictEqual(updates.length, 1);
  assert.match(src, /neuro_auto_pushed_on/);
});
