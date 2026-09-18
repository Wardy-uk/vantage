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
 * Day-to-day noise whose period is NOT a week.
 *
 * ⚠ This has now caught three fixtures. `(i * 5) % 7` repeats exactly every
 * seven days, so every baseline week gets an IDENTICAL mean, the standard
 * deviation is zero, and `zScore` correctly returns null — the detector then
 * reads as quiet and the test passes for the wrong reason, or fails
 * mysteriously. 5 and 11 are coprime, so this never aligns to the week.
 *
 * Any fixture feeding a weekly-bucket detector must use it.
 */
const wobble = i => ((i * 5) % 11) - 5;


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

// ── The advisory constraint ──────────────────────────────────────────────────
//
// Nick's condition on shipping E (16 Sep 2026): it may appear on the radar and
// run the normal lifecycle, but it must not cross into ACTION without a human.
// These pin both halves — that it says so, and that it cannot.

test('E declares itself an unvalidated advisory, on the card and in metadata', () => {
  const absences = Array.from({ length: 4 }, (_, n) => ({ date: '2026-09-16', name: `P${n}`, status: 'annual_leave' }));
  const r = leading.detectCapacityCollision({ series: steadyFlow(), capacity: capacity(absences), asOf: ASOF });

  assert.equal(r.indicator.validation.status, 'unvalidated-advisory');
  assert.equal(r.indicator.validation.autoActionable, false, 'the machine-readable half is what auto-push reads');
  assert.match(r.indicator.validation.detail, /has NOT been validated|not a predictor/);
  // And visibly, next to the numbers it qualifies — not only in metadata a
  // reader never sees.
  assert.ok(r.indicator.evidence.some(e => /ADVISORY/.test(String(e.value))),
    'the status is evidence, because it is a fact about what the card is worth');
});

test('A does NOT claim to be advisory — the distinction has to cut both ways', () => {
  // Positive control for the test above. If everything were advisory the flag
  // would carry no information and the auto-push filter would be a no-op.
  const s = steadyFlow({ nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 160 : 100 + ((i * 7) % 11) - 5)) });
  const r = leading.detectNetFlow({ series: s, asOf: ASOF });
  assert.equal(r.indicator.validation.status, 'validated');
  assert.equal(r.indicator.validation.autoActionable, true);
});

test('an indicator that declares nothing is treated as untested, not as trusted', () => {
  // The default falls the safe way. A future detector whose author forgets to
  // declare itself must not inherit A's credibility by silence.
  const r = leading.detectAgeing({
    series: steadyFlow({ nt_oldest_development: series('nt_oldest_development', i => (i < 7 ? 47 - i : 40)) }),
    asOf: ASOF,
  });
  assert.equal(r.indicators[0].validation.status, 'unvalidated-advisory');
});

test('the advisory flag reaches the radar card, which is what carries it to the finding', () => {
  const absences = Array.from({ length: 4 }, (_, n) => ({ date: '2026-09-16', name: `P${n}`, status: 'annual_leave' }));
  const state = {
    available: true,
    indicators: [leading.detectCapacityCollision({ series: steadyFlow(), capacity: capacity(absences), asOf: ASOF }).indicator],
  };
  const [card] = leading.toRadarItems(state);
  assert.equal(card.advisory, true);
  assert.equal(card.validation.status, 'unvalidated-advisory');
  assert.match(card.detail, /ADVISORY/, 'a reader who never opens the metadata still sees it');
  assert.match(card.detail, /Nothing acts on this until you decide/);
});

test('E records a dated, checkable claim so it can be scored prospectively', () => {
  const absences = Array.from({ length: 4 }, (_, n) => ({ date: '2026-09-16', name: `P${n}`, status: 'annual_leave' }));
  const r = leading.detectCapacityCollision({ series: steadyFlow(), capacity: capacity(absences), asOf: ASOF });
  const p = r.indicator.prospective;
  assert.equal(p.forDay, '2026-09-16', 'a claim about a day still in the future');
  assert.equal(p.predictedOff, 4);
  assert.ok(Array.isArray(p.scoreAgainst) && p.scoreAgainst.length,
    'the measure is fixed when the claim is made, not chosen later with hindsight');
});

// ── Shadow mode ──────────────────────────────────────────────────────────────
//
// The promise is narrow and absolute: a shadow detector produces no card, no
// finding and no NEURO action, however loudly it fires. These pin it at both
// layers, because the value of shadow mode is entirely in that promise.

const capacityFor = (absences, over = {}) => ({
  available: true, rosterCount: 12, unsyncable: [], absences, approvedOnly: true, ...over,
});

/**
 * ⚠ The ownership baseline must VARY, and for the same reason the flow fixture
 * had to: `(i * 3) % 7` repeats exactly every week, so all four baseline weeks
 * had identical means, the standard deviation was zero, and `zScore` correctly
 * returned null — which silently dropped the family and made the composite look
 * quiet when it should have fired. 5 and 11 are coprime, so the pattern does not
 * align to the week.
 */
const UNASSIGNED_BASE = i => 10 + ((i * 5) % 11);

function shadowSeries(extra = {}) {
  return steadyFlow({
    nt_legacy_unassigned: series('nt_legacy_unassigned', UNASSIGNED_BASE),
    ...extra,
  });
}

test('S1 blocks rather than guesses when too few evidence families can be computed', () => {
  // No unassigned series and no capacity: only flow and rejection remain.
  const r = leading.detectShadowComposite({ series: steadyFlow(), capacity: null, asOf: ASOF });
  assert.ok(r.blocked);
  assert.match(r.blocked.reason, /of 4 evidence families/);
  assert.equal(r.blocked.shadow, true);
});

test('S1 fires when two INDEPENDENT families are elevated together', () => {
  const s = shadowSeries({
    nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 128 : 100 + ((i * 7) % 11) - 5)),
    nt_legacy_unassigned: series('nt_legacy_unassigned', i => (i < 7 ? 34 : UNASSIGNED_BASE(i))),
  });
  const r = leading.detectShadowComposite({ series: s, capacity: capacityFor([]), asOf: ASOF });
  assert.ok(r.indicator, 'flow and ownership rising together must register');
  assert.equal(r.indicator.shadow, true);
  assert.equal(r.indicator.detector, 'S1');
});

test('S1 never corroborates flow with a stock, because stock is the integral of flow', () => {
  // The defect that killed the discovery-era composite: it counted net flow and
  // three stocks as four agreeing signals when they are one fact. If a stock
  // ever appears in the evidence families, this fails.
  const s = shadowSeries({
    nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 128 : 100 + ((i * 7) % 11) - 5)),
    nt_legacy_unassigned: series('nt_legacy_unassigned', i => (i < 7 ? 34 : UNASSIGNED_BASE(i))),
  });
  const r = leading.detectShadowComposite({ series: s, capacity: capacityFor([]), asOf: ASOF });
  const families = r.indicator.evidence.map(e => e.label);
  for (const forbidden of ['inc', 'prod', 'dev', 'incidents', 'production', 'development']) {
    assert.ok(!families.includes(forbidden), `stock "${forbidden}" must never be an evidence family`);
  }
  assert.deepEqual([...families].sort(), ['capacity', 'flow', 'ownership', 'rejection']);
});

test('detect() keeps shadow output out of indicators entirely', () => {
  const s = shadowSeries({
    nt_new_tickets: series('nt_new_tickets', i => (i < 7 ? 128 : 100 + ((i * 7) % 11) - 5)),
    nt_legacy_unassigned: series('nt_legacy_unassigned', i => (i < 7 ? 34 : UNASSIGNED_BASE(i))),
  });
  const r = leading.detect({ series: s, capacity: capacityFor([]), asOf: ASOF });
  assert.ok(r.shadow.length >= 1, 'the shadow ran');
  assert.ok(r.indicators.every(i => i.shadow !== true), 'and none of it reached the indicator list');
});

test('toRadarItems refuses a shadow even if one is handed to it directly', () => {
  // Independent of detect()'s filtering. Shadow mode is a promise about what
  // reaches the screen, so the screen has to be incapable of rendering one on
  // its own account.
  const card = { key: 'x', detector: 'S1', shadow: true, severity: 'high', title: 'should never render',
    change: 'x', whyItMatters: 'x', evidence: [], horizonDays: 1,
    confidence: { level: 'high', score: 1, basis: [] }, confirm: 'x', disprove: 'x', action: 'x', tense: 'could' };
  assert.deepEqual(leading.toRadarItems({ available: true, indicators: [card] }), []);
});

test('the reader asks NOVA for EVERYTHING — scope is a rule, not a list', () => {
  // ⚠ This replaced a test that checked every key read by a detector was on a
  // hand-maintained request list. The list itself was the defect: on 14 Sep
  // 2026 a NOVA fault sent FRT breaches from ~5 a day to 45 and VANTAGE said
  // nothing, because `nt_sla_frt_all_breached` had never been added to it. A
  // curated list fails silently — nothing announces the key nobody added.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./kpi-series.js'), 'utf8');
  assert.ok(!/DETECTOR_KEYS/.test(src), 'the hand-maintained key list must stay gone');
  assert.match(src, /keys = null/, 'the reader requests every series by default');
});

test('REGRESSION, 14 Sep 2026: the FRT breach series is watched', () => {
  // The exact series the incident moved. If a future change narrows the scope
  // again, this fails rather than another incident finding it.
  const { usable } = require('./kpi-series');
  const frt = series('nt_sla_frt_all_breached', i => 5 + Math.abs(wobble(i)) + ((i * 3) % 13), { days: 120 });
  assert.equal(usable(frt), true, 'the series the 14 Sep incident moved must be in scope');
});

test('a series outside the scanned scope says so, and says why the scope is narrow', () => {
  // The 14 Sep miss was a scope gap that nothing announced. An out-of-scope
  // series now explains itself rather than simply being absent.
  const { usable, whyNotUsable } = require('./kpi-series');
  const out = series('nt_tpj_tickets', i => 20 + wobble(i), { days: 200 });
  assert.equal(usable(out), false);
  assert.match(whyNotUsable(out), /outside the scanned scope/);
  assert.match(whyNotUsable(out), /a new warning every working day/);
});

test('a permanently-zero series is NOT watched, and says why', () => {
  // nt_ai_rate is 0 on all 96 of its days. Watching it would look like coverage
  // and deliver none: no variance means zScore returns null, so it could never
  // fire however badly the thing it measures broke.
  const { usable, whyNotUsable } = require('./kpi-series');
  // An IN-SCOPE key, so the zero rule is what rejects it rather than the scope
  // rule. nt_ai_rate is the real-world example and is out of scope as well.
  const dead = series('nt_solved_nova', () => 0, { days: 120 });
  assert.equal(usable(dead), false);
  assert.match(whyNotUsable(dead), /coverage in name only/);
});

test('a series with too little history is not watched, and says how little', () => {
  const { usable, whyNotUsable } = require('./kpi-series');
  const young = series('nt_frt_compliance', i => 10 + wobble(i), { days: 20 });
  assert.equal(usable(young), false);
  assert.match(whyNotUsable(young), /only 20 days of history/);
});


test('a radar card exposes what the verdict buttons need, or nothing at all', () => {
  // The buttons render only when `logId` is present, so a card with no ledger
  // row must not offer a control that would post nowhere.
  const withRow = leading.toRadarItems({
    available: true,
    indicators: [{ key: 'k', detector: 'A', severity: 'medium', title: 't', change: 'c',
      whyItMatters: 'w', evidence: [], horizonDays: 5, confidence: { level: 'high', score: 1, basis: [] },
      confirm: 'x', disprove: 'y', action: 'z', tense: 'could', recordId: 42, outcome: 'useful', outcomeSource: 'human' }],
  })[0];
  assert.equal(withRow.logId, 42);
  assert.equal(withRow.verdict, 'useful');
  assert.equal(withRow.verdictSource, 'human');

  const withoutRow = leading.toRadarItems({
    available: true,
    indicators: [{ key: 'k', detector: 'A', severity: 'medium', title: 't', change: 'c',
      whyItMatters: 'w', evidence: [], horizonDays: 5, confidence: { level: 'high', score: 1, basis: [] },
      confirm: 'x', disprove: 'y', action: 'z', tense: 'could' }],
  })[0];
  assert.equal(withoutRow.logId, null, 'no row, no button');
});

test('the browser client states who is judging, because the server no longer assumes', () => {
  // `label()` had `by` defaulting to 'nick'. That default was removed so an
  // assistant omitting the field cannot record a human verdict in his name —
  // which means a client that does not send `by` now FAILS. The buttons shipped
  // without it and were broken in production for as long as it took to notice.
  const fs = require('node:fs');
  const client = fs.readFileSync(require.resolve('../../frontend/src/api.js'), 'utf8');
  const call = client.match(/leadingVerdict:[^\n]*\n?[^\n]*/)[0];
  assert.match(call, /by:\s*'nick'/, 'the verdict call must state its provenance');
});

// ── The Daily KPI Tracker: T1 tactical, T2 strategic ─────────────────────────

const trackerRow = (kpiKey, label) => ({ kpiKey, label });
function trackerFeed({ liveValue, key = 'nt_legacy_cc_incidents', label = 'CC Incidents', over = {} } = {}) {
  return {
    available: true,
    rows: [trackerRow(key, label), trackerRow(null, 'Number of TPJ Tickets in Dev')],
    measurable: [trackerRow(key, label)],
    unmeasured: ['Number of TPJ Tickets in Dev'],
    totalRows: 2,
    live: {
      available: true, error: null, day: ASOF, ageSeconds: 30,
      items: [{ key, value: liveValue }],
    },
    hourly: { available: true, error: null, daysCovered: 0, ready: false, readySoon: false, needed: 10, series: [] },
    baselineTrustedFrom: '2026-09-11',
    ...over,
  };
}
// The live day is ASOF, so daily history must stop the day before.
function histBefore(values, key = 'nt_legacy_cc_incidents') {
  return series(key, i => values(i + 1), { days: 121 });
}

test('T1 fires when today has moved far beyond this KPI\'s normal daily move', () => {
  const s = { [ 'nt_legacy_cc_incidents' ]: histBefore(() => 22) };
  // A flat history has no variance to score against, so give it some.
  s.nt_legacy_cc_incidents = histBefore(i => 22 + wobble(i));
  const r = leading.detectTacticalDrift({ tracker: trackerFeed({ liveValue: 60 }), series: s, asOf: ASOF });
  assert.ok(r.indicators?.length, 'a move of ~+40 on a queue that swings by 3 must fire');
  assert.equal(r.indicators[0].tense, 'happening', 'tactical is steerable TODAY, not a could');
  assert.equal(r.indicators[0].detector, 'T1');
});

test('T1 does not fire on a move in the GOOD direction', () => {
  const s = { nt_legacy_cc_incidents: histBefore(i => 22 + wobble(i)) };
  const r = leading.detectTacticalDrift({ tracker: trackerFeed({ liveValue: 2 }), series: s, asOf: ASOF });
  assert.equal(r.quiet, 'T1', 'a backlog collapsing is not something to warn about');
});

test('T1 states that it is comparing against yesterday, NOT against this hour', () => {
  // The claim Nick asked for is "unusual for 11am". Until ten weekdays of
  // hourly readings exist that claim cannot be made, and the card must not let
  // a reader assume the stronger one.
  const s = { nt_legacy_cc_incidents: histBefore(i => 22 + wobble(i)) };
  const r = leading.detectTacticalDrift({ tracker: trackerFeed({ liveValue: 60 }), series: s, asOf: ASOF });
  const scope = r.indicators[0].evidence.find(e => e.label === 'Compared against');
  assert.match(String(scope.value), /yesterday's close only/);
  assert.match(String(scope.value), /need 10 days/);
  assert.ok(r.indicators[0].confidence.basis.some(b => /not against this hour/.test(b)));
});

test('T1 blocks — never guesses — when the live snapshot failed', () => {
  const s = { nt_legacy_cc_incidents: histBefore(() => 22) };
  const feed = trackerFeed({ liveValue: 60 });
  feed.live = { available: false, error: 'Jira timed out', items: [] };
  const r = leading.detectTacticalDrift({ tracker: feed, series: s, asOf: ASOF });
  assert.ok(r.blocked);
  assert.match(r.blocked.reason, /Jira timed out/);
});

test('T2 scans at a HIGHER bar than the single-series detectors', () => {
  // Thirty-one series at z>=2 is roughly a false card every week from chance
  // alone. The bar is set from that arithmetic, not from looking at results.
  assert.ok(leading.TRACKER_SCAN_Z > leading.Z_FIRE);
  assert.equal(leading.TRACKER_SCAN_Z, 3);
});

test('T2 fires on a sustained drift and quotes the five weeks', () => {
  const s = { nt_legacy_cc_incidents: series('nt_legacy_cc_incidents', i => (i < 7 ? 60 : 22 + wobble(i))) };
  const feed = trackerFeed({ liveValue: 22 });
  const r = leading.detectTrackerDrift({ tracker: feed, series: s, asOf: ASOF });
  assert.ok(r.indicators?.length);
  assert.equal(r.indicators[0].tense, 'could', 'a fortnight-long drift is not steerable today');
  assert.ok(r.indicators[0].evidence.some(e => e.label === 'Previous four weeks'));
});

test('T2 respects direction — a higher-better KPI falling is the bad case', () => {
  const s = { nt_legacy_solved_today: series('nt_legacy_solved_today', i => (i < 7 ? 40 : 120 + wobble(i))) };
  s.nt_legacy_solved_today.direction = 'higher-better';
  const feed = trackerFeed({ liveValue: 40, key: 'nt_legacy_solved_today', label: 'Total Solved' });
  const r = leading.detectTrackerDrift({ tracker: feed, series: s, asOf: ASOF });
  assert.ok(r.indicators?.length, 'solved collapsing must fire even though the number went DOWN');
  assert.match(r.indicators[0].evidence.find(e => e.label === 'Direction').value, /higher is better/);
});

test('both tracker detectors block rather than guess when the feed is unavailable', () => {
  for (const fn of [leading.detectTacticalDrift, leading.detectTrackerDrift]) {
    const r = fn({ tracker: { available: false, reason: 'bridge down' }, series: {}, asOf: ASOF });
    assert.ok(r.blocked);
    assert.match(r.blocked.reason, /bridge down/);
  }
});

test('the tracker rows with no KPI key are carried, not dropped', () => {
  // The tracker has 34 rows and 31 are measurable. A monitor covering 31 must
  // never be able to read as one covering the tracker.
  const feed = trackerFeed({ liveValue: 22 });
  assert.equal(feed.totalRows, 2);
  assert.equal(feed.measurable.length, 1);
  assert.deepEqual(feed.unmeasured, ['Number of TPJ Tickets in Dev']);
});

// ── Q1: something that was happening has stopped ─────────────────────────────

test('Q1 fires when a higher-better measure goes silent after being active', () => {
  // The blind spot: a sparse-but-real measure going to zero for months, which
  // nothing else can see because a dead series has no variance to deviate from.
  // Deliberately NOT nt_ai_resolved — that one is retired by name now, and a
  // fixture on a retired key would test the retirement, not the detector.
  const s = { nt_sla_res_development_met: series('nt_sla_res_development_met', i => (i < 30 ? 0 : (i % 5 === 0 ? 8 : 0)), { days: 150 }) };
  s.nt_sla_res_development_met.direction = 'higher-better';
  const r = leading.detectWentQuiet({ series: s, asOf: ASOF });
  assert.ok(r.indicators?.length, 'a measure that stopped must be visible');
  assert.equal(r.indicators[0].tense, 'happening', 'it is still stopped, and still switchable-back-on');
  assert.match(r.indicators[0].title, /recorded nothing for 30 days/);
});

test('Q1 does NOT fire for a lower-better measure at zero — that is the target', () => {
  // Without this the same replay fires 42 times instead of 8, and most of them
  // congratulate the team on having no tickets without a reply.
  const s = { nt_incidents_no_reply: series('nt_incidents_no_reply', i => (i < 30 ? 0 : (i % 5 === 0 ? 8 : 0)), { days: 150 }) };
  s.nt_incidents_no_reply.direction = 'lower-better';
  assert.equal(leading.detectWentQuiet({ series: s, asOf: ASOF }).quiet, 'Q1');
});

test('Q1 does not fire for something that never worked', () => {
  // nt_ai_rate is zero across its whole life. Nothing stopped; it never
  // started, and that is a different finding needing a different fix.
  const s = { nt_ai_rate: series('nt_ai_rate', () => 0, { days: 150 }) };
  s.nt_ai_rate.direction = 'higher-better';
  assert.equal(leading.detectWentQuiet({ series: s, asOf: ASOF }).quiet, 'Q1');
});

test('Q1 does not fire on a quiet fortnight in a normally sparse series', () => {
  // Active on only 4% of days — too thin to call a stop a change.
  const s = { nt_thing: series('nt_thing', i => (i > 120 && i % 25 === 0 ? 3 : 0), { days: 150 }) };
  s.nt_thing.direction = 'higher-better';
  assert.equal(leading.detectWentQuiet({ series: s, asOf: ASOF }).quiet, 'Q1');
});

test('Q1 runs at FULL scope, deliberately unlike T1 and T2', () => {
  // T1/T2 are scoped narrowly because at full scope they warn every working
  // day. A stop is rare and discrete — 0.9 a month across all 132 series — so
  // this one watches everything, which is what closes the blind-spot class.
  const s = { nt_sla_res_development_met: series('nt_sla_res_development_met', i => (i < 30 ? 0 : (i % 5 === 0 ? 8 : 0)), { days: 150 }) };
  s.nt_sla_res_development_met.direction = 'higher-better';
  const { usable } = require('./kpi-series');
  assert.equal(usable(s.nt_sla_res_development_met), false, 'the scanned-scope rule excludes it');
  assert.ok(leading.detectWentQuiet({ series: s, asOf: ASOF }).indicators?.length,
    'and Q1 sees it anyway — that is the whole point');
});

test('Q1 does not warn about a measure that was retired ON PURPOSE', () => {
  // The false positive that shipped on 18 Sep: "AI Tickets Resolved has
  // recorded nothing for 103 days" was correct about the number and wrong about
  // what it meant. NOVA replaced the approval-queue model on 15 May 2026
  // (commit e51a2cd) and zero is the expected value.
  const s = { nt_ai_resolved: series('nt_ai_resolved', i => (i < 30 ? 0 : (i % 5 === 0 ? 8 : 0)), { days: 150 }) };
  s.nt_ai_resolved.direction = 'higher-better';
  assert.equal(leading.detectWentQuiet({ series: s, asOf: ASOF }).quiet, 'Q1');
  assert.match(leading.DELIBERATELY_RETIRED.nt_ai_resolved, /e51a2cd/, 'the reason cites its evidence');
});

test('a human calling a Q1 card a false alarm retires that measure', () => {
  // The general case: nothing in the data distinguishes a pipeline breaking
  // from an architect retiring it, so a person has to be able to say. Without
  // this, every deliberate change leaves a permanent false alarm on a screen
  // Nick checks daily — and a screen with one of those is one he stops reading.
  const s = { nt_thing: series('nt_thing', i => (i < 30 ? 0 : (i % 5 === 0 ? 8 : 0)), { days: 150 }) };
  s.nt_thing.direction = 'higher-better';
  assert.ok(leading.detectWentQuiet({ series: s, asOf: ASOF }).indicators?.length, 'fires when unknown');
  assert.equal(leading.detectWentQuiet({ series: s, asOf: ASOF, retired: new Set(['nt_thing']) }).quiet, 'Q1',
    'and stays quiet once a person has said it was deliberate');
});

test('current() runs end to end — the impure half nothing else covered', () => {
  // ⚠ This test exists because its absence took the radar down. `retired` was
  // declared AFTER the detect() call that used it — a temporal dead zone — so
  // /api/leading answered 400 with "Cannot access 'retired' before
  // initialization" and the radar went with it. All 286 tests passed, because
  // every one of them calls the PURE detect() directly and nothing ever
  // executed this function.
  //
  // With no bridge configured it must return an unavailable STATE with a
  // reason, never throw. That is the contract, and it is also enough to catch
  // a reference error anywhere on the path.
  const saved = [process.env.NOVA_BRIDGE_URL, process.env.NOVA_BRIDGE_SECRET];
  delete process.env.NOVA_BRIDGE_URL;
  delete process.env.NOVA_BRIDGE_SECRET;
  return leading.current()
    .then(r => {
      assert.equal(r.available, false, 'no bridge means unavailable, not a throw');
      assert.match(String(r.reason), /not configured/);
    })
    .finally(() => {
      if (saved[0]) process.env.NOVA_BRIDGE_URL = saved[0];
      if (saved[1]) process.env.NOVA_BRIDGE_SECRET = saved[1];
    });
});
