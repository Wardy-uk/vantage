'use strict';

/**
 * Pins the detectors — and, more importantly, pins what they REFUSE to do.
 *
 * Every test here has a positive control beside it. A detector suite that only
 * asserts "nothing fired" passes just as well against a broken detector that
 * can never fire, which is the same failure as a source scan with no positive
 * control: it reads as coverage and is not. So each refusal case is paired with
 * the surge that proves the detector was capable of firing on that data.
 *
 * The cases that matter most are the holes. `kpi_org_daily` has days that are
 * simply absent, and a detector that treats a missing day as zero sees an
 * outage as a collapse in ticket volume — it would warn about the wrong thing
 * with total confidence.
 */

const test = require('node:test');
const assert = require('node:assert');

const leading = require('./leading');

// ── Synthetic series ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const ASOF = '2026-09-15';

/**
 * A series of `days` daily values ending on `asOf`.
 *
 * `valueFor(i)` receives 0 for `asOf`, 1 for the day before, and so on — so a
 * test reads backwards from today, the way the detectors do.
 */
function series(key, valueFor, { days = 120, asOf = ASOF, missing = [], source = 'jira' } = {}) {
  const points = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = addDays(asOf, -i);
    if (missing.includes(day)) continue;
    const v = valueFor(i);
    if (v === null) continue;
    points.push({ day, value: v, target: null, rag: null, source: typeof source === 'function' ? source(day) : source });
  }
  return {
    key,
    label: key,
    unit: 'count',
    direction: 'lower-better',
    points,
    sourceBreaks: [],
    coverage: {
      expectedDays: days,
      daysPresent: points.length,
      daysWithValue: points.length,
      daysNull: 0,
      daysMissing: days - points.length,
      firstValueDay: points[0]?.day ?? null,
      lastValueDay: points[points.length - 1]?.day ?? null,
      longestGapDays: 0,
      gapDays: [],
      gapDaysTruncated: false,
      sources: { [typeof source === 'function' ? 'mixed' : source]: points.length },
      staleDays: 0,
    },
  };
}

/**
 * A steady desk: arrivals and throughput matched on average, nothing moving.
 *
 * The day-to-day wobble lives in ARRIVALS and not in both series, deliberately.
 * The first version of this fixture varied arrivals and throughput by the same
 * term, which cancelled in the net and left a baseline of exactly zero every
 * week — a zero standard deviation, which `zScore` correctly refuses to divide
 * by, so the positive control could not fire and the whole suite passed on a
 * detector that never ran. The fixture has to be able to produce a warning
 * before "no warning" means anything.
 *
 * 7 and 11 are coprime, so `(i * 7) % 11` walks every residue and gives a
 * baseline with real variance and a mean near zero.
 */
function steadyFlow(extra = {}) {
  return {
    nt_new_tickets: series('nt_new_tickets', i => 100 + ((i * 7) % 11) - 5),
    nt_solved_team: series('nt_solved_team', () => 70),
    nt_solved_nova: series('nt_solved_nova', () => 30),
    nt_development: series('nt_development', () => 200),
    nt_oldest_development: series('nt_oldest_development', () => 40),
    nt_incidents: series('nt_incidents', () => 60),
    nt_production: series('nt_production', () => 30),
    nt_oldest_incident: series('nt_oldest_incident', () => 10),
    nt_oldest_production: series('nt_oldest_production', () => 12),
    nt_escalated: series('nt_escalated', i => 10 + (i % 3)),
    nt_rejected: series('nt_rejected', i => 1 + (i % 2)),
    ...extra,
  };
}

// ── Detector A — net flow ────────────────────────────────────────────────────

test('A: a steady desk produces nothing', () => {
  const r = leading.detectNetFlow({ series: steadyFlow(), asOf: ASOF });
  assert.equal(r.quiet, 'A', 'a matched week is not a warning');
});

test('A: POSITIVE CONTROL — a surge in net arrivals does fire', () => {
  // The control for every "did not fire" above it. Without this, a detector
  // wired to return `quiet` unconditionally would pass the whole suite.
  const s = steadyFlow({
    nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 160 : 100 + ((i * 7) % 11) - 5)),
  });
  const r = leading.detectNetFlow({ series: s, asOf: ASOF });
  assert.ok(r.indicator, 'a 60-a-day surge above a flat baseline must fire');
  assert.equal(r.indicator.detector, 'A');
  assert.match(r.indicator.title, /more tickets than it cleared/);
});

test('A: an unusually GOOD week is not a warning', () => {
  const s = steadyFlow({
    nt_solved_team: series('nt_solved_team', i => (i < 7 ? 160 : 70)),
  });
  const r = leading.detectNetFlow({ series: s, asOf: ASOF });
  assert.equal(r.quiet, 'A', 'clearing the backlog fast is not something to warn about');
});

test('A: A MISSING DAY BLOCKS THE DETECTOR — it never reads as zero arrivals', () => {
  // The whole point. A day NOVA was down is absent from kpi_org_daily. Read as
  // zero it looks like the desk received nothing, which on a net-flow detector
  // reads as a fantastic day and drags the baseline down for a month.
  const s = steadyFlow({
    nt_new_tickets: series('nt_new_tickets', i => 100 + ((i * 7) % 11) - 5, { missing: [addDays(ASOF, -3)] }),
  });
  const r = leading.detectNetFlow({ series: s, asOf: ASOF });
  assert.ok(r.blocked, 'a hole in the window must block, not shorten');
  assert.match(r.blocked.reason, /missing 1 of the last 35 days/);
  assert.equal(r.indicator, undefined);
});

test('A: a hole does not merely lower confidence — it stops the claim', () => {
  // Distinct from the test above: this asserts the SHAPE of the refusal. A
  // caveat attached to a number is read as a number.
  const s = steadyFlow({
    nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 160 : 100), { missing: [addDays(ASOF, -2)] }),
  });
  const r = leading.detectNetFlow({ series: s, asOf: ASOF });
  assert.ok(r.blocked, 'even a firing-strength surge is refused when the window has a hole');
});

// ── Detector B — ageing ──────────────────────────────────────────────────────

test('B: a tail ageing one day per day, above its own typical, fires', () => {
  // Oldest rises exactly 1.0/day for the last week, from a baseline of 40.
  const s = steadyFlow({
    nt_oldest_development: series('nt_oldest_development', i => (i < 7 ? 47 - i : 40)),
  });
  const r = leading.detectAgeing({ series: s, asOf: ASOF });
  assert.equal(r.indicators.length, 1);
  assert.match(r.indicators[0].title, /Development/);
  assert.match(r.indicators[0].change, /1 days per day|0\.9|1\.0|slope/i);
});

test('B: a young queue ageing normally does not fire', () => {
  // Same 1.0 slope, but the queue's oldest is still BELOW its four-week
  // typical — the tail is short, it is just the newest thing to be oldest.
  const s = steadyFlow({
    nt_oldest_development: series('nt_oldest_development', i => (i < 7 ? 37 - i : 100)),
  });
  const r = leading.detectAgeing({ series: s, asOf: ASOF });
  assert.equal(r.indicators.length, 0, 'long-by-its-own-standards is half the condition');
});

test('B: a tail that is being worked does not fire', () => {
  const s = steadyFlow({
    nt_oldest_development: series('nt_oldest_development', i => (i % 5) + 40),
  });
  const r = leading.detectAgeing({ series: s, asOf: ASOF });
  assert.equal(r.indicators.length, 0);
});

// ── Detector C — escalation quality ──────────────────────────────────────────

test('C: a rising rejection RATE fires, and reports volume alongside it', () => {
  const s = steadyFlow({
    nt_rejected: series('nt_rejected', i => (i < 7 ? 8 : 1 + (i % 2))),
  });
  const r = leading.detectEscalationQuality({ series: s, asOf: ASOF });
  assert.ok(r.indicator);
  assert.match(r.indicator.change, /escalation volume is/i);
});

test('C: a week with no escalations is BLOCKED, not treated as a rate', () => {
  // Dividing by zero here would manufacture an infinite rate and then fire on
  // it — a warning generated entirely by a quiet week.
  const s = steadyFlow({
    nt_escalated: series('nt_escalated', i => (i < 7 ? 0 : 10 + (i % 3))),
  });
  const r = leading.detectEscalationQuality({ series: s, asOf: ASOF });
  assert.ok(r.blocked);
  assert.match(r.blocked.reason, /zero escalations/);
});

// ── Detector D — Development drift ───────────────────────────────────────────

test('D: Dev growing while Customer Care is flat fires, and is worded as exposure', () => {
  const s = steadyFlow({
    nt_development: series('nt_development', i => (i < 14 ? 200 + (14 - i) * 4 : 200)),
    nt_oldest_development: series('nt_oldest_development', i => (i < 14 ? 40 + (14 - i) : 40)),
  });
  const r = leading.detectDevDrift({ series: s, asOf: ASOF });
  assert.ok(r.indicator, 'a fortnight well outside its own distribution must fire');
  // The framing is load-bearing, not decoration: this card appears on a screen
  // read daily by the person whose PIP is being assessed, and Development's
  // queue is not his to clear.
  assert.match(r.indicator.whyItMatters, /not a failure of the desk|exposure you carry/);
});

test('D: both queues growing is a busy fortnight, not a drift', () => {
  const s = steadyFlow({
    nt_development: series('nt_development', i => (i < 14 ? 200 + (14 - i) * 4 : 200)),
    nt_oldest_development: series('nt_oldest_development', i => (i < 14 ? 40 + (14 - i) : 40)),
    nt_incidents: series('nt_incidents', i => (i < 14 ? 60 + (14 - i) * 4 : 60)),
  });
  const r = leading.detectDevDrift({ series: s, asOf: ASOF });
  assert.equal(r.quiet, 'D', 'divergence is the signal; parallel growth is not');
});

// ── Detector E — capacity ────────────────────────────────────────────────────

const capacity = (absences, extra = {}) => ({
  available: true, rosterCount: 12, unsyncable: [], absences, approvedOnly: true, ...extra,
});

test('E: a thin day on a normally busy weekday fires', () => {
  // 2026-09-16 is a Wednesday.
  const absences = Array.from({ length: 4 }, (_, n) => ({ date: '2026-09-16', name: `P${n}`, status: 'annual_leave' }));
  const r = leading.detectCapacityCollision({ series: steadyFlow(), capacity: capacity(absences), asOf: ASOF });
  assert.ok(r.indicator);
  assert.match(r.indicator.title, /4 of 12/);
  assert.equal(r.indicator.horizonDays, 1);
});

test('E: one person off is not a collision', () => {
  const r = leading.detectCapacityCollision({
    series: steadyFlow(), capacity: capacity([{ date: '2026-09-16', name: 'P1', status: 'annual_leave' }]), asOf: ASOF,
  });
  assert.equal(r.quiet, 'E');
});

test('E: unavailable capacity is a BLOCKED detector, never a quiet one', () => {
  // "We could not read the rota" and "nobody is off" are opposite messages.
  const r = leading.detectCapacityCollision({
    series: steadyFlow(), capacity: { available: false, reason: 'bridge timed out' }, asOf: ASOF,
  });
  assert.ok(r.blocked);
  assert.match(r.blocked.reason, /timed out/);
});

test('E: unsyncable roster members lower confidence and say why', () => {
  const absences = Array.from({ length: 4 }, (_, n) => ({ date: '2026-09-16', name: `P${n}`, status: 'annual_leave' }));
  const r = leading.detectCapacityCollision({
    series: steadyFlow(), capacity: capacity(absences, { unsyncable: ['Sam'] }), asOf: ASOF,
  });
  assert.ok(r.indicator.confidence.score < 0.8);
  assert.ok(r.indicator.confidence.basis.some(b => /Sam/.test(b)));
  assert.ok(r.indicator.confidence.basis.some(b => /APPROVED leave only/.test(b)));
});

// ── Confidence ───────────────────────────────────────────────────────────────

test('a capture-method change inside the window lowers confidence and names the day', () => {
  const s = series('nt_new_tickets', () => 100);
  s.sourceBreaks = [{ day: addDays(ASOF, -10), from: 'reconstruct', to: 'jira' }];
  const c = leading.confidence([s], ASOF);
  assert.ok(c.score < 1);
  assert.ok(c.basis.some(b => /capture method/.test(b)));
});

test('a clean series says so explicitly rather than returning an empty basis', () => {
  const c = leading.confidence([series('nt_new_tickets', () => 100)], ASOF);
  assert.equal(c.score, 1);
  assert.equal(c.level, 'high');
  assert.ok(c.basis.length, 'an empty basis reads as no reasoning, not as nothing wrong');
});

test('a zero-variance baseline yields no z-score rather than an infinite one', () => {
  assert.equal(leading.zScore(5, [3, 3, 3, 3]), null);
});

// ── Assembly ─────────────────────────────────────────────────────────────────

test('detect() refuses to run without a clock', () => {
  assert.throws(() => leading.detect({ series: steadyFlow() }), /asOf/);
});

test('detect() reports blocked detectors rather than dropping them', () => {
  const r = leading.detect({ series: steadyFlow(), capacity: null, asOf: ASOF });
  assert.ok(r.blocked.some(b => b.id === 'E'), 'capacity was not readable and must be named');
});

test('a disabled detector is reported as blocked, with the reason, not hidden', () => {
  const r = leading.detect({ series: steadyFlow(), capacity: null, asOf: ASOF, disabled: ['D'] });
  const d = r.blocked.find(b => b.id === 'D');
  assert.ok(d, 'a switched-off detector is still named — a silent one looks like a quiet department');
  assert.match(d.reason, /measured and failed/);
});

test('"measured and failed" and "could not be measured" are not collapsed into one word', () => {
  // D was replayed and got it wrong; B had nothing to be scored against. The
  // fix for each is completely different, and a single word "disabled" would
  // tell Nick that a detector nobody could test had been tested and failed.
  const r = leading.detect({ series: steadyFlow(), capacity: null, asOf: ASOF, disabled: ['B', 'D'] });
  assert.match(r.blocked.find(b => b.id === 'B').reason, /not measurable/);
  assert.match(r.blocked.find(b => b.id === 'D').reason, /measured and failed/);
});

test('the shipped default disables exactly the detectors the replay could not back', () => {
  // Pinned so a later edit cannot quietly switch a failing detector back on.
  // If the replay result changes, this line changes WITH the evidence.
  assert.deepEqual(leading.disabledDetectors(), ['B', 'C', 'D']);
});

test('one detector throwing does not lose the others', () => {
  // A malformed series reaches the detector as a real shape would; the guard is
  // what stops a single bad KPI blanking the screen.
  const broken = steadyFlow();
  broken.nt_new_tickets = { key: 'nt_new_tickets', points: null, coverage: {} };
  const r = leading.detect({ series: broken, capacity: null, asOf: ASOF });
  assert.ok(r.blocked.length >= 1);
  assert.ok(Array.isArray(r.indicators), 'the run survives');
});

test('the card carries every field the brief asks for', () => {
  const s = steadyFlow({ nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 160 : 100 + ((i * 7) % 11) - 5)) });
  const r = leading.detect({ series: s, capacity: null, asOf: ASOF });
  const card = r.indicators[0];
  for (const field of ['title', 'change', 'whyItMatters', 'evidence', 'horizonDays', 'confidence', 'confirm', 'disprove', 'action']) {
    assert.ok(card[field] !== undefined && card[field] !== null && card[field] !== '', `missing ${field}`);
  }
  assert.ok(Array.isArray(card.evidence) && card.evidence.length, 'evidence must be checkable, not a sentence');
});
