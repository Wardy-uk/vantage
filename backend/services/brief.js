'use strict';

/**
 * The coaching brief — the coach speaking first.
 *
 * The coaching screen was reactive: it waited to be asked. That is the wrong
 * shape for the problem it exists to help with, because the failure mode being
 * coached is *not noticing*, and a tool you have to remember to consult cannot
 * help with not remembering.
 *
 * So this reads what is actually happening — the department radar AND the
 * behavioural signals about Nick — and proposes two or three things worth
 * working on, unprompted.
 *
 * Three rules that keep it useful rather than motivational:
 *
 * 1. **Every theme must cite its evidence.** "You seem stretched" is worthless.
 *    "You have logged six findings and raised one, and the oldest is nine days"
 *    is a conversation.
 * 2. **It ends with a question, not a task list.** Nick does not have a shortage
 *    of tasks; the tool's value is asking the thing he is working around.
 * 3. **It is allowed to say there is nothing.** A brief that always finds three
 *    development areas is a horoscope, and will be treated as one by week three.
 *
 * The brief is generated on demand and cached for the day. It is deliberately
 * not scheduled or pushed: a coaching prompt that arrives unbidden every morning
 * becomes wallpaper.
 */

const openrouter = require('./openrouter');
const radar = require('./radar');
const self = require('./self');
const coachSvc = require('./coach');
const db = require('./../db');

const CACHE_MS = 6 * 60 * 60 * 1000;
let cache = { at: 0, key: null, data: null };

const SYSTEM = `You are Nick Ward's leadership coach, writing him a short brief without being asked.

${coachSvc.SITUATION}

YOUR TASK
Read the evidence below and identify AT MOST THREE things worth his attention as a
leader this week. Fewer is better. Zero is a legitimate answer if nothing stands out.

For each one:
- Name the pattern plainly, in a sentence.
- Cite the specific evidence. Numbers, ticket keys, names, dates — whatever is in
  the data. Never a general impression.
- Say why it matters for him specifically, not in the abstract.
- End with ONE question for him to sit with. Not a task, not advice. A question
  he cannot answer without thinking.

WHAT TO LOOK FOR, in rough priority order:
1. Gaps between what he has NOTICED and what he has SAID. The register records
   both dates. An unraised high-severity finding is the single most relevant
   pattern available, because "he did not surface it" is the doubt on record.
2. Displacement. What gets dropped when the week is busy — rescheduled 1:1s,
   commitments made without dates, his own actions going overdue while the
   department's improve.
3. Where he is doing the department's work instead of leading it. Building
   instruments is genuinely valuable and also a comfortable place to hide.
4. Things going wrong that he has not connected to each other.
5. Something going WELL that he is discounting. He under-credits delivery, and a
   brief that only ever finds problems will be avoided.

RULES
- Be direct. He is senior and technical. Do not cushion.
- Do NOT invent evidence. If the data does not support a theme, drop the theme.
- Do NOT restate the radar back to him. He can read it. Say what it MEANS.
- Never more than one question per theme.
- If the honest answer is "nothing this week stands out", say exactly that and stop.

Respond ONLY with JSON:
{"themes":[{"title":"short","evidence":"the specific facts","why":"why it matters for him","question":"one question"}],"note":"optional one-line framing, or empty"}`;

/** Compact the evidence so the model sees signal rather than a data dump. */
function buildEvidence(radarData, selfData) {
  const lines = [];

  lines.push('## What he has found, and whether he said anything');
  const f = selfData.findings;
  lines.push(`- ${f.total} findings logged, ${f.raised} raised with anyone, ${f.unraised} not.`);
  if (f.medianDaysToRaise !== null) lines.push(`- Median days from finding to raising: ${f.medianDaysToRaise}.`);
  if (f.highUnraised) lines.push(`- ${f.highUnraised} HIGH severity findings have never been raised.`);
  for (const a of f.ageingUnraised) {
    lines.push(`- Unraised ${a.ageDays} days (${a.severity}): "${a.title}"`);
  }

  lines.push('\n## The improvement plan');
  const p = selfData.plan;
  lines.push(`- Of ${p.mineTotal} actions that are HIS: ${p.mineMoving} moving or done, ${p.mineNotStarted} not started.`);
  lines.push(`- Of the actions that are not his: ${p.notMineEscalated} escalated, ${p.notMineUntouched} untouched.`);

  if (selfData.oneToOnes) {
    lines.push('\n## 1:1 cadence');
    lines.push(`- ${selfData.oneToOnes.totalReschedules} reschedules across ${selfData.oneToOnes.peopleWithReschedules} people.`);
    for (const w of selfData.oneToOnes.worst) lines.push(`- ${w.person}: moved ${w.moveCount} times.`);
  }

  if (selfData.commitments) {
    const c = selfData.commitments;
    lines.push('\n## His own commitments');
    lines.push(`- ${c.openLast30} open from the last 30 days; ${c.madeInMeetings} made in meetings, of which ${c.meetingsUndated} carry no date.`);
  }

  const o = selfData.observations;
  if (o.total) {
    lines.push('\n## What he has noticed about himself');
    lines.push(`- ${JSON.stringify(o.byKind)}`);
    for (const r of o.recent) lines.push(`- [${r.kind}, ${r.when}] ${r.note}`);
  }

  lines.push('\n## The department right now');
  for (const i of (radarData?.items || []).slice(0, 14)) {
    lines.push(`- [${i.tense}/${i.severity}] ${i.source}: ${i.title} — ${(i.detail || '').slice(0, 160)}`);
  }
  if (radarData?.blind?.length) {
    lines.push(`- NOTE: ${radarData.blind.length} signal source(s) could not be read, so the picture is incomplete.`);
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

  const evidence = buildEvidence(radarData, selfData);
  const key = `${selfData.findings.total}:${selfData.findings.raised}:${(radarData?.items || []).length}`;

  if (!force && cache.data && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.data, cached: true };
  }

  const reply = await openrouter.complete(
    [{ role: 'system', content: SYSTEM }, { role: 'user', content: evidence }],
    { temperature: 0.4, maxTokens: 2500, json: true },
  );

  // Same tolerant extraction the meeting analyser uses — a malformed tail costs
  // one theme, not the brief.
  const themes = radar.extractItems(reply.text).filter(t => t.title && t.question);

  const data = {
    generatedAt: new Date().toISOString(),
    themes,
    evidenceUsed: {
      findings: selfData.findings,
      plan: selfData.plan,
      oneToOnes: selfData.oneToOnes,
      commitments: selfData.commitments,
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

/**
 * Turn a theme into a coaching conversation, pre-loaded with its own question.
 *
 * The brief's value collapses if reading it is where it ends. This is the step
 * from "that is a fair point" to actually working it through.
 */
function startFrom(theme) {
  if (!theme?.title) throw new Error('A theme is required');
  const session = coachSvc.createSession({ title: theme.title.slice(0, 60), mode: 'reflect' });
  db.insert('messages', {
    session_id: session.id,
    role: 'assistant',
    content: `${theme.evidence || ''}\n\n${theme.why || ''}\n\n**${theme.question}**`.trim(),
    created_at: new Date().toISOString(),
  });
  return coachSvc.getSession(session.id);
}

module.exports = { generate, startFrom, buildEvidence };
