'use strict';

/**
 * Pins the per-person reader.
 *
 * Two properties matter more than the rest and both are about restraint:
 *
 *   1. The verification-only fence. NOVA put solvedToday/solvedWeek/
 *      ticketsPerHour in their own object so a renderer could not fold them into
 *      a scorecard. If this side ever reads them into a card, the tool built to
 *      evidence the PIP rebuilds the reasoning the PIP was opened over.
 *   2. Absence is not agreement. `measuredButNotOnRoster: null` means the check
 *      could not run; `[]` means it ran and found nothing.
 */

const test = require('node:test');
const assert = require('node:assert');

const people = require('./people');

const ok = data => ({ ok: true, error: null, data });
const failed = error => ({ ok: false, error, data: null });

const base = (over = {}) => ({
  available: true,
  window: { days: 30, from: '2026-08-04' },
  roster: ok({
    scope: { departments: ['NT', 'NOVA_AI'], activeOnly: true },
    people: [{ accountId: 'a1', name: 'Abdi Mohamed', tierCode: 'T2', team: 'Support', availableForAssignment: true }],
    measuredButNotOnRoster: [],
  }),
  performance: ok({
    asOf: { day: '2026-09-02', capturedAt: '2026-09-02T18:00:00Z', ageDays: 1 },
    people: [],
    notCaptured: 0,
    slaCoverage: { withValue: 8, ofPeople: 14, basis: 'resolved that day with a parseable Resolution SLA' },
    withheld: [{ field: 'rag', reason: 'computed by superseded logic' }],
  }),
  standups: ok({
    sessionsInWindow: 23, sessionsEvidenced: 22, perPerson: [], unmatchedSubmitters: [],
  }),
  escalations: ok({
    scope: { ticketPrefix: 'NT' }, perPerson: [],
    attributionCaveat: 'Sync rows carry the current assignee, not the actor.',
    unmatchedActors: [],
  }),
  unavailable: [],
  ...over,
});

// ── The fence ────────────────────────────────────────────────────────────────

test('verification-only figures never reach a card or the coach summary', () => {
  // The single most important assertion in this file. These are the "headline
  // productivity indicators (ticket counts, activity status)" named in PIP
  // competency 1. Admissible against a specific overtime claim; never evidence
  // that somebody is underperforming.
  const p = base({
    performance: ok({
      asOf: { day: '2026-09-02', capturedAt: null, ageDays: 0 },
      notCaptured: 0,
      slaCoverage: { withValue: 1, ofPeople: 1, basis: 'x' },
      withheld: [],
      people: [{
        accountId: 'a1', name: 'Abdi Mohamed', state: 'measured',
        workload: { open: 12, overSla: 3 }, quality: { qaScored: 4, qaOverall: 6.1 },
        sla: { compliancePct: 80 },
        verificationOnly: { solvedToday: 99, solvedWeek: 412, ticketsPerHour: 13.2 },
      }],
    }),
  });

  const blob = JSON.stringify(people.toRadarItems(p)) + (people.summarise(p) || '');
  for (const n of ['99', '412', '13.2', 'solvedToday', 'solvedWeek', 'ticketsPerHour']) {
    assert.doesNotMatch(blob, new RegExp(n.replace('.', '\\.')), `verification-only value "${n}" leaked`);
  }
  // And the summary says out loud why they are absent, so their absence is not
  // read as the data being missing.
  assert.match(people.summarise(p), /never evidence that somebody is underperforming/);
});

// ── Absence is not agreement ─────────────────────────────────────────────────

test('an unchecked roster comparison is never reported as agreement', () => {
  const p = base({
    roster: ok({
      scope: { departments: ['NT'], activeOnly: true },
      people: [], measuredButNotOnRoster: null,
    }),
  });
  assert.match(people.summarise(p), /NOT CHECKED/);
  // Not a blunt /agree/: the line deliberately says "Do not say the two agree".
  // What must never appear is the ASSERTION of agreement.
  assert.doesNotMatch(people.summarise(p), /Roster and capture agree/);
  // null must not become a card claiming zero discrepancies either.
  assert.equal(people.toRadarItems(p).filter(i => /not on the roster/.test(i.title)).length, 0);
});

test('an empty roster comparison IS agreement, and says so', () => {
  assert.match(people.summarise(base()), /Roster and capture agree/);
});

test('people measured but not on the roster are named, with why it matters', () => {
  const p = base({
    roster: ok({
      scope: { departments: ['NT'], activeOnly: true },
      people: [],
      measuredButNotOnRoster: [{ accountId: 'w1', name: 'Willem Kruger' }, { accountId: 'a2', name: 'Arman Shazad' }],
    }),
  });
  const [card] = people.toRadarItems(p).filter(i => /not on the roster/.test(i.title));
  assert.match(card.detail, /Willem Kruger, Arman Shazad/);
  assert.match(card.detail, /coverage percentage/);
  assert.match(card.remedy, /Willem Kruger/);
});

// ── Unmeasured is not quiet ──────────────────────────────────────────────────

test('roster members with no capture row are called unmeasured, not quiet', () => {
  const p = base({
    performance: ok({
      asOf: { day: '2026-09-02', capturedAt: null, ageDays: 1 },
      people: [], notCaptured: 3,
      slaCoverage: { withValue: 8, ofPeople: 14, basis: 'x' }, withheld: [],
    }),
  });
  const [card] = people.toRadarItems(p).filter(i => /no figures/.test(i.title));
  assert.match(card.detail, /UNMEASURED/);
  assert.match(card.detail, /not the same as having had a quiet one/);
});

test('a stale capture is reported as its own date rather than as today', () => {
  const p = base({
    performance: ok({
      asOf: { day: '2026-08-20', capturedAt: null, ageDays: 14 },
      people: [], notCaptured: 0,
      slaCoverage: { withValue: 1, ofPeople: 1, basis: 'x' }, withheld: [],
    }),
  });
  const [card] = people.toRadarItems(p).filter(i => /days old/.test(i.title));
  assert.equal(card.severity, 'medium');
  assert.match(card.detail, /2026-08-20/);
});

test('a fresh capture raises no staleness card', () => {
  assert.equal(people.toRadarItems(base()).filter(i => /days old/.test(i.title)).length, 0);
});

test('a HEALTHY capture never raises staleness, midweek or after a weekend', () => {
  // The false positive that would have shipped. NOVA rounds (now - midnight of
  // the frozen day), and the capture freezes at 18:00 for the day just ended, so
  // last night's run reads as 2 by the afternoon and Friday's reads as 3-4 on a
  // Monday. At a threshold of 2 this card fired every day on a healthy system —
  // and a card that is always on is one he learns to scroll past.
  for (const ageDays of [0, 1, 2, 3, 4]) {
    const p = base({
      performance: ok({
        asOf: { day: '2026-09-02', capturedAt: null, ageDays },
        people: [], notCaptured: 0,
        slaCoverage: { withValue: 1, ofPeople: 1, basis: 'x' }, withheld: [],
      }),
    });
    assert.equal(
      people.toRadarItems(p).filter(i => /days old/.test(i.title)).length, 0,
      `ageDays ${ageDays} is normal and must not raise a card`,
    );
  }
});

test('a genuinely missed capture does raise it', () => {
  const p = base({
    performance: ok({
      asOf: { day: '2026-08-29', capturedAt: null, ageDays: 5 },
      people: [], notCaptured: 0,
      slaCoverage: { withValue: 1, ofPeople: 1, basis: 'x' }, withheld: [],
    }),
  });
  assert.equal(people.toRadarItems(p).filter(i => /days old/.test(i.title)).length, 1);
});

// ── Who a card can be about ──────────────────────────────────────────────────

test('Nick and the AI agent are never the subject of a per-person card', () => {
  // The live run produced: "Ask Nick Ward at your next 1:1 whether the standup
  // is landing" — telling Nick to ask himself, next to a robot that cannot
  // attend a standup. NOVA's roster is a MEASUREMENT scope, not a reporting
  // line: 14 = 12 reports + Nick (NTL) + NOVA AI (AI).
  const p = base({
    standups: ok({
      sessionsInWindow: 23, sessionsEvidenced: 22,
      perPerson: [
        { accountId: 'n1', name: 'Nick Ward', tierCode: 'NTL', submitted: 0, missed: 22, lastSubmittedAt: null },
        { accountId: 'ai', name: 'NOVA AI', tierCode: 'AI', submitted: 0, missed: 22, lastSubmittedAt: null },
      ],
      unmatchedSubmitters: [],
    }),
  });
  assert.equal(people.toRadarItems(p).filter(i => /standups/.test(i.title)).length, 0);
});

test('a real report with no standups still raises, alongside them', () => {
  const p = base({
    roster: ok({
      scope: { departments: ['NT', 'NOVA_AI'], activeOnly: true },
      people: [
        { accountId: 'h1', name: 'Hope Goodall', tierCode: 'T1', team: 'CustomerCare' },
        { accountId: 'n1', name: 'Nick Ward', tierCode: 'NTL', team: 'Support' },
        { accountId: 'ai', name: 'NOVA AI', tierCode: 'AI', team: 'NOVA AI' },
      ],
      measuredButNotOnRoster: [],
    }),
    standups: ok({
      sessionsInWindow: 23, sessionsEvidenced: 22,
      perPerson: [
        { accountId: 'n1', name: 'Nick Ward', tierCode: 'NTL', submitted: 0, missed: 22, lastSubmittedAt: null },
        { accountId: 'ai', name: 'NOVA AI', tierCode: 'AI', submitted: 0, missed: 22, lastSubmittedAt: null },
        { accountId: 'h1', name: 'Hope Goodall', tierCode: 'T1', submitted: 0, missed: 22, lastSubmittedAt: null },
      ],
      unmatchedSubmitters: [],
    }),
  });
  const [card] = people.toRadarItems(p).filter(i => /standups/.test(i.title));
  assert.match(card.title, /^1 submitted no standups/);
  assert.match(card.detail, /Hope Goodall/);
  assert.doesNotMatch(card.detail, /Nick Ward|NOVA AI/);
});

test('the summary reports the reporting line, not the measurement scope', () => {
  const p = base({
    roster: ok({
      scope: { departments: ['NT', 'NOVA_AI'], activeOnly: true },
      people: [
        { accountId: 'a1', name: 'Abdi Mohamed', tierCode: 'T2' },
        { accountId: 'n1', name: 'Nick Ward', tierCode: 'NTL' },
        { accountId: 'ai', name: 'NOVA AI', tierCode: 'AI' },
      ],
      measuredButNotOnRoster: [],
    }),
  });
  assert.match(people.summarise(p), /Team: 1 person reports to him/);
  assert.match(people.summarise(p), /returns 3 because it is a MEASUREMENT scope/);
});

// ── Standups ─────────────────────────────────────────────────────────────────

test('standup coverage counts against EVIDENCED sessions, not session rows', () => {
  // ensureSession() creates a row whenever anything touches a date and nothing
  // ever moves status off pending, so a row proves a date was considered. A
  // missed standup charged against a row a background job created is a
  // manufactured finding.
  const p = base({
    roster: ok({
      scope: { departments: ['NT'], activeOnly: true },
      people: [{ accountId: 'z1', name: 'Zoe Rees', tierCode: 'T1', team: 'CustomerCare' }],
      measuredButNotOnRoster: [],
    }),
    standups: ok({
      sessionsInWindow: 23,
      sessionsEvidenced: 22,
      perPerson: [{ accountId: 'z1', name: 'Zoe Rees', submitted: 0, missed: 22, lastSubmittedAt: null }],
      unmatchedSubmitters: [{ name: 'n.rutland', submissions: 4 }],
    }),
  });
  const [card] = people.toRadarItems(p).filter(i => /standups/.test(i.title));
  assert.match(card.detail, /22 sessions that have evidence of running/);
  assert.match(card.detail, /does not prove a standup happened/);
  // An unmatched submitter is named rather than absorbed into the count.
  assert.match(card.detail, /n\.rutland/);
});

test('missed:null raises nothing — "missed 0 of 0" is not a fact about a person', () => {
  const p = base({
    standups: ok({
      sessionsInWindow: 5, sessionsEvidenced: 0,
      perPerson: [{ accountId: 'z1', name: 'Zoe Rees', submitted: 0, missed: null, lastSubmittedAt: null }],
      unmatchedSubmitters: [],
    }),
  });
  assert.equal(people.toRadarItems(p).filter(i => /standups/.test(i.title)).length, 0);
});

test('with no roster, no per-person card is raised at all', () => {
  // Identity lives only on the roster. Without it there is no way to tell a
  // person from an agent, and naming whoever happens to be in the list is the
  // absent-is-not-zero failure pointed at identity instead of at counts.
  const p = base({
    roster: failed('KPI SQL Server not configured'),
    standups: ok({
      sessionsInWindow: 23, sessionsEvidenced: 22,
      perPerson: [{ accountId: 'ai', name: 'NOVA AI', submitted: 0, missed: 22, lastSubmittedAt: null }],
      unmatchedSubmitters: [],
    }),
  });
  assert.equal(people.toRadarItems(p).filter(i => /standups/.test(i.title)).length, 0);
});

// ── Build stamp and failure ──────────────────────────────────────────────────

test('an unavailable read produces no cards and no summary', () => {
  assert.deepEqual(people.toRadarItems({ available: false, reason: 'NOVA returned 503' }), []);
  assert.equal(people.summarise({ available: false, reason: 'x' }), null);
  assert.deepEqual(people.toRadarItems(null), []);
});

test('each signal fails independently rather than losing the rest', () => {
  const p = base({ escalations: failed('Invalid column name'), standups: failed('timeout') });
  assert.match(people.summarise(p), /Escalations: UNAVAILABLE \(Invalid column name\)/);
  assert.match(people.summarise(p), /Standups: UNAVAILABLE \(timeout\)/);
  // The roster still reports, because one broken query must not blank the rest.
  assert.match(people.summarise(p), /Team: 1 person reports to him/);
});

test('the expected build is the one NOVA shipped', () => {
  // If NOVA bumps its stamp, this fails here rather than rendering figures from
  // a build whose new fields are quietly undefined.
  assert.equal(people.BUILD_EXPECTED, '2026-09-03-people-a');
});

test('the SLA basis is carried, not smoothed', () => {
  assert.match(people.summarise(base()), /rests on 8 of 14 people/);
  assert.match(people.summarise(base()), /parseable Resolution SLA/);
});

test('withheld fields are named so they do not look missing', () => {
  assert.match(people.summarise(base()), /Deliberately not sent: rag/);
});
