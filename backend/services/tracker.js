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
async function current({ force = false, days = 28, withHistory = false } = {}) {
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

    // ⚠ An ARRAY, not a Map.
    //
    // The first cut held these in a `Map` for lookup convenience. In-process
    // that is fine and the detectors worked; over the wire `JSON.stringify` of
    // a Map is `{}`, so `/api/tracker` and the MCP operation both returned an
    // empty object where every live value should have been — and nothing would
    // have caught it, because the only consumers exercised until then were
    // in-process. Anything crossing a serialisation boundary is a plain array
    // or a plain object. `indexLive()` below rebuilds the lookup for callers
    // that want one.
    const liveItems = raw.live?.items || [];

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
        items: liveItems,
      },
      hourly,
      baselineTrustedFrom: BASELINE_TRUSTED_FROM,
    };

    // A screen needs the live value AND where it sat yesterday, in one call.
    // Opt-in, because the detectors already hold the daily series and a second
    // fetch on their path would be wasted work against a DTU-limited database.
    if (withHistory) data.byRow = await joinHistory(rows, liveItems, force);
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (cache.data?.available) return { ...cache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}


/**
 * One row per tracker line, with today beside the recent past.
 *
 * Built for a reader rather than a detector: the question on a screen is "what
 * is this now, what was it yesterday, and is that unusual", and answering it
 * from three separate calls would guarantee the three drifted.
 *
 * A row with no KPI key comes back with `measured: false` and its label. It is
 * NOT dropped — the tracker is the sheet Nick reports, and a view showing only
 * the rows we can compute would quietly redefine it as the subset NOVA happens
 * to know.
 */
async function joinHistory(rows, liveItems, force) {
  const kpiSeries = require('./kpi-series');
  const hist = await kpiSeries.current({ force }).catch(() => ({ available: false }));
  const live = new Map(liveItems.map(i => [i.key, i]));

  return rows.map(row => {
    if (!row.kpiKey) {
      return {
        label: row.label, key: null, measured: false,
        reason: 'no KPI key in the NOVA tracker spec — not computed, so not watched',
      };
    }
    const s = hist.available ? hist.series[row.kpiKey] : null;
    const pts = s?.points || [];
    const item = live.get(row.kpiKey) || null;
    const recent = pts.slice(-14);
    const yesterday = recent.length ? recent[recent.length - 1] : null;
    const week = recent.slice(-7).map(p => p.value);
    const prevWeek = recent.slice(-14, -7).map(p => p.value);
    const avg = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

    return {
      label: row.label,
      key: row.kpiKey,
      measured: true,
      extra: row.extra === true,
      unit: s?.unit ?? null,
      direction: s?.direction ?? null,
      target: item?.target ?? s?.dailyTarget ?? null,
      live: item ? item.value : null,
      rag: item?.rag ?? null,
      // The close this live value should be read against. Named rather than
      // implied, because "yesterday" is doing real work in every comparison.
      yesterday: yesterday ? { day: yesterday.day, value: yesterday.value } : null,
      change: item && yesterday && item.value !== null ? Math.round((item.value - yesterday.value) * 10) / 10 : null,
      weekMean: avg(week),
      prevWeekMean: avg(prevWeek),
      points: recent.map(p => ({ day: p.day, value: p.value })),
      // Absence, said out loud rather than shown as an empty sparkline.
      historyAvailable: Boolean(s),
      historyReason: s ? null : (hist.available ? 'no daily history for this key' : (hist.reason || 'daily history not read')),
    };
  });
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

/** Key → live item, for callers that want a lookup. Built on demand rather than
 *  stored, because a Map cannot cross a JSON boundary — see the note in `current`. */
const indexLive = live => new Map((live?.items || []).map(i => [i.key, i]));

module.exports = {
  current, isConfigured, baselineCaveat, indexLive,
  BUILD_EXPECTED, BASELINE_TRUSTED_FROM, MIN_DAYS_FOR_HOURLY_BASELINE,
};
