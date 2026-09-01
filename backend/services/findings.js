'use strict';

/**
 * The findings register — what Nick spotted, when, and what he did about it.
 *
 * This is the evidence half of VANTAGE, and it exists because of one sentence:
 * "it wasn't him that surfaced this information, when he should have."
 *
 * A radar that shows risk is useful. A dated record of Nick having found a risk
 * BEFORE anyone asked, and what he did next, is the thing that actually answers
 * the doubt — and it is the only artefact here that no other system produces.
 * NOVA knows the tickets, NEURO knows the people; neither knows who noticed.
 *
 * Design decisions worth keeping:
 *
 * - `found_on` is when it was SPOTTED, not when it was typed. The gap between
 *   the two is itself a measure, and backdating honestly beats a register that
 *   only proves he can use a form.
 * - `raised_with` / `raised_on` are separate from the finding. Spotting
 *   something and telling someone are different acts, and only the second one
 *   counts as proactive escalation. A finding with no `raised_on` is a private
 *   observation, and the register says so rather than flattering it.
 * - Nothing is deleted on resolve. The register is a history, not a to-do list;
 *   its value at a 90-day review is entirely in what it still remembers.
 */

const db = require('../db');

const SEVERITIES = ['high', 'medium', 'low'];
/**
 * `resolved_pending` is the honest gap between two systems.
 *
 * NEURO's task being ticked proves the work was done; it does not say WHAT was
 * done, and that sentence is the whole value of a resolved finding at a review.
 * So a tick in NEURO moves a finding to `resolved_pending` and the register
 * asks for the sentence, rather than either ignoring the tick or inventing a
 * resolution nobody wrote.
 */
const STATUSES = ['open', 'raised', 'resolved_pending', 'resolved', 'accepted'];

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

function list({ status, since, limit = 200 } = {}) {
  return db.find('findings', f =>
    (!status || f.status === status) && (!since || (f.found_on || '') >= since))
    .sort((a, b) => (b.found_on || '').localeCompare(a.found_on || ''))
    .slice(0, limit);
}

function add({ title, detail, source, severity = 'medium', foundOn, action, raisedWith, raisedOn, tense } = {}) {
  if (!title?.trim()) throw new Error('A finding needs a title.');
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);

  return db.insert('findings', {
    title: title.trim(),
    detail: (detail || '').trim(),
    source: source || 'manual',
    severity,
    // Which radar tense this came from, so an unresolved finding can be pinned
    // back onto the radar in the section it belongs to. Null for anything typed
    // in by hand — and it stays null rather than being guessed, because
    // "already gone wrong" and "could go wrong" demand different responses and
    // a wrong one is worse than an unplaced card.
    tense: ['happened', 'happening', 'could'].includes(tense) ? tense : null,
    // Defaults to today, but explicitly settable — a finding spotted on Tuesday
    // and logged on Thursday should say Tuesday.
    found_on: foundOn || today(),
    action: (action || '').trim(),
    raised_with: raisedWith || null,
    raised_on: raisedOn || null,
    status: raisedOn ? 'raised' : 'open',
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function update(id, patch = {}) {
  const allowed = ['title', 'detail', 'severity', 'action', 'raised_with', 'raised_on', 'status', 'found_on'];
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.includes(k)) clean[k] = v;
  }
  if (clean.severity && !SEVERITIES.includes(clean.severity)) throw new Error('bad severity');
  if (clean.status && !STATUSES.includes(clean.status)) throw new Error('bad status');
  // Recording who it was raised with implies it HAS been raised. Leaving the
  // status behind would understate the thing the register exists to evidence.
  if (clean.raised_on && !clean.status) clean.status = 'raised';
  clean.updated_at = nowIso();
  return db.update('findings', id, clean);
}

/**
 * Close a finding, with the sentence that says how.
 *
 * The reason is REQUIRED and that is the point of the button. "Resolved" on its
 * own is the least useful thing this register could record: at a review the
 * question is never whether something was closed, it is what was done about it.
 * A finding closed with no account of what changed is indistinguishable from
 * one quietly dropped, which is the failure the whole register exists to avoid.
 *
 * Nothing is deleted. `resolved_on` sits alongside `found_on` and `raised_on`,
 * so the three dates together are the story: spotted, told someone, fixed.
 */
function resolve(id, { how, on } = {}) {
  if (!how?.trim()) throw new Error('Say what was done to resolve it — "resolved" on its own records nothing.');
  const f = db.findOne('findings', x => x.id === id);
  if (!f) throw new Error(`No finding ${id}`);
  return db.update('findings', id, {
    status: 'resolved',
    resolved_how: how.trim(),
    resolved_on: on || today(),
    updated_at: nowIso(),
  });
}

/** Back to open, keeping what was written — a resolution can turn out to be wrong. */
function reopen(id) {
  const f = db.findOne('findings', x => x.id === id);
  if (!f) throw new Error(`No finding ${id}`);
  return db.update('findings', id, {
    status: f.raised_on ? 'raised' : 'open',
    reopened_on: today(),
    updated_at: nowIso(),
  });
}

function remove(id) {
  return db.remove('findings', f => f.id === id);
}

/**
 * The register as markdown, for pasting into the Weekly Risk & Anomaly Summary.
 *
 * Deliberately an EXPORT rather than an automatic write into NEURO. The weekly
 * report is the document Chris assesses, and what goes into it should be a
 * decision Nick makes, not a side effect of a tool having noticed something —
 * the same reason weekly-risk refuses to assert its own manual sections.
 */
function markdown({ since } = {}) {
  const items = list({ since });
  if (!items.length) return '_No findings recorded in this period._';

  const raised = items.filter(f => f.raised_on);
  const unraised = items.filter(f => !f.raised_on);

  const lines = [];
  lines.push(`**${items.length} finding${items.length === 1 ? '' : 's'} recorded**`
    + `${since ? ` since ${since}` : ''}`
    + ` — ${raised.length} raised, ${unraised.length} not yet raised.`);
  lines.push('');
  lines.push('| Found | Finding | Severity | Raised with | Raised | Action |');
  lines.push('|---|---|---|---|---|---|');
  for (const f of items) {
    // A closed finding's best evidence is what was DONE, so the resolution goes
    // in the action column rather than being left to a status word nobody can
    // see in a pasted table.
    const action = [
      f.action || null,
      f.status === 'resolved' && f.resolved_how ? `Resolved ${f.resolved_on || ''}: ${f.resolved_how}`.trim() : null,
      f.status === 'resolved_pending' ? 'Marked done in NEURO — resolution not yet written up.' : null,
    ].filter(Boolean).join(' · ') || '—';
    lines.push(`| ${f.found_on} | ${f.title} | ${f.severity} | ${f.raised_with || '—'} | ${f.raised_on || '—'} | ${action} |`);
  }

  if (unraised.length) {
    lines.push('');
    lines.push(`_${unraised.length} finding${unraised.length === 1 ? ' has' : 's have'} not been raised with anyone. Spotting and escalating are different acts; only the second is evidence of proactive escalation._`);
  }
  return lines.join('\n');
}

/**
 * Draft the message that raises a finding.
 *
 * This is the whole point of the register's second half. "Raise it with Chris"
 * is a task, and tasks that start from a blank page are exactly the ones that
 * do not get started — the PIP names that difficulty explicitly. A message he
 * can read, adjust and send is not a task; it is a decision, and decisions he
 * makes fine.
 *
 * Written in his voice and kept short. It states what was found, what it means,
 * and what has been done — no apology, no preamble, no self-criticism. A
 * finding raised defensively reads worse than one raised plainly, and this is
 * evidence going to the person assessing him.
 */
async function draftRaise(id, { to = 'Chris' } = {}) {
  const openrouter = require('./openrouter');
  const f = db.findOne('findings', x => x.id === id);
  if (!f) throw new Error(`No finding ${id}`);
  if (!openrouter.isConfigured()) throw new Error('No OpenRouter key — cannot draft');

  const reply = await openrouter.complete([
    {
      role: 'system',
      content: `Write a short message from Nick Ward (Head of Service Delivery) to ${to}, raising something he has found.

RULES
- His voice: direct, British, unfussy. No corporate padding.
- Four things, in order: what he found, why it matters, what he has already done, what he needs from ${to} (if anything).
- Under 120 words.
- NO apologising. No "sorry to bother you", no "I may have missed something".
- No self-criticism and no defensiveness. If the finding is about a system he
  owns, state it as a fact rather than a confession — he found it, which is the
  point.
- If nothing is needed from ${to}, say it is for visibility and say so plainly.
- Plain text. No subject line, no sign-off, no markdown.`,
    },
    {
      role: 'user',
      content: `FINDING: ${f.title}\n\nDETAIL: ${f.detail}\n\nSEVERITY: ${f.severity}\nFOUND: ${f.found_on}\nACTION ALREADY TAKEN: ${f.action || 'none recorded'}`,
    },
  ], { temperature: 0.5, maxTokens: 400 });

  return { findingId: id, to, draft: reply.text.trim() };
}

/**
 * Put a finding on NEURO's weekly risk report — the "Escalations to Chris" list.
 *
 * This is the one automated step in the Radar → log → Findings → report chain,
 * and it is deliberately the LAST one. Everything before it is Nick deciding
 * something is worth recording; this is Nick deciding it is worth Chris seeing.
 * Nothing is sent: the line lands in the manual section of the report NEURO
 * builds, and publishing and sending it stay where they were.
 *
 * Three things worth knowing, because each is a way this could quietly mislead:
 *
 * 1. NEURO's `setManual` REPLACES a field rather than merging into it, so the
 *    list has to be read, appended to and written back. Two people doing that
 *    at once would lose one line — acceptable here (one person, one browser),
 *    and the alternative is a PATCH endpoint NEURO does not have.
 *
 * 2. `escalateToChris` is THREE-valued in NEURO: `null` means "not yet
 *    confirmed" and blocks publication, `[]` means "nothing to escalate — a
 *    decision", and a list means these. Adding the first line therefore ANSWERS
 *    that section and clears NEURO's blocker, which is a real consequence of a
 *    small click: it stops NEURO asking whether there was anything else. So the
 *    result says when that happened, and the screen has to say it too.
 *
 * 3. It does NOT mark the finding raised. Appearing on a report that has not
 *    been sent is not the same as having raised something, and `raised_on` is
 *    the field the register uses to evidence proactive escalation. Faking that
 *    date here would corrupt the one number this whole register exists to
 *    produce.
 */
async function escalate(id, { week = null } = {}) {
  const neuro = require('./neuro');
  const f = db.findOne('findings', x => x.id === id);
  if (!f) throw new Error(`No finding ${id}`);
  if (!neuro.isConfigured()) throw new Error('No NEURO credential set — cannot reach the weekly risk report');

  const current = await neuro.weeklyRiskManual(week);
  const targetWeek = current.week;
  const list = Array.isArray(current.manual?.escalateToChris) ? current.manual.escalateToChris : [];

  // Matched on the TITLE rather than on a marker injected into the line. A
  // marker would be the exact check, and it would also be machine noise in a
  // document Chris reads. The cost is that Nick rewriting a line beyond
  // recognition would let it be added twice, which he can see and delete.
  const existing = list.find(x => typeof x === 'string' && x.includes(f.title));
  if (existing) {
    return { ok: true, already: true, week: targetWeek, line: existing, count: list.length };
  }

  const provenance = f.raised_on
    ? `Raised with ${f.raised_with || 'someone'} on ${f.raised_on}.${f.action ? ` ${f.action}` : ''}`
    : `Spotted ${f.found_on}; not raised separately — this report is the escalation.`;
  const line = `${f.title} — ${f.detail || 'No detail recorded.'} ${provenance}`.replace(/\s+/g, ' ').trim();

  const wasUnconfirmed = current.manual?.escalateToChris === null;
  const saved = await neuro.setWeeklyRiskManual({ escalateToChris: [...list, line] }, targetWeek);

  // A risk and a task are different objects doing different jobs, and a finding
  // needs both: the report line is what Chris reads, the task is what makes it
  // get done. Without the task it is a thing that was reported and then nobody
  // owned — which is precisely the pattern the Support Review found.
  //
  // Never allowed to fail the escalation. The line is on the report either way,
  // and a 500 here would send Nick back to click again and duplicate it.
  let task = null;
  try {
    const created = await neuro.createTask({
      text: f.title,
      notes: `${f.detail || ''}

VANTAGE finding, spotted ${f.found_on}. On the w/c ${targetWeek} risk report.`.trim(),
      source: 'vantage-finding',
    });
    // Same id-shape tolerance plan-tasks already needs: NEURO has answered
    // with the row at the top level and nested under `task` at different times.
    const taskId = created.id ?? created.task?.id ?? created.data?.id ?? null;
    task = { id: taskId, created: created.created !== false };
  } catch (err) {
    task = { id: null, created: false, error: err.message };
  }

  db.update('findings', id, {
    neuro_week: targetWeek,
    neuro_escalated_on: nowIso(),
    ...(task.id ? { neuro_task_id: task.id } : {}),
    updated_at: nowIso(),
  });

  return {
    ok: true,
    already: false,
    week: targetWeek,
    line,
    count: (saved.manual?.escalateToChris || []).length,
    // True when this click also answered NEURO's "escalations confirmed?"
    // question. It is the thing most worth saying out loud: the section is no
    // longer blocking publication, so NEURO will not ask again.
    confirmedSection: wasUnconfirmed,
    blockers: saved.blockers || [],
    // Reported separately from the escalation, because half-landing is a real
    // outcome: "on the report, but no task" is a different thing to fix than
    // "neither", and one success message over both would hide it.
    task,
  };
}

/**
 * Bring NEURO's answer back: a finding whose task has been ticked is done.
 *
 * ONE call for every finding rather than one per finding — NEURO's task list is
 * a single read and there is no per-task endpoint worth the round trips.
 *
 * It moves a finding to `resolved_pending`, never straight to `resolved`. The
 * tick proves the work happened; it does not say what was done, and that
 * sentence is the thing worth having. A `dropped` task is NOT a resolution —
 * abandoning something is not fixing it — so it is recorded and shown, and the
 * finding stays open.
 *
 * Never writes back to NEURO. Resolving in VANTAGE does not tick the task: the
 * two systems are allowed to disagree, and closing someone's task from here on
 * the strength of a sentence typed in another tool is not a write this repo has
 * any business making.
 */
async function syncFromNeuro() {
  const neuro = require('./neuro');
  if (!neuro.isConfigured()) return { ok: false, reason: 'NEURO not configured', changed: [] };

  const linked = db.find('findings', x => x.neuro_task_id);
  if (!linked.length) return { ok: true, checked: 0, changed: [] };

  const payload = await neuro.allTasks();
  const byId = new Map((payload.tasks || []).map(t => [String(t.id), t]));

  const changed = [];
  for (const f of linked) {
    const task = byId.get(String(f.neuro_task_id));
    // A task NEURO no longer returns is not a done task. It could have been
    // merged, dropped or never created; saying nothing is the honest answer.
    if (!task) continue;
    const patch = { neuro_task_status: task.status || null, updated_at: nowIso() };
    if (task.status === 'done' && f.status !== 'resolved' && f.status !== 'resolved_pending') {
      patch.status = 'resolved_pending';
      patch.neuro_resolved_on = task.completed_at || today();
      changed.push({ id: f.id, title: f.title, to: 'resolved_pending' });
    }
    if (patch.neuro_task_status !== f.neuro_task_status || patch.status) db.update('findings', f.id, patch);
  }
  return { ok: true, checked: linked.length, changed };
}

module.exports = {
  list, add, update, remove, markdown, draftRaise,
  escalate, resolve, reopen, syncFromNeuro,
  SEVERITIES, STATUSES,
};
