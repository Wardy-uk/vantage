'use strict';

/**
 * Pins two deliberate absences.
 *
 * VANTAGE shows Nick's own work. It does not show what other people owe him
 * (NEURO's waiting-on already does, on the People board, where the person it
 * concerns is), and it does not show raw vault action lines at all.
 *
 * The history, so nobody rebuilds either by accident:
 *
 * `/api/vault-actions` scrapes every unticked checkbox out of meeting notes and
 * records no assignee on any of the 3,218 rows, so it cannot say whose work
 * anything is. A card built on it announced "307 commitments are past their due
 * date" — unowned lines, presented to Nick as promises he had broken, on the
 * screen he reads every day. The count was wrong too: PLAUD writes several
 * summary variants per recording, so the 307 folded to seven distinct items.
 *
 * Two sources DO know whose work they are and both remain: tasks with
 * `origin: 'commitment'`, and NEURO's waiting-on — the second of which is
 * NEURO's to show, not this tool's.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { fromNeuro } = require('./radar');

const SOURCE = fs.readFileSync(path.join(__dirname, 'radar.js'), 'utf8');

test('raw vault action lines produce no cards, whatever is passed in', () => {
  const items = Array.from({ length: 40 }, (_, n) => ({
    text: `Speaker ${n} to do a thing`,
    file: 'Meetings/2026/08/2026-08-30 note.md',
    dueDate: n % 2 ? '2020-01-01' : null,
    assignee: null,
  }));
  // Passed under every name the old signature used, so a partial revert of the
  // plumbing cannot quietly bring the cards back.
  const out = fromNeuro({ actions: { ok: true, data: { items } }, tasks: null, health: null });
  assert.deepEqual(out, []);
});

test('what other people owe Nick produces no cards', () => {
  const out = fromNeuro({
    waiting: { ok: true, data: { staleAfterDays: 7, items: [
      { person: 'Naomi', summary: 'the risk assessment', created_at: '2026-04-01' },
      { person: 'Chris', summary: 'the headcount figures', created_at: '2026-05-01' },
    ] } },
    tasks: null,
    health: null,
  });
  assert.deepEqual(out, []);
});

test('the radar does not fetch either source', () => {
  // A fetch nothing consumes is a slower radar and a blind spot that looks like
  // coverage — the same species as a client function with no caller.
  assert.doesNotMatch(SOURCE, /neuro\.vaultActions/,
    'vault action items are not VANTAGE\'s to show — no owner on the row');
  assert.doesNotMatch(SOURCE, /neuro\.waitingOn/,
    'what others owe Nick belongs on NEURO\'s People board');
  // Positive control: the sources that ARE read must still be here, or this
  // test would pass just as well against an empty file.
  assert.match(SOURCE, /neuro\.tasks/);
  assert.match(SOURCE, /neuro\.teamHealth/);
});
