'use strict';

/**
 * Which VANTAGE view is on, recorded locally for NEURO's usage heatmap.
 *
 * ── Why it is HERE and not a bridge write ───────────────────────────────────
 *
 * NEURO→VANTAGE is already one direct read of this SQLite file
 * (`estate-cost.js`, the AI spend panel), both processes run as the same user
 * on the same Pi, and the alternative was a SIXTH write on a bridge whose
 * closed set of five is load-bearing and whose count is the register of what
 * VANTAGE may do to NEURO. A usage grid is not worth spending that on. So
 * VANTAGE records into its own store and NEURO reads the file, exactly as it
 * already does for the ledger.
 *
 * ⚠ THE CONSEQUENCE, WRITTEN DOWN: the shape of these documents is now
 * something NEURO reads. Changing `screen` / `date_key` / `hour` breaks NEURO's
 * heatmap SILENTLY — it degrades to "VANTAGE could not be read", which is at
 * least a named gap rather than a quiet week, but it will not fail here.
 *
 * ── What it records, and what it does not ───────────────────────────────────
 *
 * A view name, a local date, an hour. No path, no query, no finding id, no
 * session — nothing that says WHAT Nick was looking at, only WHICH SCREEN. That
 * is the whole question the heatmap asks, and anything more would make a
 * coaching tool's navigation log into a record of what he was worried about.
 *
 * ⚠ IT COUNTS OPENS, NOT TIME. Stated in NEURO's panel; restated nowhere else
 * so the two cannot phrase it differently.
 */

// ⚠ REQUIRED LAZILY, and the store is INJECTABLE. `../db` pulls in
// `better-sqlite3`, a native module that only builds on the Pi — so requiring
// it at the top would make this file unloadable on a dev box and take its tests
// down with it, which is `db.js`'s own stated rule. The decisions here (what is
// a view, how a date is keyed, what gets swept) are the part worth pinning, and
// they pin against a fake store with no driver present.
function store(given) {
  return given || require('../db');
}

const COLLECTION = 'screen_opens';

// What a row records. An OPEN is arriving on a view; an INTERACTION is using a
// control once there. ⚠ A row written before 18 Sep 2026 carries NO `kind` and
// is an open — the only thing recorded then — so the reader defaults it that
// way rather than reclassifying real history.
const KINDS = new Set(['opened', 'interacted']);

// The most control-uses one flush may claim. Matches NEURO's own ceiling; a
// runaway must not be able to flatten every other row on the grid.
const MAX_COUNT = 500;

// The views this app has. An unrecognised name is REFUSED rather than stored:
// a typo'd or injected screen name would appear on NEURO's grid as a VANTAGE
// screen that does not exist, and a row nobody can trace back to a view is
// worse than a missing one.
const VIEWS = new Set([
  'radar', 'tracker', 'findings', 'plan', 'coach', 'patterns', 'admin', 'standing',
]);

// Rows older than this are swept on write. The grid's widest window is a year
// and its default is twelve weeks, so a year is generous — but this is an
// append-per-navigation store in a table with no other retention, and
// "append-only with no retention becomes the next pile" is a lesson already
// paid for once (`push_log`, `email_triage`).
const RETAIN_DAYS = 400;

/**
 * Local date key. NEVER toISOString().
 *
 * ⚠ In BST (UTC+1) it is EARLY MORNING that diverges, not late evening: 00:30
 * local is 23:30Z the PREVIOUS day, so a UTC key files it a day early — and on
 * a Monday morning that moves it into the wrong column of NEURO's week grid,
 * which is built from these. (The instinct is to worry about late evening;
 * that is the case west of UTC, not here.)
 */
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cutoffKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - RETAIN_DAYS);
  return dateKey(d);
}

/**
 * Record one view open.
 *
 * ⚠ It NEVER throws. This is called on every navigation in the app; a usage
 * grid must not be able to cost a screen change, and the caller is fire and
 * forget. A failure returns `{ ok: false, reason }` so a test can see it.
 */
function record(screen, now = new Date(), db, opts = {}) {
  const name = typeof screen === 'string' ? screen.trim().toLowerCase() : '';
  if (!name) return { ok: false, reason: 'no screen named' };
  if (!VIEWS.has(name)) return { ok: false, reason: `unknown view "${name}"` };

  // ⚠ An unrecognised kind is REFUSED, never normalised to `opened` — silently
  // filing interactions as opens would inflate the accessed grid with work
  // that belongs in the other one, and nothing downstream could tell.
  const kind = opts.kind === undefined ? 'opened' : opts.kind;
  if (!KINDS.has(kind)) return { ok: false, reason: `unknown kind "${opts.kind}"` };

  const count = typeof opts.count === 'number' && Number.isFinite(opts.count) && opts.count > 0
    ? Math.min(Math.floor(opts.count), MAX_COUNT)
    : 1;

  try {
    store(db).insert(COLLECTION, {
      screen: name,
      kind,
      count,
      date_key: dateKey(now),
      // Local, matching NEURO's own `activity_log.hour`.
      hour: now.getHours(),
      at: now.toISOString(),
    });
    prune(now, db);
    return { ok: true, kind, recorded: count };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * Drop rows past the retention window.
 *
 * ⚠ A row with NO readable date is KEPT, never swept — "I cannot tell how old
 * this is" is not evidence that it is old, and a sweep that removes what it
 * cannot date is one that eventually empties the store.
 */
function prune(now = new Date(), db) {
  const cut = cutoffKey(now);
  try {
    return store(db).remove(COLLECTION, r => typeof r.date_key === 'string' && r.date_key < cut);
  } catch {
    return 0;
  }
}

/** Everything recorded, for a test or a manual look. NEURO reads the file. */
function list(db) {
  try { return store(db).find(COLLECTION); } catch { return []; }
}

module.exports = { record, prune, list, dateKey, cutoffKey, COLLECTION, VIEWS, KINDS, RETAIN_DAYS, MAX_COUNT };
