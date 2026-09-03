'use strict';

/**
 * How urgent is this, and does it go straight into Nick's list?
 *
 * ── What this decides ────────────────────────────────────────────────────────
 *
 * VANTAGE can put work into NEURO. Until now every write took the same route —
 * `findings.escalate()` called `createTask` and that was that — so a passing
 * observation and a customer-facing failure arrived identically, at the top of
 * the list Nick uses to decide what to do next. This is the single place that
 * decides otherwise, and `route` is the whole output:
 *
 *   'direct'  → a real NEURO task, now, whether or not Nick is looking.
 *   'pending' → a pending action in NEURO's approval queue, waiting for him.
 *
 * Pure. No I/O, no clock, no database — the same split as `pi-health.assess()`
 * and `weekly-risk.assess()`, so the weighting pins in tests without NOVA,
 * NEURO or a date. And ONE caller: every VANTAGE→NEURO task-creating write goes
 * through `neuro.createTask`, which consults this, so a grep for
 * `criticality.assess` finds the whole of the policy.
 *
 * ── The asymmetry, which is what sets the thresholds ─────────────────────────
 *
 * The two mistakes are not the same size.
 *
 *   • A wrong `direct` puts work in Nick's task list that he never asked for,
 *     silently, at the moment he is trying to decide what to do next. That is
 *     precisely why NEURO's own auto-promote was removed: an unreviewed item
 *     from an automated extractor is how a list stops being trusted, and a list
 *     he does not trust is one he stops reading — which costs him everything
 *     else in it, not just the wrong row.
 *   • A wrong `pending` delays something urgent until he next opens the queue.
 *     That is a real cost and it is bounded: the item is visible, it is in a
 *     queue built to be read, and nothing has been lost.
 *
 * So this errs towards `pending`, and `direct` is reserved for the cases where
 * the finding says something has ALREADY gone wrong or is going wrong NOW, at
 * high severity. "Could go wrong" never goes direct however severe it looks —
 * being early is the value of that tense, and earliness is not urgency.
 *
 * ⚠ **The thresholds are set from that asymmetry and from the vocabulary, NOT
 * from a measured distribution.** The live findings register was read on 3 Sep
 * 2026 while this was written and holds ZERO rows, so there was no severity mix
 * to fixture from — and inventing one to justify a number would be worse than
 * saying this. They are the conservative reading of a vocabulary of nine
 * severity/tense pairs, and they are worth re-checking against real findings
 * once the register has some: the number to watch is how often a `direct`
 * turned out to be something Nick would rather have reviewed.
 *
 * ⚠ **Unknown is never treated as low.** A finding with no severity or no tense
 * is one nobody has judged, and it routes to `pending` with a basis that says
 * so — not because it is unimportant but because there is nothing here to
 * justify writing it into his list unasked.
 */

/** Severity, as `findings.js` defines it. Anything else is unknown. */
const SEVERITIES = ['high', 'medium', 'low'];

/**
 * Tense, as the radar defines it.
 *
 *   happened   — it has already gone wrong.
 *   happening  — it is going wrong now.
 *   could      — it has not gone wrong yet.
 */
const TENSES = ['happened', 'happening', 'could'];

/** The two routes into NEURO. */
const DIRECT = 'direct';
const PENDING = 'pending';

/** The three levels, which are what NEURO stores as provenance. */
const LEVELS = ['high', 'medium', 'low'];

/**
 * The tenses in which something is ALREADY costing something.
 *
 * `could` is deliberately absent. A high-severity risk that has not happened is
 * exactly the thing VANTAGE exists to spot early, and exactly the thing that
 * must not write itself into Nick's task list while he is not looking: being
 * early is worth a queue entry, not an interruption.
 */
const LIVE_TENSES = new Set(['happened', 'happening']);

function norm(value, allowed) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : null;
}

/**
 * Weigh one item.
 *
 * @param {object} item
 * @param {string} item.severity  'high' | 'medium' | 'low'
 * @param {string} item.tense     'happened' | 'happening' | 'could'
 * @param {string} item.source    where the finding came from; 'manual' means Nick typed it
 * @returns {{level: string, basis: string, route: string}}
 *
 * `basis` is a sentence, and it travels with the write into NEURO so a task
 * that arrived without being asked for can always answer *why*. It is the
 * reason this returns three things rather than a boolean.
 */
function assess(item = {}) {
  const severity = norm(item.severity, SEVERITIES);
  const tense = norm(item.tense, TENSES);
  const source = String(item.source ?? '').trim().toLowerCase();
  const manual = source === 'manual';

  if (!severity) {
    return {
      level: 'medium',
      route: PENDING,
      basis: 'no severity recorded — nobody has judged this yet, so it waits for you rather than arriving as a task',
    };
  }

  if (severity === 'high') {
    // Nick typed it himself. He has already made the judgement this module
    // exists to make, and a tool that second-guesses its own user on his own
    // finding is one he routes around.
    if (manual) {
      return {
        level: 'high',
        route: DIRECT,
        basis: 'you logged this as high severity yourself',
      };
    }
    if (tense && LIVE_TENSES.has(tense)) {
      return {
        level: 'high',
        route: DIRECT,
        basis: tense === 'happened'
          ? 'high severity, and it has already gone wrong'
          : 'high severity, and it is going wrong now',
      };
    }
    if (tense === 'could') {
      // The one that most looks like it should be direct, and is not.
      return {
        level: 'high',
        route: PENDING,
        basis: 'high severity, but it has not happened yet — being early is worth your attention, not your task list',
      };
    }
    return {
      level: 'high',
      route: PENDING,
      basis: 'high severity, but nothing says whether it has happened yet',
    };
  }

  if (severity === 'medium') {
    return {
      level: 'medium',
      route: PENDING,
      basis: tense && LIVE_TENSES.has(tense)
        ? 'medium severity and already live — worth deciding on soon'
        : 'medium severity',
    };
  }

  return {
    level: 'low',
    route: PENDING,
    basis: 'low severity',
  };
}

/** Would this be written straight into NEURO? Convenience, one source of truth. */
function isDirect(item) {
  return assess(item).route === DIRECT;
}

module.exports = {
  assess,
  isDirect,
  SEVERITIES,
  TENSES,
  LEVELS,
  DIRECT,
  PENDING,
};
