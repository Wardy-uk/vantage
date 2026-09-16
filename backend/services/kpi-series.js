'use strict';

/**
 * The daily KPI history, and the capacity ahead — read from NOVA's bridge.
 *
 * VANTAGE reads, it does not recompute. Every number here was frozen by NOVA's
 * 18:00 capture into `kpi_org_daily` and is passed through untouched; the
 * detectors in `leading.js` take derivatives of it and nothing else. A second
 * implementation of "how many tickets arrived on Tuesday" would drift from the
 * one feeding the weekly report, and the disagreement would surface in a
 * document going to Nick's manager.
 *
 * ── Why a series and not a trend ────────────────────────────────────────────
 *
 * `kpi-org-trend` already existed and returns WEEKLY averages. That is the
 * right shape for a compliance table and the wrong shape for early warning: a
 * week bucket cannot say which day something turned, and by the time it moves,
 * the thing it describes is on a wallboard. Everything this file exists for is
 * a first derivative, and a derivative needs the points.
 *
 * ── The holes matter more than the points ───────────────────────────────────
 *
 * `kpi_org_daily` is not uniformly populated and the gaps do not look like
 * gaps: a day the capture never ran is simply absent, and absent renders as
 * nothing unless something insists otherwise. A detector that reads a missing
 * day as zero sees new tickets collapse and backlog vanish — it would fire on
 * an outage and call it an improvement.
 *
 * So `coverage` travels with every series and is never discarded here. It is
 * what `leading.js` computes confidence from, and what stops a slope being
 * drawn across a hole.
 *
 * ── One discontinuity, measured, carried ────────────────────────────────────
 *
 * Every long series changes SOURCE partway through: history before roughly
 * 30 Jul 2026 was reconstructed from Jira by `kpi-org/backfill.ts`
 * (`source: 'reconstruct'`), and after it comes from the live 18:00 freeze
 * (`source: 'jira'`). Measured on 16 Sep 2026, the boundary is smooth for the
 * stock KPIs — `nt_development` ran 192, 194, 194 straight through it — but
 * "smooth for the ones I checked" is not "smooth". `sourceBreaks` reports where
 * the changes are so a detector can refuse to draw a baseline across one, and
 * so a back-test can be scored either side.
 *
 * NOTE two series that are NOT safe and are excluded by name below: the
 * `no_reply` KPIs carry `source: 'backfill-legacy'`, copied from the legacy
 * `jira_kpi_daily` whose values NOVA's own backfill calls "inflated 2-3x", and
 * they contain a 130 sitting between a 0 and a 2. That is not a signal.
 */

const BUILD_EXPECTED = '2026-09-16-series-a';
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 60_000;
/** Enough for a 28-day baseline, a current week, and room to see a season. */
const DEFAULT_DAYS = 120;

/**
 * Series that must never reach a detector, with the reason attached.
 *
 * Kept as data rather than left to each detector to remember, because "do not
 * use this one" enforced by convention is enforced by nobody.
 */
const EXCLUDED = {
  nt_incidents_no_reply: 'history is `backfill-legacy`, copied from the legacy table NOVA calls inflated 2-3x; contains a 130 between a 0 and a 2',
  nt_production_no_reply: 'history is `backfill-legacy`, same contaminated source',
  nt_csat: 'measured 16 Sep 2026: 30 days of value in 120, with an 11-day hole. The sample cannot support a trend',
};

/**
 * The KPIs the detectors actually read, asked for BY NAME.
 *
 * Not an optimisation for its own sake. Asking for everything returns 132
 * series — around 900KB at 120 days — on a path the radar calls, and it makes
 * a missing KPI silent: an unrequested key that has no data is simply not in
 * the response, which is indistinguishable from one that was never wanted.
 * `kpi-org-series` answers a NAMED key with an empty series and a coverage
 * block saying why, which is the difference between "no data" and "not asked".
 *
 * Keep in step with the detectors in `leading.js`. A detector reading a key
 * absent from this list gets `undefined` and blocks itself, which is safe but
 * looks like a data problem rather than a wiring one.
 */
const DETECTOR_KEYS = [
  'nt_new_tickets', 'nt_solved_team', 'nt_solved_nova',
  'nt_oldest_incident', 'nt_oldest_production', 'nt_oldest_development',
  'nt_escalated', 'nt_rejected',
  'nt_development', 'nt_incidents', 'nt_production', 'nt_tpj_dev_t3',
  // The shadow composite's OWNERSHIP family. Added after S1 shipped blocked on
  // "only 2 of 4 evidence families could be computed" — which read as a data
  // problem and was a wiring one, exactly as the note above predicted. Pinned
  // by a test now, so the next detector cannot repeat it.
  'nt_legacy_unassigned',
];

function isConfigured() {
  return Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

function base() {
  return (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '')
    .replace(/\/$/, '');
}

async function bridge(path, { timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetch(`${base()}/api/neuro-bridge/${path}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA returned ${res.status}`);
  }
  return payload.data;
}

/**
 * Where a series changes capture method.
 *
 * PURE, and exported, because it is the thing a back-test has to know about and
 * a detector has to refuse to baseline across. Returns the FIRST day of each
 * new source after the first.
 */
function sourceBreaks(points) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].source !== points[i - 1].source) {
      out.push({ day: points[i].day, from: points[i - 1].source, to: points[i].source });
    }
  }
  return out;
}

/**
 * Current KPI history, cached.
 *
 * NEVER throws. Unavailability is a state carrying its own reason — the same
 * contract `signals.js` holds, for the same reason: a dashboard must not go
 * down because a database was slow, and it must not imply an all-clear either.
 */
let cache = { at: 0, data: null };

async function current({ force = false, days = DEFAULT_DAYS, keys = DETECTOR_KEYS } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const raw = await bridge(`kpi-org-series?days=${days}`
      + (keys?.length ? `&keys=${encodeURIComponent(keys.join(','))}` : ''));

    // Same refusal as `signals.js`. A build we do not recognise may have
    // renamed or dropped a coverage field, and a coverage field read as
    // `undefined` is a confidence score computed from nothing.
    if (raw.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on kpi-org-series build "${raw.build || 'unknown'}"; VANTAGE reads "${BUILD_EXPECTED}". Redeploy NOVA.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const series = {};
    const excluded = [];
    for (const s of raw.series || []) {
      if (EXCLUDED[s.key]) {
        excluded.push({ key: s.key, reason: EXCLUDED[s.key] });
        continue;
      }
      series[s.key] = { ...s, sourceBreaks: sourceBreaks(s.points || []) };
    }

    const data = {
      available: true,
      asOf: new Date().toISOString(),
      window: raw.window,
      team: raw.team,
      series,
      // Named, all three kinds, because each is a different answer to "why is
      // this not on the screen" and a detector that is silent for one of them
      // must be able to say which.
      excluded,
      absent: raw.absent || [],
      unknownKeys: raw.unknownKeys || [],
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (cache.data?.available) return { ...cache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}

/**
 * Who is off, and who is on the roster to be off in the first place.
 *
 * Two caveats travel with this and both change what may be said about it:
 *
 *  - It carries APPROVED leave only. People HR does not return a request still
 *    awaiting a manager, so leave booked for tomorrow and not yet signed off is
 *    legitimately missing. "Nobody is off" is therefore a floor.
 *  - A roster member with no People HR id never syncs and so ALWAYS looks
 *    available. `syncable: false` is an absence of evidence that reads exactly
 *    like evidence of presence, and it is counted so confidence can fall.
 */
let capacityCache = { at: 0, data: null };

async function capacity({ force = false, days = 14 } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured' };
  }
  if (!force && capacityCache.data && Date.now() - capacityCache.at < CACHE_MS) return capacityCache.data;

  try {
    const raw = await bridge(`availability?days=${days}`, { timeoutMs: 30_000 });

    // A roster of nobody is a broken roster join, not a free team. NOVA's own
    // route documents the distinction; refusing to collapse it here is what
    // keeps it true one system further out.
    if (!raw.rosterCount) {
      const data = { available: false, reason: 'NOVA returned an empty roster — a broken roster join, not an empty team' };
      capacityCache = { at: Date.now(), data };
      return data;
    }

    const roster = raw.roster || [];
    const data = {
      available: true,
      asOf: new Date().toISOString(),
      from: raw.from,
      to: raw.to,
      rosterCount: raw.rosterCount,
      unsyncable: roster.filter(r => !r.syncable).map(r => r.name),
      absences: raw.absences || [],
      approvedOnly: true,
    };
    capacityCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (capacityCache.data?.available) return { ...capacityCache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}

module.exports = {
  current, capacity, isConfigured, sourceBreaks,
  BUILD_EXPECTED, EXCLUDED, DEFAULT_DAYS, DETECTOR_KEYS,
};
