'use strict';

/**
 * "Build my case" — a written promotion case for Chris (30 Oct 2026).
 *
 * Nick's design, asked one question at a time:
 *  - A WRITTEN case, skill by skill: a short argument per SFIA skill drawn from
 *    the latest assessment, the strongest evidence as one-line summaries, then
 *    readiness and gaps. Exported as Word and as text for Confluence.
 *  - Written for Chris (line manager). Customers may be named; colleagues are
 *    NEVER named — role only ("a direct report"). Enforced here, not just asked
 *    for: every line is checked against NEURO's team roster, and a line naming
 *    someone cannot be confirmed or exported.
 *  - VANTAGE proposes, Nick prunes: per skill it pre-ticks the 3–5 strongest
 *    items the assessment cited and drafts their wording. Nick unticks, edits,
 *    adds more, and presses "Happy with this skill". Nothing reaches the export
 *    until he has — unconfirmed skills are left out, and the page says which.
 *  - Gaps are owned with the plan: Partly / Not yet / No evidence get an honest
 *    position, whatever evidence there is, and the Plan tab's actions.
 *
 * The case lives in perf_state (`case_<slot>`). Ids the model picks must be
 * accepted items tagged to that skill; anything else is dropped, never kept.
 * Nothing here is sent anywhere: the export is a file Nick downloads.
 */

const store = require('./perf-store');
const sfia = require('./sfia');

const KEY = (slot) => `case_${slot}`;
const RUN_KEY = (slot) => `case_run_${slot}`;
const NAMES_KEY = 'case_roster_names';
const STALE_MS = 30 * 60_000;
const CONCURRENCY = 3;
const MAX_PICKS = 5;
const PROMPT_ITEMS = 25;
const LINE_MAX = 320;
const TEXT_MAX = 1500;
const RATING_WORDS = { met: 'Met', partly: 'Partly', 'not-yet': 'Not yet', 'no-evidence': 'No evidence yet', unrated: 'Not rated' };
const READY_WORDS = { ready: 'Ready', nearly: 'Nearly', 'not-yet': 'Not yet', 'too-little-evidence': 'Too little evidence to say' };
const RATED = ['met', 'partly', 'not-yet'];
const GAP = ['partly', 'not-yet', 'no-evidence', 'unrated'];

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const tidy = (s, n) => String(s || '').replace(/\r/g, '').trim().slice(0, n);
const bad = (msg, status = 400) => { const e = new Error(msg); e.status = status; return e; };

// ── colleague-name guard ─────────────────────────────────────────────────────

/**
 * Names that must not appear: each roster full name, and each first name that
 * belongs to one person only (a shared first name is checked by full name).
 * Nick's own name never counts. Pure.
 */
function guardNames(people) {
  const full = [...new Set((people || []).map((p) => String(p || '').trim()).filter((p) => p.includes(' ')))]
    .filter((p) => !/^nick ward$/i.test(p));
  const firstCount = new Map();
  for (const f of full) { const k = f.split(/\s+/)[0]; firstCount.set(k, (firstCount.get(k) || 0) + 1); }
  const first = [...firstCount].filter(([k, n]) => n === 1 && k.length >= 3 && k !== 'Nick').map(([k]) => k);
  return { full, first };
}

/** Which roster names a text contains. Case-sensitive whole words (a capital "Will" is a name, "will" is not). Pure. */
function nameHits(text, names) {
  const t = String(text || '');
  if (!t || !names) return [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = new Set();
  for (const f of names.full || []) if (new RegExp(`\\b${esc(f).replace(/\s+/g, '\\s+')}\\b`).test(t)) hits.add(f);
  for (const f of names.first || []) {
    if ([...hits].some((h) => h.startsWith(`${f} `))) continue;
    if (new RegExp(`\\b${esc(f)}\\b`).test(t)) hits.add(f);
  }
  return [...hits];
}

/** The roster from NEURO, cached; a failed read falls back to the last good list and says so. */
async function loadNames() {
  const cached = store.getState(NAMES_KEY, null);
  try {
    const neuro = require('./neuro');
    if (!neuro.isConfigured()) throw new Error('NEURO is not configured');
    const roster = await neuro.call('/api/team-health/roster');
    const people = (roster.people || roster.data?.people || []).map((p) => p.name).filter(Boolean);
    if (!people.length) throw new Error('NEURO returned an empty roster');
    const v = { names: guardNames(people), at: new Date().toISOString() };
    store.setState(NAMES_KEY, v);
    return { names: v.names, fresh: true, at: v.at };
  } catch (e) {
    if (cached) return { names: cached.names, fresh: false, at: cached.at, error: e.message };
    return { names: null, fresh: false, at: null, error: e.message };
  }
}

const cachedNames = () => store.getState(NAMES_KEY, null)?.names || null;

// ── the model's draft ────────────────────────────────────────────────────────

const SKILL_PROMPT = `You are helping Nick Ward write a promotion case for his line manager, Chris. You get one SFIA skill, VANTAGE's assessment of it, and Nick's accepted evidence for it.

Return JSON only:
{"argument": "...", "position": "...", "picks": [{"id": 123, "line": "..."}]}

- argument: 2–4 sentences in Nick's voice (first person), saying what the evidence shows about this skill at the target level. Direct, factual, no superlatives. Only claims the evidence supports.
- position: one honest sentence on what is NOT yet shown at the target level ("" if the rating is Met).
- picks: the 3–5 STRONGEST items for this skill (fewer if fewer are good), best first. Prefer items the assessment cited. Each line is one sentence (under 35 words), past tense, what Nick did and the outcome, readable by someone who has never seen the item.

Rules, all of them hard:
- NEVER name a colleague. Use their role instead: "a direct report", "a team lead", "my line manager", "a developer", "a colleague in Product". Customer and company names are fine.
- Never invent numbers, dates, outcomes or facts not in the item. If an item is vague, say less.
- Never quote an email or a meeting.
- Never put anything personal about an individual in the case — health, welfare, family, pay, someone leaving, someone's performance problems or a disciplinary matter — even unnamed. Pick a different item.
- Prefer work that was DONE over something promised or planned ("I committed to…" is not evidence).
- Never write evidence numbers (#123) in the argument, position or lines — the reader has never seen them.
- ids must be ids from the evidence given.`;

const OPENING_PROMPT = `You are helping Nick Ward write the opening of a promotion case for his line manager, Chris. You get the role, VANTAGE's readiness verdict and each skill's rating.

Return JSON only: {"opening": "..."}

The opening is 3–5 sentences in Nick's voice: where he stands against the role, the strongest areas, and the gaps he is working on. Honest — if the verdict is Not yet or Nearly, say so plainly. NEVER name a colleague (role only). No invented facts.`;

/** Validate one skill's draft against the items it may cite. Pure. */
/** Evidence numbers mean nothing to Chris: "(#366, #347)" and a bare "#31" are taken out. Pure. */
function stripRefs(t) {
  if (!t) return t;
  return t.replace(/\s*\((?:\s*#\d+\s*,?)+\)/g, '').replace(/\s*#\d+\b/g, '').replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

function parseSkillDraft(raw, { candidateIds, rating }) {
  let j;
  try { j = require('./perf-json').parseModelJson(raw); } catch { throw new Error('the model\'s answer was not readable JSON'); }
  const valid = new Set(candidateIds);
  const seen = new Set();
  const items = [];
  for (const p of Array.isArray(j?.picks) ? j.picks : []) {
    const id = Number(p?.id);
    const line = stripRefs(tidy(p?.line, LINE_MAX).replace(/\s+/g, ' '));
    if (!valid.has(id) || seen.has(id) || !line) continue;
    seen.add(id);
    items.push({ id, line, included: true });
    if (items.length >= MAX_PICKS) break;
  }
  return {
    argument: stripRefs(tidy(j?.argument, TEXT_MAX)) || null,
    position: rating === 'met' ? null : (stripRefs(tidy(j?.position, TEXT_MAX)) || null),
    items,
  };
}

/** Accepted items for a skill (either role — the assessment reads by code), cited first, counter-evidence last. Pure. */
function candidatesFor(evidence, code, cite = []) {
  const citeSet = new Set(cite);
  const mine = evidence.filter((e) => e.tags.some((t) => t.code === code));
  const stance = (e) => (e.tags.some((t) => t.code === code && t.stance === 'for') ? 0 : 1);
  return mine.slice().sort((a, b) => (citeSet.has(b.id) - citeSet.has(a.id)) || (stance(a) - stance(b)));
}

function evLine(e, code) {
  const st = [...new Set(e.tags.filter((t) => t.code === code).map((t) => t.stance))].join('/');
  return `#${e.id} [${String(e.occurredAt || '').slice(0, 10)}] (${st}) ${clip(e.title, 200)}${e.detail ? ` — ${clip(e.detail, 400)}` : ''}`;
}

// ── storage and the view ─────────────────────────────────────────────────────

function emptyDoc(role, assessment) {
  return { roleId: role.id, assessmentId: assessment?.id || null, opening: null, openingEdited: false, skills: {}, updatedAt: null };
}

function getDoc(slot) { return store.getState(KEY(slot), null); }
function putDoc(slot, doc) { doc.updatedAt = new Date().toISOString(); store.setState(KEY(slot), doc); return doc; }

function runState(slot) {
  const st = store.getState(RUN_KEY(slot), null);
  if (st?.running && Date.now() - Date.parse(st.startedAt) > STALE_MS) return { ...st, running: false, error: 'interrupted (the server restarted) — press Draft again' };
  return st;
}

function needRole(slot) {
  if (!store.SLOTS.includes(slot)) throw bad('slot must be current or future');
  const role = store.activeRole(slot);
  if (!role) throw bad(`No ${slot} role saved yet`, 409);
  return role;
}

/**
 * Everything the page needs for one slot. Items Nick ticked into the case from
 * the evidence list (the older per-item flow) are folded in where the case does
 * not mention them yet, so neither route loses the other's work.
 */
function view(slot) {
  const role = needRole(slot);
  const assessment = store.latestAssessment(slot);
  const doc = getDoc(slot) || emptyDoc(role, assessment);
  const evidence = store.acceptedFor(null);
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const aBy = new Map((assessment?.skills || []).map((s) => [s.code, s]));
  const plan = store.planFor(slot).filter((p) => p.state !== 'dismissed');
  const names = cachedNames();
  const skills = role.profile.skills.map((s) => {
    const a = aBy.get(s.code) || null;
    const d = doc.skills[s.code] || null;
    const items = (d?.items || []).map((it) => {
      const e = byId.get(it.id);
      return { ...it, title: e ? clip(e.title, 160) : null, occurredAt: e?.occurredAt || null, gone: !e, names: nameHits(it.line, names) };
    });
    const known = new Set(items.map((i) => i.id));
    for (const e of evidence) {
      if (!e.inCase || !e.caseSummary || known.has(e.id) || !e.tags.some((t) => t.code === s.code)) continue;
      items.push({ id: e.id, line: e.caseSummary, included: true, fromList: true, title: clip(e.title, 160), occurredAt: e.occurredAt, gone: false, names: nameHits(e.caseSummary, names) });
    }
    const candidates = candidatesFor(evidence, s.code, a?.cite || []);
    return {
      code: s.code, name: s.name, target: s.level, targetName: sfia.levelName(s.level),
      rating: a?.rating || 'unrated', observedLevel: a?.observedLevel || null, why: a?.why || null,
      drafted: Boolean(d), draftedAt: d?.draftedAt || null, error: d?.error || null,
      argument: d?.argument ?? null, position: d?.position ?? null,
      argumentNames: nameHits(d?.argument, names), positionNames: nameHits(d?.position, names),
      items, available: candidates.filter((e) => !known.has(e.id)).length,
      reviewed: Boolean(d?.reviewed), reviewedAt: d?.reviewedAt || null,
      plan: plan.filter((p) => p.code === s.code).map((p) => ({ id: p.id, action: p.action, proves: p.proves, state: p.state })),
    };
  });
  return {
    slot, role: { id: role.id, title: role.profile.title },
    assessment: assessment ? { id: assessment.id, createdAt: assessment.createdAt, readiness: assessment.readiness || null, roleId: assessment.roleId } : null,
    stale: Boolean(assessment && doc.assessmentId && doc.assessmentId !== assessment.id),
    roleChanged: Boolean(assessment && assessment.roleId !== role.id),
    opening: doc.opening, openingNames: nameHits(doc.opening, names),
    skills, run: runState(slot),
    reviewedCount: skills.filter((s) => s.reviewed).length,
    nameCheck: names ? { ready: true, at: store.getState(NAMES_KEY, null)?.at || null } : { ready: false },
  };
}

// ── drafting ─────────────────────────────────────────────────────────────────

async function draftSkill(s, a, evidence, role) {
  const openrouter = require('./openrouter');
  const cands = candidatesFor(evidence, s.code, a?.cite || []).slice(0, PROMPT_ITEMS);
  if (!a || !RATED.includes(a.rating) || !cands.length) {
    // Nothing to argue from: an honest position, the plan carries the rest. No model call.
    return {
      argument: null,
      position: cands.length
        ? `There is accepted evidence for ${s.name}, but VANTAGE has not rated it yet — reassess before relying on it.`
        : `I have no accepted evidence yet for ${s.name} at L${s.level} (${sfia.levelName(s.level)}).`,
      items: cands.slice(0, 3).map((e) => ({ id: e.id, line: '', included: false })),
    };
  }
  const user = [
    `ROLE: ${role.profile.title}`,
    `SKILL: ${s.code} ${s.name} — target L${s.level} (${sfia.levelName(s.level)})`,
    s.bar ? `THE BAR: ${s.bar}` : null,
    s.inRole ? `IN THIS ROLE: ${s.inRole}` : null,
    `ASSESSMENT: ${RATING_WORDS[a.rating]}${a.observedLevel ? `, seen at L${a.observedLevel}` : ''}. ${clip(a.why, 1200)}`,
    `CITED BY THE ASSESSMENT: ${(a.cite || []).map((c) => `#${c}`).join(', ') || 'none'}`,
    '', `EVIDENCE (${cands.length}):`, ...cands.map((e) => evLine(e, s.code)),
  ].filter((x) => x != null).join('\n');
  const reply = await openrouter.complete([{ role: 'system', content: SKILL_PROMPT }, { role: 'user', content: user }],
    { temperature: 0.2, maxTokens: 1500, json: true, callType: 'perf_case', timeoutMs: 180_000, retryOnEmpty: true });
  return parseSkillDraft(reply.text, { candidateIds: cands.map((e) => e.id), rating: a.rating });
}

/**
 * Draft in the background. `code` drafts that one skill (overwriting it, even
 * if confirmed — the page asks first); without it, every skill Nick has NOT
 * confirmed is drafted and confirmed ones are left exactly as they are.
 */
function draft(slot, { code = null } = {}) {
  const role = needRole(slot);
  const assessment = store.latestAssessment(slot);
  if (!assessment) throw bad('Assess this role first — the case is written from the assessment', 409);
  if (!require('./openrouter').isConfigured()) throw bad('No OpenRouter key — cannot draft', 503);
  if (runState(slot)?.running) throw bad('A draft is already running for this role', 409);
  if (code && !role.profile.skills.some((s) => s.code === code)) throw bad(`${code} is not a skill in this role`);
  const doc0 = getDoc(slot);
  const targets = role.profile.skills.filter((s) => (code ? s.code === code : !doc0?.skills?.[s.code]?.reviewed));
  const total = targets.length + (code ? 0 : 1);
  store.setState(RUN_KEY(slot), { running: true, startedAt: new Date().toISOString(), done: 0, total, error: null, code });
  run(slot, role, assessment, targets, { opening: !code }).catch((e) => {
    store.setState(RUN_KEY(slot), { running: false, done: 0, total, error: e.message, finishedAt: new Date().toISOString() });
  });
  return runState(slot);
}

async function run(slot, role, assessment, targets, { opening }) {
  await loadNames();
  const evidence = store.acceptedFor(null);
  const aBy = new Map((assessment.skills || []).map((s) => [s.code, s]));
  const failures = [];
  let done = 0;
  const tick = () => { done += 1; const st = store.getState(RUN_KEY(slot), {}); store.setState(RUN_KEY(slot), { ...st, done }); };
  const queue = [...targets];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      let result;
      try { result = await draftSkill(s, aBy.get(s.code), evidence, role); } catch (e) {
        try { result = await draftSkill(s, aBy.get(s.code), evidence, role); } catch (e2) { result = { error: e2.message || e.message }; failures.push(`${s.code}: ${e2.message}`); }
      }
      // Re-read before writing: workers finish in any order, and Nick may be editing other skills meanwhile.
      const doc = getDoc(slot) || emptyDoc(role, assessment);
      const prev = doc.skills[s.code];
      doc.skills[s.code] = result.error
        ? { ...(prev || { argument: null, position: null, items: [] }), error: `Drafting failed: ${result.error}`, reviewed: false }
        : { ...result, draftedAt: new Date().toISOString(), reviewed: false, reviewedAt: null, error: null };
      doc.assessmentId = assessment.id;
      doc.roleId = role.id;
      putDoc(slot, doc);
      tick();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (opening) {
    const doc = getDoc(slot) || emptyDoc(role, assessment);
    if (!doc.openingEdited) {
      try {
        const openrouter = require('./openrouter');
        const lines = role.profile.skills.map((s) => {
          const a = aBy.get(s.code);
          return `${s.code} ${s.name}: ${RATING_WORDS[a?.rating] || 'Not rated'} (target L${s.level}${a?.observedLevel ? `, seen L${a.observedLevel}` : ''})`;
        });
        const user = `ROLE: ${role.profile.title}\nVERDICT: ${READY_WORDS[assessment.readiness?.rating] || 'unknown'} — ${clip(assessment.readiness?.why, 600)}\n\nSKILLS:\n${lines.join('\n')}`;
        const reply = await openrouter.complete([{ role: 'system', content: OPENING_PROMPT }, { role: 'user', content: user }],
          { temperature: 0.2, maxTokens: 800, json: true, callType: 'perf_case', timeoutMs: 120_000, retryOnEmpty: true });
        const j = require('./perf-json').parseModelJson(reply.text);
        doc.opening = tidy(j?.opening, TEXT_MAX) || null;
        putDoc(slot, doc);
      } catch (e) { failures.push(`opening: ${e.message}`); }
    }
    tick();
  }
  store.setState(RUN_KEY(slot), {
    running: false, done, total: done, finishedAt: new Date().toISOString(),
    error: failures.length ? `${failures.length} part(s) failed: ${failures.join(' · ')}` : null,
  });
}

/** One line for an item Nick added from "Add more". Synchronous, one short call. */
async function draftLine(slot, code, id) {
  const role = needRole(slot);
  const s = role.profile.skills.find((x) => x.code === code);
  if (!s) throw bad(`${code} is not a skill in this role`);
  const e = store.acceptedFor(null).find((x) => x.id === id && x.tags.some((t) => t.code === code));
  if (!e) throw bad('That item is not accepted evidence for this skill', 404);
  const doc = getDoc(slot) || emptyDoc(role, store.latestAssessment(slot));
  const sk = doc.skills[code] || { argument: null, position: null, items: [], reviewed: false };
  const existing = sk.items.find((i) => i.id === id);
  let line = existing?.line || '';
  if (!line) {
    await loadNames();
    const openrouter = require('./openrouter');
    const reply = await openrouter.complete([
      { role: 'system', content: SKILL_PROMPT },
      { role: 'user', content: `ROLE: ${role.profile.title}\nSKILL: ${s.code} ${s.name} — target L${s.level}\nASSESSMENT: (not needed — return argument "" and position "")\n\nEVIDENCE (1):\n${evLine(e, code)}\n\nPick this one item.` },
    ], { temperature: 0.2, maxTokens: 400, json: true, callType: 'perf_case', timeoutMs: 90_000, retryOnEmpty: true });
    line = parseSkillDraft(reply.text, { candidateIds: [id], rating: 'met' }).items[0]?.line || '';
  }
  if (existing) Object.assign(existing, { line, included: true });
  else sk.items.push({ id, line, included: true });
  sk.reviewed = false;
  doc.skills[code] = sk;
  putDoc(slot, doc);
  return view(slot).skills.find((x) => x.code === code);
}

// ── Nick's edits ─────────────────────────────────────────────────────────────

/** Validate an edit to one skill. Refused, never repaired. Pure apart from the names it is given. */
function applySkillEdit(prev, body, { candidateIds, names, gap }) {
  const next = { ...(prev || { argument: null, position: null, items: [] }) };
  if (body.argument !== undefined) {
    if (body.argument !== null && typeof body.argument !== 'string') throw bad('argument must be text');
    next.argument = body.argument == null ? null : tidy(body.argument, TEXT_MAX) || null;
  }
  if (body.position !== undefined) {
    if (body.position !== null && typeof body.position !== 'string') throw bad('position must be text');
    next.position = body.position == null ? null : tidy(body.position, TEXT_MAX) || null;
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length > 60) throw bad('items must be a list of up to 60');
    const valid = new Set(candidateIds);
    const seen = new Set();
    next.items = body.items.map((it) => {
      const id = Number(it?.id);
      if (!valid.has(id)) throw bad(`#${it?.id} is not accepted evidence for this skill`);
      if (seen.has(id)) throw bad(`#${id} is listed twice`);
      seen.add(id);
      if (typeof it.line !== 'string') throw bad(`#${id} needs its line as text`);
      return { id, line: tidy(it.line, LINE_MAX).replace(/\s+/g, ' '), included: Boolean(it.included) };
    });
  }
  if (body.reviewed !== undefined) {
    if (typeof body.reviewed !== 'boolean') throw bad('reviewed must be true or false');
    if (body.reviewed) {
      if (!names) throw bad('Cannot confirm yet — the colleague-name check has no roster (NEURO did not answer). Try again shortly.', 503);
      const inc = next.items.filter((i) => i.included);
      if (inc.some((i) => !i.line)) throw bad('Every ticked item needs its line — write one or untick it');
      const hits = [next.argument, next.position, ...inc.map((i) => i.line)].flatMap((t) => nameHits(t, names));
      if (hits.length) throw bad(`Names a colleague (${[...new Set(hits)].join(', ')}) — use their role instead`);
      if (!gap && !next.argument) throw bad('Write the argument for this skill first');
      if (gap && !next.position) throw bad('Say where you stand on this skill first');
    }
    next.reviewed = body.reviewed;
    next.reviewedAt = body.reviewed ? new Date().toISOString() : null;
  } else if (body.argument !== undefined || body.position !== undefined || body.items !== undefined) {
    // Any change unconfirms: what was confirmed is not what is there now.
    next.reviewed = false;
    next.reviewedAt = null;
  }
  return next;
}

async function editSkill(slot, code, body) {
  const role = needRole(slot);
  if (!role.profile.skills.some((s) => s.code === code)) throw bad(`${code} is not a skill in this role`);
  if (body?.reviewed === true) await loadNames();
  const assessment = store.latestAssessment(slot);
  const a = (assessment?.skills || []).find((s) => s.code === code);
  const candidateIds = store.acceptedFor(null).filter((e) => e.tags.some((t) => t.code === code)).map((e) => e.id);
  const doc = getDoc(slot) || emptyDoc(role, assessment);
  // The view folds in items ticked from the evidence list; an edit made from that view carries them, so they are valid here too.
  doc.skills[code] = applySkillEdit(doc.skills[code], body || {}, { candidateIds, names: cachedNames(), gap: GAP.includes(a?.rating || 'unrated') });
  putDoc(slot, doc);
  return view(slot).skills.find((s) => s.code === code);
}

function editOpening(slot, text) {
  const role = needRole(slot);
  if (text !== null && typeof text !== 'string') throw bad('opening must be text');
  const doc = getDoc(slot) || emptyDoc(role, store.latestAssessment(slot));
  doc.opening = text == null ? null : tidy(text, TEXT_MAX) || null;
  doc.openingEdited = true;
  putDoc(slot, doc);
  return { opening: doc.opening };
}

/** Items Nick can add to a skill: accepted, tagged to it, not already in it. */
function candidates(slot, code) {
  const role = needRole(slot);
  if (!role.profile.skills.some((s) => s.code === code)) throw bad(`${code} is not a skill in this role`);
  const v = view(slot).skills.find((s) => s.code === code);
  const have = new Set(v.items.map((i) => i.id));
  const a = (store.latestAssessment(slot)?.skills || []).find((s) => s.code === code);
  const cite = new Set(a?.cite || []);
  return {
    items: candidatesFor(store.acceptedFor(null), code, a?.cite || []).filter((e) => !have.has(e.id)).map((e) => ({
      id: e.id, title: clip(e.title, 200), occurredAt: e.occurredAt, cited: cite.has(e.id),
      against: !e.tags.some((t) => t.code === code && t.stance === 'for'),
    })),
  };
}

// ── export ───────────────────────────────────────────────────────────────────

/**
 * The case as blocks — the one structure both the text and the Word file are
 * made from, so they cannot say different things. Confirmed skills only. Pure.
 */
function caseBlocks(v, { date = new Date() } = {}) {
  const confirmed = v.skills.filter((s) => s.reviewed);
  const b = [];
  b.push({ t: 'h1', text: `${v.role.title} — my case` });
  b.push({ t: 'p', text: `Nick Ward · ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' })}`, muted: true });
  b.push({ t: 'h2', text: 'Where I stand' });
  if (v.opening) b.push({ t: 'p', text: v.opening });
  if (v.assessment?.readiness?.rating) b.push({ t: 'p', text: `Readiness against the role (VANTAGE's reading of my evidence, ${v.assessment.createdAt.slice(0, 10)}): ${READY_WORDS[v.assessment.readiness.rating] || v.assessment.readiness.rating}.` });
  b.push({ t: 'h2', text: 'The role, skill by skill' });
  b.push({ t: 'table', head: ['Skill', 'Target', 'Where I am'], rows: v.skills.map((s) => [`${s.code} ${s.name}`, `L${s.target} (${s.targetName || ''})`, `${RATING_WORDS[s.rating] || s.rating}${s.observedLevel ? ` — seen at L${s.observedLevel}` : ''}`]) });
  const strong = confirmed.filter((s) => s.rating === 'met' || s.rating === 'partly');
  const gaps = confirmed.filter((s) => s.rating !== 'met' && s.rating !== 'partly');
  const lines = (s) => s.items.filter((i) => i.included && i.line);
  const planLines = (s) => s.plan.filter((p) => p.state === 'open' || p.state === 'pushed').map((p) => `${p.action}${p.proves ? ` — this will show ${p.proves.replace(/^[A-Z]/, (c) => c.toLowerCase())}` : ''}`);
  if (strong.length) b.push({ t: 'h2', text: 'What the evidence shows' });
  for (const s of strong) {
    b.push({ t: 'h3', text: `${s.code} ${s.name} — ${RATING_WORDS[s.rating]} (target L${s.target})` });
    if (s.argument) b.push({ t: 'p', text: s.argument });
    for (const i of lines(s)) b.push({ t: 'li', text: `${String(i.occurredAt || '').slice(0, 10)} — ${i.line}` });
    if (s.rating === 'partly') {
      if (s.position) b.push({ t: 'p', text: `Still to show: ${s.position}` });
      for (const p of planLines(s)) b.push({ t: 'li', text: `What I'm doing: ${p}` });
    }
  }
  if (gaps.length) b.push({ t: 'h2', text: 'Gaps, and what I am doing about them' });
  for (const s of gaps) {
    b.push({ t: 'h3', text: `${s.code} ${s.name} — ${RATING_WORDS[s.rating]} (target L${s.target})` });
    if (s.position) b.push({ t: 'p', text: s.position });
    if (s.argument) b.push({ t: 'p', text: s.argument });
    for (const i of lines(s)) b.push({ t: 'li', text: `${String(i.occurredAt || '').slice(0, 10)} — ${i.line}` });
    const pl = planLines(s);
    if (pl.length) { b.push({ t: 'p', text: "What I'm doing:" }); for (const p of pl) b.push({ t: 'li', text: p }); }
  }
  return b;
}

function toMarkdown(blocks) {
  const out = [];
  for (const x of blocks) {
    if (x.t === 'h1') out.push(`# ${x.text}`, '');
    else if (x.t === 'h2') out.push(`## ${x.text}`, '');
    else if (x.t === 'h3') out.push(`### ${x.text}`, '');
    else if (x.t === 'p') out.push(x.muted ? `_${x.text}_` : x.text, '');
    else if (x.t === 'li') out.push(`- ${x.text}`);
    else if (x.t === 'table') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(`| ${x.head.join(' | ')} |`, `|${x.head.map(() => '---').join('|')}|`, ...x.rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`), '');
    }
  }
  // A list ends with a blank line before the next block.
  return out.join('\n').replace(/(\n- [^\n]*)\n(?=[^-\n])/g, '$1\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A minimal .docx (Word 2007+) from the blocks: real headings, a table, bullets. */
async function toDocx(blocks) {
  const JSZip = require('jszip');
  const run = (text, { bold = false, color = null } = {}) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const para = (text, style, opts) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(text, opts)}</w:p>`;
  const body = blocks.map((x) => {
    if (x.t === 'h1') return para(x.text, 'Title');
    if (x.t === 'h2') return para(x.text, 'Heading1');
    if (x.t === 'h3') return para(x.text, 'Heading2');
    if (x.t === 'li') return para(x.text, 'ListBullet');
    if (x.t === 'p') return para(x.text, null, x.muted ? { color: '666666' } : {});
    if (x.t === 'table') {
      const cell = (c, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${run(c, { bold: head })}</w:p></w:tc>`;
      const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((k) => `<w:${k} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`).join('') + '</w:tblBorders>';
      return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>`
        + `<w:tr>${x.head.map((c) => cell(c, true)).join('')}</w:tr>${x.rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`).join('')}</w:tbl><w:p/>`;
    }
    return '';
  }).join('');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const style = (id, name, size, { bold = true, before = 240, after = 80, color = null, ind = null } = {}) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/>${ind || ''}</w:pPr><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + style('Title', 'Title', 40, { before: 0, after: 60 })
    + style('Heading1', 'heading 1', 30, { color: '1F3864' })
    + style('Heading2', 'heading 2', 24, { before: 200 })
    + style('ListBullet', 'List Bullet', 22, { bold: false, before: 0, after: 60, ind: '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="360" w:hanging="360"/>' })
    + '</w:styles>';
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', styles);
  zip.file('word/numbering.xml', numbering);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The export. Refuses rather than ship a colleague's name; says which skills were left out. */
function exportCase(slot) {
  const v = view(slot);
  if (!v.reviewedCount) throw bad('Confirm at least one skill ("Happy with this skill") before exporting — unconfirmed skills are never exported', 409);
  const names = cachedNames();
  const texts = [v.opening, ...v.skills.filter((s) => s.reviewed).flatMap((s) => [s.argument, s.position, ...s.items.filter((i) => i.included).map((i) => i.line)])];
  const hits = [...new Set(texts.flatMap((t) => nameHits(t, names)))];
  if (hits.length) throw bad(`The case names a colleague (${hits.join(', ')}) — use their role instead`, 409);
  const blocks = caseBlocks(v);
  return { v, blocks, left: v.skills.filter((s) => !s.reviewed).map((s) => ({ code: s.code, name: s.name })) };
}

module.exports = {
  view, draft, draftLine, editSkill, editOpening, candidates, exportCase, toMarkdown, toDocx, loadNames, runState,
  // pure, for tests
  guardNames, nameHits, parseSkillDraft, stripRefs, candidatesFor, applySkillEdit, caseBlocks,
};
