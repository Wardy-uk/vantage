'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const plans = require('./plans');
const plan = require('./plan');
const neuro = require('./neuro');
const { parseProposal } = require('./plan-import');

const SIP_LIKE = `---
type: tracker
project: Support Improvement Plan
---

# SIP - Action Register

## 1. Quick wins

| ID | Action | Source | Owner | Planner status | Due | Notes | Planner ID |
|---|---|---|---|---|---|---|---|
| Q1 | Communicate the plan | Mel review: Quick wins | Nick | Done | 04/09 | | abc |
| Q3 | Daily blocker check | Mel review: Quick wins | Nick | Added | 21/08 | paused | def |
| T2 | Front-door triage | Mel review: 30-day | Nick | Not adding | | | |

## Counts

| Planner status | Count |
|---|---|
| Done | 1 |
`;

test('a SIP register keeps every line it does not need to change, and gains Rank and Star', () => {
  const { markdown, problems } = plans.setTaskCells(SIP_LIKE, new Map([['Q3', { Rank: '1', Star: '★' }]]));
  assert.deepStrictEqual(problems, []);
  const before = SIP_LIKE.split('\n');
  const after = markdown.split('\n');
  assert.equal(after.length, before.length);
  // frontmatter, headings, the counts table: byte-identical
  for (const i of [0, 1, 2, 3, 5, 7, 15, 16, 17, 18, 19]) assert.equal(after[i], before[i], `line ${i}`);
  const parsed = plan.parseRegister(markdown).actions;
  const q3 = parsed.find(a => a.id === 'Q3');
  assert.equal(q3.rank, 1);
  assert.equal(q3.starred, true);
  assert.equal(parsed.find(a => a.id === 'Q1').starred, false);
  // SIP's status words still parse, and map
  assert.equal(q3.status, 'Added');
  assert.equal(q3.statusKey, 'doing');
  assert.equal(parsed.find(a => a.id === 'T2').statusKey, 'dropped');
});

test('a second edit on an already-extended table adds no further columns', () => {
  const once = plans.setTaskCells(SIP_LIKE, new Map([['Q1', { Star: '★' }]])).markdown;
  const twice = plans.setTaskCells(once, new Map([['Q1', { Star: '' }]])).markdown;
  const header = twice.split('\n').find(l => l.startsWith('| ID |'));
  assert.equal((header.match(/Rank/g) || []).length, 1);
  assert.equal((header.match(/Star/g) || []).length, 1);
  assert.equal(plan.parseRegister(twice).actions.find(a => a.id === 'Q1').starred, false);
});

test('an unknown task id is reported, not silently ignored', () => {
  const { problems } = plans.setTaskCells(SIP_LIKE, new Map([['Z9', { Star: '★' }]]));
  assert.ok(problems.some(p => p.startsWith('Z9')));
});

test('a row whose cell count is off is left alone and reported', () => {
  const broken = SIP_LIKE.replace('| Q1 | Communicate the plan |', '| Q1 | Communicate | the plan |');
  const { markdown, problems } = plans.setTaskCells(broken, new Map([['Q1', { Star: '★' }]]));
  assert.ok(problems.some(p => p.startsWith('Q1')));
  assert.ok(markdown.includes('| Q1 | Communicate | the plan |'));
});

test('the real SIP register (when present) round-trips through a star', { skip: !fs.existsSync(path.join(process.env.USERPROFILE || '', 'Documents/Nicks knowledge base/Projects/Support Improvement Plan/SIP - Action Register.md')) }, () => {
  const real = fs.readFileSync(path.join(process.env.USERPROFILE, 'Documents/Nicks knowledge base/Projects/Support Improvement Plan/SIP - Action Register.md'), 'utf8');
  const before = plan.parseRegister(real);
  const { markdown, problems } = plans.setTaskCells(real, new Map([['Q3', { Star: '★' }]]));
  assert.deepStrictEqual(problems, [], 'no SIP row is unwritable');
  const after = plan.parseRegister(markdown);
  assert.equal(after.actions.length, before.actions.length);
  assert.deepStrictEqual(after.actions.map(a => [a.id, a.status, a.owner, a.due]), before.actions.map(a => [a.id, a.status, a.owner, a.due]));
  assert.equal(after.actions.find(a => a.id === 'Q3').starred, true);
});

test('a template register parses, with its own status words', () => {
  const md = plans.buildRegister({
    name: 'KPI revision', folder: 'KPI revision', rank: 2, created: '2026-10-29',
    sections: [{ title: 'Phase 1', actions: [{ action: 'Agree targets | with Chris', owner: 'Nick', due: '04/11' }, { action: 'Publish', status: 'In progress' }] }],
  });
  const r = plan.parseRegister(md);
  assert.deepStrictEqual(r.problems, []);
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].action, 'Agree targets / with Chris', 'a pipe in text cannot split a cell');
  assert.equal(r.actions[0].statusKey, 'todo');
  assert.equal(r.actions[1].statusKey, 'doing');
  assert.equal(plans.parseFrontmatter(md).data['plan-rank'], '2');
});

test('an empty template register is a plan with no actions, not a parse failure', () => {
  const md = plans.buildRegister({ name: 'X', folder: 'X', rank: 1, created: '2026-10-29' });
  assert.equal(plan.parseRegister(md).actions.length, 0);
  assert.match(md, /^\s*\|\s*ID\s*\|/m);
});

test('setFrontmatterKey changes only that key', () => {
  const md = '---\ntype: tracker\nplan-rank: 3\ntags: [a]\n---\n\n# T\n';
  assert.equal(plans.setFrontmatterKey(md, 'plan-rank', '1'), '---\ntype: tracker\nplan-rank: 1\ntags: [a]\n---\n\n# T\n');
  assert.equal(plans.setFrontmatterKey('---\na: b\n---\nx', 'plan-rank', '2'), '---\na: b\nplan-rank: 2\n---\nx');
});

test('consolidated order: starred first, then plan rank, then task rank, then register order', () => {
  const rows = [
    { id: 'a', planName: 'B', planRank: 2, rank: 1, order: 0, starred: false },
    { id: 'b', planName: 'A', planRank: 1, rank: null, order: 5, starred: false },
    { id: 'c', planName: 'A', planRank: 1, rank: 2, order: 1, starred: false },
    { id: 'd', planName: 'C', planRank: null, rank: 1, order: 0, starred: true },
    { id: 'e', planName: 'A', planRank: 1, rank: 1, order: 9, starred: false },
  ];
  assert.deepStrictEqual(plans.orderTasks(rows).map(r => r.id), ['d', 'e', 'c', 'b', 'a']);
});

test('plans sort by rank, unranked last', () => {
  const out = plans.sortPlans([{ name: 'Z', rank: null }, { name: 'B', rank: 2 }, { name: 'A', rank: 1 }]);
  assert.deepStrictEqual(out.map(p => p.name), ['A', 'B', 'Z']);
});

test('VANTAGE may write only plan notes under Projects/<Folder>/', () => {
  const ok = [
    'Projects/Support Improvement Plan/SIP - Action Register.md',
    'Projects/KPI revision/KPI revision.md',
    'Projects/KPI revision/KPI revision - Source.md',
  ];
  const bad = [
    'Projects/Archive/X - Action Register.md',
    'Projects/KPI revision/Notes.md',
    'Projects/KPI revision/sub/X - Action Register.md',
    'People/Nick Ward.md',
    'Projects/../People/X - Action Register.md',
    'Projects/KPI revision/Other.md',
  ];
  for (const p of ok) assert.equal(neuro.planNotePathProblem(p), null, p);
  for (const p of bad) assert.ok(neuro.planNotePathProblem(p), p);
});

test('a folder name is refused when it could escape or is reserved', () => {
  for (const f of ['', 'Archive', '../x', 'a/b', '.hidden']) assert.ok(plans.folderProblem(f), f);
  assert.equal(plans.folderProblem('KPI revision'), null);
});

test('an import proposal keeps stated owners/dates only, and refuses an empty answer', () => {
  const p = parseProposal(JSON.stringify({
    name: 'TOM', sections: [{ title: 'Phase 1', actions: [
      { action: 'Draft the model', owner: 'Nick', due: '2026-11-04' },
      { action: 'Review', owner: null, due: 'Q4' },
      { action: '' },
    ] }],
  }));
  assert.equal(p.sections[0].actions.length, 2);
  assert.equal(p.sections[0].actions[1].due, null, 'a vague date is never a due date');
  assert.ok(p.problems.some(x => /not a date/.test(x)));
  assert.ok(p.problems.some(x => /no action text/.test(x)));
  assert.throws(() => parseProposal('{"sections":[]}'), /No actions/);
  assert.throws(() => parseProposal('{"sections":[{"title":"x","act'), /not readable JSON/);
});

test('board seeding maps status from Planner', () => {
  assert.equal(plans.boardStatus({ completedDateTime: '2026-10-01' }), 'Done');
  assert.equal(plans.boardStatus({ percentComplete: 50 }), 'In progress');
  assert.equal(plans.boardStatus({ percentComplete: 0 }), 'To do');
  assert.equal(plans.toDdmm('2026-11-04T12:00:00Z'), '04/11');
});

test('closing a SIP task writes its own word into "Planner status", and adds no columns', () => {
  const v = plans.vocabularyOf(SIP_LIKE);
  assert.equal(v.column, 'Planner status');
  assert.equal(v.dropped, 'Not adding');
  assert.equal(v.reopen({ plannerIds: ['abc'] }), 'Added');
  assert.equal(v.reopen({ plannerIds: [] }), 'To be added');
  const { markdown, problems } = plans.setTaskCells(SIP_LIKE, new Map([['Q3', { 'Planner status': 'Done' }]]), []);
  assert.deepStrictEqual(problems, []);
  assert.ok(!/Rank|Star/.test(markdown), 'a status write adds no Rank/Star columns');
  const rows = plan.parseRegister(markdown).actions;
  assert.equal(rows.find(a => a.id === 'Q3').status, 'Done');
  assert.equal(rows.find(a => a.id === 'Q1').status, 'Done');
  assert.equal(rows.find(a => a.id === 'T2').status, 'Not adding');
  const changed = markdown.split('\n').filter((l, i) => l !== SIP_LIKE.split('\n')[i]);
  assert.equal(changed.length, 1, 'only the Q3 row changed');
});

test('a template register closes with its own words', () => {
  const md = plans.buildRegister({ name: 'X', folder: 'X', rank: 1, created: '2026-10-29', sections: [{ title: 'A', actions: [{ action: 'One' }, { action: 'Two' }] }] });
  const v = plans.vocabularyOf(md);
  assert.equal(v.column, 'Status');
  assert.equal(v.dropped, 'Not doing');
  const out = plans.setTaskCells(md, new Map([['A1', { Status: v.done }], ['A2', { Status: v.dropped }]]), []).markdown;
  const rows = plan.parseRegister(out).actions;
  assert.deepStrictEqual(rows.map(a => a.statusKey), ['done', 'dropped']);
});

test('replan spread: N a day over working days, skipping weekends and bank holidays', () => {
  const rows = ['A1', 'A2', 'A3', 'A4', 'A5'].map(id => ({ planId: 'p', id, due: '' }));
  // Fri 30 Oct 2026; Mon 2 Nov treated as a holiday for the test.
  const out = plans.computeReplan(rows, { mode: 'spread', start: '2026-10-30', perDay: 2 }, new Set(['2026-11-02']));
  assert.deepStrictEqual(out.map(o => o.to), ['2026-10-30', '2026-10-30', '2026-11-03', '2026-11-03', '2026-11-04']);
  // a weekend start moves to Monday
  assert.equal(plans.computeReplan(rows.slice(0, 1), { mode: 'spread', start: '2026-10-31', perDay: 1 }).at(0).to, '2026-11-02');
});

test('replan shift: working days from the register date; undated rows are skipped, not invented', () => {
  const out = plans.computeReplan([{ planId: 'p', id: 'A1', due: '30/10' }, { planId: 'p', id: 'A2', due: 'TBC' }], { mode: 'shift', days: 1 }, new Set());
  const y = new Date().getFullYear();
  assert.equal(out[0].from, '30/10');
  assert.equal(out[0].to, plans.addWorking(`${y}-10-30`, 1, new Set()), 'one working day after 30/10 this year');
  assert.notEqual(out[0].to, `${y}-10-30`);
  assert.equal(out[1].to, null);
  assert.equal(out[1].skipped, 'no date to shift');
  assert.equal(plans.addWorking('2026-10-30', 1, new Set()), '2026-11-02');
  assert.equal(plans.addWorking('2026-11-02', -1, new Set()), '2026-10-30');
});

test('replan refuses bad input rather than guessing', () => {
  const r = [{ planId: 'p', id: 'A1', due: '' }];
  assert.throws(() => plans.computeReplan(r, { mode: 'spread', start: '2026-02-31', perDay: 2 }), /start date/);
  assert.throws(() => plans.computeReplan(r, { mode: 'spread', start: '2026-10-30', perDay: 0 }), /per day/);
  assert.throws(() => plans.computeReplan(r, { mode: 'shift', days: 0 }), /Shift/);
  assert.throws(() => plans.computeReplan(r, { mode: 'set', date: 'soon' }), /date is required/);
  assert.equal(plans.ddmmToIso('31/02'), null);
  assert.equal(plans.ddmmToIso('21/08, 24/08'), `${new Date().getFullYear()}-08-21`);
});

const pn = require('./plan-neuro');

test('hand-off: only my open rows go; repeats are made distinct; board tasks are linked, not copied', () => {
  const md = plans.buildRegister({ name: '90 Day Plan', folder: '90 Day Plan', rank: 1, created: '2026-10-29', sections: [{ title: 'W1', actions: [
    { action: 'Weekly reflection.', owner: 'Nick', due: '30/10' },
    { action: 'Weekly reflection.', owner: 'Nick', due: '06/11' },
    { action: 'Done already', owner: 'Nick', status: 'Done' },
    { action: 'Stephen does this', owner: 'Stephen Mitchell' },
    { action: 'On the board', owner: 'Nick', plannerId: 'PB1' },
    { action: 'No owner', owner: '' },
  ] }] });
  const rows = plan.parseRegister(md).actions;
  rows[0].starred = true;
  const items = pn.prepareHandoff(rows, { myBoardIds: new Map([['PB1', {}]]), planName: '90 Day Plan', ddmmToIso: plans.ddmmToIso });
  assert.deepStrictEqual(items.map(i => i.row.id), ['A1', 'A2', 'A5'], 'not done, not Stephen\'s, not unstated');
  assert.equal(items[0].create.text, 'Weekly reflection. (90 Day Plan A1)');
  assert.equal(items[1].create.text, 'Weekly reflection. (90 Day Plan A2)');
  assert.equal(items[0].create.moscow, 'must', 'a star becomes Must');
  assert.equal(items[1].create.moscow, null);
  assert.equal(items[0].create.dueDate, plans.ddmmToIso('30/10'));
  assert.equal(items[2].link, 'ms:PB1');
  assert.equal(items[2].create, undefined);
  const imported = pn.prepareHandoff(rows, { myBoardIds: new Map(), includeUnstated: true, planName: 'X', ddmmToIso: plans.ddmmToIso });
  assert.ok(imported.some(i => i.row.action === 'No owner'), 'an import counts unstated owners as Nick');
});

test('live view: NEURO tasks by link or by folder; others stay read-only; a lost link is said', () => {
  const p = { folder: '90 Day Plan', actions: [
    { id: 'A1', action: 'old wording', section: 'W1', neuroId: '11', plannerIds: [] },
    { id: 'A2', action: 'Stephen', section: 'W1', neuroId: null, ownership: 'other', statusKey: 'todo', plannerIds: [] },
    { id: 'A3', action: 'gone', section: 'W1', neuroId: '99', plannerIds: [] },
  ] };
  const ctx = {
    tasks: new Map([
      [11, { id: 11, text: 'live wording', status: 'done', due_date: '2026-11-03', moscow: 'must' }],
      [12, { id: 12, text: 'added from folder', status: 'open', origin_path: 'Projects/90 Day Plan/90 Day Plan - Action Register.md' }],
      [13, { id: 13, text: 'unrelated', status: 'open', origin_path: 'Projects/Other/x.md' }],
    ]),
    order: new Map([['task:12', 1]]), board: new Map(), orderKnown: true,
  };
  const live = pn.liveOf(p, ctx, plans.toDdmm);
  const byId = Object.fromEntries(live.actions.map(a => [a.id, a]));
  assert.equal(byId.A1.action, 'live wording', 'NEURO\'s text, not the frozen register');
  assert.equal(byId.A1.statusKey, 'done');
  assert.equal(byId.A1.starred, true);
  assert.equal(byId.A1.due, '03/11');
  assert.equal(byId.N12.rank, 1);
  assert.ok(!live.actions.some(a => a.action === 'unrelated'));
  assert.equal(byId.A2.readOnly, true);
  assert.equal(byId.A2.inNeuro, false);
  assert.equal(byId.A3.missing, true);
});
