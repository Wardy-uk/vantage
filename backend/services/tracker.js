'use strict';

/**
 * The Daily KPI Tracker — the rows Nick reports to the business daily.
 *
 * ── Why this is separate from `kpi-series` ──────────────────────────────────
 *
 * `kpi-series` reads DAILY history for the twelve KPIs the original detectors
 * need — a settled, one-row-per-day view. This reads the tracker: the canonical row
 * list, what every row is doing RIGHT NOW, and the hourly readings NOVA started
 * keeping. Different question, different cadence, different failure modes.
 *
 * ── The row list is NOT defined here ────────────────────────────────────────
 *
 * It comes from NOVA's `TRACKER_ROWS`, served over the bridge. That is the
 * definition of what Nick reports, and a copy on this side would be a second
 * thing to forget to update — with a silent failure mode, because a monitor
 * watching all-but-one row looks exactly like one watching them all.
 *
 * THREE ROWS HAVE NO KPI KEY and are passed through as blank rather than
 * dropped: "Number of TPJ Tickets in Dev" (Nick is revising the definition —
 * the obvious candidate `nt_tpj_dev_t3` matched his sheet on 10 of 12 days,
 * which is close and therefore worse than nothing), "Failed Jobs remaining on
 * Board" and "No. of CI In Progress". Counts are SERVED rather than written
 * down here — measured 17 Sep 2026 the tracker had 35 entries and 32
 * measurable, not the 34/31 an earlier comment asserted, and a number in a
 * comment is a number nobody updates.
 *
 * ── The baseline has a hole in it, and it is dated ──────────────────────────
 *
 * ⚠ Measured 17 Sep 2026: NOVA's stored values disagreed with Nick's reported
 * sheet on 2-10 September — up to +47 on Total Solved — and agree exactly from
 * 11 September onward. The cause was fixed FORWARD and the old days were never
 * backfilled. So until roughly 9 October a 28-day baseline straddles the
 * correction, and drift measured across it is partly measuring the fix rather
 * than the department. `baselineWarning` carries that date so a detector can
 * say so instead of averaging through it.
 */

const BUILD_EXPECTED = '2026-09-17-intraday-a';
const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 90_000;

/**
 * The day NOVA's capture and Nick's reported sheet started agreeing.
 *
 * Everything before it is known to disagree and was not backfilled. Held as a
 * date rather than a boolean so the warning expires by arithmetic instead of
 * being switched off by hand and forgotten.
 */
const BASELINE_TRUSTED_FROM = '2026-09-11';

let cache = { at: 0, data: null };

const isConfigured = () => Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);

function base() {
  return (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '').replace(/\/$/, '');
}

async function bridge(path) {
  const res = await fetch(`${base()}/api/neuro-bridge/${path}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `NOVA returned ${res.status}`);
  return payload.data;
}

/**
 * How many days of intraday readings before "unusual for this hour" is a claim
 * about evidence rather than a feeling.
 *
 * Ten weekdays, matching the bar in NOVA's own validator — two working weeks,
 * so every hour has been seen on every weekday twice. Below that the claim
 * rests on one or two Tuesdays.
 */
const MIN_DAYS_FOR_HOURLY_BASELINE = 10;

/**
 * Current tracker state. NEVER throws — unavailability is a state with a
 * reason, same contract as every other reader here.
 */
async function current({ force = false, days = 28 } = {}) {
  if (!isConfigured()) return { available: false, reason: 'NOVA bridge not configured' };
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const raw = await bridge(`kpi-tracker?days=${days}`);

    if (raw.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on kpi-tracker build "${raw.build || 'unknown'}"; VANTAGE reads "${BUILD_EXPECTED}". Redeploy NOVA.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const rows = raw.rows || [];
    const measurable = rows.filter(r => r.kpiKey);
    const unmeasured = rows.filter(r => !r.kpiKey).map(r => r.label);

    // Live values, keyed for lookup. Absent when the snapshot failed — and that
    // is reported rather than rendered as every KPI sitting at zero.
    const live = new Map();
    for (const item of raw.live?.items || []) live.set(item.key, item);

    // Intraday, with the readiness question answered rather than left to the
    // caller to work out from a row count.
    const intradayDays = new Set();
    for (const s of raw.intraday?.series || []) for (const p of s.points) intradayDays.add(p.day);
    const hourly = {
      available: Boolean(raw.intraday && !raw.intradayError),
      error: raw.intradayError || null,
      daysCovered: intradayDays.size,
      readySoon: intradayDays.size > 0 && intradayDays.size < MIN_DAYS_FOR_HOURLY_BASELINE,
      ready: intradayDays.size >= MIN_DAYS_FOR_HOURLY_BASELINE,
      needed: MIN_DAYS_FOR_HOURLY_BASELINE,
      series: raw.intraday?.series || [],
    };

    const data = {
      available: true,
      asOf: new Date().toISOString(),
      rows,
      measurable,
      // Named, because a monitor covering all-but-three rows must not read as
      // one covering the tracker.
      unmeasured,
      totalRows: rows.length,
      live: {
        available: Boolean(raw.live && !raw.liveError),
        error: raw.liveError || null,
        day: raw.live?.day || null,
        ageSeconds: raw.live?.ageSeconds ?? null,
        byKey: live,
      },
      hourly,
      baselineTrustedFrom: BASELINE_TRUSTED_FROM,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (cache.data?.available) return { ...cache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}

/**
 * Is a baseline window clean, given the correction of 11 Sep 2026?
 *
 * PURE. Returns a warning string or null, so a detector can state the caveat in
 * its own confidence basis rather than each one re-deriving the date.
 */
function baselineCaveat(fromDay, trustedFrom = BASELINE_TRUSTED_FROM) {
  if (!fromDay || fromDay >= trustedFrom) return null;
  return `the baseline reaches back to ${fromDay}, before ${trustedFrom} — NOVA's stored values disagreed with the reported sheet until then (up to +47 on Total Solved) and were never backfilled, so part of this movement is the correction rather than the department`;
}

module.exports = {
  current, isConfigured, baselineCaveat,
  BUILD_EXPECTED, BASELINE_TRUSTED_FROM, MIN_DAYS_FOR_HOURLY_BASELINE,
};
