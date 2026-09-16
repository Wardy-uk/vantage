'use strict';

/**
 * The life of an indicator — first sighting, every sighting after, and the day
 * the evidence went back to normal.
 *
 * ── Why a detector cannot do this itself ────────────────────────────────────
 *
 * `leading.js` is pure and stateless: it answers "what does the data say
 * today". Asked twice on consecutive days about the same developing problem it
 * returns the same card twice, which on a screen means two cards, and on a
 * screen checked daily for a fortnight means fourteen. Alert spam is not a
 * volume problem, it is a memory problem.
 *
 * So this remembers. A key that fires again STRENGTHENS the existing record —
 * same card, more sightings, a first-seen date that does not move — rather than
 * arriving as something new. The thing Nick needs to know on day nine is not
 * "here is a warning", it is "this is the ninth day of the same warning".
 *
 * ── Closing is a result, not a deletion ─────────────────────────────────────
 *
 * When the evidence normalises the indicator does NOT simply vanish. The radar
 * already has that failure — a live item disappears the moment its number moves
 * — and this tool is built for someone who systematically under-registers
 * completion. A card that quietly evaporates teaches him nothing; a card that
 * says "this normalised on Tuesday, after nine days" is the only place the
 * screen ever tells him something got better.
 *
 * Three quiet days, not one. A detector can go quiet for a day because a bank
 * holiday shortened a week or one series was late, and closing on that would
 * make the register flicker.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 *
 * It does not resolve, escalate or write anything to NEURO. An indicator that
 * matters becomes a FINDING, through the existing `+ log` path, and the finding
 * register owns everything after that. This file's whole job is dedupe and
 * memory; a second lifecycle running alongside the findings register is how two
 * screens come to disagree about whether something is still open.
 */

const db = require('../db');

const COLLECTION = 'indicators';

/** Consecutive days with no sighting before an indicator is called normalised. */
const QUIET_DAYS_TO_CLOSE = 3;
/** How long a closed indicator keeps its place on the screen. */
const SHOW_NORMALISED_DAYS = 14;

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const all = () => db.find(COLLECTION);

/**
 * What SHOULD change, given the register as it stands and what fired today.
 *
 * PURE — takes records and a day, returns the writes, touches nothing. The
 * dedupe and the decay are the two things here that fail silently when they
 * regress: a broken dedupe does not throw, it quietly produces a second card,
 * and a broken decay either leaves a solved problem on the screen for ever or
 * removes a live one inside an hour. Neither is visible without a test, and a
 * test that needs a natively-built SQLite driver does not run on most machines
 * — so it would not have been run.
 *
 * Same split `friction.assess()` and `pi-health.assess()` hold in NEURO, and
 * for this exact reason.
 */
function plan(records, fired, day) {
  const inserts = [];
  const updates = [];
  const seen = new Set();
  const openByKey = new Map(records.filter(r => r.status === 'open').map(r => [r.key, r]));

  for (const ind of fired) {
    seen.add(ind.key);
    const existing = openByKey.get(ind.key);
    if (existing) {
      // One sighting per day, however often the radar is refreshed. The radar
      // is polled; counting per call would inflate the run length all morning.
      const isNewDay = existing.lastSeenOn !== day;
      updates.push({
        id: existing.id,
        patch: {
          lastSeenOn: day,
          sightings: existing.sightings + (isNewDay ? 1 : 0),
          quietDays: 0,
          lastTitle: ind.title,
          lastSeverity: ind.severity,
          lastConfidence: ind.confidence?.score ?? null,
          // The worst it has been, kept separately: an indicator that was high
          // last week and is medium today has not become a lesser problem, and
          // overwriting the severity would say it had.
          peakSeverity: worse(existing.peakSeverity, ind.severity),
        },
      });
    } else {
      inserts.push({
        key: ind.key,
        detector: ind.detector,
        status: 'open',
        firstSeenOn: day,
        lastSeenOn: day,
        sightings: 1,
        quietDays: 0,
        lastTitle: ind.title,
        lastSeverity: ind.severity,
        lastConfidence: ind.confidence?.score ?? null,
        peakSeverity: ind.severity,
        closedOn: null,
        // ── The prospective ledger ────────────────────────────────────────
        //
        // Detector E can never be back-tested: availability is stored
        // forward-looking and overwritten, so there is no record of who was off
        // on a past day. The only way it will ever be scored is FORWARD, by
        // writing down the checkable claim on the day it is made and reading
        // back what happened afterwards.
        //
        // Written at INSERT and never updated. A claim that can be revised
        // after the outcome is known is not a claim, and the temptation to
        // "correct" it later is exactly what would make a prospective score
        // worthless.
        validationStatus: ind.validation?.status ?? null,
        prospective: ind.prospective ?? null,
        claimedOn: ind.prospective ? day : null,
      });
    }
  }

  // Decay. Only for open records that did not fire today, and only once per day.
  for (const [key, rec] of openByKey) {
    if (seen.has(key)) continue;
    if (rec.lastReconciledOn === day || rec.lastSeenOn === day) continue;
    const quietDays = (rec.quietDays || 0) + 1;
    updates.push({
      id: rec.id,
      patch: {
        quietDays,
        lastReconciledOn: day,
        ...(quietDays >= QUIET_DAYS_TO_CLOSE ? { status: 'normalised', closedOn: day } : {}),
      },
    });
  }

  return { inserts, updates };
}

/**
 * Fold today's fired indicators into the register.
 *
 * IDEMPOTENT WITHIN A DAY. The radar is polled, and a reconcile that advanced
 * `quietDays` on every page load would close a live indicator inside an hour.
 * `lastReconciledOn` is what makes a second call in the same day a no-op for
 * the ageing half.
 *
 * `day` is injected rather than read from the clock so the replay can walk a
 * year through this in a second, and so the tests do not depend on what day it
 * is when they run.
 *
 * Read, plan, apply, present — the only impure step in the lifecycle.
 */
function reconcile(fired, day = today()) {
  const { inserts, updates } = plan(all(), fired, day);
  for (const row of inserts) db.insert(COLLECTION, row);
  for (const u of updates) db.update(COLLECTION, u.id, u.patch);
  return read(fired, day);
}

/** 'high' beats 'medium' beats 'low'. */
function worse(a, b) {
  const rank = { high: 0, medium: 1, low: 2 };
  if (!a) return b;
  if (!b) return a;
  return rank[a] <= rank[b] ? a : b;
}

/**
 * Today's cards, with their history attached, plus what recently normalised.
 *
 * The history is the point. `sightings` and `firstSeenOn` turn "the queue is
 * outrunning throughput" into "the queue has been outrunning throughput for
 * nine days", which is a different sentence and calls for a different response.
 */
function read(fired, day = today()) {
  return present(all(), fired, day);
}

/** PURE. See `plan()` — the wording below is as load-bearing as the arithmetic. */
function present(records, fired, day) {
  const byKey = new Map(records.map(r => [r.key, r]));

  const active = fired.map(ind => {
    const rec = byKey.get(ind.key);
    if (!rec) return ind;
    const runDays = daysBetween(rec.firstSeenOn, day) + 1;
    return {
      ...ind,
      firstSeenOn: rec.firstSeenOn,
      sightings: rec.sightings,
      runDays,
      // Only true once it has actually recurred. A first sighting saying
      // "strengthened" would be a claim about a pattern from a single point.
      strengthened: rec.sightings > 1,
      peakSeverity: rec.peakSeverity,
      // Rendered under the title. Said once, plainly, and never re-diagnosed:
      // the brief's rule about naming a pattern once applies here too.
      standing: rec.sightings > 1
        ? `Seen on ${rec.sightings} days, first on ${rec.firstSeenOn} (${runDays} days ago).`
        : 'First sighting.',
    };
  });

  const normalised = records
    .filter(r => r.status === 'normalised' && r.closedOn && daysBetween(r.closedOn, day) <= SHOW_NORMALISED_DAYS)
    .sort((a, b) => String(b.closedOn).localeCompare(String(a.closedOn)))
    .map(r => ({
      key: r.key,
      detector: r.detector,
      title: r.lastTitle,
      firstSeenOn: r.firstSeenOn,
      closedOn: r.closedOn,
      sightings: r.sightings,
      peakSeverity: r.peakSeverity,
      // Stated carefully. The evidence normalised; whether anybody DID anything
      // is not something this can see, and claiming it would be the mirror of
      // the mistake this codebase keeps making with silence.
      note: `The evidence went back to normal after ${daysBetween(r.firstSeenOn, r.closedOn) + 1} days. That is the number moving, not a record of what was done about it.`,
    }));

  return { active, normalised };
}

/** Every record, for the admin view and the tests. */
const list = () => all().sort((a, b) => String(b.lastSeenOn).localeCompare(String(a.lastSeenOn)));

/**
 * Every claim an unvalidated detector has made, with the day it was made about.
 *
 * This is the whole prospective-validation apparatus: a list of dated,
 * unrevised predictions waiting for enough of them to be worth scoring. There
 * is deliberately no scorer yet — writing one now would mean choosing the
 * measure before seeing a single outcome, which is how a scorer comes to
 * flatter the thing it scores. `prospective.scoreAgainst` names the KPIs the
 * claim was made against so that choice is already fixed when the time comes.
 */
const prospectiveClaims = () => all()
  .filter(r => r.prospective)
  .map(r => ({
    key: r.key,
    detector: r.detector,
    validationStatus: r.validationStatus,
    claimedOn: r.claimedOn,
    firstSeenOn: r.firstSeenOn,
    title: r.lastTitle,
    ...r.prospective,
    // Whether the day it was about has actually arrived yet. A claim about
    // next Tuesday is not a miss, it is pending, and a scorer that cannot tell
    // the difference would count every open claim as a failure.
    due: r.prospective?.forDay ? r.prospective.forDay <= today() : null,
  }))
  .sort((a, b) => String(b.claimedOn).localeCompare(String(a.claimedOn)));

/** Used by the replay so a run starts from nothing rather than from live state. */
function reset() {
  return db.remove(COLLECTION, () => true);
}

module.exports = {
  reconcile, read, list, reset,
  // The pure half, exported so the dedupe and the decay are testable on a
  // machine that cannot build `better-sqlite3` — which is most of them, and so
  // is where these would otherwise have gone untested.
  plan, present, worse, prospectiveClaims,
  QUIET_DAYS_TO_CLOSE, SHOW_NORMALISED_DAYS,
};
