'use strict';

/**
 * Pins the overdue split — the one card on the radar that makes a claim about
 * the PIP.
 *
 * It counted every overdue open task and said "PIP competency 4 measures
 * exactly this". Measured live on 1 Sep 2026 the list held three overdue tasks,
 * ALL THREE continual improvement and none of them a commitment — so the card
 * reported a competency Nick was meeting as one he was failing, on the screen
 * he reads every day, while the report going to his manager counted it
 * correctly. Two numbers for one competency, and the harsher one in front of
 * him.
 *
 * The negative tests are the load-bearing ones: improvement work must never
 * acquire the word "overdue", and an unclassified task must never be quietly
 * folded into either side.
 */

const test = require('node:test');
const assert = require('node:assert');

const { fromNeuro } = require('./radar');

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const NEXT_YEAR = '2099-01-01';

const tasksOk = tasks => ({ ok: true, data: { tasks } });
const titles = items => items.map(i => i.title).join(' | ');
const details = items => items.map(i => `${i.title} ${i.detail}`).join(' | ');

test('an overdue commitment is counted, and named as what competency 4 measures', () => {
  const out = fromNeuro({
    tasks: tasksOk([{ text: 'a', due_date: YESTERDAY, origin: 'commitment' }]),
  });
  assert.match(titles(out), /1 commitment is overdue/);
  assert.match(details(out), /competency 4/);
});

test('improvement work past its date is never called overdue', () => {
  const out = fromNeuro({
    tasks: tasksOk([
      { text: 'a', due_date: YESTERDAY, origin: 'improvement' },
      { text: 'b', due_date: YESTERDAY, origin: 'improvement' },
    ]),
  });
  const card = out.find(i => /improvement task/.test(i.title));
  assert.ok(card, 'the improvement card should be raised');
  assert.doesNotMatch(card.title, /overdue/i, 'a date Nick set himself is not a broken promise');
  assert.match(`${card.title} ${card.detail}`, /NOT what competency 4 counts/);
});

test('the live shape on 1 Sep 2026 — three improvement, zero commitments — makes no PIP claim', () => {
  const out = fromNeuro({
    tasks: tasksOk([
      { text: 'wellbeing conversation', due_date: '2026-04-08', origin: 'improvement' },
      { text: 'quiet room', due_date: '2026-04-15', origin: 'improvement' },
      { text: 'career progression plans', due_date: '2026-04-17', origin: 'improvement' },
    ]),
  });
  assert.doesNotMatch(details(out), /competency 4 counts, and the target is zero/,
    'with no overdue commitment there is no competency-4 finding to report');
  assert.doesNotMatch(titles(out), /commitment/);
});

test('an unclassified overdue task is its own bucket, never folded into either', () => {
  const out = fromNeuro({
    tasks: tasksOk([{ text: 'a', due_date: YESTERDAY, origin: null }]),
  });
  assert.match(titles(out), /unclassified/);
  assert.doesNotMatch(titles(out), /commitment is overdue/);
  assert.doesNotMatch(titles(out), /improvement task/);
});

test('unclassified alongside commitments makes the commitment figure a floor', () => {
  const out = fromNeuro({
    tasks: tasksOk([
      { text: 'a', due_date: YESTERDAY, origin: 'commitment' },
      { text: 'b', due_date: YESTERDAY, origin: null },
    ]),
  });
  assert.match(details(out), /treat this as a floor/);
  // One card, not two: with a commitment card on screen the unclassified count
  // is a caveat on that number, not a finding of its own.
  assert.equal(out.filter(i => /unclassified/.test(i.title)).length, 0);
});

test('a classification NEURO proposed rather than Nick made is declared', () => {
  const out = fromNeuro({
    tasks: tasksOk([{ text: 'a', due_date: YESTERDAY, origin: 'commitment', origin_proposed: 1 }]),
  });
  assert.match(details(out), /classified by NEURO rather than by you/);
});

test('a task due in the future raises nothing at all', () => {
  const out = fromNeuro({
    tasks: tasksOk([
      { text: 'a', due_date: NEXT_YEAR, origin: 'commitment' },
      { text: 'b', due_date: null, origin: 'improvement' },
    ]),
  });
  assert.equal(out.length, 0);
});

test('an unreadable task list says nothing rather than reporting zero overdue', () => {
  const out = fromNeuro({ tasks: { ok: false, error: 'NEURO unreachable', data: null } });
  assert.equal(out.length, 0);
});
