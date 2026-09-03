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

/** Default when NOVA states no cadence for someone. Weekly is the PIP's word. */
const DEFAULT_CADENCE_DAYS = 7;

/**
 * How far past cadence before it is worth saying. A 1:1 one day late is noise;
 * this is a tool for a man who does not need another list of small failures.
 */
const GRACE_DAYS = 3;

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
function assess({ agents }, now = Date.now()) {
  const people = agents
    .filter(a => a.planStatus !== 'deferred')
    .map(a => {
      const cadence = Number(a.cadenceDays) > 0 ? Number(a.cadenceDays) : DEFAULT_CADENCE_DAYS;
      const sinceHeld = a.lastHeld
        ? Math.floor((now - Date.parse(`${a.lastHeld}T00:00:00Z`)) / 86_400_000)
        : null;
      return {
        person: a.agentName,
        cadenceDays: cadence,
        booked: a.booked || null,
        lastHeld: a.lastHeld || null,
        daysSinceHeld: sinceHeld,
        // Overdue is measured from the last one HELD, not from the booking.
        // A meeting rebooked four times is not a meeting that happened.
        overdueBy: sinceHeld === null ? null : Math.max(0, sinceHeld - cadence),
      };
    });

  const deferred = agents.filter(a => a.planStatus === 'deferred').map(a => a.agentName);

  return {
    total: people.length,
    deferred,
    // Never held at all, and nothing in the diary. The sharpest case.
    neverHeldUnbooked: people.filter(p => p.lastHeld === null && !p.booked),
    // Held before, now past cadence plus grace, with nothing booked.
    lapsedUnbooked: people.filter(p => p.lastHeld !== null && !p.booked && p.overdueBy > GRACE_DAYS),
    // Past cadence but a date is in the diary — not a gap, and not raised.
    lapsedButBooked: people.filter(p => !!p.booked && p.overdueBy !== null && p.overdueBy > GRACE_DAYS),
    covered: people.filter(p => !!p.booked || (p.overdueBy !== null && p.overdueBy <= GRACE_DAYS)),
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
  const { neverHeldUnbooked: never, lapsedUnbooked: lapsed, total } = coverage;
  const gaps = never.length + lapsed.length;
  if (!gaps) return [];

  const names = [...never, ...lapsed]
    .sort((a, b) => (b.daysSinceHeld ?? 9999) - (a.daysSinceHeld ?? 9999))
    .map(p => (p.lastHeld ? `${p.person} (${p.daysSinceHeld}d)` : `${p.person} (none on record)`));

  const detail = [
    `${total - gaps} of ${total} have a 1:1 booked or are within cadence.`,
    `Nothing booked for: ${names.join(', ')}.`,
    never.length
      ? `${never.length} of those have no 1:1 on record at all, which is the ones to do first.`
      : null,
    'Measured from the last one HELD, not the last one booked — a session rebooked repeatedly has not happened.',
  ].filter(Boolean).join(' ');

  items.push({
    tense: 'happening',
    severity: never.length ? 'high' : 'medium',
    title: `${gaps} of ${total} have no 1:1 booked`,
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

module.exports = { current, assess, toRadarItems, isConfigured, DEFAULT_CADENCE_DAYS, GRACE_DAYS };
