'use strict';

/**
 * The written case (30 Oct 2026), on a real temp SQLite file: the model's picks
 * held to that skill's accepted evidence, and the export carrying confirmed
 * skills only — as text and as a Word file that opens. No name or personal
 * guard (removed 31 Oct 2026).
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

test('a pick that mentions a colleague or a personal matter is kept — no guard', () => {
  const raw = JSON.stringify({ argument: 'A', picks: [
    { id: 1, line: 'Coached Hope Goodall through a welfare plan.' },
    { id: 2, line: 'I set up a monthly RCA process.' },
  ] });
  assert.deepEqual(pc.parseSkillDraft(raw, { candidateIds: [1, 2], rating: 'met' }).items.map((i) => i.id), [1, 2]);
});

test('edits are refused not repaired; confirming checks lines and the argument', () => {
  assert.throws(() => pc.applySkillEdit(null, { items: [{ id: 50, line: 'x', included: true }] }, { candidateIds: [1], gap: false }), /not accepted evidence/);
  assert.equal(pc.applySkillEdit(null, { items: [{ id: 1, line: 'Coached Hope', included: true }], argument: 'A', reviewed: true }, { candidateIds: [1], gap: false }).reviewed, true, 'a named colleague does not block');
  assert.throws(() => pc.applySkillEdit(null, { items: [{ id: 1, line: '', included: true }], argument: 'A', reviewed: true }, { candidateIds: [1], gap: false }), /needs its line/);
  assert.throws(() => pc.applySkillEdit(null, { items: [], reviewed: true }, { candidateIds: [], gap: false }), /argument/);
  assert.throws(() => pc.applySkillEdit(null, { items: [], reviewed: true }, { candidateIds: [], gap: true }), /where you stand/i);
  const ok = pc.applySkillEdit(null, { argument: 'A', items: [{ id: 1, line: 'Coached Hope', included: false }], reviewed: true }, { candidateIds: [1], gap: false });
  assert.equal(ok.reviewed, true);
  // Any later change unconfirms.
  const changed = pc.applySkillEdit(ok, { argument: 'B' }, { candidateIds: [1], gap: false });
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

  assert.throws(() => pc.exportCase('future'), /Confirm at least one skill/);
  const usup = await pc.editSkill('future', 'USUP', { argument: 'I lead major incidents end to end.', items: [{ id: ids[0], line: 'Led the Acme outage review and its fixes.', included: true }], reviewed: true });
  assert.equal(usup.reviewed, true);
  await pc.editSkill('future', 'KNOW', { position: 'Not yet at L5.', items: [{ id: ids[1], line: 'Published the KB health report.', included: true }] });

  const { blocks, left } = pc.exportCase('future');
  const md = pc.toMarkdown(blocks);
  assert.match(md, /Led the Acme outage review/);
  assert.doesNotMatch(md, /KB health report/, 'an unconfirmed skill is left out');
  assert.deepEqual(left.map((x) => x.code), ['KNOW']);
  assert.doesNotMatch(md, /Ran the Acme outage review/, 'the case prints its own lines, not item titles');

  const buf = await pc.toDocx(blocks);
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const zip = await require('jszip').loadAsync(buf);
  const doc = await zip.file('word/document.xml').async('string');
  assert.match(doc, /Led the Acme outage review/);
  assert.match(doc, /w:pStyle w:val="Heading1"/);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/styles.xml', 'word/numbering.xml']) assert.ok(zip.file(part), part);

  // A colleague's name in a confirmed skill exports as written.
  const st = store.getState('case_future');
  st.skills.USUP.argument = 'With Adele I led incidents.';
  store.setState('case_future', st);
  assert.match(pc.toMarkdown(pc.exportCase('future').blocks), /With Adele I led incidents/);
});
