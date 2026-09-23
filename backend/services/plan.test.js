'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseRegister, crossCheck, boardFrom, summarise, PLANNER_PLAN_ID } = require('./plan');

// The register's real shape, cut down: two sections, the counts table that
// must NOT parse as actions, a wikilinked owner, a quoted Planner title, a
// "Same Planner task as" row, and a Planner ID column in one table only.
const REGISTER = `# SIP - Action Register

## 1. Mel review: Quick wins (first 2 weeks)

| ID | Action | Source | Owner | Planner status | Due | Notes |
|---|---|---|---|---|---|---|
| Q1 | Communicate the plan | Mel review: Quick wins | Nick | Done | 21/08 | Planner: "Communicate the action plan to all teams" |
| Q8 | One visible case | Mel review: Quick wins | Nick | Added | 21/08 | Planner: "Span teams" |
| T4 | Parent case model | Mel review: 30-day; Rec 2 | Nick | Added | 21/08 | Same Planner task as Q8 |
| T9 | Map capacity | Mel review: 30-day | [[Stephen Mitchell]] and [[Nathan Rutland]] | Added | 02/10 | |

## 7. Sourced from NEURO, NOVA and the escalation model

| ID | Action | Source | Owner | Planner status | Due | Notes | Planner ID |
|---|---|---|---|---|---|---|---|
| E1 | Fix NOVA SLA reporting | NOVA (sla_trend) | Nick | To be added | | | |
| B1 | Problem management | Best practice (ITIL 4) | Director of Projects & Change with Nick | Added | TBC | | abc |

## Counts (23 September 2026)

| Planner status | Count |
|---|---|
| Done | 1 |
`;

const graph = (id, title, extra = {}) => ({
  planId: PLANNER_PLAN_ID, id, title, percentComplete: 0,
  dueDateTime: null, completedDateTime: null, ...extra,
});

test('parses every action row and nothing else', () => {
  const r = parseRegister(REGISTER);
  assert.deepStrictEqual(r.actions.map(a => a.id), ['Q1', 'Q8', 'T4', 'T9', 'E1', 'B1']);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.sections.length, 2, 'the counts table is not a section of actions');
});

test('reads source, owner and Planner references', () => {
  const [q1, , t4, t9, e1, b1] = parseRegister(REGISTER).actions;
  assert.strictEqual(q1.group, 'review');
  assert.strictEqual(e1.group, 'neuro-nova');
  assert.strictEqual(b1.group, 'best-practice');
  assert.strictEqual(t9.owner, 'Stephen Mitchell and Nathan Rutland', 'wikilinks are unwrapped');
  assert.strictEqual(t9.ownership, 'other');
  assert.strictEqual(q1.ownership, 'mine');
  assert.strictEqual(b1.ownership, 'shared');
  assert.deepStrictEqual(q1.plannerTitles, ['Communicate the action plan to all teams']);
  assert.strictEqual(t4.sameAs, 'Q8');
  assert.deepStrictEqual(b1.plannerIds, ['abc']);
});

test('an unknown status is reported, not silently accepted', () => {
  const r = parseRegister(REGISTER.replace('| Nick | Done | 21/08 |', '| Nick | Finished | 21/08 |'));
  assert.strictEqual(r.problems.length, 1);
  assert.match(r.problems[0], /Q1/);
});

test('links by ID, then quoted title, then "same task as"; flags disagreement', () => {
  const board = boardFrom({
    tasks: [
      graph('p1', 'Communicate the action plan to all teams', { percentComplete: 50 }),
      graph('p2', 'Span teams', { completedDateTime: '2026-09-14T10:00:00Z', percentComplete: 100 }),
      graph('abc', 'Problem management', { dueDateTime: '2026-10-02T10:00:00Z' }),
      graph('stray', 'Something nobody wrote down'),
      { ...graph('other-plan', 'Not this board'), planId: 'elsewhere' },
    ],
  });
  const { actions, unregistered } = crossCheck(parseRegister(REGISTER).actions, board, new Set(['p1', 'abc']));
  const by = id => actions.find(a => a.id === id);

  assert.deepStrictEqual(by('Q1').planner.map(t => t.id), ['p1']);
  assert.match(by('Q1').drift[0], /Done in the vault, 50% on the board/);

  assert.deepStrictEqual(by('T4').planner.map(t => t.id), ['p2'], 'inherits Q8\'s task');
  assert.match(by('Q8').drift[0], /Done on the board \(14\/09\), "Added" in the vault/);

  assert.match(by('B1').drift.join(' '), /Due 02\/10 on the board, "TBC" in the vault/);
  assert.strictEqual(by('B1').inNeuro, true);

  // Positive control beside the refusal: T9 has no board match, and that must
  // read as unlinked, not as a drift or as "not on the board".
  assert.deepStrictEqual(by('T9').planner, []);
  assert.deepStrictEqual(by('T9').drift, []);

  assert.deepStrictEqual(unregistered.map(t => t.id), ['stray'], 'only this board, only unclaimed tasks');
});

test('an unread board yields unknown everywhere, never "not on the board"', () => {
  const { actions, unregistered } = crossCheck(parseRegister(REGISTER).actions, null, null);
  assert.ok(actions.every(a => a.planner === null && a.inNeuro === null && a.drift.length === 0));
  assert.strictEqual(unregistered, null);
  assert.strictEqual(summarise(actions, unregistered).unregistered, null);
});

test('summary counts mine apart from everyone else', () => {
  const s = summarise(parseRegister(REGISTER).actions, []);
  assert.deepStrictEqual(s.mine, { total: 4, done: 1, onBoard: 2, toBeAdded: 1 });
  assert.strictEqual(s.total, 6);
  assert.strictEqual(s.byGroup.review, 4);
});
