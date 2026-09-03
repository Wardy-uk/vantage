'use strict';

/**
 * Per-person service desk signals, read from NOVA's bridge.
 *
 * The half of the department VANTAGE could not see. Until this existed the radar
 * knew queues and tiers and nothing about the people in them, so it could not
 * answer anything the HoTS framework counts per head.
 *
 * VANTAGE does not compute any of it. NOVA owns the capture, the roster and the
 * classification; this is a reader.
 *
 * ── THE FENCE ───────────────────────────────────────────────────────────────
 * `verificationOnly` (solvedToday, solvedWeek, ticketsPerHour) is NEVER read by
 * anything in this file that produces a card. Those are the headline
 * productivity indicators PIP competency 1 was opened over — admissible against
 * a specific overtime claim, never as a judgement that somebody is
 * underperforming. NOVA fenced them into their own object so a renderer cannot
 * fold them into a scorecard by accident; this side keeps the fence up.
 * Pinned by test.
 *
 * ── ABSENCE ─────────────────────────────────────────────────────────────────
 * Four signals fail independently and each says so. Three distinctions from the
 * NOVA side are load-bearing and are carried through rather than flattened:
 *
 *   - `measuredButNotOnRoster: null` means the check could not run. `[]` means
 *     it ran and the two agree. Reporting "no discrepancies" for the first is
 *     the whole failure this repo keeps having.
 *   - `state: 'no-capture'` is an UNMEASURED person, not a quiet one.
 *   - standup `missed` is null when nothing was evidenced, because "missed 0 of
 *     0" is not a fact about anybody.
 */

const BUILD_EXPECTED = '2026-09-03-people-a';
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 60_000;

/** A capture older than this is reported as stale rather than as today. */
const STALE_CAPTURE_DAYS = 2;

let cache = { at: 0, data: null };

function isConfigured() {
  return Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

async function fetchSignals(days = 30) {
  const base = (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '')
    .replace(/\/$/, '');

  const res = await fetch(`${base}/api/neuro-bridge/people-signals?days=${days}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA returned ${res.status}`);
  }
  return payload.data || payload;
}

/**
 * Current per-person signals, cached.
 *
 * NEVER throws, and refuses a build it does not recognise. A stale NOVA `dist`
 * once returned a plausible response with new fields quietly undefined, and the
 * figures it did return had been computed by logic already corrected.
 */
async function current({ force = false, days = 30 } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const signals = await fetchSignals(days);

    if (signals.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on people-signals build "${signals.build || 'unknown'}"; `
          + `VANTAGE reads "${BUILD_EXPECTED}". Deploy NOVA, or bump the stamp on both sides.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const data = {
      available: true,
      asOf: new Date().toISOString(),
      window: signals.window,
      roster: signals.roster,
      performance: signals.performance,
      standups: signals.standups,
      escalations: signals.escalations,
      // Named so a section that could not be measured says so instead of
      // rendering as a section with nothing in it.
      unavailable: signals.unavailable || [],
      raw: signals,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (cache.data?.available) {
      return { ...cache.data, stale: true, staleReason: err.message };
    }
    return { available: false, reason: err.message };
  }
}

/**
 * A one-line-per-signal summary for the coach's system prompt.
 *
 * Deliberately says what is NOT known. A coach handed a partial picture that
 * reads as a complete one gives confident advice about a team it cannot see.
 */
function summarise(p) {
  if (!p?.available) return null;
  const lines = [];

  const r = p.roster;
  if (r?.ok) {
    lines.push(`- Team: ${r.data.people.length} active (${r.data.scope.departments.join(', ')}).`);
    const off = r.data.measuredButNotOnRoster;
    lines.push(off === null
      ? '- Roster vs capture: NOT CHECKED (the capture could not be read). Do not say the two agree.'
      : off.length
        ? `- Measured but NOT on the roster: ${off.map(x => x.name || x.accountId).join(', ')}.`
        : '- Roster and capture agree.');
  } else lines.push(`- Roster: UNAVAILABLE (${r?.error || 'not returned'})`);

  const perf = p.performance;
  if (perf?.ok) {
    const { day, ageDays } = perf.data.asOf || {};
    lines.push(`- Performance figures are the frozen capture for ${day || 'an unknown day'}`
      + (ageDays === null || ageDays === undefined ? '' : `, ${ageDays}d old`)
      + `. ${perf.data.notCaptured} roster member(s) have no row and are UNMEASURED, not quiet.`);
    const sc = perf.data.slaCoverage;
    if (sc) lines.push(`- SLA compliance rests on ${sc.withValue} of ${sc.ofPeople} people. ${sc.basis}`);
    if (perf.data.withheld?.length) {
      lines.push(`- Deliberately not sent: ${perf.data.withheld.map(w => w.field).join(', ')}.`);
    }
  } else lines.push(`- Performance: UNAVAILABLE (${perf?.error || 'not returned'})`);

  const s = p.standups;
  lines.push(s?.ok
    ? `- Standups: ${s.data.sessionsEvidenced} of ${s.data.sessionsInWindow} sessions have any evidence they ran`
      + ` (a session row is created by background jobs and does not prove one happened).`
    : `- Standups: UNAVAILABLE (${s?.error || 'not returned'})`);

  const e = p.escalations;
  lines.push(e?.ok
    ? `- Escalations recorded per person. CAVEAT: ${e.data.attributionCaveat}`
    : `- Escalations: UNAVAILABLE (${e?.error || 'not returned'})`);

  lines.push('- Ticket counts (solved today/week, tickets per hour) are NOT in this summary. '
    + 'They exist for verifying a specific overtime claim and are never evidence that somebody is underperforming.');

  return lines.join('\n');
}

/**
 * Radar cards.
 *
 * Only the ones that need no invented threshold. QA and Golden Rules scores are
 * deliberately NOT carded yet: choosing "below 6" or "below 7" without having
 * seen the live distribution would be inventing the finding rather than reading
 * it, and a wrong threshold names a person as underperforming.
 */
function toRadarItems(p) {
  if (!p?.available) return [];
  const items = [];

  // 1. People being measured who are not on the roster. Leavers whose scores are
  //    still in the day's totals, which makes every coverage figure wrong.
  const off = p.roster?.ok ? p.roster.data.measuredButNotOnRoster : undefined;
  if (Array.isArray(off) && off.length) {
    const names = off.map(x => x.name || x.accountId);
    items.push({
      tense: 'happening',
      severity: 'medium',
      title: `${names.length} measured but not on the roster`,
      detail: `${names.join(', ')} appear in the KPI capture but are not on the active roster — `
        + 'left, moved department or deactivated since the freeze. Their tickets and scores are still '
        + 'in the day\'s totals, so every coverage percentage computed over the roster is wrong by that much.',
      source: 'People',
      remedy: `Check whether ${names[0]} should still be in the capture scope. If they have left, `
        + 'the roster is right and the capture needs them excluding; if they have not, the roster is wrong.',
    });
  }

  // 2. Roster members with no row in the capture. Unmeasured, not quiet.
  if (p.performance?.ok && p.performance.data.notCaptured > 0) {
    const d = p.performance.data;
    items.push({
      tense: 'happening',
      severity: 'low',
      title: `${d.notCaptured} of the team have no figures for ${d.asOf?.day || 'the captured day'}`,
      detail: 'They are UNMEASURED for that day, which is not the same as having had a quiet one. '
        + 'Any per-person comparison across the team is missing them entirely.',
      source: 'People',
      remedy: 'Worth one look at whether the capture is meant to cover them — a person who is never '
        + 'captured is invisible to every measure the framework counts per head.',
    });
  }

  // 3. A capture that has not run recently. The numbers are real, they are just
  //    not about today, and a date is the cheapest thing to get wrong.
  const age = p.performance?.ok ? p.performance.data.asOf?.ageDays : null;
  if (typeof age === 'number' && age >= STALE_CAPTURE_DAYS) {
    items.push({
      tense: 'happening',
      severity: age >= 7 ? 'medium' : 'low',
      title: `Per-person figures are ${age} days old`,
      detail: `The frozen capture last ran for ${p.performance.data.asOf.day}. Everything per-person `
        + 'describes that day, not today. Treat it as that date or not at all.',
      source: 'People',
      remedy: 'Check the capture job on AAPP01 — captureAgentKpis freezes at 18:00 UK.',
    });
  }

  // 4. Somebody submitting no standups at all while the team is submitting.
  //    No threshold invented: zero against a non-zero evidenced denominator.
  if (p.standups?.ok) {
    const s = p.standups.data;
    const silent = (s.perPerson || []).filter(x => x.submitted === 0 && x.missed !== null && x.missed > 0);
    if (silent.length && s.sessionsEvidenced > 0) {
      items.push({
        tense: 'happening',
        severity: 'low',
        title: `${silent.length} submitted no standups in the window`,
        detail: `${silent.map(x => x.name).join(', ')} submitted nothing across `
          + `${s.sessionsEvidenced} sessions that have evidence of running. `
          + 'Counted against evidenced sessions only — a session row on its own is created by background '
          + 'jobs and does not prove a standup happened.'
          + (s.unmatchedSubmitters?.length
            ? ` Separately, ${s.unmatchedSubmitters.length} submitter name(s) matched nobody on the roster `
              + `(${s.unmatchedSubmitters.map(u => u.name).join(', ')}) and are missing from this count.`
            : ''),
        source: 'People',
        remedy: `Ask ${silent[0].name} at your next 1:1 whether the standup is landing — `
          + 'a person who never submits is either not being asked or has stopped being expected to.',
      });
    }
  }

  return items;
}

module.exports = { current, summarise, toRadarItems, isConfigured, BUILD_EXPECTED, STALE_CAPTURE_DAYS };
