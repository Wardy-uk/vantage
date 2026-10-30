'use strict';

/**
 * The written case (30 Oct 2026), on a real temp SQLite file: the colleague-name
 * guard, the model's picks held to that skill's accepted evidence, confirmation
 * refused while a line names someone, and the export carrying confirmed skills
 * only — as text and as a Word file that opens.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-case-'));
require('../db').init(path.join(dir, 'v.db'));
const store = require('./perf-store');
const pc = require('./perf-case');

const ROSTER = ['Hope Goodall', 'Nathan Button', 'Nathan Rutland', 'Nick Ward', 'Adele Smith'];

test('the name guard: full names, unique first names, never Nick, never a lower-case word', () => {
  const g = pc.guardNames(ROSTER);
  assert.ok(g.full.includes('Hope Goodall'));
  assert.ok(!g.full.includes('Nick Ward'));
  assert.ok(g.first.includes('Hope') && g.first.includes('Adele'));
  assert.ok(!g.first.includes('Nathan'), 'a shared first name is checked by full name only');
  assert.deepEqual(pc.nameHits('Coached Hope through her first escalation', g), ['Hope']);
  assert.deepEqual(pc.nameHits('Worked with Nathan Rutland on the rota', g), ['Nathan Rutland']);
  assert.deepEqual(pc.nameHits('I hope this shows ownership; Nathan helped', g), [], 'lower-case hope and an ambiguous Nathan are not hits');
  assert.deepEqual(pc.nameHits('Coached a direct report', g), []);
});

test('the model may only pick accepted items for that skill, at most five, each with a line', () => {
  const raw = JSON.stringify({
    argument: 'I set the standard.', position: 'Not shown at L5 yet.',
    picks: [{ id: 1, line: 'Did a thing.' }, { id: 99, line: 'Invented.' }, { id: 1, line: 'Again.' }, { id: 2, line: '' },
      { id: 3, line: 'c' }, { id: 4, line: 'd' }, { id: 5, line: 'e' }, { id: 6, line: 'f' }, { id: 7, line: 'g' }],
  });
  const d = pc.parseSkillDraft(raw, { candidateIds: [1, 2, 3, 4, 5, 6, 7], rating: 'met' });
  assert.deepEqual(d.items.map((i) => i.id), [1, 3, 4, 5, 6]);
  assert.equal(d.position, null, 'a Met skill has no gap position');
  assert.ok(d.items.every((i) => i.included));
});

test('evidence numbers are taken out of drafted text', () => {
  assert.equal(pc.stripRefs('I built processes to identify recurring issues (#366, #347, #111), and RCAs (#1186).'), 'I built processes to identify recurring issues, and RCAs.');
  assert.equal(pc.stripRefs('Investigated NT-34994 #31 thoroughly'), 'Investigated NT-34994 thoroughly');
  const d = pc.parseSkillDraft(JSON.stringify({ argument: 'Shown (#1).', picks: [{ id: 1, line: 'Did it #1.' }] }), { candidateIds: [1], rating: 'met' });
  assert.equal(d.argument, 'Shown.');
  assert.equal(d.items[0].line, 'Did it.');
});

test('a drafted pick about a personal matter is dropped, not pre-ticked', () => {
  const raw = JSON.stringify({ argument: 'A', picks: [
    { id: 1, line: 'I committed to follow up with a direct report to finalize a welfare plan.' },
    { id: 2, line: 'I confirmed a team member's potential departure timing to inform capacity planning.' },
    { id: 3, line: 'I set up a monthly RCA process for the top five recurring failures.' },
  ] });
  assert.deepEqual(pc.parseSkillDraft(raw, { candidateIds: [1, 2, 3], rating: 'met' }).items.map((i) => i.id), [3]);
  assert.equal(pc.personalHit('Ran the health check on the integration'), 'health', 'a flag, not a block — Nick judges it');
  assert.equal(pc.personalHit('Led the Acme outage review'), null);
});

test('edits are refused not repaired; confirming checks names, lines and the argument', () => {
  const names = pc.guardNames(ROSTER);
  assert.throws(() => pc.applySkillEdit(null, { items: [{ id: 50, line: 'x', included: true }] }, { candidateIds: [1], names, gap: false }), /not accepted evidence/);
  assert.throws(() => pc.applySkillEdit(null, { items: [{ id: 1, line: 'Coached Hope', included: true }], argument: 'A', reviewed: true }, { candidateIds: [1], names, gap: false }), /Names a colleague \(Hope\)/);
  assert.throws(() => pc.applySkillEdit(null, { items: [{ id: 1, line: '', included: true }], argument: 'A', reviewed: true }, { candidateIds: [1], names, gap: false }), /needs its line/);
  assert.throws(() => pc.applySkillEdit(null, { items: [], reviewed: true }, { candidateIds: [], names, gap: false }), /argument/);
  assert.throws(() => pc.applySkillEdit(null, { items: [], reviewed: true }, { candidateIds: [], names, gap: true }), /where you stand/i);
  assert.throws(() => pc.applySkillEdit(null, { argument: 'A', reviewed: true }, { candidateIds: [], names: null, gap: false }), /no roster/);
  // An unticked line naming someone does not block: it is not going in the case.
  const ok = pc.applySkillEdit(null, { argument: 'A', items: [{ id: 1, line: 'Coached Hope', included: false }], reviewed: true }, { candidateIds: [1], names, gap: false });
  assert.equal(ok.reviewed, true);
  // Any later change unconfirms.
  const changed = pc.applySkillEdit(ok, { argument: 'B' }, { candidateIds: [1], names, gap: false });
  assert.equal(changed.reviewed, false);
});

test('end to end on the store: only confirmed skills are exported, and the Word file is a real docx', async () => {
  store.saveRole({ slot: 'future', title: 'Head of Technical Support', sourceName: 'jd', sourceText: 'x', profile: {
    title: 'Head of Technical Support', summary: 's', attributes: {},
    skills: [{ code: 'USUP', name: 'Incident management', level: 5 }, { code: 'KNOW', name: 'Knowledge management', level: 5 }],
  } });
  const ids = [
    store.addManual({ title: 'Ran the Acme outage review', detail: 'd', occurredAt: '2026-09-01', ref: null, tags: [{ slot: 'future', code: 'USUP', stance: 'for', why: null }] }),
    store.addManual({ title: 'Wrote the KB health report', detail: 'd', occurredAt: '2026-09-10', ref: null, tags: [{ slot: 'future', code: 'KNOW', stance: 'for', why: null }] }),
  ].map((x) => x.id);
  for (const id of ids) store.update(id, { state: 'accepted' });
  store.saveAssessment('future', store.activeRole('future').id, {
    skills: [{ code: 'USUP', name: 'Incident management', target: 5, rating: 'met', observedLevel: 5, why: 'Strong.', cite: [ids[0]] },
      { code: 'KNOW', name: 'Knowledge management', target: 5, rating: 'partly', observedLevel: 4, why: 'Some.', cite: [ids[1]] }],
    readiness: { rating: 'nearly', why: 'w' }, summary: 's', counts: { met: 1, partly: 1 },
  });
  store.setState('case_roster_names', { names: pc.guardNames(ROSTER), at: '2026-10-30T00:00:00Z' });

  assert.throws(() => pc.exportCase('future'), /Confirm at least one skill/);
  const usup = await pc.editSkill('future', 'USUP', { argument: 'I lead major incidents end to end.', items: [{ id: ids[0], line: 'Led the Acme outage review and its fixes.', included: true }], reviewed: true });
  assert.equal(usup.reviewed, true);
  await pc.editSkill('future', 'KNOW', { position: 'Not yet at L5.', items: [{ id: ids[1], line: 'Published the KB health report.', included: true }] });

  const { blocks, left } = pc.exportCase('future');
  const md = pc.toMarkdown(blocks);
  assert.match(md, /Led the Acme outage review/);
  assert.doesNotMatch(md, /KB health report/, 'an unconfirmed skill is left out');
  assert.deepEqual(left.map((x) => x.code), ['KNOW']);
  assert.doesNotMatch(md, /Ran the Acme outage review/, 'the raw item title is never exported');

  const buf = await pc.toDocx(blocks);
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const zip = await require('jszip').loadAsync(buf);
  const doc = await zip.file('word/document.xml').async('string');
  assert.match(doc, /Led the Acme outage review/);
  assert.match(doc, /w:pStyle w:val="Heading1"/);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/styles.xml', 'word/numbering.xml']) assert.ok(zip.file(part), part);

  // A name slipped into a confirmed skill by editing the store directly still refuses the export.
  const st = store.getState('case_future');
  st.skills.USUP.argument = 'With Adele I led incidents.';
  store.setState('case_future', st);
  assert.throws(() => pc.exportCase('future'), /names a colleague \(Adele\)/);
});
