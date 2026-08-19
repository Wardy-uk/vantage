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
const STATUSES = ['open', 'raised', 'resolved', 'accepted'];

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);

function list({ status, since, limit = 200 } = {}) {
  return db.find('findings', f =>
    (!status || f.status === status) && (!since || (f.found_on || '') >= since))
    .sort((a, b) => (b.found_on || '').localeCompare(a.found_on || ''))
    .slice(0, limit);
}

function add({ title, detail, source, severity = 'medium', foundOn, action, raisedWith, raisedOn } = {}) {
  if (!title?.trim()) throw new Error('A finding needs a title.');
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);

  return db.insert('findings', {
    title: title.trim(),
    detail: (detail || '').trim(),
    source: source || 'manual',
    severity,
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
    lines.push(`| ${f.found_on} | ${f.title} | ${f.severity} | ${f.raised_with || '—'} | ${f.raised_on || '—'} | ${f.action || '—'} |`);
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

module.exports = { list, add, update, remove, markdown, draftRaise, SEVERITIES, STATUSES };
