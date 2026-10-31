'use strict';

/**
 * "Build my case" — the one way Performance Evidence leaves VANTAGE (29 Oct 2026).
 *
 * The export carries ONLY items Nick has ticked into the case, each as the
 * summary he wrote, or its own title when he wrote none (no privacy screen —
 * Nick, 31 Oct 2026).
 */

const store = require('./perf-store');
const sfia = require('./sfia');

const RATING_WORDS = { met: 'Met', partly: 'Partly', 'not-yet': 'Not yet', 'no-evidence': 'No evidence yet', unrated: 'Not rated' };

/** Markdown for one slot. Pure given its inputs. */
function render({ role, assessment, items }) {
  const p = role.profile;
  const lines = [`# ${p.title} — evidence`, ''];
  if (p.summary) lines.push(p.summary, '');
  lines.push('## SFIA 9 profile', '', '| Skill | Target | Assessment |', '|---|---|---|');
  const bySkill = new Map((assessment?.skills || []).map((s) => [s.code, s]));
  for (const s of p.skills) {
    const a = bySkill.get(s.code);
    lines.push(`| ${s.code} ${s.name} | L${s.level} (${sfia.levelName(s.level)}) | ${a ? RATING_WORDS[a.rating] || a.rating : '—'} |`);
  }
  if (assessment) {
    lines.push('', `Assessment of ${assessment.createdAt.slice(0, 10)}: readiness **${assessment.readiness?.rating || '—'}**.`);
    if (assessment.summary) lines.push('', assessment.summary);
  }
  lines.push('', '## Evidence', '');
  const ticked = items.filter((e) => e.inCase);
  if (!ticked.length) lines.push('_No evidence has been added to the case yet._');
  for (const s of p.skills) {
    const mine = ticked.filter((e) => e.tags.some((t) => t.slot === role.slot && t.code === s.code));
    if (!mine.length) continue;
    lines.push(`### ${s.code} ${s.name}`, '');
    for (const e of mine) lines.push(`- ${String(e.occurredAt || '').slice(0, 10)} — ${e.caseSummary || e.title}`);
    lines.push('');
  }
  return lines.join('\n');
}

function exportSlot(slot) {
  const role = store.activeRole(slot);
  if (!role) { const e = new Error(`No ${slot} role saved yet`); e.status = 409; throw e; }
  return { markdown: render({ role, assessment: store.latestAssessment(slot), items: store.acceptedFor(slot) }) };
}

module.exports = { exportSlot, render };
