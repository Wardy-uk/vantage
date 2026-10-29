'use strict';

/**
 * Routes for Performance Evidence (29 Oct 2026). Mounted from server.js behind
 * the PIN, with its own 12 MB body parser on /api/perf/roles/propose (a JD file
 * travels as base64 — registered BEFORE the global parser; order is the mechanism).
 */

const store = require('./perf-store');
const gather = require('./perf-gather');
const profile = require('./perf-profile');
const assess = require('./perf-assess');
const exporter = require('./perf-export');

const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };
const isDateKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v));

/** Tags must name a skill in that slot's ACTIVE profile. Refused, never repaired. */
function checkTags(tags, { required = false } = {}) {
  if (!Array.isArray(tags)) throw bad('tags must be a list');
  if (required && !tags.length) throw bad('Pick at least one skill this is evidence of');
  const out = [];
  for (const t of tags) {
    const slot = t?.slot;
    if (!store.SLOTS.includes(slot)) throw bad('Each tag needs slot current or future');
    const role = store.activeRole(slot);
    const code = String(t?.code || '').toUpperCase();
    if (!role || !role.profile.skills.some((s) => s.code === code)) throw bad(`${code} is not a skill in the ${slot} role`);
    const stance = t?.stance === 'against' ? 'against' : t?.stance === 'for' ? 'for' : null;
    if (!stance) throw bad('Each tag needs stance for or against');
    if (out.some((x) => x.slot === slot && x.code === code)) continue;
    out.push({ slot, code, stance, why: typeof t.why === 'string' ? t.why.trim().slice(0, 240) || null : null });
  }
  return out;
}

function overview() {
  return {
    roles: {
      current: store.activeRole('current'),
      future: store.activeRole('future'),
      history: { current: store.roleHistory('current'), future: store.roleHistory('future') },
    },
    gather: gather.status(),
    assessments: {
      current: store.latestAssessment('current'),
      future: store.latestAssessment('future'),
      history: { current: store.assessmentHistory('current'), future: store.assessmentHistory('future') },
    },
  };
}

function mount(app, wrap) {
  app.get('/api/perf', wrap(() => overview()));

  app.post('/api/perf/roles/propose', wrap((req) => profile.propose(req.body || {})));
  app.post('/api/perf/roles/save', wrap((req) => {
    const { slot, sourceName, sourceText } = req.body || {};
    if (!store.SLOTS.includes(slot)) throw bad('slot must be current or future');
    const p = profile.validateProfile(req.body?.profile, { strict: true });
    delete p.problems;
    return store.saveRole({ slot, title: p.title, sourceName, sourceText: typeof sourceText === 'string' ? sourceText.slice(0, 200_000) : null, profile: p });
  }));

  app.get('/api/perf/evidence', wrap((req) => {
    const state = req.query.state || undefined;
    if (state && !store.STATES.includes(state)) throw bad(`state must be one of ${store.STATES.join(', ')}`);
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw bad('limit must be 1-500');
    if (!Number.isInteger(offset) || offset < 0) throw bad('offset must be 0 or more');
    const stance = req.query.stance || undefined;
    if (stance && !['for', 'against', 'none'].includes(stance)) throw bad('stance must be for, against or none');
    return store.listEvidence({ state, stance, limit, offset });
  }));

  app.post('/api/perf/evidence', wrap((req) => {
    const b = req.body || {};
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) throw bad('Say what happened');
    if (!isDateKey(b.occurredAt)) throw bad('occurredAt must be a date (YYYY-MM-DD)');
    return store.addManual({
      title: title.slice(0, 400), detail: typeof b.detail === 'string' ? b.detail.trim().slice(0, 4000) : null,
      occurredAt: `${b.occurredAt}T12:00:00`, ref: typeof b.ref === 'string' ? b.ref.trim().slice(0, 500) : null,
      tags: checkTags(b.tags, { required: true }),
    });
  }));

  app.put('/api/perf/evidence/:id', wrap((req) => {
    const id = Number(req.params.id);
    const cur = store.getEvidence(id);
    if (!cur) throw bad('No such evidence item', 404);
    const b = req.body || {};
    const patch = {};
    if (b.tags !== undefined) patch.tags = checkTags(b.tags);
    if (cur.origin === 'manual') {
      if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) throw bad('Title cannot be blank'); patch.title = t.slice(0, 400); }
      if (b.detail !== undefined) patch.detail = b.detail ? String(b.detail).slice(0, 4000) : null;
      if (b.occurredAt !== undefined) { if (!isDateKey(b.occurredAt)) throw bad('occurredAt must be YYYY-MM-DD'); patch.occurredAt = `${b.occurredAt}T12:00:00`; }
      if (b.ref !== undefined) patch.ref = b.ref ? String(b.ref).slice(0, 500) : null;
    } else if (['title', 'detail', 'occurredAt', 'ref'].some((k) => b[k] !== undefined)) {
      throw bad('A gathered item\'s text is what the source recorded and cannot be edited — re-tag it, or reject it');
    }
    // Tagging something to nothing while it is accepted would leave it counting for no skill, silently.
    if (patch.tags && !patch.tags.length && cur.state === 'accepted') throw bad('An accepted item needs at least one skill — reject it instead');
    return store.update(id, patch);
  }));

  const DECIDE = { accept: 'accepted', reject: 'rejected', restore: 'proposed' };
  function decideOne(id, decision) {
    const cur = store.getEvidence(id);
    if (!cur) throw bad(`No evidence item ${id}`, 404);
    const to = DECIDE[decision];
    if (!to) throw bad('decision must be accept, reject or restore');
    if (decision === 'accept' && !cur.tags.length) throw bad(`Item ${id} has no skill to count towards — tag it first`);
    if (decision === 'accept' && !['proposed', 'not-relevant', 'rejected'].includes(cur.state)) throw bad(`Item ${id} is ${cur.state}`, 409);
    if (decision === 'restore' && !['rejected', 'not-relevant', 'accepted'].includes(cur.state)) throw bad(`Item ${id} is ${cur.state}`, 409);
    if (decision === 'reject' && cur.origin === 'manual') throw bad('Delete evidence you entered yourself instead of rejecting it', 409);
    return store.update(id, { state: to, ...(decision !== 'accept' ? { inCase: false } : {}) });
  }
  app.post('/api/perf/evidence/:id/decide', wrap((req) => decideOne(Number(req.params.id), (req.body || {}).decision)));
  // Only items whose EVERY tag is "for" — anything with evidence against needs Nick's eye.
  // Refused while a pass is running: the re-sort may still be changing the tags.
  app.post('/api/perf/evidence/accept-all-for', wrap(() => {
    if (gather.status().running) throw bad('The sorter is still running — wait until it finishes, then accept', 409);
    return { accepted: store.acceptAllFor() };
  }));
  app.post('/api/perf/evidence/decide-batch', wrap((req) => {
    const { ids, decision } = req.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw bad('ids must be a list of 1-200');
    const done = []; const refused = [];
    for (const id of ids) {
      try { done.push(decideOne(Number(id), decision).id); } catch (e) { refused.push({ id, error: e.message }); }
    }
    return { done, refused };
  }));

  app.post('/api/perf/evidence/:id/case', wrap((req) => {
    const id = Number(req.params.id);
    const cur = store.getEvidence(id);
    if (!cur) throw bad('No such evidence item', 404);
    const { inCase, summary } = req.body || {};
    if (inCase) {
      if (cur.state !== 'accepted') throw bad('Only accepted evidence can go in the case', 409);
      const s = typeof summary === 'string' ? summary.trim() : '';
      if (!s) throw bad('Write the summary that will appear in the case — the raw item is never exported');
      return store.update(id, { inCase: true, caseSummary: s.slice(0, 600) });
    }
    return store.update(id, { inCase: false });
  }));

  app.delete('/api/perf/evidence/:id', wrap((req) => store.deleteManual(Number(req.params.id))));

  app.post('/api/perf/gather/run', wrap(() => gather.run('manual')));
  app.put('/api/perf/caps', wrap((req) => gather.setCaps(req.body || {})));
  app.post('/api/perf/backfill-override', wrap((req) => {
    const on = (req.body || {}).on;
    if (typeof on !== 'boolean') throw bad('on must be true or false');
    return gather.setBackfillOverride(on);
  }));

  app.post('/api/perf/assess/:slot', wrap((req) => assess.assess(req.params.slot)));
  app.get('/api/perf/export/:slot', wrap((req) => {
    if (!store.SLOTS.includes(req.params.slot)) throw bad('slot must be current or future');
    return exporter.exportSlot(req.params.slot);
  }));
}

module.exports = { mount, checkTags };
