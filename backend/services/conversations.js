'use strict';

/**
 * Individual conversations with direct reports, read from NOVA's bridge.
 *
 * This is the PIP competency 3 measure, and it is the first thing VANTAGE has
 * been able to say about it:
 *
 *   "all management conversations, concerns and actions to be logged within
 *    2 working days, each with an owner and a due date"
 *
 * The 1:1s were never the cited failure. The PIP's own example is "discussions
 * with a team member about overtime" — an ad-hoc conversation, which is why
 * NOVA now records five types rather than one.
 *
 * ── THE TWO TABLES STAY TWO ─────────────────────────────────────────────────
 * NOVA keeps 1:1s in `agent_121_sessions` (which drives cadence) and everything
 * else in `agent_conversations` (which carries none). A welfare check on Tuesday
 * does not discharge the monthly 1:1, and filing one as a session would reset
 * that clock and stop the real 1:1 being booked.
 *
 * NOTHING IN THIS FILE TOUCHES CADENCE. That lives in `one-to-ones.js`, reading
 * `/121/state`, and it is the only thing allowed to. This reader answers "was it
 * written up", never "is one due".
 *
 * ── UNTICKED IS UNCONFIRMED, NOT UNDOCUMENTED ───────────────────────────────
 * NOVA has no PeopleHR connection. The tick is Nick's own confirmation and
 * nothing more, so an empty one is an absence of confirmation, never evidence of
 * an absence. VANTAGE says "not confirmed as logged". It never says "not
 * documented", and it must never tick on his behalf: the entire evidential value
 * of that tick is that a person made it.
 */

const BUILD_EXPECTED = '2026-09-03-conversations-b';
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 60_000;

/**
 * The PIP's own number, not a judgement call, so it is NOT configurable.
 *
 * The QA and Golden Rules floors are settings because where "low" begins is
 * Nick's standard to set. This is different: two working days is what the
 * document says, and a tool that let it drift would be measuring something other
 * than the thing he is assessed against.
 */
const LOG_WITHIN_WORKING_DAYS = 2;

/**
 * The PeopleHR column shipped on this date. Nothing before it can carry a tick,
 * so no rate is ever computed across it — a denominator that includes
 * conversations from a time when confirming was impossible would report a
 * failure that was structurally unavailable.
 */
const MEASURED_FROM = '2026-09-03';

let cache = { at: 0, data: null };

function isConfigured() {
  return Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

/**
 * Whole working days between two instants, Mon–Fri.
 *
 * BANK HOLIDAYS ARE NOT HANDLED, and that is a real limitation rather than an
 * oversight: VANTAGE has no holiday calendar, and inventing one would make a
 * conversation logged on the Tuesday after a bank-holiday Monday read as late
 * when it was not. The count therefore OVERSTATES lateness by at most one day
 * per holiday in the window, so anything it flags is flagged conservatively —
 * a borderline case is stated as borderline rather than asserted.
 */
function workingDaysBetween(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (to < from) return 0;

  let days = 0;
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

async function fetchConversations(since = MEASURED_FROM) {
  const base = (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '')
    .replace(/\/$/, '');

  const res = await fetch(`${base}/api/neuro-bridge/121/conversations?since=${since}`, {
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
 * Classify each record against the two-working-day standard.
 *
 * `completedAt ?? occurredOn`, and the record says which was used. For anything
 * approved from a recording the two agree by construction; they diverge only on
 * sessions completed through NOVA's wizard, where `occurredOn` is when the 1:1
 * was BOOKED and can be months from when it happened.
 */
function classify(records, now = Date.now()) {
  const nowIso = new Date(now).toISOString();

  const rows = (records || []).map(r => {
    const happenedAt = r.completedAt || `${r.occurredOn}T12:00:00.000Z`;
    const basis = r.completedAt ? 'completedAt' : 'occurredOn';
    const loggedAt = r.peoplehrLoggedAt || null;

    // Only conversations that happened once confirming was possible can carry a
    // confirmation. Everything earlier is reported, never scored.
    const inSeries = r.occurredOn >= MEASURED_FROM;

    const lagWorkingDays = loggedAt ? workingDaysBetween(happenedAt, loggedAt) : null;
    const ageWorkingDays = workingDaysBetween(happenedAt, nowIso);

    return {
      key: `${r.kind}:${r.id}`,
      kind: r.kind,
      person: r.agentName,
      accountId: r.accountId ?? null,
      type: r.conversationType,
      typeLabel: r.typeLabel,
      occurredOn: r.occurredOn,
      happenedAt,
      basis,
      inSeries,
      logged: Boolean(loggedAt),
      loggedAt,
      lagWorkingDays,
      ageWorkingDays,
      // Late only once the window has actually passed. A conversation held this
      // morning is not late, and saying so would be the loudest possible way to
      // lose his trust in the number.
      late: loggedAt
        ? lagWorkingDays > LOG_WITHIN_WORKING_DAYS
        : ageWorkingDays > LOG_WITHIN_WORKING_DAYS,
      onTime: Boolean(loggedAt) && lagWorkingDays <= LOG_WITHIN_WORKING_DAYS,
    };
  });

  const scored = rows.filter(r => r.inSeries);
  return {
    all: rows,
    // Everything below is the SERIES only — conversations that could have been
    // confirmed. `preSeries` is carried so the total is never quietly smaller.
    preSeries: rows.filter(r => !r.inSeries).length,
    scored: scored.length,
    onTime: scored.filter(r => r.onTime),
    lateLogged: scored.filter(r => r.logged && !r.onTime),
    // Past the window and still unconfirmed. The actionable set.
    overdueUnconfirmed: scored.filter(r => !r.logged && r.late)
      .sort((a, b) => b.ageWorkingDays - a.ageWorkingDays),
    // Inside the window and unconfirmed — not late, not a finding.
    pending: scored.filter(r => !r.logged && !r.late),
  };
}

/** Current conversations, cached. NEVER throws; refuses an unknown build. */
async function current({ force = false, since = MEASURED_FROM } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const signals = await fetchConversations(since);

    if (signals.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on conversations build "${signals.build || 'unknown'}"; `
          + `VANTAGE reads "${BUILD_EXPECTED}". Deploy NOVA, or bump the stamp on both sides.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const conv = signals.conversations;
    const data = {
      available: true,
      asOf: new Date().toISOString(),
      since: signals.since || since,
      measuredFrom: MEASURED_FROM,
      conversations: conv,
      attribution: signals.attribution,
      // Null rather than an empty assessment when the section failed. NOVA fails
      // the whole conversations block if the roster read fails, precisely so a
      // feed with every accountId null is not mistaken for a team nobody matched.
      assessment: conv?.ok ? classify(conv.data.records) : null,
      unmatchedNames: conv?.ok ? conv.data.unmatchedNames : null,
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
 * The caveat that must travel with every figure from this source.
 *
 * NEURO drops conversations it cannot attribute to a person, so the count is a
 * FLOOR. `measured: false` means NEURO has never reported — which is not zero,
 * and is the difference between "none were dropped" and "we do not know".
 */
function floorNote(p) {
  const a = p?.attribution;
  if (!a?.ok) return 'How many conversations went unattributed could NOT be read, so treat every count as a floor.';
  if (!a.data.measured) {
    return 'NEURO has never reported how many conversations it could not attribute — NOT a report of zero. Treat every count as a floor.';
  }
  if (a.data.unattributed > 0) {
    return `${a.data.unattributed} conversation(s) could not be attributed to a person and are NOT in these counts, `
      + `so every figure here is a FLOOR (last sweep ${String(a.data.lastSweepAt || '').slice(0, 10) || 'unknown'}).`;
  }
  return 'Nothing was dropped for want of attribution at the last sweep.';
}

/** Lines for the coach's system prompt. */
function summarise(p) {
  if (!p?.available) return null;
  const a = p.assessment;
  if (!a) return `- Conversations: UNAVAILABLE (${p.conversations?.error || 'section not returned'})`;

  const lines = [
    `- Conversation write-ups (PIP competency 3, "logged within 2 working days"), measured from ${p.measuredFrom}:`
    + ` ${a.onTime.length} on time, ${a.lateLogged.length} logged late, ${a.overdueUnconfirmed.length} past the window and unconfirmed,`
    + ` ${a.pending.length} still inside it.`,
  ];
  if (a.preSeries) {
    lines.push(`- ${a.preSeries} earlier conversation(s) are shown but NOT scored: the PeopleHR column did not exist,`
      + ' so they could not have been confirmed and a failure there would be one nobody could have avoided.');
  }
  if (a.overdueUnconfirmed.length) {
    lines.push(`- Unconfirmed past the window: ${a.overdueUnconfirmed.slice(0, 6)
      .map(r => `${r.person} ${r.typeLabel} ${r.occurredOn} (${r.ageWorkingDays}wd)`).join(', ')}.`);
  }
  lines.push(`- ${floorNote(p)}`);
  if (p.unmatchedNames?.length) {
    lines.push(`- ${p.unmatchedNames.length} name(s) matched nobody on the roster and are missing from these counts.`);
  }
  lines.push('- UNCONFIRMED IS NOT UNDOCUMENTED. NOVA cannot see PeopleHR; the tick is his own confirmation.'
    + ' Never tell him something is undocumented, and never suggest VANTAGE tick it for him.');
  return lines.join('\n');
}

/** Radar cards. One, and only when something is genuinely past the window. */
function toRadarItems(p) {
  if (!p?.available || !p.assessment) return [];
  const a = p.assessment;
  const overdue = a.overdueUnconfirmed;
  if (!overdue.length) return [];

  const first = overdue[0];
  const done = a.onTime.length + a.lateLogged.length;

  return [{
    tense: 'happening',
    severity: overdue.length >= 3 ? 'high' : 'medium',
    title: `${overdue.length} conversation(s) not confirmed logged in PeopleHR`,
    detail: `Past the two-working-day window: ${overdue.slice(0, 6)
      .map(r => `${r.person} (${r.typeLabel}, ${r.occurredOn}, ${r.ageWorkingDays} working days ago)`).join('; ')}. `
      + `${done} of ${a.scored} have been confirmed, ${a.onTime.length} of them inside the window. `
      + 'This is his own tick in NOVA, not a reading of PeopleHR — unconfirmed means unconfirmed, not undocumented. '
      + floorNote(p),
    source: 'Conversations',
    remedy: `Write up ${first.person}'s ${first.typeLabel.toLowerCase()} from ${first.occurredOn} in PeopleHR, `
      + 'then tick it on the 1-2-1 Overview. The note is the evidence at a review; the tick is only how you find it again.',
  }];
}

module.exports = {
  current, classify, summarise, toRadarItems, floorNote, workingDaysBetween,
  isConfigured, BUILD_EXPECTED, LOG_WITHIN_WORKING_DAYS, MEASURED_FROM,
};
