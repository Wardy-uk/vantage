'use strict';

/**
 * Pins the three rules VANTAGE owes NOVA's health report.
 *
 * The NOVA side asked for these by name, and each one is a way the report can
 * be read as reassurance when it is the opposite. They are the reason the
 * report is worth consuming at all — a consumer that gets them wrong is worse
 * than no consumer, because it converts an honest "cannot tell" into a tick.
 */

const test = require('node:test');
const assert = require('node:assert');

const nh = require('./nova-health');

const report = (over = {}) => ({
  available: true,
  asOf: '2026-09-18T10:00:00Z',
  raw: {
    build: nh.BUILD_WRITTEN_AGAINST,
    overall: 'ok',
    trustworthy: true,
    controlsHealthy: true,
    tables: { ok: true, error: null, data: [{ table: 'jira_issue_cache', severity: 'ok', verdict: 'fine', control: true }] },
    columns: { ok: true, error: null, data: [] },
    jobs: { ok: true, error: null, data: { uptimeSeconds: 99999, warmingUp: false, inMemoryOnly: true, jobs: [] } },
    unavailable: [],
    ...over,
  },
});

test('RULE 1a: sick controls mean the checker is BLIND, and the greens prove nothing', () => {
  const r = nh.toRadar(report({ trustworthy: false, controlsHealthy: false, overall: 'ok' }));
  const blind = r.blind.find(b => /blind/.test(b.name));
  assert.ok(blind, 'a blind checker must reach the blind-spots banner');
  assert.match(blind.reason, /not evidence of anything/);
});

test('RULE 1b: a missing section is INCOMPLETE, not worthless — a different sentence', () => {
  // Build -b split the flag because the two causes want different reactions.
  // Saying "the numbers cannot be believed" when they are merely incomplete
  // would be as wrong as saying nothing.
  const r = nh.toRadar(report({
    trustworthy: false, controlsHealthy: true, overall: 'unknown',
    unavailable: [{ name: 'jobs', error: 'no registry' }],
  }));
  const blind = r.blind.find(b => /partial/.test(b.name));
  assert.ok(blind, 'a partial report is named as partial');
  assert.match(blind.reason, /Incomplete rather than wrong/);
  assert.ok(!r.blind.some(b => /\(blind\)/.test(b.name)), 'and is NOT reported as a blind checker');
});

test('RULE 2: unknown is reported as not-evaluated, never as passing', () => {
  const r = nh.toRadar(report({
    tables: { ok: true, error: null, data: [{ table: 'agent_incidents', severity: 'unknown', verdict: 'could not read' }] },
  }));
  const blind = r.blind.find(b => /not evaluated/.test(b.name));
  assert.ok(blind);
  assert.match(blind.reason, /agent_incidents/);
  assert.match(blind.reason, /not the same as fine/);
  assert.equal(r.items.length, 0, 'unknown is not a card either — it is an absence');
});

test('RULE 2 carries a next step where NOVA\'s verdict names the cause, and none where it does not', () => {
  const withCause = nh.toRadar(report({
    tables: { ok: true, error: null, data: [{ table: 'agent_escalation_predictions', severity: 'unknown',
      verdict: '42 rows, but no timestamp column to measure recency on' }] },
  })).blind.find(b => /not evaluated/.test(b.name));
  assert.match(withCause.reason, /no timestamp column/, 'the verdict is shown, not just the table name');
  assert.match(withCause.remedy, /TIMESTAMP_PREFERENCE/);

  const noCause = nh.toRadar(report({
    tables: { ok: true, error: null, data: [{ table: 'agent_incidents', severity: 'unknown', verdict: 'could not read' }] },
  })).blind.find(b => /not evaluated/.test(b.name));
  assert.equal(noCause.remedy, null);
});

test('RULE 3: warmingUp means NO job information, not healthy jobs', () => {
  // NOVA holds lastRun in memory, so a restart makes every job look never-run.
  // A consumer reading that as fine would be reassured exactly when it has
  // least reason to be.
  const r = nh.toRadar(report({
    jobs: { ok: true, error: null, data: { uptimeSeconds: 120, warmingUp: true, inMemoryOnly: true,
      jobs: [{ id: 'kpi-org-capture', severity: 'fail', verdict: 'never ran' }] } },
  }));
  assert.equal(r.items.length, 0, 'a warming-up job list must not raise a card');
  assert.ok(r.blind.some(b => /jobs/.test(b.name) && /held in memory only/.test(b.reason)),
    'and the absence of job information must be stated');
});

test('a failing check becomes ONE card, however many are failing', () => {
  // Six dead tables is a single fact about NOVA's capture. Six cards would push
  // every department signal off a screen that holds five.
  const fails = ['a', 'b', 'c', 'd', 'e', 'f'].map(t => ({ table: t, severity: 'fail', verdict: `${t} stopped` }));
  const r = nh.toRadar(report({ tables: { ok: true, error: null, data: fails }, overall: 'fail' }));
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].title, /6 of NOVA's own checks are failing/);
  assert.equal(r.items[0].tense, 'happening', 'it is wrong now and fixable now');
  assert.match(r.items[0].detail, /and 2 more/, 'the ones it could not list are counted');
});

test('a warn raises neither a card nor a blind spot', () => {
  const r = nh.toRadar(report({
    tables: { ok: true, error: null, data: [{ table: 'x', severity: 'warn', verdict: 'a day late' }] },
  }));
  assert.equal(r.items.length, 0);
  assert.equal(r.blind.length, 0);
});

test('an unreadable report is itself a finding, and says nothing is confirmed', () => {
  const r = nh.toRadar({ available: false, reason: 'bridge timed out' });
  assert.equal(r.items.length, 0);
  assert.match(r.blind[0].reason, /bridge timed out/);
  assert.match(r.blind[0].reason, /Nothing below reflects/);
});

test('a section NOVA could not evaluate is named, not dropped', () => {
  const r = nh.toRadar(report({ unavailable: [{ name: 'columns', error: 'query timed out' }] }));
  assert.ok(r.blind.some(b => /columns/.test(b.name) && /timed out/.test(b.reason)));
});

test('the database section added in build -d is consumed, not skipped', () => {
  // A section this reader does not understand is a section whose failures never
  // reach the screen — the quiet kind of gap, and exactly what this whole
  // feature exists to stop.
  const checks = nh.allChecks({
    tables: { data: [] }, columns: { data: [] }, jobs: { data: null },
    database: { ok: true, data: {
      pool: { size: 50, used: 23, free: 27, pending: 0, severity: 'ok', note: 'no queueing' },
      staleStatsReadable: true,
      staleStats: [{ table: 'jira_issue_cache', stat: 'IX_x', rows: 12761, modifications: 138000, severity: 'fail' }],
      resource: { avgCpuPercent: 40, avgDataIoPercent: 100, maxWorkerPercent: 5, severity: 'warn', note: 'Data IO pegged' },
    } },
  });
  assert.ok(checks.some(c => c.name === 'connection pool'));
  assert.ok(checks.some(c => c.name === 'DTU headroom'));
  const stat = checks.find(c => /stats jira_issue_cache/.test(c.name));
  assert.ok(stat, 'a stale statistic must surface');
  assert.equal(stat.severity, 'fail');
  assert.match(stat.verdict, /138,000 modifications against 12,761 rows/);
});

test('an unreadable statistics DMV is unknown, never an empty all-clear', () => {
  // The report carries its own absent-is-not-zero guard here. If this reader
  // ignored it, "no stale statistics found" and "could not look" would render
  // identically — which is the failure, one layer out.
  const checks = nh.allChecks({
    tables: { data: [] }, columns: { data: [] }, jobs: { data: null },
    database: { ok: true, data: { pool: null, staleStatsReadable: false, staleStats: [], resource: null } },
  });
  const s = checks.find(c => c.name === 'stale statistics');
  assert.equal(s.severity, 'unknown');
  assert.match(s.verdict, /not evidence that nothing is stale/);
});

// ── The gate is the shape, not the version ───────────────────────────────────

test('a NEWER build with the same shape is READ, not refused', () => {
  // ⚠ The reason this changed. Strict stamp equality refused build -e, which
  // was a performance fix — "stop the health check scanning 723MB to ask what
  // time it is" — with a contract byte-identical to -d. It could not have
  // affected this reader and it blocked it anyway, putting a blind spot on
  // Nick's radar for the fourth time in a day.
  const r = nh.readable({
    build: '2026-09-99-z', overall: 'ok', trustworthy: true, controlsHealthy: true,
    unavailable: [],
    tables: { ok: true, error: null, data: [] },
    columns: { ok: true, error: null, data: [] },
    jobs: { ok: true, error: null, data: null },
  });
  assert.equal(r.ok, true, 'an unfamiliar version whose shape is intact must still be usable');
});

test('a response missing a field this reader USES is refused, by name', () => {
  // The protection the stamp was introduced for: a stale dist once served a
  // plausible response with new fields silently undefined, and undefined
  // renders as a confident blank. This catches it, and says which field.
  const r = nh.readable({
    build: '2026-09-18-e', overall: 'ok', trustworthy: true,
    unavailable: [], tables: { ok: true }, columns: { ok: true }, jobs: { ok: true },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['controlsHealthy']);
});

test('an extra section is not a reason to refuse', () => {
  // `database` arrived exactly this way in build -d. Extra is fine; missing is not.
  const r = nh.readable({
    build: '2026-09-18-e', overall: 'ok', trustworthy: true, controlsHealthy: true,
    unavailable: [],
    tables: { ok: true }, columns: { ok: true }, jobs: { ok: true },
    somethingNobodyHasWrittenYet: { ok: true },
  });
  assert.equal(r.ok, true);
});

test('a readable but newer build says so, in the blind-spots banner', () => {
  // Not a refusal, and not silence either: a newer NOVA may carry checks this
  // screen has not been taught to render, and an unrendered check is a gap.
  const r = nh.toRadar({
    available: true, asOf: 'now',
    buildNote: 'NOVA is on build "2026-09-99-z"; this reader was written against "2026-09-18-e".',
    raw: {
      build: '2026-09-99-z', overall: 'ok', trustworthy: true, controlsHealthy: true,
      unavailable: [], tables: { ok: true, data: [] }, columns: { ok: true, data: [] },
      jobs: { ok: true, data: { warmingUp: false, jobs: [] } },
    },
  });
  assert.ok(r.blind.some(b => /newer build/.test(b.name)));
});
