'use strict';

/**
 * 1:1 coverage, read from NOVA's bridge.
 *
 * The first OMISSION signal in VANTAGE. Everything else on the radar fires when
 * a number moves badly; this fires when something that should have happened did
 * not — which is the half of the job the tool was structurally blind to.
 *
 * NOVA already answers it. `GET /121/state` returns, per person, the cadence,
 * the next booking and the date one was last held, with `booked: null` and
 * `lastHeld: null` for the people who have neither. Those nulls ARE the finding.
 * We were about to ask NOVA to build this; it had been there all along, unread.
 *
 * WHY THIS, RATHER THAN NEURO's `bookedOneToOnes`:
 * both exist. NEURO reads `1-2-1-booked` out of vault frontmatter, which NEURO
 * itself writes from NOVA's `/121/completed` — so NOVA is upstream and holds the
 * sessions. NEURO's copy is used for a different job (telling the meeting
 * analyser what IS booked so it cannot claim otherwise) and stays where it is.
 * When the two disagree that is a finding, not a bug to paper over.
 *
 * NO BUILD STAMP. `flow-signals` carries one and VANTAGE refuses unrecognised
 * builds; `/121/state` does not offer one. So this reader validates the SHAPE it
 * gets instead, and treats a payload it cannot read as unavailable rather than
 * as an empty team.
 */

const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;

/**
 * Fallback only. Live data (3 Sep 2026) has `cadenceDays: 28` for all twelve
 * people and no nulls, so this is never currently reached.
 *
 * 28 is NOT in conflict with the PIP, and it would be an easy false finding to
 * raise. The PIP's "weekly 1:1s reinstated" is Nick's own 1:1 WITH CHRIS, under
 * competencies 2 and 4. The HoTS framework asks for documented 1:1s with his
 * staff and states no frequency. Different meetings.
 */
const DEFAULT_CADENCE_DAYS = 28;

/**
 * How far past cadence before it is worth saying. A 1:1 one day late is noise;
 * this is a tool for a man who does not need another list of small failures.
 *
 * Configurable — ONE_TO_ONE_GRACE_DAYS on the admin page. Where late becomes
 * overdue is Nick's standard to set, not one baked in here.
 */
const DEFAULT_GRACE_DAYS = 3;
const graceDays = () => threshold('ONE_TO_ONE_GRACE_DAYS') ?? DEFAULT_GRACE_DAYS;

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

const daysSince = ymd => (ymd ? Math.floor((Date.now() - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000) : null);

async function fetchState(days = 60) {
  const base = (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '')
    .replace(/\/$/, '');

  const res = await fetch(`${base}/api/neuro-bridge/121/state?days=${days}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA returned ${res.status}`);
  }

  const agents = payload?.data?.agents;
  // NOVA's own route returns `agents: null` on failure precisely so this cannot
  // be read as "nobody is on the team". Honour that: anything not an array is a
  // failed read, never an empty roster.
  if (!Array.isArray(agents)) {
    throw new Error('NOVA returned no agent list (shape not recognised)');
  }
  return { agents, horizon: payload.data.horizon || null };
}

/**
 * Split the roster into what is covered and what is not.
 *
 * Returns BOTH sides. A caller that could only see the gaps would report the
 * outstanding column as though it were the whole picture — which for this user
 * is not a stylistic preference, it is the difference between a tool he uses
 * and one he avoids.
 */
function assess({ agents }, now = Date.now(), grace = graceDays()) {
  const today = new Date(now).toISOString().slice(0, 10);

  const people = agents
    .filter(a => a.planStatus !== 'deferred')
    .map(a => {
      const cadence = Number(a.cadenceDays) > 0 ? Number(a.cadenceDays) : DEFAULT_CADENCE_DAYS;
      const sinceHeld = a.lastHeld
        ? Math.floor((now - Date.parse(`${a.lastHeld}T00:00:00Z`)) / 86_400_000)
        : null;
      const booked = a.booked || null;
      // A DATE IN THE PAST IS NOT AN APPOINTMENT.
      //
      // /121/state returns the earliest still-open session, and open sessions go
      // stale: live data had Stephen's sitting at 2 Jul, "in_progress", nine
      // weeks after the fact. Counting any non-null `booked` as coverage read
      // five of twelve people as fine and produced no card at all — a clean bill
      // of health for a man on a PIP for management cadence.
      const stale = Boolean(booked) && booked < today;
      return {
        person: a.agentName,
        cadenceDays: cadence,
        booked,
        bookedIsStale: stale,
        // Only a future date counts as being in the diary.
        bookedAhead: booked && !stale ? booked : null,
        sessionStatus: a.sessionStatus || null,
        lastHeld: a.lastHeld || null,
        daysSinceHeld: sinceHeld,
        // Overdue is measured from the last one HELD, not from any booking.
        // A meeting rebooked four times is not a meeting that happened.
        overdueBy: sinceHeld === null ? null : Math.max(0, sinceHeld - cadence),
      };
    });

  const deferred = agents.filter(a => a.planStatus === 'deferred').map(a => a.agentName);
  const lapsed = p => p.overdueBy !== null && p.overdueBy > grace;

  return {
    total: people.length,
    deferred,
    // Never held at all, and no future date. The sharpest case.
    neverHeldUnbooked: people.filter(p => p.lastHeld === null && !p.bookedAhead),
    // Held before, now past cadence plus grace, with no future date.
    lapsedUnbooked: people.filter(p => p.lastHeld !== null && !p.bookedAhead && lapsed(p)),
    // A booking that has come and gone with the session still open. Its own
    // bucket because the remedy differs: not "book one" but "that session never
    // happened — close it or move it".
    staleBookings: people.filter(p => p.bookedIsStale),
    // Past cadence, but a real future date exists. Not a gap, and not raised.
    lapsedButBooked: people.filter(p => !!p.bookedAhead && lapsed(p)),
    covered: people.filter(p => !!p.bookedAhead || (p.overdueBy !== null && !lapsed(p))),
    people,
  };
}

/**
 * Current 1:1 coverage, cached.
 *
 * NEVER throws, and never reports a healthy zero for a failed read. "Everyone
 * has a 1:1 booked" asserted because the endpoint 500'd is the worst sentence
 * this file could produce.
 */
async function current({ force = false } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const state = await fetchState();
    const data = {
      available: true,
      asOf: new Date().toISOString(),
      ...assess(state),
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
 * Radar cards.
 *
 * One card for the gap, carrying the names and a written first line — not "book
 * your 1:1s". The starting-from-nothing part is the part that does not happen.
 */
function toRadarItems(coverage) {
  if (!coverage?.available) return [];

  const items = [];
  const { neverHeldUnbooked: never, lapsedUnbooked: lapsed, staleBookings: stale, total } = coverage;
  const gapPeople = [...never, ...lapsed];
  const gaps = gapPeople.length;
  if (!gaps) return [];

  const names = gapPeople
    .sort((a, b) => (b.daysSinceHeld ?? 9999) - (a.daysSinceHeld ?? 9999))
    .map(p => (p.lastHeld ? `${p.person} (${p.daysSinceHeld}d)` : `${p.person} (none on record)`));

  const staleNames = stale
    .filter(p => gapPeople.includes(p))
    .map(p => `${p.person} (${p.booked}, still ${p.sessionStatus || 'open'})`);

  const detail = [
    `${total - gaps} of ${total} have a 1:1 in the diary or are within cadence.`,
    `Nothing upcoming for: ${names.join(', ')}.`,
    never.length
      ? `${never.length} of those ${never.length === 1 ? 'has' : 'have'} no 1:1 on record at all, which is where to start.`
      : null,
    staleNames.length
      ? `${staleNames.length} ${staleNames.length === 1 ? 'is' : 'are'} carrying a session whose date has passed and which is still open — `
        + `${staleNames.join(', ')}. Those look booked and are not.`
      : null,
    'Measured from the last one HELD, not the last one booked.',
  ].filter(Boolean).join(' ');

  items.push({
    tense: 'happening',
    severity: never.length ? 'high' : 'medium',
    title: `${gaps} of ${total} have no 1:1 coming up`,
    detail,
    source: '1:1 coverage',
    // The first move, written out. Naming one person beats listing all of them:
    // a list is a decision about where to start, and the decision is the part
    // that stalls.
    remedy: (() => {
      const first = never[0] || lapsed[0];
      const name = first.person.split(' ')[0];
      return `Book 30 minutes with ${first.person} this week, then send: `
        + `"${name} — I want to get our one-to-ones back on a regular footing. `
        + `I've put 30 minutes in the diary; shout if that time doesn't work."`;
    })(),
  });

  return items;
}

module.exports = { current, assess, toRadarItems, isConfigured, DEFAULT_CADENCE_DAYS, DEFAULT_GRACE_DAYS, graceDays };
