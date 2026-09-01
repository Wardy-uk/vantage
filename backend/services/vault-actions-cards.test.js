'use strict';

/**
 * Pins the two cards built from NEURO's raw action lines.
 *
 * They said "307 commitments are past their due date" and "428 commitments made
 * in meetings have no due date". Both numbers were wrong and both words were
 * wrong:
 *
 *   OWNERSHIP — the parser leaves `assignee` empty on all 3,218 rows, so
 *   nothing here knows whose work it is. `self.js` had already learned this and
 *   documented it; this card called them his anyway, which on a screen he reads
 *   every day amounts to telling him he has broken 307 promises.
 *
 *   COUNT — PLAUD writes several summary variants per recording, so one thing
 *   said in one meeting appears once per variant. Live, the 79 overdue lines
 *   from meetings folded to SEVEN distinct items, one of them counted 43 times.
 *
 * The forbidden-wording tests are the ones that matter. A future tidy-up that
 * restores the shorter word puts an accusation back on the screen.
 */

const test = require('node:test');
const assert = require('node:assert');

const { fromNeuro } = require('./radar');

const actionsOk = items => ({ ok: true, data: { items } });
const say = out => out.map(i => `${i.title} ${i.detail}`).join(' || ');
const overdueCard = out => out.find(i => /date that has gone/.test(i.title));
const undatedCard = out => out.find(i => /no date on them/.test(i.title));

const line = (text, file, dueDate = '2020-01-01') => ({ text, file, dueDate });
// Dated relative to today: the undated card only looks at the last 21 days, so
// a fixture with a hardcoded month silently ages out of its own test.
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const meeting = n => `Meetings/2026/08/${daysAgo(n)} note.md`;

test('copies of one line from different summary variants count once', () => {
  const out = fromNeuro({
    actions: actionsOk([
      line('Pull QA data for Heidi Power — prep for check-in', meeting(1)),
      line('Pull QA data for Heidi Power — prep for check-in', meeting(2)),
      line('Pull QA data for Heidi Power — prep for check-in  <!--id:abc-->', meeting(3)),
      line('PULL QA DATA FOR HEIDI POWER — prep for check-in', meeting(4)),
      line('Book 30 min with Chris Middleton', meeting(5)),
    ]),
  });
  assert.match(overdueCard(out).title, /^2 things said in meetings/);
});

test('neither card calls an unattributed line a commitment', () => {
  const out = fromNeuro({
    actions: actionsOk([
      line('Something somebody said', meeting(1)),
      line('Something else', meeting(2)),
      ...Array.from({ length: 5 }, (_, n) => ({ text: `undated ${n}`, file: meeting(n), dueDate: null })),
    ]),
  });
  const cards = out.filter(i => /said in meetings/.test(i.title));
  assert.equal(cards.length, 2, 'both cards should be raised by this fixture');
  for (const c of cards) {
    assert.doesNotMatch(c.title, /commitment/i,
      'nothing here knows whose work it is, so it cannot be called a commitment');
  }
});

test('the overdue card states that ownership is unknown', () => {
  const out = fromNeuro({
    actions: actionsOk([line('A thing', meeting(1)), line('Another thing', meeting(2))]),
  });
  assert.match(overdueCard(out).detail, /OWNERSHIP UNKNOWN/);
  // And it points at the two populations that DO know.
  assert.match(overdueCard(out).detail, /waiting-on/);
});

test('a daily note line is not on the overdue card — a to-do is not a promise to anyone', () => {
  const out = fromNeuro({
    actions: actionsOk([
      line('buy milk', 'Daily/2026-08-30.md'),
      line('tidy the backlog', 'Tasks/Captured commitments - triage.md'),
    ]),
  });
  assert.equal(overdueCard(out), undefined);
});

test('the oldest date is named, because it is the fact that makes the card worth reading', () => {
  const out = fromNeuro({
    actions: actionsOk([
      line('Old thing', meeting(1), '2026-03-18'),
      line('Newer thing', meeting(2), '2026-05-06'),
    ]),
  });
  assert.match(overdueCard(out).detail, /Oldest 2026-03-18/);
});

test('the id comment never reaches the card', () => {
  const out = fromNeuro({
    actions: actionsOk([
      line('Succession plan  <!--id:g2D79J0BpkqWelbQA1M7fZcAOJ1_-->', meeting(1)),
      line('Something else entirely', meeting(2)),
    ]),
  });
  assert.doesNotMatch(say(out), /<!--/);
});

test('the undated card folds too, and only fires above the noise floor', () => {
  const four = f => ({ text: 'Same thing said four times', file: f, dueDate: null });
  const out = fromNeuro({
    actions: actionsOk([four(meeting(1)), four(meeting(2)), four(meeting(3)), four(meeting(4))]),
  });
  assert.equal(undatedCard(out), undefined, 'four copies of one line is one thing, not four');
});

test('an unreadable action feed says nothing rather than reporting none outstanding', () => {
  const out = fromNeuro({ actions: { ok: false, error: 'NEURO unreachable', data: null } });
  assert.equal(out.length, 0);
});
