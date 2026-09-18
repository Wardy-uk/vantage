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
/**
 * How much history to fetch.
 *
 * 240, not 120, and the extra is for Q1. Every other detector needs five weeks;
 * Q1 needs `QUIET_LOOKBACK` days of evidence a measure was ALIVE plus however
 * long it has been silent — so the window bounds how old a stop it can still
 * see. At 120 days it could only notice a stop less than 60 days old, and the
 * AI-resolution pipeline had been dead for 103: the proof it ever worked had
 * scrolled out of view, so Q1 sat quiet about the very thing it was built for.
 *
 * ⚠ THE LIMIT DOES NOT GO AWAY, it moves. At 240 days Q1 sees stops up to ~180
 * days old and is blind to anything older — a process that died last winter
 * looks, to every detector here, exactly like one that never existed. Nothing
 * in the data can distinguish those; only a person can.
 *
 * The cost is measured, not guessed: 1.2MB at 120 days, 2.2MB at 240, fetched
 * once per 30-minute cache window over Tailscale.
 */
const DEFAULT_DAYS = 240;

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
 * WHICH SERIES THE DETECTORS WATCH — a rule, not a list.
 *
 * ⚠ THIS REPLACED A HAND-MAINTAINED LIST, and the reason is an incident.
 *
 * On 14 Sep 2026 a NOVA fault stopped tickets getting an AI first response and
 * FRT breaches jumped from a typical 5 a day to 45. VANTAGE said nothing. The
 * detectors were fine — replayed against `nt_sla_frt_all_breached`, T2 fires on
 * 14 September and every day after. It never saw the series, because the watch
 * list was Nick's DAILY TRACKER ROWS and FRT breach counts are not on his
 * sheet.
 *
 * That was the wrong definition. "What Nick reports to the business" and "what
 * would tell us something is wrong" are different sets, and the second is the
 * one a warning system needs. Measured the morning after: 49 well-populated
 * series were sitting unwatched, including every FRT and Resolution SLA
 * measure in the estate.
 *
 * A curated list fails silently — nothing announces the key nobody added. So
 * the list is gone and a PREDICATE decides: anything with enough history, that
 * actually varies, and is not known-bad. Adding a KPI to NOVA now brings it
 * into scope automatically, and the failure mode becomes "too much watched",
 * which is visible, rather than "one thing missed", which is not.
 */

/**
 * Is this series worth scoring at all?
 *
 * Three conditions, each answering a way a series can be useless:
 *
 *   ENOUGH HISTORY  a weekly detector needs five complete weeks; 60 days leaves
 *                   room for the odd gap.
 *   IT MOVES        a permanently-zero or near-constant series has no standard
 *                   deviation, so `zScore` returns null and it can NEVER fire.
 *                   Watching one looks like coverage and is not — `nt_ai_rate`
 *                   is 0 on all 96 of its days, and had it been "watched" it
 *                   would have reported nothing for ever while appearing fine.
 *   NOT KNOWN-BAD   the contaminated and too-sparse ones, named in EXCLUDED.
 */
/**
 * WHAT THE DETECTORS SCAN — and why it is not "everything".
 *
 * Two categories, and the second is the one whose absence caused the 14 Sep
 * 2026 miss:
 *
 *   THE TRACKER   what Nick reports to the business daily. How much work there
 *                 is, and where it is sitting.
 *   SLA HEALTH    whether the work is being SERVED in time. Outcome measures
 *                 rather than volume ones — and the tracker has none of them,
 *                 which is precisely why a fault that stopped AI first
 *                 responses and tripled FRT breaches was invisible.
 *
 * ⚠ "WATCH EVERYTHING" WAS TRIED AND MEASURED AND REJECTED. Replaying 91 days
 * over all 80 usable series: T1 produced 33.6 distinct warnings a month and T2
 * 20.4 — a new card every working day, on a radar whose whole promise is a
 * short ranked list. Correlation folding and a three-day persistence rule both
 * helped and neither was close to enough, because many of these series trend
 * and are volatile, so a z against their own four-week baseline is out most of
 * the time. At the scope below the same replay gives 6.6 and 4.3 a month, and
 * T1 still catches 14 September ON THE DAY.
 *
 * So this is a judgement about CATEGORIES rather than a rule derived from the
 * data, and it can be wrong the same way the last one was. What is different is
 * that the gap is now VISIBLE: `notWatched` lists every usable series outside
 * the scope, and the screen shows the count. A blind spot that announces itself
 * is a different animal from one that waits for an incident.
 */
const SLA_HEALTH_KEYS = [
  'nt_sla_frt_all_breached',
  'nt_sla_res_all_breached',
  'nt_frt_compliance',
  'nt_res_compliance',
  'nt_first_line_rate',
];

const TRACKER_STOCK_KEYS = [
  'nt_legacy_new_tickets', 'nt_legacy_solved_today', 'nt_solved_nova',
  'nt_legacy_cc_incidents', 'nt_legacy_cc_service_requests', 'nt_legacy_cc_tpj',
  'nt_legacy_production', 'nt_legacy_tier2', 'nt_legacy_tier3', 'nt_legacy_development',
];

/** The scanned set. Usability is applied ON TOP, so a dead series inside the
 *  scope is still excluded and still says why. */
const SCANNED = new Set([...TRACKER_STOCK_KEYS, ...SLA_HEALTH_KEYS]);

const MIN_DAYS = 60;
const MIN_NON_ZERO = 30;
const MIN_DISTINCT = 8;
const RECENT_WINDOW = 60;

function usable(series) {
  if (!series || EXCLUDED[series.key]) return false;
  if (!SCANNED.has(series.key)) return false;
  const pts = series.points || [];
  if (pts.length < MIN_DAYS) return false;
  const recent = pts.slice(-RECENT_WINDOW).map(p => p.value);
  if (recent.filter(v => v !== 0).length < MIN_NON_ZERO) return false;
  return new Set(recent).size >= MIN_DISTINCT;
}

/** Why a series is not watched, for the screen. An unwatched KPI that says
 *  nothing about why is the same silent omission in a new place. */
function whyNotUsable(series) {
  if (!series) return 'not in the feed';
  if (EXCLUDED[series.key]) return EXCLUDED[series.key];
  if (!SCANNED.has(series.key)) {
    return 'outside the scanned scope — the tracker rows plus the top-level SLA health measures. '
      + 'Watching every series was measured and produced a new warning every working day';
  }
  const pts = series.points || [];
  if (pts.length < MIN_DAYS) return `only ${pts.length} days of history (needs ${MIN_DAYS})`;
  const recent = pts.slice(-RECENT_WINDOW).map(p => p.value);
  const nz = recent.filter(v => v !== 0).length;
  if (nz < MIN_NON_ZERO) return `zero on ${recent.length - nz} of the last ${recent.length} days — it cannot produce a deviation, so watching it would be coverage in name only`;
  return `only ${new Set(recent).size} distinct values in ${recent.length} days — too flat to score`;
}

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

async function current({ force = false, days = DEFAULT_DAYS, keys = null } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    // No `keys` filter by default. Asking for a named subset is what produced
    // the blind spot this predicate replaced: a key nobody thought to name is
    // indistinguishable from one with no data.
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
      // What the detectors will actually score, and what they will not — each
      // with its reason. Computed here so one rule answers it for every caller.
      watched: Object.values(series).filter(usable).map(s2 => s2.key).sort(),
      // How many series exist that a detector COULD score but is not scoring.
      // Surfaced deliberately: the 14 Sep miss was a scope gap nothing
      // announced, and a number on a screen is the cheapest guard against the
      // same thing happening quietly again.
      outsideScope: Object.values(series)
        .filter(s2 => !SCANNED.has(s2.key) && !EXCLUDED[s2.key] && (s2.points || []).length >= MIN_DAYS)
        .length,
      notWatched: Object.values(series).filter(s2 => !usable(s2))
        .map(s2 => ({ key: s2.key, label: s2.label, reason: whyNotUsable(s2) }))
        .sort((a, b) => a.key.localeCompare(b.key)),
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
  BUILD_EXPECTED, EXCLUDED, DEFAULT_DAYS,
  usable, whyNotUsable, MIN_DAYS, MIN_NON_ZERO, MIN_DISTINCT,
  SCANNED, SLA_HEALTH_KEYS, TRACKER_STOCK_KEYS,
};
