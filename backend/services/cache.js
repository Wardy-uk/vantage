'use strict';

/**
 * A cache that survives restarts, and never makes anyone wait.
 *
 * The radar takes 60–110 seconds: NOVA's flow queries run sequentially against a
 * DTU-limited instance on purpose, because firing them concurrently starved the
 * database and half of them timed out. That is the right trade server-side and
 * an unacceptable one in front of a person — a two-minute spinner on the screen
 * you are meant to check daily is a screen you stop checking.
 *
 * So two behaviours:
 *
 * 1. **Stale-while-revalidate.** A cached value is returned IMMEDIATELY even if
 *    it is past its age, and a refresh is kicked off behind it. The reader gets
 *    a number and a timestamp instead of a wait. Freshness is reported rather
 *    than enforced — the caller can say "as at 9:12" and let the reader judge.
 * 2. **Persisted.** The value survives a `pm2 restart`. Without this, every
 *    deploy hands the next visitor a cold two-minute load, which is the worst
 *    possible moment for it.
 *
 * Only ONE refresh per key runs at a time. Three tabs opening at once must not
 * become three concurrent runs of a query set that already starves the database.
 */

const db = require('../db');

/** In-flight refreshes, so concurrent readers share one run. */
const inflight = new Map();

function read(key) {
  const row = db.findOne('cache', c => c.key === key);
  if (!row) return null;
  return { value: row.value, at: row.at, ageMs: Date.now() - Date.parse(row.at) };
}

function write(key, value) {
  const row = db.findOne('cache', c => c.key === key);
  const at = new Date().toISOString();
  if (row) db.update('cache', row.id, { value, at });
  else db.insert('cache', { key, value, at });
  return { value, at, ageMs: 0 };
}

async function refresh(key, producer) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      return write(key, await producer());
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Get a value, preferring speed over freshness.
 *
 * - Fresh enough: returned as is.
 * - Stale but present: returned immediately, refresh started in the background.
 * - Absent: the caller has to wait, because there is nothing else to give them.
 *
 * `force` waits for a genuine refresh — used by the explicit Refresh button,
 * where waiting is what was asked for.
 */
async function get(key, producer, { maxAgeMs = 30 * 60 * 1000, force = false } = {}) {
  if (force) {
    const fresh = await refresh(key, producer);
    return { ...fresh, stale: false, refreshing: false };
  }

  const hit = read(key);
  if (!hit) {
    const fresh = await refresh(key, producer);
    return { ...fresh, stale: false, refreshing: false };
  }

  if (hit.ageMs <= maxAgeMs) return { ...hit, stale: false, refreshing: false };

  // Stale: hand back what we have and start the refresh behind it. The failure
  // is swallowed deliberately — a background refresh that throws must not become
  // an unhandled rejection, and the reader already has a usable answer with an
  // honest timestamp on it.
  refresh(key, producer).catch(err =>
    console.warn(`[VANTAGE] background refresh of "${key}" failed:`, err.message));

  return { ...hit, stale: true, refreshing: true };
}

module.exports = { get, read, write, refresh };
