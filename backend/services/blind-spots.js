'use strict';

/**
 * Blind spots with a memory, and a next step.
 *
 * ── Why the banner was not enough ───────────────────────────────────────────
 *
 * The blind-spots banner says what the radar cannot see. It said it with no
 * next step, and it said it identically on the first hour and the fifth day —
 * which is awareness without action, the one thing this tool is not allowed to
 * ship (Nick, 23 Sep 2026, looking at `nova-health: not evaluated`).
 *
 * A blind spot is NOT a tense. The three tenses are claims about the desk, and
 * "could not see it" is evidence of nothing either way — filing it as `could`
 * would be the absence-read-as-fact failure in a new place. But a blind spot
 * that PERSISTS is a fact in its own right, about the instrument rather than
 * the desk: "VANTAGE has been unable to see X for days" is true, it is
 * happening now, and it is fixable. That, and only that, becomes a card.
 *
 * ── What "persisting" is allowed to claim ───────────────────────────────────
 *
 * The radar is rebuilt hourly on weekday working hours and on demand, so there
 * are nights and weekends with no observation at all. The claim is therefore
 * never "blind for N days" — nobody looked on Saturday. It is "every rebuild
 * since <first seen> has been blind on this", which the record supports
 * exactly. A single rebuild without the entry closes the episode, so a
 * flapping source never promotes: that under-claims, which is the safe
 * direction for a card about VANTAGE's own reliability.
 *
 * Episodes are keyed on the blind entry's NAME. An aggregate entry such as
 * `nova-health: not evaluated` can change which checks it lists while staying
 * open; the card shows the latest reason, and says since when.
 */

const db = require('../db');

const COLLECTION = 'blind_spots';

/** Calendar days of unbroken blindness before it becomes a card. */
const PERSIST_DAYS = 3;

const DAY_MS = 86_400_000;

const fmtDay = iso => new Date(iso).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London',
});

/**
 * The next step for a blind spot, where one can honestly be named. PURE.
 *
 * Returns null rather than a vague line. "Investigate the source" reads as
 * advice and costs nothing to ignore; no line at all is at least honest that
 * the fix is not known from here. An entry that already carries a remedy
 * (nova-health writes its own, because it knows the cause) keeps it.
 */
function remedyFor({ name, reason, remedy }) {
  if (remedy) return remedy;
  const r = String(reason || '');

  if (/not configured/i.test(r)) {
    return 'A variable is missing from VANTAGE\'s .env on the Pi — set it, then pm2 restart vantage-backend --update-env.';
  }
  if (/Redeploy NOVA/.test(r) || /build "/.test(r)) {
    return 'NOVA is serving a build VANTAGE does not recognise. Run deploy\\deploy.ps1 -Branch nova-codex on AAPP01; if NOVA is already current, the stamp on VANTAGE\'s side needs bumping to match.';
  }

  if (name.startsWith('detector ')) {
    if (/missing \d+ of the last/.test(r)) {
      return 'NOVA has no kpi_org_daily row for those days. The detector will not draw a baseline across the hole, so this clears when the days are backfilled on NOVA or age out of the window.';
    }
    if (/threw:/.test(r)) return 'That is a fault in leading.js, not in the data — the error above is where to start.';
    return null;
  }

  if (['team-health', 'tasks', 'meetings', 'booked-1to1s'].includes(name)) {
    return 'NEURO did not answer. On the Pi, pm2 status shows whether it is up; if it is, check NEURO_API_TOKEN still matches.';
  }
  if (name === 'meeting-analysis') {
    return 'This is the model call over your meeting notes. One failure usually clears on the next hourly warm; if it repeats, pm2 logs vantage-backend shows the OpenRouter error.';
  }
  if (['nova-flow', 'sentiment', '1to1-coverage', 'people-signals', 'conversations', 'leading-indicators'].includes(name)) {
    return 'NOVA\'s bridge did not answer for this. If the other NOVA sources read fine it is this one endpoint, not NOVA being down; if they all failed, check the site in IIS on AAPP01.';
  }
  return null;
}

/**
 * What SHOULD change, given the stored episodes and this rebuild's blind list.
 *
 * PURE, for the same reason as `indicator-log.plan()`: a broken dedupe does not
 * throw, it quietly produces a fresh "first seen" on every rebuild, and the card
 * then never promotes. Nothing visible fails. Only a test sees it, and a test
 * that needs the native SQLite driver would not get run.
 */
function plan(records, blind, now) {
  const inserts = [];
  const updates = [];
  const openByName = new Map(records.filter(r => r.status === 'open').map(r => [r.name, r]));
  const seen = new Set();

  for (const b of blind) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    const existing = openByName.get(b.name);
    if (existing) {
      updates.push({ id: existing.id, patch: { lastSeen: now, rebuilds: (existing.rebuilds || 1) + 1, reason: b.reason } });
    } else {
      inserts.push({ name: b.name, status: 'open', firstSeen: now, lastSeen: now, rebuilds: 1, reason: b.reason });
    }
  }
  // One rebuild that could see it ends the episode. See the header: that is
  // the under-claiming direction, deliberately.
  for (const r of openByName.values()) {
    if (!seen.has(r.name)) updates.push({ id: r.id, patch: { status: 'closed', closedAt: now } });
  }
  return { inserts, updates };
}

/**
 * This rebuild's blind list, each entry annotated with `since` and `remedy`,
 * plus the cards for any that have persisted. PURE.
 *
 * The card TITLE is fixed per blind spot, with the duration in the detail. The
 * findings register pins on title, so a title carrying "for 4 days" would
 * become a different finding every day it was logged.
 */
function present(records, blind, now) {
  const openByName = new Map(records.filter(r => r.status === 'open').map(r => [r.name, r]));
  const annotated = blind.map(b => {
    const rec = openByName.get(b.name);
    const since = rec?.firstSeen || now;
    const persisted = Date.parse(now) - Date.parse(since) >= PERSIST_DAYS * DAY_MS;
    return { ...b, since, rebuilds: rec?.rebuilds || 1, persisted, remedy: remedyFor(b) };
  });

  const items = annotated.filter(b => b.persisted).map(b => ({
    tense: 'happening',
    severity: 'medium',
    title: `Still blind: ${b.name}`,
    detail: `Every radar rebuild since ${fmtDay(b.since)} — ${b.rebuilds} of them — has been unable to see this: `
      + `${String(b.reason || 'no reason given').replace(/\.\s*$/, '')}. `
      + 'This is about VANTAGE\'s view, not the desk: nothing on this screen covers it until it clears, and it has not cleared on its own.',
    source: 'Blind spots',
    remedy: b.remedy,
    blindSince: b.since,
  }));

  return { blind: annotated, items };
}

/**
 * Read, plan, apply, present — the only impure step.
 *
 * Never throws. If the store cannot be read, the blind list comes back with
 * remedies but no history, and a failure note the caller puts in the banner:
 * no promotion is the safe failure, but it must not look like no persistence.
 */
function reconcile(blind, now = new Date().toISOString()) {
  try {
    const { inserts, updates } = plan(db.find(COLLECTION), blind, now);
    for (const row of inserts) db.insert(COLLECTION, row);
    for (const u of updates) db.update(COLLECTION, u.id, u.patch);
    return { ok: true, ...present(db.find(COLLECTION), blind, now) };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      blind: blind.map(b => ({ ...b, remedy: remedyFor(b) })),
      items: [],
    };
  }
}

module.exports = { reconcile, plan, present, remedyFor, PERSIST_DAYS };
