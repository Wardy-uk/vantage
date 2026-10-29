'use strict';

/**
 * The per-skill reassessment (29 Oct 2026, Nick: "read the lot"), on a real temp
 * SQLite file with the model stubbed at the OpenRouter client:
 *  - EVERY accepted item for a skill reaches that skill's call — no per-skill cap;
 *  - the bar, in-role and targets travel to the model, targets marked context;
 *  - a skill whose call fails is said to have failed, never read as rated;
 *  - the plan is written from the per-skill answers, only for gaps.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-run-'));
require('../db').init(path.join(dir, 'v.db'));

const calls = [];
require.cache[require.resolve('./openrouter')] = {
  exports: {
    isConfigured: () => true,
    complete: async (messages) => {
      const user = messages[1].content;
      calls.push(user);
      if (/^ROLE: .*\nATTRIBUTE TARGETS/.test(user)) {
        return { model: 'stub', text: JSON.stringify({ attributes: {}, readiness: { rating: 'nearly', why: 'w' }, summary: 's', plan: [] }) };
      }
      if (/SKILL: QUAS/.test(user)) throw new Error('boom');
      const ids = [...user.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
      const met = /SKILL: SLMO/.test(user);
      return { model: 'stub', text: JSON.stringify({ rating: met ? 'met' : 'partly', observedLevel: 5, why: 'reason', cite: [ids[0]], plan: met ? [] : [{ action: 'Publish the monthly service review to SMT', proves: 'the review', priority: 1 }] }) };
    },
  },
};

const store = require('./perf-store');
const assess = require('./perf-assess');

test('every accepted item reaches its skill; a failed skill says so; plan only for gaps', async () => {
  store.saveRole({
    slot: 'future', title: 'Head of Technical Support',
    profile: {
      title: 'Head of Technical Support',
      attributes: { autonomy: { level: 5 }, influence: { level: 5 }, complexity: { level: 5 }, knowledge: { level: 5 }, business_skills: { level: 5 } },
      skills: [
        { code: 'SLMO', name: 'Service level management', level: 5, bar: 'Ensures service delivery meets agreed service levels.', inRole: 'Owns the SLA framework.', targets: 'SLA >=95%' },
        { code: 'PEMT', name: 'Performance management', level: 5, why: 'Manages the teams' },
        { code: 'QUAS', name: 'Quality assurance', level: 5, why: 'QA framework' },
      ],
    },
  });
  const d = require('../db').get();
  const ins = d.prepare(`INSERT INTO perf_evidence (source_key, origin, kind, occurred_at, title, state, tags_json, created_at)
    VALUES (?, 'neuro', 'k', ?, ?, 'accepted', ?, ?)`);
  for (let i = 0; i < 60; i += 1) {
    ins.run(`k${i}`, `2026-0${1 + (i % 9)}-10`, `item ${i}`, JSON.stringify([
      { slot: 'future', code: 'SLMO', stance: 'for' },
      ...(i < 5 ? [{ slot: 'future', code: 'PEMT', stance: 'for' }, { slot: 'future', code: 'QUAS', stance: 'for' }] : []),
    ]), new Date().toISOString());
  }

  assert.equal(assess.assess('future').started, true);
  for (let i = 0; i < 100 && assess.runState('future')?.running; i += 1) await new Promise((r) => setTimeout(r, 20));
  const st = assess.runState('future');
  assert.equal(st.running, false);
  assert.match(st.error, /QUAS/);

  const slmoCall = calls.find((c) => /SKILL: SLMO/.test(c));
  assert.equal([...slmoCall.matchAll(/^#\d+ /gm)].length, 60, 'all 60 items read, not 15');
  assert.match(slmoCall, /THE BAR \(SFIA L5\): Ensures service delivery/);
  assert.match(slmoCall, /OUTCOME TARGETS \(context only\): SLA >=95%/);

  const a = store.latestAssessment('future');
  const by = Object.fromEntries(a.skills.map((s) => [s.code, s]));
  assert.equal(by.SLMO.rating, 'met');
  assert.equal(by.PEMT.rating, 'partly');
  assert.equal(by.QUAS.rating, 'unrated');
  assert.match(by.QUAS.why, /call for this skill failed/);
  assert.equal(a.evidenceRead, 60);

  const plan = store.planFor('future');
  assert.ok(plan.some((p) => p.code === 'PEMT'));
  assert.ok(!plan.some((p) => p.code === 'SLMO'), 'no homework for a met skill');

  assert.throws(() => { store.setState('assess_run_future', { running: true, startedAt: new Date().toISOString() }); assess.assess('future'); }, /already running/);
});
