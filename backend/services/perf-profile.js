'use strict';

/**
 * A job description becomes a proposed SFIA 9 profile (29 Oct 2026).
 *
 * Nick's decision: skills with a target level each, plus the role's level on the
 * five generic attributes. The model PROPOSES; nothing is saved until Nick
 * edits and confirms it (perf-store.saveRole). Same shape as plan-import.
 *
 * Every skill and attribute level must cite the JD's own words (`why`). A skill
 * the JD does not evidence is left out — a blank is "the JD does not ask for
 * this", never a capability gap (context/role.md).
 */

const openrouter = require('./openrouter');
const { extractText } = require('./plan-import');
const sfia = require('./sfia');

const MAX_TEXT = 40_000;
const MAX_SKILLS = 25;

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const lvl = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null; };

/** Validate a profile (the model's, or Nick's edited one). Pure. Refuses rather than repairs. */
function validateProfile(p, { strict = false } = {}) {
  const problems = [];
  if (!p || typeof p !== 'object') throw new Error('No profile');
  const title = str(p.title, 120);
  if (!title) throw new Error('The profile needs a role title');
  const attributes = {};
  for (const a of sfia.ATTRIBUTES) {
    const raw = p.attributes?.[a.key];
    const level = lvl(raw?.level);
    if (!level) { if (strict) throw new Error(`${a.name} needs a level from 1 to 7`); problems.push(`${a.name} had no usable level`); continue; }
    attributes[a.key] = { level, why: str(raw?.why, 300) || null };
  }
  const skills = [];
  const seen = new Set();
  for (const s of Array.isArray(p.skills) ? p.skills : []) {
    const code = String(s?.code || '').trim().toUpperCase();
    const level = lvl(s?.level);
    if (!sfia.CODE_RE.test(code)) { problems.push(`"${s?.code}" is not a SFIA code and was dropped`); continue; }
    if (!level) { if (strict) throw new Error(`${code} needs a level from 1 to 7`); problems.push(`${code} had no usable level and was dropped`); continue; }
    if (seen.has(code)) continue;
    if (skills.length >= MAX_SKILLS) { problems.push(`more than ${MAX_SKILLS} skills — the rest were dropped`); break; }
    seen.add(code);
    const check = sfia.checkCode(code);
    // Optional, aligned form (29 Oct 2026): `bar` = SFIA's own wording for the
    // target level (what the rating is judged against), `inRole` = what that
    // looks like in this job, `targets` = outcome KPIs, read as context only.
    skills.push({
      code, name: str(s?.name, 80) || code, level, why: str(s?.why, 400) || null, check,
      ...(str(s?.bar, 1200) ? { bar: str(s.bar, 1200) } : {}),
      ...(str(s?.inRole, 800) ? { inRole: str(s.inRole, 800) } : {}),
      ...(str(s?.targets, 400) ? { targets: str(s.targets, 400) } : {}),
    });
  }
  if (!skills.length) throw new Error('The profile has no skills');
  if (strict && Object.keys(attributes).length < sfia.ATTRIBUTES.length) throw new Error('All five generic attributes need a level');
  return { title, summary: str(p.summary, 400) || null, attributes, skills, problems };
}

const PROMPT = `You map a job description to the SFIA 9 framework. Answer ONLY with JSON:
{"title":"role title","summary":"one sentence","attributes":{"autonomy":{"level":5,"why":"..."},"influence":{...},"complexity":{...},"knowledge":{...},"business_skills":{...}},"skills":[{"code":"SLMO","name":"Service level management","level":5,"why":"..."}]}

RULES
- Use real SFIA 9 skill codes (four capital letters) and their official names. Never invent a code.
- Include only skills the document actually evidences. Typically 6 to 15. Do not pad.
- level is the SFIA level of responsibility (1-7) the ROLE requires, judged from the document's scope and authority. Level 6 needs organisation-wide influence the document states; do not award it for departmental authority.
- attributes are the five SFIA generic attributes, each at the level the role requires.
- why: quote or closely paraphrase the document's words that justify the level. No justification, no entry.`;

/** Read a JD and propose a profile. Writes nothing. Returns the text too, so Save can store it. */
async function propose(input = {}) {
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot read the document');
  const { text, from } = await extractText(input);
  const sent = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const reply = await openrouter.complete([
    { role: 'system', content: PROMPT },
    { role: 'user', content: `Document (${from}):\n\n${sent}` },
  ], { temperature: 0.1, maxTokens: 4000, json: true, callType: 'perf_profile' });
  let j;
  try { j = require('./perf-json').parseModelJson(reply.text); } catch { throw new Error('The model\'s answer was not readable JSON — nothing proposed. Try again.'); }
  const profile = validateProfile(j);
  if (text.length > MAX_TEXT) profile.problems.push(`The document was ${text.length} characters; only the first ${MAX_TEXT} were read`);
  return { profile, sourceName: from, sourceText: text, catalogue: sfia.catalogue() ? 'checked' : 'not-checked' };
}

module.exports = { propose, validateProfile, PROMPT };
