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
    const list = evidence.filter((e) => e.tags.some((t) => (slot == null || t.slot === slot) && t.code === s.code)).slice(0, cap);
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

/**
 * The plan leans to the future role (30 Oct 2026, Nick: the role he is working
 * towards is the goal). The future role's plan is shown whole. The CURRENT
 * role's open actions are ordered so that a skill the future role also holds
 * comes first (it counts twice), then by priority, and only the first
 * CURRENT_PLAN_CAP are offered; the rest are HELD BACK — counted and shown on
 * request, never deleted, so nothing is lost if the focus changes. Read-time,
 * so it applies to plans already written. Pure.
 */
const CURRENT_PLAN_CAP = 3;
function weighPlan(items, { slot, futureCodes = [], cap = CURRENT_PLAN_CAP } = {}) {
  if (slot !== 'current') return items.map((i) => ({ ...i, alsoFuture: false, heldBack: false }));
  const fut = new Set(futureCodes);
  const marked = items.map((i) => ({ ...i, alsoFuture: fut.has(i.code), heldBack: false }));
  const open = marked.filter((i) => i.state === 'open')
    .sort((a, b) => (b.alsoFuture - a.alsoFuture) || (a.priority - b.priority) || (a.id - b.id));
  const held = new Set(open.slice(cap).map((i) => i.id));
  return marked.map((i) => (held.has(i.id) ? { ...i, heldBack: true } : i));
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
FEEDBACK
- Items titled "Feedback from …" are what someone SAID about Nick's work, each with a weight (1 of 5 = strongest). Nick's order: 1 his line manager in a 1-2-1, 2 a tech leadership meeting, 3 the risk meeting, 4 a meeting with senior leaders, 5 any other meeting (peers and direct reports count). Give weight-1 and weight-2 feedback the most say; a single weight-5 remark should not move a rating on its own.
- Feedback is about how he was seen at that date: weigh recent feedback above older, and note when later evidence shows he acted on criticism.
RECENCY (31 Oct 2026, Nick: ratings were resting on things from May)
- The rating is about how he works NOW. TODAY is given; each item shows the date it was recorded.
- It cuts ONE way (Nick: old evidence can still be appropriate, particularly the good stuff):
  - Evidence FOR keeps its value whatever its age: something he built, wrote or led in the last year still shows he can work at that level.
  - Evidence AGAINST fades with age: an item more than 3 months old counts against him only if recent evidence shows the same problem still happening. On its own it never holds a skill below the bar.
- A problem that later evidence shows addressed or fixed is NOT evidence against; say it was addressed.
- Recent feedback can describe something that happened earlier: judge it by what it says about him now.
- In why, give the month of any item more than 3 months old that you rely on ("in May (#9389)").
- Never base a plan action on an old problem that later evidence shows fixed or does not repeat.
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
- Judge how he works NOW: old achievements still count; old problems count only if the readings show them still happening. Do not plan around a problem they say was addressed.
- Do not invent facts.
${PLAN_RULES}`;

const CONCURRENCY = 4;
const RUN_KEY = (slot) => `assess_run_${slot}`;
const STALE_MS = 30 * 60_000;

/**
 * Stable ratings (30 Oct 2026). Nick's two roles rated the same skill at the
 * same level "met" in one and "partly" in the other, 14 seconds apart, because
 * each role read only the evidence triage had tagged to THAT role. Three rules:
 *  - A skill is rated on every accepted item tagged to its CODE, from either
 *    role. Evidence about service level management is evidence about it,
 *    whichever role the sorter happened to be reading for.
 *  - A rating is KEPT while nothing it rests on has changed: same code, level,
 *    bar and evidence (ids, wording, stance). Pressing Reassess cannot re-roll
 *    a rating whose evidence has not moved, and both roles get the SAME rating
 *    for a skill they hold at the same level and bar.
 *  - A fresh rating is the majority of VOTES readings, and the split is shown:
 *    "met 3/3" is settled, "met 2 · partly 1" is borderline. No majority
 *    (three different answers) reads as partly, marked split.
 * `fresh` ignores kept ratings (the "Fresh reading" button).
 */
// Bumped when the rating rules change, so kept ratings are re-read under the new rules.
const PROMPT_VERSION = 'recency-2';
const VOTES = Math.max(1, Math.min(5, Number(process.env.PERF_ASSESS_VOTES) || 3));
const CACHE_KEY = 'assess_skill_cache';
const FINAL_CACHE_KEY = 'assess_final_cache';
const CACHE_MAX = 300;

const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 32);

/** What a skill's rating rests on. Pure. The role's "in this role" wording is not part of it. */
function skillKey(s, items) {
  const ev = items.map((e) => `${e.id}|${e.title}|${e.detail || ''}|${e.tags.filter((t) => t.code === s.code).map((t) => t.stance).sort().join(',')}`).sort();
  return sha(JSON.stringify([PROMPT_VERSION, s.code, s.level, s.bar || s.why || '', ev]));
}

/** Majority of the readings. Pure. */
function majority(votes) {
  const ok = votes.filter((v) => v && RATINGS.includes(v.rating));
  if (!ok.length) return null;
  const tally = {};
  for (const v of ok) tally[v.rating] = (tally[v.rating] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const split = ok.length > 1 && top[0][1] * 2 <= ok.length;
  const rating = split ? 'partly' : top[0][0];
  const agree = ok.filter((v) => v.rating === rating);
  const pick = agree[0] || ok[0];
  const lvTally = {};
  for (const n of agree.map((v) => Number(v.observedLevel)).filter((n) => Number.isInteger(n))) lvTally[n] = (lvTally[n] || 0) + 1;
  const lv = Object.entries(lvTally).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0];
  return { ...pick, rating, observedLevel: lv ? Number(lv[0]) : (pick.observedLevel ?? null), votes: ok.map((v) => v.rating), split };
}

function cacheGet(key) { return (store.getState(CACHE_KEY, {}) || {})[key] || null; }
function cachePut(key, value, stateKey = CACHE_KEY) {
  const c = store.getState(stateKey, {}) || {};
  c[key] = { ...value, at: new Date().toISOString() };
  const keys = Object.keys(c);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => String(c[a].at).localeCompare(String(c[b].at)));
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
  }
  store.setState(stateKey, c);
}

function skillText(s) {
  const lines = [`SKILL: ${s.code} ${s.name} — target L${s.level}`];
  if (s.bar) lines.push(`THE BAR (SFIA L${s.level}): ${s.bar}`);
  if (s.inRole) lines.push(`IN THIS ROLE: ${s.inRole}`);
  if (s.targets) lines.push(`OUTCOME TARGETS (context only): ${s.targets}`);
  if (!s.bar && s.why) lines.push(`EXPECTED / SCOPE: ${s.why}`);
  return lines.join('\n');
}

function evLine(e, code) {
  const tags = [...new Set(e.tags.filter((t) => t.code === code).map((t) => `${t.code}:${t.stance}`))].join(',');
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
function assess(slot, { fresh = false } = {}) {
  if (!store.SLOTS.includes(slot)) { const e = new Error('slot must be current or future'); e.status = 400; throw e; }
  const role = store.activeRole(slot);
  if (!role) { const e = new Error(`No ${slot} role saved yet — add its job description first`); e.status = 409; throw e; }
  const openrouter = require('./openrouter');
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot assess');
  if (runState(slot)?.running) { const e = new Error('A reassessment of this role is already running'); e.status = 409; throw e; }
  const total = role.profile.skills.length + 1;
  store.setState(RUN_KEY(slot), { running: true, startedAt: new Date().toISOString(), done: 0, total });
  runAssess(slot, role, { fresh }).catch((e) => {
    console.warn(`[VANTAGE] perf assess ${slot} failed: ${e.message}`);
    store.setState(RUN_KEY(slot), { ...(store.getState(RUN_KEY(slot), {})), running: false, error: e.message, finishedAt: new Date().toISOString() });
  });
  return { started: true, total };
}

async function runAssess(slot, role, { fresh = false } = {}) {
  const openrouter = require('./openrouter');
  const { parseModelJson } = require('./perf-json');
  const skills = role.profile.skills;
  const evidence = store.acceptedFor(null);
  const { bySkill, chosen } = selectEvidence(evidence, null, skills, Infinity);
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
      const key = skillKey(s, ids.map((id) => byId.get(id)));
      const kept = fresh ? null : cacheGet(key);
      if (kept) { perSkill[i] = { code: s.code, ...kept, reused: kept.at }; tick(); continue; }
      const prompt = [
        { role: 'system', content: SKILL_PROMPT },
        { role: 'user', content: `ROLE: ${role.profile.title}\nTODAY: ${new Date().toISOString().slice(0, 10)}\n${skillText(s)}\n\nACCEPTED EVIDENCE (${ids.length} items):\n${ids.map((id) => evLine(byId.get(id), s.code)).join('\n')}` },
      ];
      const votes = [];
      let lastErr = null;
      for (let v = 0; v < VOTES; v += 1) {
        try {
          // The first reading is the deterministic one; the others sample, so a borderline skill shows as split.
          const reply = await withRetry(() => openrouter.complete(prompt, { temperature: v === 0 ? 0 : 0.7, maxTokens: 3000, json: true, callType: 'perf_assess', timeoutMs: 240_000 }));
          models.add(reply.model);
          votes.push(parseModelJson(reply.text));
        } catch (e) { lastErr = e; }
      }
      const m = majority(votes);
      if (!m) {
        const msg = lastErr ? lastErr.message : 'no usable rating';
        failures.push(`${s.code}: ${msg}`);
        perSkill[i] = { code: s.code, failed: msg };
      } else {
        perSkill[i] = { code: s.code, ...m };
        // Only a full set of readings is kept; a run that lost a reading is re-read next time.
        if (votes.length === VOTES) cachePut(key, m);
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
  const finalUser = `ROLE: ${role.profile.title}\nATTRIBUTE TARGETS:\n${attrText}\n\nPER-SKILL READINGS:\n${skillSummary}`;
  const finalKey = sha(finalUser);
  const keptFinal = fresh ? null : (store.getState(FINAL_CACHE_KEY, {}) || {})[finalKey];
  if (keptFinal) final = keptFinal.final;
  else {
    try {
      const reply = await withRetry(() => openrouter.complete([
        { role: 'system', content: FINAL_PROMPT },
        { role: 'user', content: finalUser },
      ], { temperature: 0, maxTokens: 4000, json: true, callType: 'perf_assess', timeoutMs: 240_000 }));
      models.add(reply.model);
      final = parseModelJson(reply.text);
      cachePut(finalKey, { final }, FINAL_CACHE_KEY);
    } catch (e) { failures.push(`overall: ${e.message}`); }
  }
  tick();

  const result = parseAssessment({
    skills: perSkill.filter((x) => x && !x.failed),
    attributes: final.attributes, readiness: final.readiness, summary: final.summary,
  }, { skills, bySkill });
  // A skill whose call failed says so, rather than reading as "the model did not rate it".
  for (const r of result.skills) {
    const p = perSkill.find((x) => x && x.code === r.code);
    if (p?.failed) r.why = `The model call for this skill failed (${p.failed}) — press Reassess to try again.`;
    else if (p && RATINGS.includes(r.rating)) {
      if (Array.isArray(p.votes)) { r.votes = p.votes; r.split = Boolean(p.split); }
      if (p.reused) r.keptFrom = p.reused;
    }
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

module.exports = { assess, runState, parseAssessment, parsePlan, selectEvidence, skillKey, majority, weighPlan, CURRENT_PLAN_CAP, RATINGS, READINESS, VOTES };
