'use strict';

/**
 * Mapping the Support Review's 35 actions onto work that already exists.
 *
 * ── Why a model, when there is already a scorer ─────────────────────────────
 *
 * NEURO's `task-dedupe` is a good matcher for the job it was built for: two
 * systems holding the SAME task, worded nearly the same. This is a different
 * job. The review is written in formal management English; the work is written
 * in Nick's shorthand, at speed, with typos. Measured against live data on
 * 20 Aug 2026, word overlap found candidates for 4 of 35 actions, and its top
 * suggestion was sometimes the wrong item:
 *
 *   Q6  "Reinstate regular 1:1s for every Customer Care colleague"
 *   ↔   "Re-instate reglar 121s with team"        scored NOTHING
 *   Q3  "Daily cross-functional blocker review"
 *   ↔   "Consider options for establishing daily 15 mins cross team huddle"
 *                                                  scored 0.41, under the line
 *
 * No threshold fixes that: lowering it promotes wrong pairs before it finds
 * these. The two texts mean the same thing without sharing words, which is
 * precisely what a language model is for and a bag of tokens is not.
 *
 * ── What stops it inventing things ──────────────────────────────────────────
 *
 * The model NEVER produces a task. It is given a numbered list of candidates
 * and may only return ids from it; every id is checked against the set it was
 * given and anything else is dropped and counted. So the worst case is a wrong
 * pairing between two real items, which Nick rejects in one click — not a
 * fabricated task, and not a link to something that does not exist.
 *
 * Nothing it returns is applied. Every pair is a proposal shown next to the
 * action, and creating or merging anything still takes a deliberate click.
 *
 * ── Absence ─────────────────────────────────────────────────────────────────
 *
 * No key, a failed call or an unparseable answer all return `available: false`
 * with a reason. None of them return an empty list of pairs — "the model found
 * nothing" and "the model never ran" must never look the same on the screen.
 */

const openrouter = require('./openrouter');
const cache = require('./cache');
const { extractItems } = require('./radar');
const plan = require('./plan');

/** Cheap and consistent; this is classification, not prose. */
const MODEL = process.env.VANTAGE_MATCH_MODEL || openrouter.DEFAULT_MODEL;

const CACHE_KEY = 'plan-match';
/** Six hours. The board and the task list move in days, not minutes. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const CONFIDENCE = ['high', 'medium', 'low'];

const SYSTEM = `You are mapping a formal improvement plan onto work that has already been captured somewhere else.

Nick Ward is Head of Service Delivery at a proptech SaaS company. A Support Review produced 35 numbered actions, written in formal management language. Separately, Nick and his manager have been capturing work as tasks and on a Microsoft Planner board, written informally, at speed, often with typos and abbreviations ("121s" means one-to-one meetings, "T2"/"DD" are support tiers).

Your job: for each plan action, say which EXISTING candidate — if any — is the same piece of work.

Rules, in order of importance:

1. ONLY return candidate ids from the list you are given, exactly as written. Never invent an id, a task or a wording. If you are unsure of an id, omit the pair.
2. A pair means SAME JOB, not same topic. "Publish triage criteria" and "review ticket types" are both about tickets and are not the same job. Being about the same area is not enough.
3. Most actions will have NO match. Returning few pairs is the correct answer, and is far better than filling the list. Do not try to cover all 35.
4. One candidate belongs to at most one action. If two actions fit, choose the closer and drop the other.
5. Judge by meaning, not words. Typos, abbreviations and completely different phrasing are expected — "Re-instate reglar 121s with team" IS "Reinstate regular 1:1s for every colleague".
6. Confidence: "high" only when you would defend the pair to someone reviewing Nick's performance. "low" means plausible but genuinely uncertain.
7. "why" is one short sentence a human can check at a glance. No hedging, no restating both texts.

Respond ONLY with JSON:
{"pairs":[{"plan":"Q6","candidate":"m:AAA111","confidence":"high","why":"both are restarting regular 1:1s with the team"}]}`;

/** The candidate list as the model sees it — ids it may return, and nothing else. */
function renderCandidates({ tasks = [], microsoft = [] }) {
  const lines = [];
  for (const t of tasks) {
    lines.push(`n:${t.id} | ${t.text}${t.dueDate ? ` (due ${t.dueDate})` : ''}${t.microsoft ? ` [also on ${t.microsoft.source}]` : ''}`);
  }
  for (const m of microsoft) {
    lines.push(`m:${m.msId} | ${m.text}${m.dueDate ? ` (due ${m.dueDate})` : ''} [${m.source}]`);
  }
  return lines.join('\n');
}

function renderActions() {
  return plan.PLAN
    .map(p => `${p.id} | ${p.title} (${plan.HORIZONS[p.horizon]})`)
    .join('\n');
}

/**
 * Run the pass. Returns proposals keyed by plan id.
 *
 * `only` narrows the actions asked about — used to skip ones already linked, so
 * the model is not spending attention re-deciding settled questions.
 */
async function propose(catalogue, { only = null } = {}) {
  if (!openrouter.isConfigured()) {
    return { available: false, reason: 'No OpenRouter key is set', pairs: {} };
  }

  const actions = only ? plan.PLAN.filter(p => only.includes(p.id)) : plan.PLAN;
  if (!actions.length) return { available: true, pairs: {}, model: MODEL, dropped: 0 };

  const candidateText = renderCandidates(catalogue);
  if (!candidateText) {
    // Nothing to match against is NOT "no matches". Said plainly, because a
    // silent empty result here is exactly the false all-clear this tool exists
    // to avoid.
    return { available: false, reason: 'There were no tasks or Planner items to match against', pairs: {} };
  }

  // The ids the model is allowed to use. Anything outside this set is dropped.
  const allowed = new Set([
    ...catalogue.tasks.map(t => `n:${t.id}`),
    ...catalogue.microsoft.map(m => `m:${m.msId}`),
  ]);
  const allowedActions = new Set(actions.map(p => p.id));

  const user = `PLAN ACTIONS:\n${actions.map(p => `${p.id} | ${p.title}`).join('\n')}\n\nCANDIDATES (use these ids exactly):\n${candidateText}`;

  let reply;
  try {
    reply = await openrouter.complete(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      { model: MODEL, temperature: 0, maxTokens: 3000, json: true },
    );
  } catch (err) {
    return { available: false, reason: `The matching model failed: ${err.message}`, pairs: {} };
  }

  const items = extractItems(reply.text, { required: 'plan' });
  if (!items.length && !/"pairs"\s*:\s*\[\s*\]/.test(reply.text || '')) {
    // An unparseable answer is a failure, not a finding of nothing. An answer
    // that genuinely said `"pairs": []` is a finding of nothing, and says so.
    return { available: false, reason: 'The matching model returned nothing readable', pairs: {} };
  }

  const pairs = {};
  const usedCandidates = new Set();
  let dropped = 0;

  for (const it of items) {
    const planId = String(it.plan || '').trim();
    const candidate = String(it.candidate || '').trim();

    // The whitelist. A hallucinated id, an action that was not asked about, or a
    // candidate already spoken for is discarded — counted, never silently.
    if (!allowedActions.has(planId) || !allowed.has(candidate)) { dropped += 1; continue; }
    if (pairs[planId] || usedCandidates.has(candidate)) { dropped += 1; continue; }

    usedCandidates.add(candidate);
    pairs[planId] = {
      kind: candidate.startsWith('m:') ? 'microsoft' : 'neuro',
      ref: candidate.slice(2),
      confidence: CONFIDENCE.includes(it.confidence) ? it.confidence : 'low',
      why: typeof it.why === 'string' ? it.why.slice(0, 300) : '',
    };
  }

  return { available: true, pairs, model: MODEL, dropped, asked: actions.length };
}

/**
 * Cached. The pass costs a model call and the inputs move in days, so a page
 * load must not trigger one — but a stale proposal is still worth showing, with
 * its age, rather than nothing.
 */
function cached(catalogue, { only = null, force = false } = {}) {
  return cache.get(CACHE_KEY, () => propose(catalogue, { only }), { maxAgeMs: MAX_AGE_MS, force });
}

module.exports = { propose, cached, CACHE_KEY, MODEL };
