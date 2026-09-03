'use strict';

/**
 * The unattended half of the handoff (item 18).
 *
 * ── What this changes ────────────────────────────────────────────────────────
 *
 * Until now VANTAGE had no autonomous job at all, so a "direct" route meant
 * *direct, if Nick happens to have a screen open* — which is not much of a
 * route. Nick's decision (3 Sep 2026) settles it: VANTAGE may write
 * high-criticality suggestions into NEURO unattended.
 *
 * That is a real change in what the tool is, which is why it is a component of
 * its own rather than a branch inside `criticality`. `criticality` answers WHAT
 * WEIGHT this carries and knows nothing about time; this answers WHEN VANTAGE
 * acts on its own, and knows nothing about weight. Folding the second into the
 * first would make the pure module impure and hide a scheduler inside a
 * lookup table.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 *
 * **Only the `direct` route travels.** A `pending` suggestion is by definition
 * one that can wait for Nick, and pushing those unattended would fill NEURO's
 * approval queue from a screen he has not opened — which is how a queue built
 * to be read stops being read.
 *
 * **It never touches the weekly risk report.** Putting a line in front of Chris
 * is `findings.escalate()`, and it stays a thing Nick does. A task appearing in
 * his list unasked is recoverable in a click; a line on a document that leaves
 * the building is not.
 *
 * **It never escalates, resolves or re-words a finding.** It reads the register
 * and writes to NEURO. Nothing here changes what the finding says.
 *
 * ── Not sending the same thing twice ─────────────────────────────────────────
 *
 * A ledger stamped on the finding itself (`neuro_auto_pushed_on`), written PER
 * FINDING as each one lands rather than batched at the end of the pass. That is
 * `plaud-admin-blocks`' lesson exactly: its first live run created 52 calendar
 * events where 27 were wanted, because two overlapping passes both planned
 * against a ledger that was only written when the run finished. The equivalent
 * here is a duplicate task in the list Nick uses to decide what to do next.
 *
 * The in-flight guard is the other half. A pass makes sequential HTTP calls to
 * NEURO over Tailscale and the timer does not wait for it, so overlap is a
 * normal case rather than a rare one.
 */

const db = require('../db');
const criticality = require('./criticality');

/** On by default — Nick approved the capability; this is the way to switch it off. */
const ENABLED = process.env.VANTAGE_AUTO_PUSH_ENABLED !== 'false';

/**
 * How many findings one pass will push.
 *
 * A pass proposing dozens has failed regardless of whether each item is
 * defensible: the value of an unattended write is that the ONE thing that
 * matters is already in his list, not that a screenful arrived while he was in
 * a meeting. Loud when it caps.
 */
const MAX_PER_PASS = Number(process.env.VANTAGE_AUTO_PUSH_MAX || 3);

/** Statuses that still describe live work. A resolved finding is not pushed. */
const LIVE_STATUSES = new Set(['open', 'raised']);

let inFlight = false;

/** Has this finding already been handed to NEURO by any route? */
function alreadySent(f) {
  return Boolean(f.neuro_auto_pushed_on || f.neuro_task_id || f.neuro_action_id || f.neuro_escalated_on);
}

/**
 * Which findings this pass would push, in order.
 *
 * Pure, so what the timer will do is answerable without a timer, a clock or a
 * network — and so the "only direct travels" rule pins in a test.
 */
function selectFor(findings = []) {
  return findings
    .filter((f) => f && LIVE_STATUSES.has(f.status))
    .filter((f) => !alreadySent(f))
    // ⚠ Through the published predicate, not by calling `assess` again.
    // `criticality.assess` is meant to have exactly ONE caller — the write
    // funnel in `neuro.js` — so that a grep for it finds the whole of the
    // policy; a second call site here would be a second place that looks like
    // it decides. This asks the same question and re-implements no threshold.
    .filter((f) => criticality.isDirect({ severity: f.severity, tense: f.tense, source: f.source }))
    // Oldest first: a finding that has been sitting there is the one most
    // likely to have been forgotten, which is the whole reason for a timer.
    .sort((a, b) => String(a.found_on || '').localeCompare(String(b.found_on || '')));
}

/**
 * Push what qualifies.
 *
 * Read-only unless `apply` — the same two-step as every other writer here, so
 * "what is this about to put in my list" is answerable without it happening.
 */
async function run({ apply = false, reason = 'timer' } = {}) {
  if (!ENABLED) return { ok: false, reason: 'disabled (VANTAGE_AUTO_PUSH_ENABLED)' };

  const neuro = require('./neuro');
  if (!neuro.isConfigured()) return { ok: false, reason: 'no NEURO credential' };

  // ⚠ Not optional, and not a performance guard. Two overlapping passes both
  // reading a ledger neither has written yet is how one finding becomes two
  // tasks. Sequential HTTP over Tailscale is slower than any sensible timer.
  if (apply && inFlight) return { ok: false, reason: 'a pass is already running' };
  if (apply) inFlight = true;

  try {
    const all = db.find('findings', () => true);
    const queue = selectFor(all);
    const batch = queue.slice(0, MAX_PER_PASS);
    const capped = queue.length - batch.length;
    if (capped) {
      console.warn(`[VANTAGE] auto-push: ${queue.length} findings qualify, pushing ${batch.length} — ${capped} left for the next pass`);
    }

    const pushed = [];
    const failed = [];

    for (const f of batch) {
      if (!apply) {
        pushed.push({ id: f.id, title: f.title, severity: f.severity, tense: f.tense, dryRun: true });
        continue;
      }
      try {
        const outcome = await neuro.proposeWork({
          text: f.title,
          severity: f.severity,
          tense: f.tense,
          source: 'vantage-finding',
          notes: `${f.detail || ''}\n\nVANTAGE finding, spotted ${f.found_on}. Sent to your tasks automatically.`.trim(),
        });
        // Stamped per finding, the moment it lands. Never batched to the end.
        db.update('findings', f.id, {
          neuro_auto_pushed_on: new Date().toISOString(),
          ...(outcome.taskId ? { neuro_task_id: outcome.taskId } : {}),
          updated_at: new Date().toISOString(),
        });
        pushed.push({ id: f.id, title: f.title, taskId: outcome.taskId ?? null, basis: outcome.basis });
      } catch (err) {
        // Fault-isolated and never retried in the same pass: these are real
        // writes into Nick's list, and one failure must not abandon the rest or
        // double up the ones that worked.
        failed.push({ id: f.id, title: f.title, error: err.message });
      }
    }

    if (pushed.length && apply) {
      console.log(`[VANTAGE] auto-push (${reason}): ${pushed.length} finding(s) sent to NEURO`);
    }
    return { ok: true, dryRun: !apply, qualified: queue.length, pushed, failed, capped };
  } finally {
    if (apply) inFlight = false;
  }
}

module.exports = {
  run,
  selectFor,
  alreadySent,
  ENABLED,
  MAX_PER_PASS,
  LIVE_STATUSES,
};
