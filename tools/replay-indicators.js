'use strict';

/**
 * Offline historical replay — does a detector WARN, or does it just describe?
 *
 * This is the question the whole feature turns on. A detector that fires on the
 * day a problem lands on the wallboard has added nothing: NOVA already shows
 * levels, on a bigger screen, to more people. The only thing that justifies
 * another card on Nick's radar is days of notice.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 *
 * It walks the history one day at a time and, on each day D, calls the SAME
 * `detect()` the live path calls, with the series truncated to `<= D`. Nothing
 * is recomputed and nothing is reimplemented — a back-test of a copy of the
 * logic proves something about the copy.
 *
 * ── What counts as the problem becoming obvious ─────────────────────────────
 *
 * A RISE EPISODE: a stock KPI climbing its ENTIRE green-to-red span within 14
 * days. The span comes from NOVA's own RAG bands, so the size of a move that
 * matters is still someone else's number and this cannot mark its own homework
 * — but the EVENT is the climb, not the line-crossing.
 *
 * ⚠ THIS REPLACED RAG CROSSINGS ON 17 SEP 2026, and the change mattered more
 * than any detector. Measured over 320 days: `nt_production` is above its red
 * line 69% of the time and `nt_incidents` 65%. A "crossing" on a series that
 * lives above its own line is usually the series dipping under and coming back,
 * not a problem arriving — several of V1's events occurred while the stock was
 * FALLING (2026-08-11: Production at 83 on a 14-day slope of -3.3, then red).
 * Only 6 of V1's 19 events were preceded by a sustained rise, and two thirds of
 * genuine rises never produced a crossing at all because the series was already
 * red. So the old label was BOTH noisy and incomplete, and every lead time
 * measured against it averaged real warnings together with coin-flips.
 *
 * Two restrictions, both measured rather than assumed:
 *
 *  - STOCK KPIs ONLY. The daily FLOW KPIs cross their daily target constantly —
 *    `nt_new_tickets` turned red 21 times in 120 days, `nt_escalated` 19. A
 *    marker that fires every six days is not an event.
 *  - EPISODES ARE SEPARATED by `EPISODE_GAP_DAYS`, so one long climb counts once
 *    rather than as a new event every day it continues.
 *
 * ── The rule that matters most ──────────────────────────────────────────────
 *
 * A fire on or after the obvious day scores a lead of ZERO and is counted as
 * COINCIDENT, not as a hit. That is the whole test. A detector can look
 * excellent on precision while every one of its fires lands the same morning
 * the wallboard turns red, and that detector is worthless.
 *
 * ── Thresholds are not to be tuned from this output ─────────────────────────
 *
 * The detector thresholds live in `leading.js` and were fixed before this was
 * first run. If a detector scores badly the answer is to report it and leave it
 * disabled, not to widen the window until the history looks kind. A curve
 * fitted to a dozen events is not a warning system.
 *
 * Usage:
 *   node tools/replay-indicators.js --snapshot path/to/kpi-snapshot.json
 *   node tools/replay-indicators.js --fetch            # via the NOVA bridge
 *   node tools/replay-indicators.js --snapshot x.json --json
 */

const fs = require('node:fs');
const path = require('node:path');

const leading = require('../backend/services/leading');
const indicatorLog = require('../backend/services/indicator-log');
const episodes = require('../backend/services/episodes');

// ── Scoring parameters, fixed ────────────────────────────────────────────────

/** The episode definition is shared with the live ledger — see episodes.js. */
const { RISE_WINDOW_DAYS, EPISODE_GAP_DAYS } = episodes;

/**
 * Kept for the superseded measure, which `--rag` still reports so the old
 * numbers can be reproduced rather than taken on trust.
 */
const RED_RUN_DAYS = 3;
/**
 * How long a warning is allowed to be "about" an outcome. 21 days: three weeks
 * is already far beyond the 1-5 day brief, so a detector that cannot beat this
 * window is not marginal, it is not working.
 */
const ATTRIBUTION_DAYS = 21;

/**
 * Stock KPIs whose red runs mark a problem arriving, and which detector claims
 * to see each one coming.
 *
 * Mapped explicitly rather than by rule, because a detector that could be
 * scored against any red KPI would eventually be scored against one it never
 * claimed to predict.
 */
const OUTCOMES = [
  { kpi: 'nt_incidents', label: 'Incident backlog rose sharply', detectors: ['A'] },
  { kpi: 'nt_production', label: 'Production backlog rose sharply', detectors: ['A'] },
  // D is off, so nothing currently claims Development. Left mapped so a
  // replacement can be scored against the same episodes without the mapping
  // being reinvented — and so the absence shows as a MISS rather than as an
  // outcome nobody was measured on.
  { kpi: 'nt_development', label: 'Development backlog rose sharply', detectors: ['D'] },
];

/**
 * `--rag` reproduces the SUPERSEDED measure.
 *
 * Kept runnable rather than deleted, because a correction nobody can reproduce
 * is an assertion. The old numbers should stay obtainable by anyone who wants
 * to check that the label really was the thing that changed.
 */
const USE_RAG = process.argv.includes('--rag');

const DAY_MS = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const between = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// ── Loading ──────────────────────────────────────────────────────────────────

async function load(args) {
  const snapIdx = args.indexOf('--snapshot');
  if (snapIdx !== -1 && args[snapIdx + 1]) {
    const file = path.resolve(args[snapIdx + 1]);
    return { source: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  if (args.includes('--fetch')) {
    require('dotenv').config();
    const kpiSeries = require('../backend/services/kpi-series');
    const res = await kpiSeries.current({ force: true, days: 400 });
    if (!res.available) throw new Error(`could not fetch: ${res.reason}`);
    return { source: 'NOVA bridge', data: { window: res.window, series: Object.values(res.series) } };
  }
  throw new Error('need --snapshot <file> or --fetch');
}

/**
 * Truncate every series to days <= `day`.
 *
 * This is the thing the whole harness rests on, so it is one function and it is
 * blunt. A detector that can see a single day past `asOf` is reading the future
 * and every number below it becomes a lie.
 */
function asOfView(seriesByKey, day) {
  const out = {};
  for (const [key, s] of Object.entries(seriesByKey)) {
    const points = s.points.filter(p => p.day <= day);
    out[key] = {
      ...s,
      points,
      sourceBreaks: (s.sourceBreaks || []).filter(b => b.day <= day),
      coverage: {
        ...s.coverage,
        daysWithValue: points.length,
        lastValueDay: points[points.length - 1]?.day ?? null,
        // Recomputed against the replay's clock, not carried from the live
        // snapshot — otherwise every historic day would look perfectly fresh.
        staleDays: points.length ? between(points[points.length - 1].day, day) : null,
      },
    };
  }
  return out;
}

/**
 * Rise episodes come from `backend/services/episodes.js`, NOT from a copy here.
 *
 * The live ledger labels prospective warnings with the same function. If the
 * replay used its own implementation, a historical lead time and a prospective
 * one would be measured with different rulers and could never be compared —
 * which is the entire point of building the ledger.
 */
/** Red runs of at least RED_RUN_DAYS — the SUPERSEDED measure, kept for `--rag`. */
function redRuns(series) {
  if (!series) return [];
  const pts = series.points;
  const runs = [];
  let start = null;
  let len = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (pts[i].rag === 'red') {
      if (start === null) { start = pts[i].day; len = 0; }
      len += 1;
    } else {
      if (start !== null && len >= RED_RUN_DAYS) runs.push({ start, days: len });
      start = null; len = 0;
    }
  }
  if (start !== null && len >= RED_RUN_DAYS) runs.push({ start, days: len });
  // Only runs that BEGIN — a series that is already red on day one was not
  // observed arriving, and counting it would credit or blame a detector for an
  // event that predates the window.
  return runs.filter(r => r.start !== pts[0]?.day);
}

// ── The replay ───────────────────────────────────────────────────────────────

function replay(seriesByKey, { from, to, disabled = [] }) {
  const fires = [];      // one row per detector-day that fired
  const runsByKey = new Map();
  const blockedDays = new Map();
  let records = [];
  let nextId = 1;

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const view = asOfView(seriesByKey, day);
    let result;
    try {
      // capacity: null on every day. Availability has NO history anywhere in
      // the estate — `agent_availability` holds forward-looking approved leave
      // and is overwritten — so detector E cannot be replayed at all. That is
      // reported as an unvalidatable detector rather than scored as a failing
      // one; the two are different findings.
      result = leading.detect({ series: view, capacity: null, asOf: day, disabled });
    } catch (err) {
      blockedDays.set(`threw:${err.message}`, (blockedDays.get(`threw:${err.message}`) || 0) + 1);
      continue;
    }

    for (const b of result.blocked) {
      blockedDays.set(b.id, (blockedDays.get(b.id) || 0) + 1);
    }

    // The real lifecycle, day by day, so a "first fire" is the start of a RUN
    // and not every day the detector happened to be shouting.
    const { inserts, updates } = indicatorLog.plan(records, result.indicators, day);
    for (const row of inserts) {
      records.push({ ...row, id: nextId++ });
      runsByKey.set(`${row.key}@${row.firstSeenOn}`, { key: row.key, detector: row.detector, start: day, days: 1 });
    }
    for (const u of updates) records = records.map(r => (r.id === u.id ? { ...r, ...u.patch } : r));

    for (const ind of result.indicators) {
      const rec = records.find(r => r.key === ind.key && r.status === 'open');
      if (rec) {
        const run = runsByKey.get(`${ind.key}@${rec.firstSeenOn}`);
        if (run) run.days = between(run.start, day) + 1;
      }
      fires.push({ day, key: ind.key, detector: ind.detector, severity: ind.severity, confidence: ind.confidence.score });
    }
  }

  return { fires, runs: [...runsByKey.values()], blockedDays };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function score(runs, seriesByKey, { from, to }) {
  const perDetector = new Map();
  const detail = [];

  const ensure = id => {
    if (!perDetector.has(id)) {
      perDetector.set(id, { id, runs: 0, warnings: 0, coincident: 0, falsePositives: 0, leads: [] });
    }
    return perDetector.get(id);
  };
  for (const r of runs) ensure(r.detector).runs += 1;

  const outcomes = [];
  for (const o of OUTCOMES) {
    const eps = USE_RAG
      ? redRuns(seriesByKey[o.kpi])
      : episodes.forSeries(seriesByKey[o.kpi]).map(e => ({ start: e.day, rose: e.rose }));
    for (const run of eps) {
      // Only outcomes inside the scored window — one before `from` cannot
      // possibly have been warned about by a replay that had not started.
      if (run.start < from || run.start > to) continue;
      outcomes.push({ ...o, obviousOn: run.start, redDays: run.days ?? null, rose: run.rose ?? null });
    }
  }

  const claimed = new Set();
  for (const outcome of outcomes) {
    const candidates = runs
      .filter(r => outcome.detectors.includes(r.detector))
      .filter(r => r.start <= outcome.obviousOn && between(r.start, outcome.obviousOn) <= ATTRIBUTION_DAYS)
      .sort((a, b) => a.start.localeCompare(b.start));

    // Coincident: the detector fired, but not before. Lead zero. This is the
    // line between a warning and a description, and it is scored as a miss for
    // lead-time purposes while still being recorded as "it did see it".
    const coincidentOnly = runs.filter(r =>
      outcome.detectors.includes(r.detector) && r.start === outcome.obviousOn);

    if (candidates.length) {
      const first = candidates[0];
      const lead = between(first.start, outcome.obviousOn);
      const d = ensure(first.detector);
      if (lead > 0) { d.warnings += 1; d.leads.push(lead); } else { d.coincident += 1; }
      claimed.add(`${first.key}@${first.start}`);
      detail.push({ ...outcome, detector: first.detector, firedOn: first.start, leadDays: lead, result: lead > 0 ? 'warned' : 'coincident' });
    } else if (coincidentOnly.length) {
      ensure(coincidentOnly[0].detector).coincident += 1;
      detail.push({ ...outcome, detector: coincidentOnly[0].detector, firedOn: outcome.obviousOn, leadDays: 0, result: 'coincident' });
    } else {
      detail.push({ ...outcome, detector: outcome.detectors.join('/'), firedOn: null, leadDays: null, result: 'missed' });
    }
  }

  // A run that never preceded a mapped outcome. Counted only for detectors that
  // HAVE a mapped outcome — scoring a detector as a false positive against
  // outcomes it never claimed to predict is not a measurement.
  const scorable = new Set(OUTCOMES.flatMap(o => o.detectors));
  for (const run of runs) {
    if (!scorable.has(run.detector)) continue;
    if (claimed.has(`${run.key}@${run.start}`)) continue;
    const near = outcomes.some(o =>
      o.detectors.includes(run.detector)
      && o.obviousOn >= run.start
      && between(run.start, o.obviousOn) <= ATTRIBUTION_DAYS);
    if (!near) ensure(run.detector).falsePositives += 1;
  }

  return { perDetector: [...perDetector.values()], outcomes: detail, scorable };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── Positive control ─────────────────────────────────────────────────────────

/**
 * Inject a surge the detectors MUST see, and check they saw it.
 *
 * Without this, a replay reporting "no false positives, no warnings" is
 * indistinguishable from a replay in which nothing ran at all — a clean sheet
 * produced by a broken pipeline. It is the same failure `privacy.test.js` and
 * `vault-actions-cards.test.js` guard against, and it has caught a real one in
 * this repo before.
 */
function positiveControl(seriesByKey, { to }) {
  const spike = addDays(to, -3);
  const copy = JSON.parse(JSON.stringify(seriesByKey));
  const arrivals = copy.nt_new_tickets;
  if (!arrivals) return { ran: false, reason: 'nt_new_tickets is not in the snapshot' };
  for (const p of arrivals.points) {
    if (p.day > addDays(spike, -7) && p.day <= spike) p.value += 500;
  }
  const out = replay(copy, { from: spike, to: spike, disabled: [] });
  return {
    ran: true,
    detected: out.fires.some(f => f.detector === 'A'),
    fires: out.fires.length,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const { source, data } = await load(args);

  const seriesByKey = {};
  for (const s of data.series) seriesByKey[s.key] = s;

  // Start once every detector KPI has a full baseline behind it, so a detector
  // is never scored over days it was structurally unable to answer.
  const needed = ['nt_new_tickets', 'nt_solved_team', 'nt_solved_nova', 'nt_development', 'nt_incidents', 'nt_production', 'nt_oldest_development'];
  const firsts = needed.map(k => seriesByKey[k]?.coverage?.firstValueDay).filter(Boolean);
  const lasts = needed.map(k => seriesByKey[k]?.coverage?.lastValueDay).filter(Boolean);
  if (firsts.length !== needed.length) {
    console.error(`Cannot replay: missing ${needed.filter(k => !seriesByKey[k]).join(', ')}`);
    process.exit(1);
  }
  const from = addDays(firsts.sort().reverse()[0], leading.REQUIRED_DAYS);
  const to = lasts.sort()[0];

  const { runs, blockedDays } = replay(seriesByKey, { from, to });
  const { perDetector, outcomes } = score(runs, seriesByKey, { from, to });
  const control = positiveControl(seriesByKey, { to });
  const days = between(from, to) + 1;

  if (asJson) {
    console.log(JSON.stringify({ source, from, to, days, perDetector, outcomes, runs, control, blocked: [...blockedDays] }, null, 2));
    process.exit(0);
  }

  console.log(`\nreplay-indicators — ${source}`);
  console.log(`scored ${days} days, ${from} → ${to}`);
  console.log(USE_RAG
    ? `outcome = SUPERSEDED MEASURE: a stock KPI red for ${RED_RUN_DAYS}+ consecutive days`
    : `outcome = a stock KPI rising its whole green-to-red span within ${RISE_WINDOW_DAYS} days (episodes ${EPISODE_GAP_DAYS}+ days apart)`);
  console.log(`attribution window = ${ATTRIBUTION_DAYS} days; a fire ON the outcome day scores lead 0\n`);

  console.log('POSITIVE CONTROL');
  if (!control.ran) console.log(`  ✗ could not run — ${control.reason}`);
  else if (control.detected) console.log('  ✓ an injected +500/day surge was detected — the pipeline is live, so a clean sheet below means something');
  else console.log('  ✗ AN INJECTED SURGE WAS NOT DETECTED. Every number below is meaningless — the pipeline is not running.\n');

  console.log('\nOUTCOMES FOUND');
  if (!outcomes.length) console.log('  none in the scored window');
  for (const o of outcomes) {
    const mark = o.result === 'warned' ? '✓' : o.result === 'coincident' ? '=' : '✗';
    console.log(`  ${mark} ${o.obviousOn}  ${o.label.padEnd(38)} ${
      o.result === 'warned' ? `warned ${o.leadDays}d earlier (${o.detector}, fired ${o.firedOn})`
        : o.result === 'coincident' ? `${o.detector} fired the SAME DAY — description, not warning`
          : `no warning from ${o.detector}`}`);
  }

  console.log('\nPER DETECTOR');
  console.log(`  ${'id'.padEnd(4)}${'runs'.padStart(5)}${'warned'.padStart(8)}${'coinc'.padStart(7)}${'FP'.padStart(5)}${'median lead'.padStart(13)}`);
  for (const d of perDetector.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${d.id.padEnd(4)}${String(d.runs).padStart(5)}${String(d.warnings).padStart(8)}${String(d.coincident).padStart(7)}${String(d.falsePositives).padStart(5)}${String(median(d.leads) ?? '—').padStart(13)}`);
  }

  console.log('\nDETECTORS THAT COULD NOT BE SCORED AT ALL');
  console.log('  B  Ageing acceleration      built on a COUNTER: nt_oldest_development rises +1 on 316 of');
  console.log('                              319 days and has fallen twice in 320, so the "frozen tail" it');
  console.log('                              looks for is the default state. Its KPI is also red every day.');
  console.log('  C  Escalation quality       nt_rejected is RAG green on every day, and a flow KPI has no');
  console.log('                              rise episode to score against either. Unmeasurable.');
  console.log('  E  Capacity collision       agent_availability DOES hold history — 311 past rows over 156');
  console.log('                              days back to 2026-02-02. V1 said otherwise and was WRONG. But');
  console.log('                              updated_at is a SYNC stamp, not a booking date, so nothing');
  console.log('                              records when a row first appeared: annual leave is bookable in');
  console.log('                              advance, sickness is recorded on the day, and replaying that');
  console.log('                              would be hindsight. Advisory until prospective data decides.');

  if (blockedDays.size) {
    console.log('\nDAYS EACH DETECTOR COULD NOT RUN (out of ' + days + ')');
    for (const [id, n] of [...blockedDays.entries()].sort()) console.log(`  ${String(id).padEnd(28)} ${n}`);
  }

  console.log('');
  process.exit(0);
}

main().catch(err => {
  console.error('\nReplay failed:', err.message, '\n');
  process.exit(1);
});
