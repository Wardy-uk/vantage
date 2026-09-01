'use strict';

/**
 * Signals about NICK, not about the department.
 *
 * Everything else in VANTAGE describes the service desk. This describes the
 * person running it — and for coaching, that is the half that matters. A coach
 * handed a queue summary can only ever discuss the queue.
 *
 * The measures here are chosen because they are behavioural and because they
 * are, uncomfortably, the ones the PIP is actually about:
 *
 *   - The gap between FINDING something and RAISING it. The findings register
 *     records both dates, so this is measurable rather than impressionistic —
 *     and "he did not surface it" is the specific doubt on record.
 *   - How often 1:1s are rescheduled. Invisible everywhere else, because the
 *     meeting eventually happens. It shows what gets displaced under pressure.
 *   - Whether the actions that are HIS on the improvement plan move, separately
 *     from the ones that are not.
 *   - What he has noticed about himself, especially under `avoidance`.
 *
 * None of this is scored or graded. It is assembled so a coach can ask a better
 * question, and a tool that turned it into a performance number would be doing
 * the opposite of the job.
 */

const findings = require('./findings');
const coach = require('./coach');
const plan = require('./plan');
const neuro = require('./neuro');

const DAY = 86_400_000;
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Found versus raised.
 *
 * The register's whole point. Spotting something privately is not the behaviour
 * in question — telling someone is.
 */
function findingsBehaviour() {
  const all = findings.list({ limit: 500 });
  const raised = all.filter(f => f.raised_on);
  const unraised = all.filter(f => !f.raised_on);
  const lags = raised
    .map(f => days(f.found_on, f.raised_on))
    .filter(n => Number.isFinite(n) && n >= 0);

  const today = new Date().toISOString().slice(0, 10);
  const ageingUnraised = unraised
    .map(f => ({ ...f, ageDays: days(f.found_on, today) }))
    .filter(f => f.ageDays >= 3)
    .sort((a, b) => b.ageDays - a.ageDays);

  return {
    total: all.length,
    raised: raised.length,
    unraised: unraised.length,
    medianDaysToRaise: median(lags),
    // High-severity things found and still not said out loud. The most direct
    // measure available of the behaviour the PIP questions.
    ageingUnraised: ageingUnraised.slice(0, 5).map(f => ({
      title: f.title, severity: f.severity, ageDays: f.ageDays,
    })),
    highUnraised: unraised.filter(f => f.severity === 'high').length,
  };
}

/** Progress on what is HIS, kept apart from what is not. */
function planBehaviour() {
  const p = plan.list();
  const mine = p.items.filter(i => i.owner === 'mine');
  const notMine = p.items.filter(i => i.owner !== 'mine');
  return {
    mineTotal: mine.length,
    mineMoving: mine.filter(i => ['in-progress', 'done'].includes(i.status)).length,
    mineNotStarted: mine.filter(i => i.status === 'not-started').length,
    notMineEscalated: notMine.filter(i => i.status === 'escalated').length,
    // An `above` item left "not started" is ambiguous: it may be blocked, or it
    // may simply never have been raised with whoever owns it.
    notMineUntouched: notMine.filter(i => i.status === 'not-started').length,
  };
}

/** What he has noticed about himself. `avoidance` is the one that matters. */
function observationBehaviour() {
  const all = coach.listObservations({ limit: 500 });
  const byKind = {};
  for (const o of all) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
  return {
    total: all.length,
    byKind,
    recent: all.slice(0, 5).map(o => ({ kind: o.kind, note: o.note.slice(0, 140), when: o.created_at.slice(0, 10) })),
  };
}

/**
 * Assemble everything. Each external source degrades on its own.
 *
 * Returns a shape meant to be READ by a model, not rendered as a scorecard.
 */
/**
 * What actually moved recently.
 *
 * Included because an ADHD brain systematically under-registers completion, and
 * a tool that only ever shows the outstanding column is lying by omission. This
 * is not encouragement — it is the other half of an accurate report.
 */
function doneBehaviour() {
  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  const all = findings.list({ limit: 500 });
  const p = plan.list();
  return {
    findingsRaised: all.filter(f => f.raised_on && f.raised_on >= weekAgo).length,
    findingsWithAction: all.filter(f => (f.action || '').trim()).length,
    findingsLogged: all.filter(f => (f.found_on || '') >= weekAgo).length,
    planMoved: p.items.filter(i => i.owner === 'mine' && ['in-progress', 'done'].includes(i.status)).length,
  };
}

/**
 * The standing numbers — always on, no commentary.
 *
 * Deliberately separate from the brief, because the brief names a pattern once
 * and then stops. The FACT must not disappear with the diagnosis: Nick needs to
 * see where things stand every time he opens the app, both because it is the
 * evidence he is assessed on and because out of sight genuinely is out of mind.
 *
 * So: numbers, permanently, with no judgement attached. The interpretation is
 * the brief's job and it says it once. This just refuses to let the position go
 * quiet.
 *
 * Local reads only — no network — so it can render immediately on every screen.
 */
function quick() {
  const f = findingsBehaviour();
  const p = planBehaviour();
  const d = doneBehaviour();
  return {
    findings: {
      total: f.total,
      unraised: f.unraised,
      highUnraised: f.highUnraised,
      oldestUnraisedDays: f.ageingUnraised[0]?.ageDays ?? null,
      oldestUnraisedTitle: f.ageingUnraised[0]?.title ?? null,
    },
    plan: { mineTotal: p.mineTotal, mineMoving: p.mineMoving },
    done: d,
  };
}

async function snapshot() {
  const out = {
    findings: findingsBehaviour(),
    plan: planBehaviour(),
    observations: observationBehaviour(),
    done: doneBehaviour(),
    oneToOnes: null,
    // null, never 0 — "nothing finished" and "the ledger could not be read" are
    // opposite facts and only one of them is bad news.
    moved: null,
    unavailable: [],
  };

  if (!neuro.isConfigured()) {
    out.unavailable.push({ name: 'neuro', reason: 'no NEURO credential' });
    return out;
  }

  // ⚠ VANTAGE's own `doneBehaviour()` counts findings raised and plan items
  // moved — its own activity, and nothing else. That is a few percent of the
  // work, on a screen built for a man who systematically under-registers
  // completion. NEURO's ledger is the rest, detected from six sources, with the
  // gaps it knows about carried rather than hidden.
  try {
    const w = await neuro.wins();
    out.moved = {
      today: w.doneToday ?? null,
      thisWeek: w.doneThisWeek ?? null,
      typicalDay: w.typical ?? null,
      bySource: w.bySource || [],
      // Said out loud so nothing downstream reads the totals as the whole
      // picture: Jira resolutions and emails dealt with are NOT in them.
      knownGaps: w.knownGaps || [],
      headline: w.headline || null,
    };
  } catch (err) {
    out.unavailable.push({ name: 'wins', reason: err.message });
  }

  try {
    const moves = await neuro.oneToOneMoves();
    out.oneToOnes = {
      peopleWithReschedules: moves.length,
      totalReschedules: moves.reduce((s, m) => s + m.moveCount, 0),
      worst: moves.slice(0, 5).map(m => ({ person: m.person, moveCount: m.moveCount })),
    };
  } catch (err) {
    out.unavailable.push({ name: '1to1-moves', reason: err.message });
  }

  // ⚠ Vault action items are deliberately not read (1 Sep 2026). The parser
  // records no assignee on any row, so this block could only ever describe
  // work of unknown ownership — it carried a careful caveat saying so, which
  // is the sign a source is answering a question nobody asked. What is his is
  // in the task store; what others owe him is NEURO's to show.

  return out;
}

module.exports = { snapshot, quick, findingsBehaviour, planBehaviour, observationBehaviour, doneBehaviour };
