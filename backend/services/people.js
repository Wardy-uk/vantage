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

/**
 * A capture older than this is reported as stale rather than as today.
 *
 * FIVE, not two, and the arithmetic matters. NOVA computes
 * `Math.round((now - midnight of the frozen day) / 1 day)`, and the capture
 * freezes at 18:00 for the day just ended. So a job that ran perfectly last
 * night reads as 2 by the afternoon, and a Monday reading Friday's capture
 * reads as 3 or 4 with nothing wrong at all.
 *
 * At 2 this fired every single day on a healthy system. A card that is always
 * on is a card he learns to scroll past, and it takes the real ones with it.
 * 5 means at least one working day's capture genuinely did not run, whenever
 * you happen to look.
 */
const STALE_CAPTURE_DAYS = 5;

/**
 * Who a per-person card can be ABOUT.
 *
 * NOVA's roster is the KPI measurement scope, not Nick's reporting line: its 14
 * is twelve people who report to him, plus Nick himself (tierCode 'NTL'), plus
 * the NOVA AI robot (tierCode 'AI'). Reading it as "the team" produced a card
 * telling Nick to ask Nick, at his next 1:1 with Nick, why Nick had not
 * submitted a standup — alongside a robot that cannot attend one.
 *
 * Matched on name for Nick because this whole tool is his and the bridge route
 * is already hardcoded to him. NOT matched on 'NTL': the Service Desk Team
 * Leader is a live vacancy in the JD folder, and whoever fills it will carry
 * that tier and WILL be somebody he manages.
 */
const SELF_NAME = 'nick ward';
const isSelf = p => (p?.name || '').trim().toLowerCase() === SELF_NAME;
const isBot = p => p?.tierCode === 'AI';
const managedOnly = list => (list || []).filter(p => !isSelf(p) && !isBot(p));

/**
 * The set of accountIds Nick manages, taken from the ROSTER.
 *
 * Only the roster carries `tierCode`. The standup and escalation rows carry
 * `accountId` and `name` and nothing else, so filtering them on tier silently
 * did nothing: it dropped Nick (matched by name) and let the NOVA AI agent
 * straight through, which then became the entire content of the one card the
 * reader produced.
 *
 * Returns null when the roster could not be read. A caller that cannot tell who
 * is a person must raise NOTHING rather than name whoever happens to be in the
 * list — the absent-is-not-zero rule pointed at identity instead of at counts.
 */
function managedIds(p) {
  if (!p?.roster?.ok) return null;
  return new Set(managedOnly(p.roster.data.people).map(x => x.accountId));
}

/**
 * A configured threshold, or null.
 *
 * Lazily required and failure-tolerant on purpose. `settings` reaches the store,
 * which needs `better-sqlite3` — built natively on the Pi and absent on plenty of
 * machines. Requiring it at module load made these readers, and everything that
 * imports them, throw on import. A threshold is configuration: it must never be
 * the reason the radar cannot load.
 *
 * A store that cannot be read yields null, which each caller already treats as
 * "no line drawn" rather than as zero.
 */
function threshold(key) {
  try {
    return require('./settings').getNumber(key);
  } catch {
    return null;
  }
}

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
    const managed = managedOnly(r.data.people);
    lines.push(`- Team: ${managed.length} ${managed.length === 1 ? 'person reports' : 'people report'} to him.`
      + ` NOVA's roster returns ${r.data.people.length} because it is a MEASUREMENT scope —`
      + ` it also carries Nick himself and the NOVA AI agent, neither of whom is a report.`);
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
  const ids = managedIds(p);

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

  // 4. Quality floors. UNSET means no card — a line nobody has drawn is not a
  //    line, and picking one here would name a real person as underperforming on
  //    an opinion of "low" that Nick never gave. Both read SCORES, never counts.
  const qaFloor = threshold('QA_SCORE_FLOOR');
  const grFloor = threshold('GOLDEN_RULES_FLOOR');
  const measured = ids === null ? [] : (p.performance?.ok ? p.performance.data.people : [])
    .filter(x => ids.has(x.accountId) && x.state === 'measured');

  for (const [floor, read, label, scale, what] of [
    [qaFloor, x => x.quality?.qaOverall, 'QA', '10', 'accuracy, clarity and tone on resolved tickets'],
    [grFloor, x => x.quality?.grOverall, 'Golden Rules', '3', 'ownership, next action and timeframe in customer replies'],
  ]) {
    if (floor === null) continue;
    // A null score is UNSCORED, not a low score. Nobody is raised for a day
    // nothing of theirs was sampled.
    const below = measured
      .filter(x => typeof read(x) === 'number' && read(x) < floor)
      .sort((a, b) => read(a) - read(b));
    if (!below.length) continue;

    items.push({
      tense: 'happening',
      severity: 'medium',
      title: `${below.length} below your ${label} floor of ${floor}`,
      detail: `${below.map(x => `${x.name} (${read(x)})`).join(', ')} — scored out of ${scale} on `
        + `${what}, for ${p.performance.data.asOf?.day || 'the captured day'}. `
        + `${measured.length - below.length} of ${measured.length} scored at or above it. `
        + 'One day of sampling: check the trend before treating it as a pattern.',
      source: 'People',
      remedy: `Pull ${below[0].name}'s lowest-scoring ticket from that day and read it with them at your next 1:1. `
        + 'A score is not feedback; the ticket is.',
    });
  }

  // 5. Somebody submitting no standups at all while the team is submitting.
  //    No threshold invented: zero against a non-zero evidenced denominator.
  if (p.standups?.ok) {
    const s = p.standups.data;
    // Identity comes from the roster, not from these rows — they carry no tier.
    // No roster means no way to tell a person from an agent, so nothing is said.
    const pct = threshold('STANDUP_FLOOR_PCT');
    const denom = s.sessionsEvidenced;
    // Unset floor: only a total no-show is raised. Set: anyone under the share.
    const under = x => (pct === null
      ? x.submitted === 0
      : denom > 0 && (x.submitted / denom) * 100 < pct);
    const silent = ids === null ? [] : (s.perPerson || [])
      .filter(x => ids.has(x.accountId))
      .filter(x => x.missed !== null && x.missed > 0 && under(x));
    if (silent.length && s.sessionsEvidenced > 0) {
      items.push({
        tense: 'happening',
        severity: 'low',
        title: pct === null
        ? `${silent.length} submitted no standups in the window`
        : `${silent.length} below your standup floor of ${pct}%`,
        detail: `${silent.map(x => `${x.name} (${x.submitted}/${denom})`).join(', ')} against `
          + `${denom} sessions that have evidence of running. `
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
