'use strict';

/**
 * Performance Evidence — the full assessment (29 Oct 2026).
 *
 * Nick's decision (Q2): VANTAGE rates each skill against its target (met /
 * partly / not yet), and gives an overall readiness for the role. This is a
 * deliberate, written exception to self.js's "nothing is scored or graded"
 * rule, for this section only.
 *
 * The rules from context/role.md ("Proposing SFIA grades over time") still hold,
 * and are enforced HERE, not in the prompt:
 *  - A skill with no accepted evidence is `no-evidence`, whatever the model says.
 *    Never "not-yet": absence of evidence is not evidence of absence.
 *  - Every rating cites accepted evidence tagged to that skill for this role.
 *    Citations to anything else are dropped; a rating left citing nothing is
 *    `unrated` (shown as such), not silently kept.
 *  - Only ACCEPTED evidence is read. Proposed items are not Nick's word yet.
 *  - It is a reading for Nick, private, and goes outward only via his export.
 *
 * Runs only when Nick presses Reassess. Each run is kept (history), so a rating
 * that moves can be seen moving.
 */

const store = require('./perf-store');
const sfia = require('./sfia');

const RATINGS = ['met', 'partly', 'not-yet'];
const READINESS = ['ready', 'nearly', 'not-yet', 'too-little-evidence'];
const PER_SKILL = 15;

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Evidence for the prompt: per skill, most recent first, capped. Pure. */
function selectEvidence(evidence, slot, skills, cap = PER_SKILL) {
  const bySkill = {};
  const chosen = new Map();
  for (const s of skills) {
    const list = evidence.filter((e) => e.tags.some((t) => t.slot === slot && t.code === s.code)).slice(0, cap);
    bySkill[s.code] = list.map((e) => e.id);
    for (const e of list) chosen.set(e.id, e);
  }
  return { bySkill, chosen: [...chosen.values()] };
}

/** Validate the model's assessment. Pure. */
function parseAssessment(raw, { skills, bySkill }) {
  let j;
  try { j = require('./perf-json').parseModelJson(raw); } catch { throw new Error('The model\'s answer was not readable JSON — nothing saved. Try again.'); }
  const given = new Map((Array.isArray(j?.skills) ? j.skills : []).map((s) => [String(s?.code || '').toUpperCase(), s]));
  const out = [];
  for (const s of skills) {
    const valid = new Set(bySkill[s.code] || []);
    const base = { code: s.code, name: s.name, target: s.level };
    if (!valid.size) { out.push({ ...base, rating: 'no-evidence', observedLevel: null, why: 'No accepted evidence yet.', cite: [] }); continue; }
    const m = given.get(s.code);
    const cite = (Array.isArray(m?.cite) ? m.cite : []).map(Number).filter((id) => valid.has(id));
    const rating = RATINGS.includes(m?.rating) ? m.rating : null;
    if (!rating || !cite.length) {
      out.push({ ...base, rating: 'unrated', observedLevel: null, why: m ? 'The model gave a rating it could not support with accepted evidence.' : 'The model did not rate this skill.', cite: [] });
      continue;
    }
    const lv = Number(m.observedLevel);
    out.push({ ...base, rating, observedLevel: Number.isInteger(lv) && lv >= 1 && lv <= 7 ? lv : null, why: clip(m.why, 2000) || null, cite });
  }
  const counts = { met: 0, partly: 0, 'not-yet': 0, 'no-evidence': 0, unrated: 0 };
  for (const r of out) counts[r.rating] += 1;
  const rated = counts.met + counts.partly + counts['not-yet'];
  let readiness = READINESS.includes(j?.readiness?.rating) ? j.readiness.rating : null;
  // Fewer than half the skills evidenced cannot support a readiness verdict, whatever the model says.
  if (rated * 2 < skills.length) readiness = 'too-little-evidence';
  if (!readiness) readiness = 'too-little-evidence';
  const attributes = {};
  for (const a of sfia.ATTRIBUTES) {
    const g = j?.attributes?.[a.key];
    const lv = Number(g?.observedLevel);
    attributes[a.key] = { observedLevel: Number.isInteger(lv) && lv >= 1 && lv <= 7 ? lv : null, why: clip(g?.why, 1000) || null };
  }
  return {
    skills: out, counts, attributes,
    readiness: { rating: readiness, why: clip(j?.readiness?.why, 1500) || null },
    summary: clip(j?.summary, 2500) || null,
  };
}

/**
 * The development plan (29 Oct 2026, Nick: "something needs to display
 * actionable insights / coaching on what I specifically need to do to bridge
 * the gaps"). Kept only for a REAL gap — a skill not rated met, or a generic
 * attribute seen below its target or not seen at all — so a met skill never
 * gets homework. Pure.
 */
function parsePlan(j, { assessment, role }) {
  const attrKeys = new Map(sfia.ATTRIBUTES.map((a) => [a.key, a]));
  const gaps = new Set();
  for (const s of assessment.skills) if (s.rating !== 'met') gaps.add(s.code);
  for (const a of sfia.ATTRIBUTES) {
    const target = role.profile.attributes?.[a.key]?.level;
    const seen = assessment.attributes?.[a.key]?.observedLevel;
    if (target && (!seen || seen < target)) gaps.add(a.key);
  }
  const out = [];
  const seenText = new Set();
  for (const p of Array.isArray(j?.plan) ? j.plan : []) {
    const raw = String(p?.code || '').trim();
    const code = attrKeys.has(raw.toLowerCase()) ? raw.toLowerCase() : raw.toUpperCase();
    if (!gaps.has(code)) continue;
    const action = clip(p?.action, 400);
    if (action.length < 10) continue;
    const k = action.toLowerCase();
    if (seenText.has(k)) continue;
    seenText.add(k);
    const pr = Number(p?.priority);
    out.push({ code, action, proves: clip(p?.proves, 400) || null, priority: [1, 2, 3].includes(pr) ? pr : 2 });
    if (out.length >= 40) break;
  }
  return out;
}

const PLAN_RULES = `PLAN (the coaching) — only for a gap
- One to three actions Nick can personally start in the next few weeks, within the scope he actually has. Concrete and specific to the gap and the evidence: name the thing to produce, the people or forum, the measure. Never generic advice ("communicate more", "be strategic").
- If the work is happening but the evidence does not show it, say so and name what to record or produce so it shows.
- proves: the evidence the action would produce that would move the rating.
- priority: 1 = moves readiness most, 2 = solid, 3 = nice to have.`;

const SKILL_PROMPT = `You rate one manager (Nick) on ONE SFIA 9 skill, using ONLY the accepted evidence given (all of it — read every item). Answer ONLY with JSON:
{"rating":"met|partly|not-yet","observedLevel":5,"why":"...","cite":[12,40],"plan":[{"action":"...","proves":"...","priority":1}]}
THE BAR
- Rate against THE BAR only: SFIA's own wording for the target level. "In this role" says what that level looks like in his job — use it to recognise evidence. Judge him within his scope, never against authority the role does not give him.
- Outcome targets are CONTEXT ONLY. A missed, unproven or out-of-date target alone NEVER makes a skill partly or not-yet. Rate how he operates, not whether a KPI number was hit.
- Lateness or a slip is not evidence against unless the substance shows he is below the bar.
RULES
- met = the evidence shows him working at the bar consistently. partly = some of the bar shown, or below it, or real evidence against. not-yet = the evidence shows him below the bar.
- Weigh evidence AGAINST honestly; do not ignore it.
- why: 4-8 sentences naming evidence ids: what the evidence shows against the bar, and what (if anything) is missing.
- cite: evidence ids that support the rating (at least one, only ids given).
- observedLevel: the SFIA level the evidence shows, or null if it cannot tell.
- plan: [] if met.
- Do not invent facts beyond the evidence.
${PLAN_RULES}`;

const FINAL_PROMPT = `You have per-skill SFIA ratings for one manager (Nick) against a role. Produce the role-level reading. Answer ONLY with JSON:
{"attributes":{"autonomy":{"observedLevel":5,"why":"..."},"influence":{...},"complexity":{...},"knowledge":{...},"business_skills":{...}},
 "readiness":{"rating":"ready|nearly|not-yet","why":"..."},
 "summary":"3-4 sentences: strongest areas, the gaps, what would move it",
 "plan":[{"code":"influence","action":"...","proves":"...","priority":1}]}
RULES
- Judge the five SFIA generic attributes from the per-skill readings and their evidence notes; observedLevel null if they cannot tell.
- readiness: ready = the role's bar is met across nearly all skills; nearly = most met, gaps closable; not-yet = substantial gaps.
- plan: only for attributes seen below their target (code = the attribute key).
- Do not invent facts.
${PLAN_RULES}`;

const CONCURRENCY = 4;
const RUN_KEY = (slot) => `assess_run_${slot}`;
const STALE_MS = 30 * 60_000;

function skillText(s) {
  const lines = [`SKILL: ${s.code} ${s.name} — target L${s.level}`];
  if (s.bar) lines.push(`THE BAR (SFIA L${s.level}): ${s.bar}`);
  if (s.inRole) lines.push(`IN THIS ROLE: ${s.inRole}`);
  if (s.targets) lines.push(`OUTCOME TARGETS (context only): ${s.targets}`);
  if (!s.bar && s.why) lines.push(`EXPECTED / SCOPE: ${s.why}`);
  return lines.join('\n');
}

function evLine(e, slot) {
  const tags = e.tags.filter((t) => t.slot === slot).map((t) => `${t.code}:${t.stance}`).join(',');
  return `#${e.id} [${String(e.occurredAt || '').slice(0, 10)}] (${tags}) ${clip(e.title, 200)}${e.detail ? ` — ${clip(e.detail, 300)}` : ''}`;
}

async function withRetry(fn) {
  try { return await fn(); } catch { return fn(); }
}

/** Is a run in progress? A run older than STALE_MS (a restart killed it) is not. */
function runState(slot) {
  const st = store.getState(RUN_KEY(slot), null);
  if (st?.running && Date.now() - Date.parse(st.startedAt) > STALE_MS) return { ...st, running: false, error: 'interrupted (the server restarted) — press Reassess again' };
  return st;
}

/**
 * Start a reassessment in the background (29 Oct 2026, Nick: "read the lot").
 * One model call PER SKILL with every accepted item tagged to it, then one short
 * call for attributes, readiness and summary. Returns at once; progress is in
 * runState(slot), shown by the page.
 */
function assess(slot) {
  if (!store.SLOTS.includes(slot)) { const e = new Error('slot must be current or future'); e.status = 400; throw e; }
  const role = store.activeRole(slot);
  if (!role) { const e = new Error(`No ${slot} role saved yet — add its job description first`); e.status = 409; throw e; }
  const openrouter = require('./openrouter');
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot assess');
  if (runState(slot)?.running) { const e = new Error('A reassessment of this role is already running'); e.status = 409; throw e; }
  const total = role.profile.skills.length + 1;
  store.setState(RUN_KEY(slot), { running: true, startedAt: new Date().toISOString(), done: 0, total });
  runAssess(slot, role).catch((e) => {
    console.warn(`[VANTAGE] perf assess ${slot} failed: ${e.message}`);
    store.setState(RUN_KEY(slot), { ...(store.getState(RUN_KEY(slot), {})), running: false, error: e.message, finishedAt: new Date().toISOString() });
  });
  return { started: true, total };
}

async function runAssess(slot, role) {
  const openrouter = require('./openrouter');
  const { parseModelJson } = require('./perf-json');
  const skills = role.profile.skills;
  const evidence = store.acceptedFor(slot);
  const { bySkill, chosen } = selectEvidence(evidence, slot, skills, Infinity);
  const byId = new Map(chosen.map((e) => [e.id, e]));
  let done = 0;
  const tick = () => { done += 1; store.setState(RUN_KEY(slot), { ...store.getState(RUN_KEY(slot), {}), done }); };
  const models = new Set();
  const perSkill = new Array(skills.length);
  const failures = [];

  let next = 0;
  async function worker() {
    while (next < skills.length) {
      const i = next++;
      const s = skills[i];
      const ids = bySkill[s.code] || [];
      if (!ids.length) { perSkill[i] = { code: s.code }; tick(); continue; }
      try {
        const reply = await withRetry(() => openrouter.complete([
          { role: 'system', content: SKILL_PROMPT },
          { role: 'user', content: `ROLE: ${role.profile.title}\n${skillText(s)}\n\nACCEPTED EVIDENCE (${ids.length} items):\n${ids.map((id) => evLine(byId.get(id), slot)).join('\n')}` },
        ], { temperature: 0, maxTokens: 3000, json: true, callType: 'perf_assess', timeoutMs: 240_000 }));
        models.add(reply.model);
        perSkill[i] = { code: s.code, ...parseModelJson(reply.text) };
      } catch (e) {
        failures.push(`${s.code}: ${e.message}`);
        perSkill[i] = { code: s.code, failed: e.message };
      }
      tick();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const skillSummary = skills.map((s, i) => {
    const r = perSkill[i] || {};
    if (r.failed) return `${s.code} ${s.name}: not rated (the call failed).`;
    if (!(bySkill[s.code] || []).length) return `${s.code} ${s.name}: no accepted evidence.`;
    return `${s.code} ${s.name}: ${r.rating}${r.observedLevel ? `, seen L${r.observedLevel}` : ''} (target L${s.level}). ${clip(r.why, 800)}`;
  }).join('\n');
  const attrText = sfia.ATTRIBUTES.map((a) => `${a.key} (${a.name}): target L${role.profile.attributes?.[a.key]?.level ?? '?'}${role.profile.attributes?.[a.key]?.why ? ` — ${clip(role.profile.attributes[a.key].why, 300)}` : ''}`).join('\n');
  let final = {};
  try {
    const reply = await withRetry(() => openrouter.complete([
      { role: 'system', content: FINAL_PROMPT },
      { role: 'user', content: `ROLE: ${role.profile.title}\nATTRIBUTE TARGETS:\n${attrText}\n\nPER-SKILL READINGS:\n${skillSummary}` },
    ], { temperature: 0, maxTokens: 4000, json: true, callType: 'perf_assess', timeoutMs: 240_000 }));
    models.add(reply.model);
    final = parseModelJson(reply.text);
  } catch (e) { failures.push(`overall: ${e.message}`); }
  tick();

  const result = parseAssessment({
    skills: perSkill.filter((x) => x && !x.failed),
    attributes: final.attributes, readiness: final.readiness, summary: final.summary,
  }, { skills, bySkill });
  // A skill whose call failed says so, rather than reading as "the model did not rate it".
  for (const r of result.skills) {
    const f = perSkill.find((x) => x && x.code === r.code && x.failed);
    if (f) r.why = `The model call for this skill failed (${f.failed}) — press Reassess to try again.`;
  }
  const saved = store.saveAssessment(slot, role.id, {
    ...result, evidenceRead: chosen.length, model: [...models].join(', ') || null,
    ...(failures.length ? { failures } : {}),
  });
  const plan = parsePlan({
    plan: [
      ...perSkill.flatMap((x) => (x && Array.isArray(x.plan) ? x.plan.map((p) => ({ ...p, code: x.code })) : [])),
      ...(Array.isArray(final.plan) ? final.plan : []),
    ],
  }, { assessment: result, role });
  const added = store.savePlan(slot, saved.id, plan);
  store.setState(RUN_KEY(slot), {
    running: false, done: skills.length + 1, total: skills.length + 1, finishedAt: new Date().toISOString(),
    assessmentId: saved.id, planAdded: added,
    error: failures.length ? `${failures.length} part(s) failed: ${failures.join(' · ')}` : null,
  });
  return saved;
}

module.exports = { assess, runState, parseAssessment, parsePlan, selectEvidence, RATINGS, READINESS };
