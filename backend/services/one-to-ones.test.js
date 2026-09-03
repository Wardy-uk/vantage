'use strict';

/**
 * Pins VANTAGE's first omission signal.
 *
 * The dangerous direction here is the opposite of the usual one. Everywhere else
 * the risk is reporting a problem that is not there; here it is reporting
 * COVERAGE that is not there — telling a man on a PIP for management cadence
 * that his 1:1s are fine because an endpoint failed.
 *
 * `assess` and `toRadarItems` are pure so the whole thing can be asserted
 * without a network.
 */

const test = require('node:test');
const assert = require('node:assert');

const oto = require('./one-to-ones');

const DAY = 86_400_000;
const ymd = offsetDays => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// Shape taken from NOVA's live route (neuro-bridge-121.ts), not invented.
const agent = (name, over = {}) => ({
  agentName: name, planStatus: 'active', cadenceDays: 7,
  booked: null, sessionId: null, sessionStatus: null, outlookEventId: null, lastHeld: null,
  ...over,
});

test('a person with no 1:1 on record and nothing booked is the sharpest case', () => {
  const a = oto.assess({ agents: [agent('Hope Goodall')] });
  assert.equal(a.neverHeldUnbooked.length, 1);
  assert.equal(a.lapsedUnbooked.length, 0);
  assert.equal(a.covered.length, 0);
});

test('overdue is measured from the last 1:1 HELD, not from a booking', () => {
  // The whole point. A session rebooked repeatedly has not happened, and a tool
  // that counted the booking would report cadence being met while it slipped.
  const a = oto.assess({
    agents: [agent('Zoe Rees', { lastHeld: ymd(-40), booked: ymd(+5) })],
  });
  assert.equal(a.lapsedUnbooked.length, 0, 'a booked date is not a gap');
  assert.equal(a.lapsedButBooked.length, 1, 'but it is still past cadence, and visible');
  assert.equal(a.people[0].overdueBy, 33);
});

test('within cadence, or booked, counts as covered and raises nothing', () => {
  const a = oto.assess({
    agents: [
      agent('Naomi Wentworth', { lastHeld: ymd(-3) }),
      agent('Abdi Mohamed', { lastHeld: ymd(-30), booked: ymd(+2) }),
    ],
  });
  assert.equal(a.covered.length, 2);
  assert.equal(oto.toRadarItems({ available: true, ...a }).length, 0);
});

test('a lapse inside the grace period is not raised', () => {
  // He does not need another list of small failures. One day late is noise.
  const a = oto.assess({ agents: [agent('Luke Scaife', { lastHeld: ymd(-9) })] });
  assert.equal(a.lapsedUnbooked.length, 0);
  assert.equal(a.people[0].overdueBy, 2);
});

test('a deferred plan is excluded from the count, not silently failed', () => {
  // Nathan's plan is deferred while he is on sick leave. Counting him as a
  // missed 1:1 would be reporting a gap that is a decision.
  const a = oto.assess({
    agents: [agent('Nathan Rutland', { planStatus: 'deferred' }), agent('Heidi Power')],
  });
  assert.equal(a.total, 1);
  assert.deepEqual(a.deferred, ['Nathan Rutland']);
});

test('a missing cadence falls back to weekly rather than to no cadence', () => {
  // cadenceDays null must not make overdueBy null — that would silently drop the
  // person out of every bucket and read as coverage.
  const a = oto.assess({ agents: [agent('Maria Pappa', { cadenceDays: null, lastHeld: ymd(-20) })] });
  assert.equal(a.people[0].cadenceDays, oto.DEFAULT_CADENCE_DAYS);
  assert.equal(a.lapsedUnbooked.length, 1);
});

// ── The failure that matters ─────────────────────────────────────────────────

test('an unavailable read produces NO cards, never a clean bill of health', () => {
  // "Everyone has a 1:1 booked" asserted because the endpoint 500'd is the worst
  // sentence this file could produce, and the one it exists to prevent.
  assert.deepEqual(oto.toRadarItems({ available: false, reason: 'NOVA returned 503' }), []);
  assert.deepEqual(oto.toRadarItems(null), []);
  assert.deepEqual(oto.toRadarItems(undefined), []);
});

test('the card reports what is covered as well as what is missing', () => {
  // A card showing only the outstanding column is lying by omission to somebody
  // who systematically under-registers what he has finished.
  const a = oto.assess({
    agents: [
      agent('Hope Goodall'),
      agent('Stephen Mitchell', { lastHeld: ymd(-2) }),
      agent('Isabel Busk', { lastHeld: ymd(-1) }),
    ],
  });
  const [card] = oto.toRadarItems({ available: true, ...a });
  assert.match(card.detail, /2 of 3 have a 1:1 booked or are within cadence/);
  assert.match(card.title, /1 of 3 have no 1:1 booked/);
});

test('the card names one person and writes the message, rather than listing work', () => {
  // Awareness without a first move produces avoidance. The starting-from-nothing
  // part is the part that does not happen, so the card does it.
  const a = oto.assess({ agents: [agent('Hope Goodall'), agent('Zoe Rees')] });
  const [card] = oto.toRadarItems({ available: true, ...a });
  assert.match(card.remedy, /Book 30 minutes with (Hope Goodall|Zoe Rees)/);
  assert.match(card.remedy, /one-to-ones back on a regular footing/);
  assert.doesNotMatch(card.remedy, /consider|reflect|make time/i);
});

test('never-held outranks lapsed for severity and for who to start with', () => {
  const a = oto.assess({
    agents: [agent('Hope Goodall'), agent('Arman Shazad', { lastHeld: ymd(-60) })],
  });
  const [card] = oto.toRadarItems({ available: true, ...a });
  assert.equal(card.severity, 'high');
  assert.match(card.remedy, /Hope Goodall/);
});

test('lapsed-only is medium, because it is a slip rather than an absence', () => {
  const a = oto.assess({ agents: [agent('Arman Shazad', { lastHeld: ymd(-60) })] });
  const [card] = oto.toRadarItems({ available: true, ...a });
  assert.equal(card.severity, 'medium');
});
