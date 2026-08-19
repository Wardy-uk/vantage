'use strict';

/**
 * The coaching brief — designed around how Nick's attention actually works.
 *
 * The first version was reactive, then confronting. Both were wrong for the same
 * reason: Nick is neurodivergent (ADHD, disclosed, OH report received) and his
 * difficulty is INITIATION, not knowledge. The PIP says so in as many words —
 * "difficulty initiating and prioritising management tasks without external
 * structure or support". A tool that repeatedly tells him what he already knows
 * he should do is not support; it is the problem restated more loudly.
 *
 * Worse, a growing register of undone things is not motivating for this brain.
 * It is the thing that produces the avoidance it is measuring. The earlier
 * version accurately described the problem while quietly making it worse.
 *
 * So the design rules changed:
 *
 * 1. **Name a pattern ONCE.** Every theme surfaced is remembered. The prompt is
 *    given that history and told not to re-diagnose. A hard truth said weekly
 *    stops being insight and becomes background shame.
 * 2. **Lead with the smallest possible next action**, and DO the preparatory
 *    part — the actual first sentence, the drafted message. "Raise it with
 *    Chris" is a task. A message he can read and send is not.
 * 3. **One thing.** Not a list. A list is a working-memory tax and an invitation
 *    to pick nothing.
 * 4. **Credit what moved.** ADHD brains systematically under-register
 *    completion, and a tool that only ever shows the outstanding column is
 *    lying by omission.
 *
 * It remains honest. It will still say a difficult thing. It will just say it
 * once, and then spend its effort making the next step smaller.
 */

const openrouter = require('./openrouter');
const radar = require('./radar');
const self = require('./self');
const coachSvc = require('./coach');
const db = require('./../db');

const CACHE_MS = 6 * 60 * 60 * 1000;
/** A pattern named within this many days is not named again. */
const RENAME_AFTER_DAYS = 21;

let cache = { at: 0, key: null, data: null };

const SYSTEM = `You are Nick Ward's leadership coach, writing a short brief without being asked.

${coachSvc.SITUATION}

HOW HE WORKS — this changes what is useful
Nick is neurodivergent (ADHD, disclosed; occupational health report received).
His difficulty is INITIATION, not knowledge. He almost always knows what should
be done. What stops him is starting, particularly on interpersonal tasks that
have no clear first move. His PIP names this directly: "difficulty initiating and
prioritising management tasks without external structure or support."

Consequences you must respect:
- Telling him what he ought to do is nearly worthless. He knows.
- A list of outstanding items produces avoidance, not action. Give him ONE thing.
- The most useful thing you can do is REMOVE THE FIRST STEP. Draft the message.
  Write the opening sentence. Name the person and the time. Do the part that
  requires starting from nothing, so what is left is editing rather than
  initiating.
- Repeating a criticism he has already accepted turns into shame, and shame
  produces more avoidance. Say a hard thing once, then help.
- He under-registers what he has finished. If something real moved, say so
  plainly — not as encouragement, as accurate reporting.

YOUR OUTPUT
At most TWO themes, and one is usually better. Zero is legitimate.

For each theme:
- "title": short and plain.
- "evidence": the specific facts. Numbers, names, dates, ticket keys.
- "why": why it matters for him. ONE sentence. Skip entirely if it has been
  named before — see ALREADY NAMED below.
- "question": one question, only if genuinely useful. Otherwise leave empty.
- "nextStep": THE MOST IMPORTANT FIELD. The smallest concrete action, already
  started for him. If it is a message, write the message. If it is a
  conversation, write the opening sentence. Never "consider", "reflect on" or
  "make time for".

ALREADY NAMED
Patterns listed as already named must NOT be re-diagnosed. You may reference one
in a single clause if the next step depends on it, but do not restate the
analysis, do not add fresh commentary on his character, and do not say it again
in different words. Move to what makes it easier.

ALSO
- Never invent evidence. Drop a theme rather than pad it.
- Do not restate the radar. He can read it.
- If something meaningful got finished, include it as "done" — one line, factual.

Respond ONLY with JSON:
{"themes":[{"title":"","evidence":"","why":"","question":"","nextStep":""}],"done":"one line on what actually moved, or empty"}`;

// ── Theme memory ─────────────────────────────────────────────────────────────

function namedThemes() {
  const cutoff = new Date(Date.now() - RENAME_AFTER_DAYS * 86_400_000).toISOString();
  return db.find('brief_themes', t => (t.named_at || '') >= cutoff);
}

function rememberThemes(themes) {
  const now = new Date().toISOString();
  const known = new Set(namedThemes().map(t => (t.title || '').toLowerCase()));
  for (const t of themes) {
    const key = (t.title || '').toLowerCase();
    if (!key || known.has(key)) continue;
    db.insert('brief_themes', { title: t.title, named_at: now });
  }
}

// ── Evidence ─────────────────────────────────────────────────────────────────

function buildEvidence(radarData, selfData, alreadyNamed) {
  const lines = [];

  if (alreadyNamed.length) {
    lines.push('## ALREADY NAMED — do not re-diagnose these');
    for (const t of alreadyNamed) lines.push(`- "${t.title}" (first raised ${t.named_at.slice(0, 10)})`);
    lines.push('');
  }

  lines.push('## What moved recently');
  const d = selfData.done;
  lines.push(`- ${d.findingsRaised} finding(s) raised in the last 7 days.`);
  lines.push(`- ${d.findingsWithAction} finding(s) now carry a recorded action.`);
  lines.push(`- ${d.planMoved} improvement-plan action(s) of his are in progress or done.`);

  lines.push('\n## Found versus said');
  const f = selfData.findings;
  lines.push(`- ${f.total} findings logged, ${f.raised} raised, ${f.unraised} not.`);
  if (f.highUnraised) lines.push(`- ${f.highUnraised} are HIGH severity and unraised.`);
  for (const a of f.ageingUnraised.slice(0, 3)) {
    lines.push(`- Unraised ${a.ageDays}d (${a.severity}): "${a.title}"`);
  }

  lines.push('\n## The improvement plan');
  const p = selfData.plan;
  lines.push(`- Of ${p.mineTotal} actions that are his: ${p.mineMoving} moving, ${p.mineNotStarted} not started.`);

  if (selfData.oneToOnes) {
    lines.push('\n## 1:1 cadence');
    lines.push(selfData.oneToOnes.totalReschedules === 0
      ? '- No reschedules recorded. May mean none happened, or that they are not captured. Evidence of nothing either way.'
      : `- ${selfData.oneToOnes.totalReschedules} reschedules across ${selfData.oneToOnes.peopleWithReschedules} people.`);
  }

  if (selfData.commitments && !selfData.commitments.attributionAvailable) {
    lines.push('\n## Vault action items');
    lines.push(`- ${selfData.commitments.openLast30} open in 30 days, none carrying an assignee.`);
    lines.push('- NOT known to be his. Do not describe them as his commitments.');
  }

  const o = selfData.observations;
  if (o.total) {
    lines.push('\n## What he has noticed about himself');
    for (const r of o.recent.slice(0, 3)) lines.push(`- [${r.kind}] ${r.note}`);
  }

  lines.push('\n## The department right now');
  for (const i of (radarData?.items || []).slice(0, 10)) {
    lines.push(`- [${i.tense}/${i.severity}] ${i.source}: ${i.title}`);
  }
  if (radarData?.blind?.length) {
    lines.push(`- NOTE: ${radarData.blind.length} source(s) unreadable; picture incomplete.`);
  }

  return lines.join('\n');
}

async function generate({ force = false } = {}) {
  const [radarData, selfData] = await Promise.all([
    radar.build().catch(() => null),
    self.snapshot().catch(() => null),
  ]);

  if (!selfData) throw new Error('Could not read the behavioural signals');
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — the brief needs a model');

  const alreadyNamed = namedThemes();
  const evidence = buildEvidence(radarData, selfData, alreadyNamed);
  const key = `${selfData.findings.total}:${selfData.findings.raised}:${(radarData?.items || []).length}:${alreadyNamed.length}`;

  if (!force && cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.data, cached: true };
  }

  const reply = await openrouter.complete(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: evidence }],
    { temperature: 0.4, maxTokens: 2500, json: true },
  );

  const themes = radar.extractItems(reply.text).filter(t => t.title);
  rememberThemes(themes);

  // `done` sits outside the items array, so the tolerant extractor does not see
  // it. Pulled separately, and its absence is not an error.
  let done = '';
  const m = reply.text.match(/"done"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) { try { done = JSON.parse(`"${m[1]}"`); } catch { done = m[1]; } }

  const data = {
    generatedAt: new Date().toISOString(),
    themes,
    done,
    previouslyNamed: alreadyNamed.map(t => t.title),
    evidenceUsed: {
      findings: selfData.findings,
      plan: selfData.plan,
      done: selfData.done,
      radarItems: (radarData?.items || []).length,
    },
    unavailable: [
      ...(selfData.unavailable || []),
      ...((radarData?.blind || []).map(b => ({ name: b.name, reason: b.reason }))),
    ],
  };

  cache = { at: Date.now(), key, data };
  return data;
}

/** Open a coaching conversation from a theme, carrying its next step. */
function startFrom(theme) {
  if (!theme?.title) throw new Error('A theme is required');
  const session = coachSvc.createSession({ title: theme.title.slice(0, 60), mode: 'reflect' });
  const body = [theme.evidence, theme.why, theme.nextStep ? `**Next step:** ${theme.nextStep}` : '', theme.question ? `**${theme.question}**` : '']
    .filter(Boolean).join('\n\n');
  db.insert('messages', {
    session_id: session.id, role: 'assistant', content: body, created_at: new Date().toISOString(),
  });
  return coachSvc.getSession(session.id);
}

module.exports = { generate, startFrom, buildEvidence, namedThemes };
