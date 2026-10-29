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
function selectEvidence(evidence, slot, skills) {
  const bySkill = {};
  const chosen = new Map();
  for (const s of skills) {
    const list = evidence.filter((e) => e.tags.some((t) => t.slot === slot && t.code === s.code)).slice(0, PER_SKILL);
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
    out.push({ ...base, rating, observedLevel: Number.isInteger(lv) && lv >= 1 && lv <= 7 ? lv : null, why: clip(m.why, 500) || null, cite });
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
    attributes[a.key] = { observedLevel: Number.isInteger(lv) && lv >= 1 && lv <= 7 ? lv : null, why: clip(g?.why, 300) || null };
  }
  return {
    skills: out, counts, attributes,
    readiness: { rating: readiness, why: clip(j?.readiness?.why, 600) || null },
    summary: clip(j?.summary, 900) || null,
  };
}

const PROMPT = `You assess one manager (Nick) against an SFIA 9 role profile, using ONLY the accepted evidence given.
Answer ONLY with JSON:
{"skills":[{"code":"SLMO","rating":"met|partly|not-yet","observedLevel":5,"why":"...","cite":[12,40]}],
 "attributes":{"autonomy":{"observedLevel":5,"why":"..."},"influence":{...},"complexity":{...},"knowledge":{...},"business_skills":{...}},
 "readiness":{"rating":"ready|nearly|not-yet","why":"..."},
 "summary":"3-4 sentences: strongest areas, the gaps, what evidence would move it"}
RULES
- met = the evidence shows consistent work AT the target level. partly = some, or below level, or mixed with evidence against. not-yet = the evidence shows him below target.
- Weigh evidence AGAINST honestly; do not ignore it.
- cite: evidence ids that support the rating. A rating must cite at least one id listed for that skill.
- Skip a skill with no evidence listed — do not rate it.
- observedLevel: the SFIA level the evidence shows, or null if it cannot tell.
- Do not invent facts beyond the evidence.`;

async function assess(slot) {
  if (!store.SLOTS.includes(slot)) { const e = new Error('slot must be current or future'); e.status = 400; throw e; }
  const role = store.activeRole(slot);
  if (!role) { const e = new Error(`No ${slot} role saved yet — add its job description first`); e.status = 409; throw e; }
  const openrouter = require('./openrouter');
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot assess');
  const skills = role.profile.skills;
  const evidence = store.acceptedFor(slot);
  const { bySkill, chosen } = selectEvidence(evidence, slot, skills);
  if (!chosen.length) {
    const result = parseAssessment({}, { skills, bySkill });
    return store.saveAssessment(slot, role.id, { ...result, evidenceRead: 0, model: null });
  }
  const profileText = `ROLE: ${role.profile.title}\nSKILLS:\n${skills.map((s) => `  ${s.code} ${s.name} — target L${s.level}; evidence ids: ${(bySkill[s.code] || []).join(', ') || 'none'}`).join('\n')}\nGENERIC ATTRIBUTE TARGETS: ${sfia.ATTRIBUTES.map((a) => `${a.name} L${role.profile.attributes?.[a.key]?.level ?? '?'}`).join('; ')}`;
  const evText = chosen.map((e) => {
    const tags = e.tags.filter((t) => t.slot === slot).map((t) => `${t.code}:${t.stance}`).join(',');
    return `#${e.id} [${String(e.occurredAt || '').slice(0, 10)}] (${tags}) ${clip(e.title, 200)} — ${clip(e.detail, 400)}`;
  }).join('\n');
  const reply = await openrouter.complete([
    { role: 'system', content: PROMPT },
    { role: 'user', content: `${profileText}\n\nACCEPTED EVIDENCE:\n${evText}` },
  ], { temperature: 0.2, maxTokens: 4000, json: true, callType: 'perf_assess' });
  const result = parseAssessment(reply.text, { skills, bySkill });
  return store.saveAssessment(slot, role.id, { ...result, evidenceRead: chosen.length, model: reply.model });
}

module.exports = { assess, parseAssessment, selectEvidence, RATINGS, READINESS };
