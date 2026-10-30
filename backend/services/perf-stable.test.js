'use strict';

/**
 * Stable ratings, the plan leaning to the future role, and the annex reader
 * (30 Oct 2026), on a real temp SQLite file with the model stubbed:
 *  - a skill both roles hold at the same level and bar gets ONE rating, read
 *    from evidence tagged to that code in either role;
 *  - Reassess keeps a rating whose evidence has not changed (no model call),
 *    and re-reads when an item is added; `fresh` re-reads everything;
 *  - a fresh rating is the majority of three readings, and a three-way split
 *    reads as partly, marked split;
 *  - the current role's plan offers three actions, shared skills first, and
 *    holds the rest back rather than deleting them;
 *  - the annex table is read exactly; a bad row is reported, never repaired.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-stable-'));
require('../db').init(path.join(dir, 'v.db'));

const calls = [];
let script = () => 'met';
require.cache[require.resolve('./openrouter')] = {
  exports: {
    isConfigured: () => true,
    complete: async (messages, opts) => {
      const user = messages[1].content;
      if (/^ROLE: .*\nATTRIBUTE TARGETS/.test(user)) {
        return { model: 'stub', text: JSON.stringify({ attributes: {}, readiness: { rating: 'nearly', why: 'w' }, summary: 's', plan: [] }) };
      }
      const code = user.match(/SKILL: (\w{4})/)[1];
      calls.push({ code, role: user.match(/^ROLE: (.*)$/m)[1], temperature: opts.temperature });
      const ids = [...user.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
      const rating = script(code, calls.filter((c) => c.code === code).length);
      return { model: 'stub', text: JSON.stringify({ rating, observedLevel: 5, why: `reason ${ids.length}`, cite: [ids[0]], plan: rating === 'met' ? [] : [{ action: `Close the ${code} gap with a monthly review`, proves: 'p', priority: 1 }] }) };
    },
  },
};

const store = require('./perf-store');
const assess = require('./perf-assess');
const annex = require('./perf-annex');

const attrs = { autonomy: { level: 5 }, influence: { level: 5 }, complexity: { level: 5 }, knowledge: { level: 5 }, business_skills: { level: 5 } };
const BAR = 'Ensures service delivery meets agreed service levels.';

async function waitFor(slot) {
  for (let i = 0; i < 200 && assess.runState(slot)?.running; i += 1) await new Promise((r) => setTimeout(r, 10));
  return store.latestAssessment(slot);
}

test('one rating per skill across roles; kept until evidence changes; majority of three', async () => {
  for (const slot of ['current', 'future']) {
    store.saveRole({ slot, title: slot, profile: { title: slot === 'future' ? 'Head of Technical Support' : 'Head of Service Delivery', attributes: attrs,
      skills: [{ code: 'SLMO', name: 'Service level management', level: 5, bar: BAR, inRole: `${slot} wording` }] } });
  }
  const d = require('../db').get();
  const ins = d.prepare(`INSERT INTO perf_evidence (source_key, origin, kind, occurred_at, title, state, tags_json, created_at)
    VALUES (?, 'neuro', 'k', '2026-10-01', ?, 'accepted', ?, ?)`);
  // Item 1 tagged only for the current role, item 2 only for the future role.
  ins.run('a', 'SLA review with Chris', JSON.stringify([{ slot: 'current', code: 'SLMO', stance: 'for' }]), new Date().toISOString());
  ins.run('b', 'Negotiated new SLA tiers', JSON.stringify([{ slot: 'future', code: 'SLMO', stance: 'for' }]), new Date().toISOString());

  script = (code, n) => (n === 2 ? 'partly' : 'met'); // readings: met, partly, met
  assess.assess('future');
  const f = await waitFor('future');
  assert.equal(calls.length, 3, 'three readings for a fresh rating');
  assert.equal(calls[0].temperature, 0);
  const s = f.skills[0];
  assert.equal(s.rating, 'met');
  assert.deepEqual(s.votes, ['met', 'partly', 'met']);
  assert.equal(s.split, false);
  assert.equal(f.evidenceRead, 2, 'evidence tagged in either role is read');

  assess.assess('current');
  const c = await waitFor('current');
  assert.equal(calls.length, 3, 'same code, level, bar and evidence: no new call');
  assert.equal(c.skills[0].rating, 'met', 'both roles carry the same rating');
  assert.ok(c.skills[0].keptFrom, 'and say it was kept');

  ins.run('c', 'Missed SLA review', JSON.stringify([{ slot: 'future', code: 'SLMO', stance: 'against' }]), new Date().toISOString());
  script = (code, n) => ['met', 'partly', 'not-yet'][(n - 1) % 3];
  calls.length = 0;
  assess.assess('future');
  const g = await waitFor('future');
  assert.equal(calls.length, 3, 'new evidence: re-read');
  assert.equal(g.skills[0].rating, 'partly', 'no majority reads as partly');
  assert.equal(g.skills[0].split, true);

  calls.length = 0;
  script = () => 'met';
  assess.assess('future', { fresh: true });
  await waitFor('future');
  assert.equal(calls.length, 3, 'fresh ignores kept ratings');
});

test('the current plan offers three, shared skills first, and holds the rest back', () => {
  const items = [
    { id: 1, code: 'AVMT', priority: 1, state: 'open' },
    { id: 2, code: 'ORDI', priority: 1, state: 'open' },
    { id: 3, code: 'SLMO', priority: 2, state: 'open' },
    { id: 4, code: 'USUP', priority: 3, state: 'open' },
    { id: 5, code: 'MEAS', priority: 1, state: 'pushed' },
  ];
  const w = assess.weighPlan(items, { slot: 'current', futureCodes: ['SLMO', 'USUP', 'MEAS'] });
  const by = Object.fromEntries(w.map((i) => [i.id, i]));
  assert.equal(by[3].heldBack, false, 'shared skill offered despite lower priority');
  assert.equal(by[4].heldBack, false);
  assert.equal(by[1].heldBack, false);
  assert.equal(by[2].heldBack, true, 'fourth open action held back');
  assert.equal(by[5].heldBack, false, 'a pushed action is never held back');
  assert.equal(by[3].alsoFuture, true);
  assert.ok(assess.weighPlan(items, { slot: 'future', futureCodes: [] }).every((i) => !i.heldBack), 'the future plan is whole');
});

test('the annex table is read exactly; bad rows are reported', () => {
  const t = annex.tablesFromText([
    '| Code | Skill | Level | Basis in the job description |',
    '|---|---|---|---|',
    '| CSMG | Customer service support | 5 | Leads support standards. |',
    '| SLMO | Service level management | 4 | Proposes commitments. |',
    '| slmox | Nonsense | 5 | x |',
    '| WFPL | Workforce planning | four | x |',
    '',
    '| Attribute | Level | Reasoning |',
    '|---|---|---|',
    '| Autonomy | 5 | Broad direction |',
    '| Influence | 5 | Shapes decisions |',
  ].join('\n'));
  const r = annex.readTables(t);
  assert.deepEqual(r.skills.map((s) => [s.code, s.level]), [['CSMG', 5], ['SLMO', 4]]);
  assert.equal(r.skills[1].inRole, 'Proposes commitments.');
  assert.equal(r.attributes.autonomy.level, 5);
  assert.ok(r.problems.some((p) => /"slmox" is not a SFIA code/.test(p)));
  assert.ok(r.problems.some((p) => /WFPL has no level/.test(p)));
  assert.ok(r.problems.some((p) => /Complexity: no level/.test(p)), 'a missing attribute is named');

  const html = '<table><tr><td>Code</td><td>Skill</td><td>Level</td><td>Basis</td></tr><tr><td><p>USUP</p></td><td>Incident management</td><td>5</td><td>Operates Support&#39;s incident response.</td></tr></table>';
  const h = annex.readTables(annex.tablesFromHtml(html));
  assert.equal(h.skills[0].code, 'USUP');
  assert.equal(h.skills[0].inRole, "Operates Support's incident response.");
});

test('cited evidence is read back by id, in the order asked, missing ids left out', () => {
  const d = require('../db').get();
  const ids = d.prepare('SELECT id FROM perf_evidence ORDER BY id').all().map((r) => r.id);
  const got = store.getMany([ids[1], 999999, ids[0]]);
  assert.deepEqual(got.map((e) => e.id), [ids[1], ids[0]]);
  assert.equal(got[0].title, 'Negotiated new SLA tiers');
  assert.deepEqual(store.getMany([]), []);
});

test('a re-sort never takes back an acceptance', () => {
  const d = require('../db').get();
  d.prepare(`INSERT INTO perf_evidence (source_key, origin, kind, occurred_at, title, state, tags_json, created_at, decided_at)
    VALUES ('acc', 'neuro', 'task-overdue', '2026-10-29', 'Begin identifying unnecessary escalations', 'accepted', '[]', ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
  const id = d.prepare("SELECT id FROM perf_evidence WHERE source_key = 'acc'").get().id;
  store.setRetriage(id, { tags: [], rolesKey: 'k1' });
  assert.equal(store.getEvidence(id).state, 'accepted', 'no skill found: still accepted');
  store.setRetriage(id, { tags: [{ slot: 'future', code: 'USUP', stance: 'for', why: 'w' }], rolesKey: 'k2' });
  assert.equal(store.getEvidence(id).state, 'accepted');
  assert.equal(store.getEvidence(id).tags[0].code, 'USUP');
});
