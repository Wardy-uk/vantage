'use strict';

/**
 * Performance Evidence — the pure rules (29 Oct 2026). No SQLite needed.
 *
 * What these pin, because each is the kind of thing that fails quietly:
 *  - no accepted evidence is "no evidence yet", never "not yet" — whatever the model says;
 *  - a rating citing nothing valid is refused as "unrated", not kept;
 *  - readiness cannot be claimed over a mostly-unevidenced profile;
 *  - a triage answer missing any item is refused whole;
 *  - tags may only name skills in that role;
 *  - automated mail is noise before any model is paid;
 *  - NOVA: only Nick's escalations; a half week's KPIs are never emitted;
 *  - the export never prints a raw item, only the summary Nick wrote.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAssessment, selectEvidence } = require('./perf-assess');
const { parseTriage, isNoise } = require('./perf-gather');
const { validateProfile } = require('./perf-profile');
const nova = require('./perf-nova')._internals;
const { render } = require('./perf-export');
const sfia = require('./sfia');

const skills = [
  { code: 'SLMO', name: 'Service level management', level: 5 },
  { code: 'PEMT', name: 'Performance management', level: 5 },
  { code: 'QUAS', name: 'Quality assurance', level: 5 },
];

test('a skill with no accepted evidence is no-evidence even if the model rates it', () => {
  const r = parseAssessment(
    { skills: [{ code: 'QUAS', rating: 'not-yet', cite: [99] }, { code: 'SLMO', rating: 'met', cite: [1] }] },
    { skills, bySkill: { SLMO: [1], PEMT: [2], QUAS: [] } },
  );
  const q = r.skills.find((s) => s.code === 'QUAS');
  assert.equal(q.rating, 'no-evidence');
  assert.equal(r.skills.find((s) => s.code === 'SLMO').rating, 'met');
});

test('a rating that cites nothing valid is unrated, and stray citations are dropped', () => {
  const r = parseAssessment(
    { skills: [{ code: 'SLMO', rating: 'met', cite: [7] }, { code: 'PEMT', rating: 'partly', cite: [2, 7] }] },
    { skills, bySkill: { SLMO: [1], PEMT: [2], QUAS: [] } },
  );
  assert.equal(r.skills.find((s) => s.code === 'SLMO').rating, 'unrated');
  assert.deepEqual(r.skills.find((s) => s.code === 'PEMT').cite, [2]);
});

test('readiness is too-little-evidence when under half the skills are rated', () => {
  const r = parseAssessment(
    { skills: [{ code: 'SLMO', rating: 'met', cite: [1] }], readiness: { rating: 'ready', why: 'x' } },
    { skills, bySkill: { SLMO: [1], PEMT: [], QUAS: [] } },
  );
  assert.equal(r.readiness.rating, 'too-little-evidence');
});

test('evidence is selected per skill for the slot only', () => {
  const ev = [
    { id: 1, tags: [{ slot: 'current', code: 'SLMO' }] },
    { id: 2, tags: [{ slot: 'future', code: 'SLMO' }] },
  ];
  const { bySkill } = selectEvidence(ev, 'current', skills);
  assert.deepEqual(bySkill.SLMO, [1]);
});

test('a triage answer missing an item is refused whole; unknown codes and slots are dropped', () => {
  const codes = { current: new Set(['SLMO']), future: new Set(['ITMG']) };
  assert.throws(() => parseTriage({ items: [{ i: 0, tags: [] }] }, 2, codes), /covered 1 of 2/);
  const out = parseTriage({ items: [
    { i: 0, tags: [{ slot: 'current', code: 'SLMO', stance: 'for', why: 'ok' }, { slot: 'current', code: 'ITMG', stance: 'for' }] },
    { i: 1, tags: [{ slot: 'future', code: 'ITMG', stance: 'maybe' }] },
  ] }, 2, codes);
  assert.equal(out.get(0).length, 1);
  assert.equal(out.get(1).length, 0);
});

test('automated mail is noise; real work is not', () => {
  assert.equal(isNoise({ title: 'Replied: Accepted: Weekly sync' }), true);
  assert.equal(isNoise({ title: 'Automatic reply: away' }), true);
  assert.equal(isNoise({ title: 'Replied: QA framework draft for review' }), false);
});

test('a profile with an invented code drops it; strict save needs every attribute', () => {
  sfia._reset();
  process.env.SFIA_CATALOGUE_PATH = '/nonexistent.json';
  const p = validateProfile({ title: 'Head', skills: [{ code: 'slmo', level: 5 }, { code: 'BAD!', level: 5 }, { code: 'PEMT', level: 9 }] });
  assert.deepEqual(p.skills.map((s) => s.code), ['SLMO']);
  assert.equal(p.skills[0].check, 'not-checked', 'no catalogue means NOT CHECKED, never verified');
  assert.throws(() => validateProfile({ title: 'Head', skills: [{ code: 'SLMO', level: 5 }] }, { strict: true }), /attribute|Autonomy/);
});

test('NOVA: only Nick\'s own escalations, inside the window', () => {
  const rows = [
    { escalation_id: 1, ticket_key: 'NT-1', escalated_by: 'Nick Ward', created_at: '2026-10-05T10:00:00Z', reason_label: 'Urgent' },
    { escalation_id: 2, ticket_key: 'NT-2', escalated_by: 'Sebastian Broome', created_at: '2026-10-05T10:00:00Z' },
    { escalation_id: 3, ticket_key: 'NT-3', escalated_by: 'Nick Ward', created_at: '2026-09-01T10:00:00Z' },
  ];
  const out = nova.escalationItems(rows, '2026-10-01', '2026-10-07');
  assert.deepEqual(out.map((i) => i.id), ['esc:1']);
});

test('NOVA: a week whose Sunday is today or later is not emitted', () => {
  assert.deepEqual(nova.finishedSundays('2026-10-01', '2026-10-25', '2026-10-25'), ['2026-10-04', '2026-10-11', '2026-10-18']);
  assert.equal(nova.kpiWeekItem({ kpis: [{ label: 'X', value: null }] }, '2026-10-18'), null, 'no values is no item, not a zero week');
});

test('the export prints only Nick\'s summaries, never the raw item', () => {
  const md = render({
    role: { slot: 'current', profile: { title: 'Head', skills: [{ code: 'SLMO', name: 'Service level management', level: 5 }] } },
    assessment: null,
    items: [
      { inCase: true, caseSummary: 'Led the SLA recovery', occurredAt: '2026-10-01', title: 'RAW EMAIL SUBJECT about Customer X', tags: [{ slot: 'current', code: 'SLMO' }] },
      { inCase: false, caseSummary: null, occurredAt: '2026-10-02', title: 'SECRET', tags: [{ slot: 'current', code: 'SLMO' }] },
    ],
  });
  assert.match(md, /Led the SLA recovery/);
  assert.doesNotMatch(md, /RAW EMAIL|SECRET/);
  assert.match(md, /L5 \(Ensure, advise\)/);
});

test('a fenced JSON answer is read; anything else that is not JSON is still refused', () => {
  const { parseModelJson } = require('./perf-json');
  const fence = '`'.repeat(3);
  const NL = String.fromCharCode(10);
  assert.deepEqual(parseModelJson(`${fence}json${NL}{"a":1}${NL}${fence}`), { a: 1 });
  assert.deepEqual(parseModelJson(`${fence}${NL}{"a":1}${fence}`), { a: 1 });
  assert.deepEqual(parseModelJson(`${fence}json${NL}{"a":1}${NL}${fence}`.replace(/\n/g, String.fromCharCode(13, 10))), { a: 1 }, 'CRLF fence');
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('Here you go: {"a":1} — done'), { a: 1 }, 'prose around the object');
  assert.throws(() => parseModelJson('{"a":1'), 'a truncated object is still refused');
  assert.throws(() => parseModelJson('no json here'));
  const codes = { current: new Set(['SLMO']), future: new Set() };
  assert.equal(parseTriage(`${fence}json${NL}{"items":[{"i":0,"tags":[]}]}${NL}${fence}`, 1, codes).size, 1, 'triage reads a fenced answer');
});

test('NOVA: a 1-2-1 item carries the counts, never the session notes', () => {
  const [it] = nova.oneToOneItems([{ sessionId: 7, agentName: 'A Person', completedAt: '2026-10-05', notesText: 'PRIVATE medical detail', actions: [{}], reviewedActions: [{ status: 'delivered' }] }], '2026-10-01', '2026-10-07');
  assert.doesNotMatch(it.detail, /PRIVATE|medical/);
  assert.match(it.detail, /1 action\(s\) agreed/);
});

test('NOVA: a 1-2-1 with a display-string completedAt is dated by its scheduled date, not lost', () => {
  const items = nova.oneToOneItems([{ sessionId: 32, agentName: 'A Person', scheduledDate: '2026-03-10', completedAt: 'Tue Mar 10', actions: [], reviewedActions: [] }], '2026-03-01', '2026-03-31');
  assert.equal(items.length, 1, 'the live bridge shape must not be filtered out');
  assert.equal(items[0].at, '2026-03-10T12:00:00');
});
