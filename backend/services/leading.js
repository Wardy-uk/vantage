'use strict';

/**
 * Leading indicators — things turning, before they are obvious.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 *
 * It is not a prediction engine, and it must never read as one. It says "these
 * two numbers have moved together in a way they usually do not, here are the
 * numbers, here is what would prove me wrong". Every claim is a statement about
 * evidence already recorded, not about the future. The horizon is how long the
 * warning is useful for, not a forecast date.
 *
 * It is also not a second wallboard. A threshold breach is not an indicator:
 * NOVA already shows levels, better, on a screen the team looks at. What NOVA
 * cannot show is a DERIVATIVE — change, acceleration, and two series diverging
 * when they normally move together. That is the whole of what is here.
 *
 * ── The rules, which are the product ────────────────────────────────────────
 *
 * 1. **PURE where it judges.** `detect()` takes plain data and a clock and
 *    returns indicators. No fetch, no store, no model. It is what the offline
 *    replay runs, so a back-tested detector and a live one cannot be different
 *    code — which is the only way a back-test means anything.
 *
 * 2. **NO MODEL IN THE PATH.** Deterministic, department-first. Nothing here
 *    reads health, readiness, desktop activity or location, and nothing here
 *    asks an LLM what it thinks. A warning Nick cannot reproduce by hand from
 *    the evidence line is a warning he cannot take to Chris.
 *
 * 3. **A HOLE IS NOT A ZERO.** Every detector checks coverage before it
 *    computes anything, and a window that is not complete BLOCKS the detector
 *    rather than shortening it. A slope drawn across a missing day measures the
 *    missing day. Blocked detectors are reported by name — a silent detector
 *    and a quiet department look identical, and only one of them is good news.
 *
 * 4. **THRESHOLDS ARE SET ONCE, HERE, BEFORE ANY BACK-TEST.** They are not to
 *    be moved because a detector scored badly. A threshold tuned until the
 *    history looks good is not a threshold, it is a curve fitted to five
 *    incidents. A detector that cannot earn its place at these numbers gets
 *    reported honestly and left disabled.
 *
 * 5. **DEVELOPMENT-OWNED WORK IS NAMED AS SUCH.** Detector D exists precisely
 *    because the Dev queue growing is Nick's EXPOSURE and not his failure, and
 *    a tool that cannot tell the difference will read as blame on the screen he
 *    checks daily.
 */

const TENSE = 'could';

// ── Thresholds ───────────────────────────────────────────────────────────────
//
// Fixed before the first back-test was run. See rule 4.

/**
 * Standard deviations from a four-week baseline before a change counts.
 *
 * 2.0 because that is roughly one week in twenty on a normal distribution, and
 * this tool ships at most five cards: a bar that fires weekly produces the alert
 * spam it exists to avoid, and a man whose difficulty is initiation will stop
 * opening a screen that always has five red things on it.
 */
const Z_FIRE = 2;

/** Whole weeks in the baseline. FOUR, because the desk's volume is strongly
 *  weekly and a three-week baseline carries a day-of-week bias. */
const BASELINE_WEEKS = 4;
/** Days in a bucket. Not a preference — it is what cancels the weekly cycle. */
const WEEK = 7;
/** Baseline plus the current week. Matches the validator's 35-day bar. */
const REQUIRED_DAYS = (BASELINE_WEEKS + 1) * WEEK;

/**
 * Age gained per calendar day before the tail counts as untouched.
 *
 * NOT a tuned number. The oldest actionable ticket in a queue ages at EXACTLY
 * 1.0 days per day when nothing leaves the tail, and drops when it is worked.
 * 0.9 allows for the one day in ten where a slightly newer ticket takes over as
 * oldest. Anything at or above it means the bottom of the queue is frozen.
 */
const AGE_SLOPE_FROZEN = 0.9;

/** Share of the roster off before a day counts as thin. A quarter of the team. */
const THIN_TEAM_SHARE = 0.25;

/** Working days ahead that detector E looks. Matches the 1-5 day warning brief. */
const LOOKAHEAD_WORKING_DAYS = 5;

/** Below this, the evidence is too poor to claim anything and nothing fires. */
const MIN_CONFIDENCE = 0.4;

const DAY_MS = 86_400_000;

// ── Small pure helpers ───────────────────────────────────────────────────────

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const between = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Z-score against a baseline.
 *
 * Returns null when the baseline does not vary at all. A zero standard
 * deviation makes every deviation infinitely significant, which is how a
 * perfectly stable number becomes a five-alarm fire the first time it moves by
 * one.
 */
function zScore(value, baseline) {
  const sd = stdev(baseline);
  if (sd === null || sd === 0) return null;
  return (value - mean(baseline)) / sd;
}

const round = (n, dp = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Day → value, for the days that HAVE a value. Days without one are absent. */
function byDay(series) {
  const m = new Map();
  for (const p of series?.points || []) m.set(p.day, p.value);
  return m;
}

/**
 * Consecutive 7-day buckets ending on `asOf`, newest first.
 *
 * A bucket is `complete` only when all seven days carry a value. An incomplete
 * bucket is returned rather than dropped, so a caller can say WHICH week was
 * short instead of quietly computing over six days.
 */
function weekBuckets(map, asOf, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const to = addDays(asOf, -i * WEEK);
    const from = addDays(to, -(WEEK - 1));
    const values = [];
    let missing = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = map.get(d);
      if (v === undefined) missing += 1; else values.push(v);
    }
    out.push({
      from, to, values, missing,
      complete: missing === 0,
      sum: values.reduce((a, b) => a + b, 0),
      mean: mean(values),
    });
  }
  return out;
}

// ── Coverage and confidence ──────────────────────────────────────────────────

/**
 * Can these series support a claim at all, and how much of one?
 *
 * Returns `{ ok, reason }` when the answer is no. A detector must call this
 * BEFORE it computes anything — the point is to refuse, not to compute and
 * caveat. A caveat on a number is read as a number.
 */
function windowUsable(seriesList, asOf) {
  for (const s of seriesList) {
    if (!s) return { ok: false, reason: 'a required KPI is not in the feed at all' };
    const map = byDay(s);
    let missing = 0;
    for (let i = 0; i < REQUIRED_DAYS; i += 1) {
      if (!map.has(addDays(asOf, -i))) missing += 1;
    }
    if (missing) {
      return {
        ok: false,
        reason: `${s.key} is missing ${missing} of the last ${REQUIRED_DAYS} days — a baseline drawn across a hole measures the hole`,
      };
    }
  }
  return { ok: true, reason: null };
}

/**
 * How much to believe it, and why.
 *
 * Deductions, never a bare number: the `basis` lines are rendered, because a
 * confidence score with the working hidden is a number the reader has to take
 * on trust, and the one thing this tool cannot ask for is trust.
 */
function confidence(seriesList, asOf, extra = []) {
  let score = 1;
  const basis = [];

  for (const s of seriesList) {
    const c = s.coverage || {};
    if (c.staleDays !== null && c.staleDays !== undefined && c.staleDays > 1) {
      score -= 0.25;
      basis.push(`${s.key} last carried a value ${c.staleDays} days ago`);
    }
    if (c.expectedDays && c.daysWithValue / c.expectedDays < 0.95) {
      score -= 0.15;
      basis.push(`${s.key} has ${c.daysWithValue} of ${c.expectedDays} days in the wider window`);
    }
    // A capture-method change inside the window being measured. The boundary
    // looked smooth on the stocks when it was checked on 16 Sep 2026, and
    // "looked smooth on the ones I checked" is not "is smooth".
    const breaks = (s.sourceBreaks || []).filter(b => between(b.day, asOf) <= REQUIRED_DAYS);
    if (breaks.length) {
      score -= 0.2;
      basis.push(`${s.key} changes capture method on ${breaks.map(b => b.day).join(', ')} (${breaks[0].from} → ${breaks[0].to}) inside the measured window`);
    }
  }

  for (const e of extra) {
    score -= e.cost;
    basis.push(e.why);
  }

  score = Math.max(0, Math.min(1, round(score, 2)));
  return {
    score,
    level: score >= 0.8 ? 'high' : score >= 0.55 ? 'medium' : 'low',
    // Stated explicitly when nothing was deducted, rather than left blank —
    // an empty basis reads as "no reasoning" rather than "nothing wrong".
    basis: basis.length ? basis : ['every series is complete, current and captured by one method throughout'],
  };
}

/**
 * How a detector's claim has actually been tested.
 *
 * Carried ON THE CARD, not held in a document nobody opens. A detector with
 * eleven days of measured median lead and one that has never been scored
 * against anything are both "an indicator on the radar" unless the card itself
 * says which it is — and the second one, presented as the first, is precisely
 * the manufactured certainty this feature was told not to produce.
 */
const VALIDATED = {
  status: 'validated',
  label: 'Historically validated',
  detail: 'Replayed over 285 days against sustained RISE EPISODES — a stock climbing its whole green-to-red span inside a fortnight. '
    + '6 of 19 rise episodes warned with a MEDIAN LEAD OF 12 DAYS, 3 fired on the day itself and scored zero, 1 false positive. '
    + 'On the narrower set of 6 genuinely rising RAG crossings from the original V1 measurement it warned on 3, median lead 7 days.',
  // ⚠ SUPERSEDED MEASUREMENT, carried rather than deleted.
  //
  // V1 reported "9 warnings, 0 coincident, 3 false positives, median lead 11
  // days" against RAG CROSSINGS. That label was largely noise: `nt_production`
  // is above its red line 69% of the time and `nt_incidents` 65%, so most
  // "crossings" are the series dipping under the line and coming back rather
  // than a problem arriving — and several happened while the stock was FALLING
  // (2026-08-11: Production at 83 on a 14-day slope of -3.3, then red). Only 6
  // of the 19 were preceded by a sustained rise.
  //
  // THE DETECTOR IS NOT WITHDRAWN and its performance did not get worse: against
  // a sound label it still warns on 9 of 19 with the same median lead. What
  // changed is what the eleven days is EVIDENCE OF — the original figure
  // averaged real warnings together with coin-flips. A number like that, in a
  // document Nick's manager may read, gets corrected in the open with the old
  // one still visible, rather than quietly restated.
  supersedes: {
    measuredOn: '2026-09-16',
    correctedOn: '2026-09-17',
    label: 'RAG crossings — a stock KPI red for 3+ consecutive days',
    result: '9 warnings, 0 coincident, 3 false positives, median lead 11 days',
    why: 'the stock KPIs are already red most of the time, so two thirds of the crossings were threshold chatter and some occurred while the stock was falling',
  },
  autoActionable: true,
};

const UNVALIDATED_ADVISORY = {
  status: 'unvalidated-advisory',
  label: 'ADVISORY — never back-tested',
  detail: 'This has NOT been validated against history and is not a predictor. '
    + 'Availability is stored forward-looking and overwritten, so there is no record of who was off on a past day and nothing to replay against. '
    + 'It is a lookup — the rota against the arrival pattern — offered for your judgement, not a measured forecast. '
    + 'Its live fires are being recorded so it can be scored prospectively later.',
  // The machine-readable half of the same statement. Read by `auto-push`.
  autoActionable: false,
};

function indicator(fields) {
  return {
    tense: TENSE,
    source: 'Leading',
    // ADVISORY BY DEFAULT. A detector has to claim validation explicitly, and
    // the default falls the safe way: a new detector whose author forgets to
    // say anything is treated as untested, because it IS untested. The reverse
    // default would mean every future detector arrived silently carrying A's
    // credibility.
    validation: UNVALIDATED_ADVISORY,
    ...fields,
  };
}

// ── Detector A — net flow divergence ─────────────────────────────────────────

/**
 * Are more tickets arriving than leaving, unusually so?
 *
 * The level is on every wallboard. The DERIVATIVE is not: a backlog that is
 * high and steady needs a plan, a backlog that started outrunning throughput
 * eight days ago needs a conversation this week, and only the comparison
 * distinguishes them.
 *
 * Net, not arrivals. A busy week the team kept up with is not a warning.
 */
function detectNetFlow({ series, asOf }) {
  const need = [series.nt_new_tickets, series.nt_solved_team, series.nt_solved_nova];
  const usable = windowUsable(need, asOf);
  if (!usable.ok) return { blocked: { id: 'A', name: 'Net flow divergence', reason: usable.reason } };

  const arrivals = byDay(series.nt_new_tickets);
  const team = byDay(series.nt_solved_team);
  const nova = byDay(series.nt_solved_nova);

  const net = new Map();
  for (const [day, v] of arrivals) {
    if (team.has(day) && nova.has(day)) net.set(day, v - team.get(day) - nova.get(day));
  }

  const buckets = weekBuckets(net, asOf, BASELINE_WEEKS + 1);
  if (!buckets.every(b => b.complete)) {
    return { blocked: { id: 'A', name: 'Net flow divergence', reason: 'one of the five weeks is incomplete once all three series are intersected' } };
  }

  const currentWeek = buckets[0];
  const baseline = buckets.slice(1).map(b => b.sum);
  const z = zScore(currentWeek.sum, baseline);

  // Only a backlog that is GROWING. An unusually good week is not a warning,
  // and a detector that fires on both is a detector nobody reads.
  if (z === null || z < Z_FIRE || currentWeek.sum <= 0) return { quiet: 'A' };

  const conf = confidence(need, asOf);
  if (conf.score < MIN_CONFIDENCE) return { blocked: { id: 'A', name: 'Net flow divergence', reason: `confidence ${conf.score} is below the floor` } };

  const perDay = currentWeek.sum / WEEK;
  return {
    indicator: indicator({
      key: 'net-flow',
      detector: 'A',
      // A claims the department's queues generally rather than one of them, so
      // any stock rise episode inside the window settles it.
      subject: null,
      // The ONLY detector that has earned this. See the replay result in
      // `DISABLED_BY_DEFAULT` above.
      validation: VALIDATED,
      severity: currentWeek.sum > 50 ? 'high' : 'medium',
      title: `The queue took on ${currentWeek.sum} more tickets than it cleared this week`,
      change: `Net arrivals ran ${round(z)} standard deviations above the previous four weeks — ${currentWeek.sum} this week against a four-week average of ${round(mean(baseline))}.`,
      whyItMatters: 'Arrivals outrunning throughput is the only way a backlog grows, and it shows up in net flow one to two weeks before it shows up as an ageing queue or a missed SLA. At this rate the open stock takes on about '
        + `${Math.round(perDay * 5)} tickets over the next five working days.`,
      evidence: [
        { label: 'This week (net)', value: currentWeek.sum },
        { label: 'Previous four weeks (net)', value: baseline.join(', ') },
        { label: 'Arrivals this week', value: weekBuckets(arrivals, asOf, 1)[0].sum },
        { label: 'Cleared this week (team + NOVA)', value: weekBuckets(team, asOf, 1)[0].sum + weekBuckets(nova, asOf, 1)[0].sum },
      ],
      horizonDays: 5,
      confidence: conf,
      confirm: 'Next week\'s net stays positive, and the tier stock counts (`Number of Tickets in ...`) rise by roughly the same amount.',
      disprove: 'Arrivals are up but cleared is up with them, or the week contained a known one-off — a bulk import, an incident spawning many tickets, a release. Check the arrival mix before acting.',
      action: 'Pull this week\'s arrivals by request type and compare against last month\'s mix. If one type is doing it, that is a routing or a product conversation; if it is across the board, it is a resourcing one.',
    }),
  };
}

// ── Detector B — ageing acceleration ─────────────────────────────────────────

const AGE_TIERS = [
  { key: 'nt_oldest_incident', name: 'Incidents' },
  { key: 'nt_oldest_production', name: 'Production' },
  { key: 'nt_oldest_development', name: 'Development' },
];

/**
 * Is the bottom of a queue frozen?
 *
 * The oldest actionable ticket ages at exactly one day per day when nothing
 * leaves the tail, and drops the moment one is cleared. So a sustained slope at
 * or near 1.0 is not a statistical claim at all — it is arithmetic proof that
 * nobody has touched the oldest work in a week.
 *
 * That is worth saying precisely because it is invisible: the queue COUNT can
 * fall all week while the tail never moves, and every level-based measure will
 * report improvement.
 */
function detectAgeing({ series, asOf }) {
  const out = [];
  const blocked = [];

  for (const tier of AGE_TIERS) {
    const s = series[tier.key];
    const usable = windowUsable([s], asOf);
    if (!usable.ok) {
      blocked.push({ id: `B:${tier.name}`, name: `Ageing acceleration (${tier.name})`, reason: usable.reason });
      continue;
    }

    const map = byDay(s);
    const today = map.get(asOf);
    const weekAgo = map.get(addDays(asOf, -WEEK));
    if (today === undefined || weekAgo === undefined) {
      blocked.push({ id: `B:${tier.name}`, name: `Ageing acceleration (${tier.name})`, reason: 'the endpoints of the seven-day slope are not both present' });
      continue;
    }

    const slope = (today - weekAgo) / WEEK;

    // A young queue ageing at 1.0 is a queue where the oldest ticket happens to
    // be the one nobody needed yet. The tail only matters when it is also long
    // by this queue's own standards.
    const baselineDays = [];
    for (let i = WEEK; i < REQUIRED_DAYS; i += 1) {
      const v = map.get(addDays(asOf, -i));
      if (v !== undefined) baselineDays.push(v);
    }
    const typical = median(baselineDays);

    if (slope < AGE_SLOPE_FROZEN || typical === null || today <= typical) continue;

    const conf = confidence([s], asOf);
    if (conf.score < MIN_CONFIDENCE) {
      blocked.push({ id: `B:${tier.name}`, name: `Ageing acceleration (${tier.name})`, reason: `confidence ${conf.score} is below the floor` });
      continue;
    }

    out.push(indicator({
      key: `ageing:${tier.name.toLowerCase()}`,
      detector: 'B',
      severity: slope >= 0.99 ? 'high' : 'medium',
      title: `Nothing has left the bottom of the ${tier.name} queue for a week`,
      change: `The oldest actionable ${tier.name} ticket has aged ${round(today - weekAgo)} days in the last ${WEEK} — a slope of ${round(slope, 2)} days per day. It reached ${today} days, against a four-week typical of ${round(typical)}.`,
      whyItMatters: 'The oldest ticket ages at exactly one day per day when nothing is cleared from the tail, and drops as soon as one is. A slope this close to 1.0 is arithmetic, not a trend: the oldest work has not been touched. The queue count can fall all week while this happens, so every level-based measure will show improvement.',
      evidence: [
        { label: `Oldest ${tier.name} ticket today`, value: `${today} days` },
        { label: 'Seven days ago', value: `${weekAgo} days` },
        { label: 'Four-week typical', value: `${round(typical)} days` },
        { label: 'Slope', value: `${round(slope, 2)} days per day (1.0 = untouched)` },
      ],
      horizonDays: 7,
      confidence: conf,
      confirm: 'Look up the oldest actionable ticket in that queue and check its last update date. If it matches the slope, nobody has been near it.',
      disprove: 'The oldest ticket is legitimately blocked but still counted as actionable — waiting on a customer, or on a third party — in which case the status is wrong rather than the work. That is a different fix and worth knowing either way.',
      action: `Open the oldest three actionable ${tier.name} tickets and give each one a named owner and a next date today. This does not need a review; it needs three decisions.`,
    }));
  }

  return { indicators: out, blocked };
}

// ── Detector C — escalation quality shift ────────────────────────────────────

/**
 * Is work coming BACK more often, as a share of what goes up?
 *
 * The rate, not the count. More rejections during a busy week is workload;
 * more rejections per escalation is a change in what is being sent or in what
 * is being accepted — and those need opposite conversations. Both numbers are
 * reported so the reader can see which one moved.
 */
function detectEscalationQuality({ series, asOf }) {
  const need = [series.nt_escalated, series.nt_rejected];
  const usable = windowUsable(need, asOf);
  if (!usable.ok) return { blocked: { id: 'C', name: 'Escalation quality shift', reason: usable.reason } };

  const esc = weekBuckets(byDay(series.nt_escalated), asOf, BASELINE_WEEKS + 1);
  const rej = weekBuckets(byDay(series.nt_rejected), asOf, BASELINE_WEEKS + 1);
  if (!esc.every(b => b.complete) || !rej.every(b => b.complete)) {
    return { blocked: { id: 'C', name: 'Escalation quality shift', reason: 'one of the five weeks is incomplete' } };
  }
  // A week where nothing was escalated has no rejection RATE — dividing by it
  // would manufacture an infinity and then fire on it.
  if (esc.some(b => b.sum === 0)) {
    return { blocked: { id: 'C', name: 'Escalation quality shift', reason: 'a week with zero escalations has no rejection rate to measure' } };
  }

  const rates = esc.map((b, i) => rej[i].sum / b.sum);
  const z = zScore(rates[0], rates.slice(1));
  if (z === null || z < Z_FIRE || rates[0] <= mean(rates.slice(1))) return { quiet: 'C' };

  const volumeZ = zScore(esc[0].sum, esc.slice(1).map(b => b.sum));
  const conf = confidence(need, asOf);
  if (conf.score < MIN_CONFIDENCE) return { blocked: { id: 'C', name: 'Escalation quality shift', reason: `confidence ${conf.score} is below the floor` } };

  return {
    indicator: indicator({
      key: 'escalation-quality',
      detector: 'C',
      severity: 'medium',
      title: `${Math.round(rates[0] * 100)}% of escalations came back this week, against ${Math.round(mean(rates.slice(1)) * 100)}% normally`,
      change: `The rejection RATE is ${round(z)} standard deviations above the four-week baseline. Escalation volume is ${volumeZ === null ? 'unchanged in a way that can be scored' : `${round(volumeZ)} standard deviations from normal`} — so this is a change in what is being sent or accepted, not simply a busier week.`,
      whyItMatters: 'A rising rejection rate means either the escalating side is sending less complete work or the receiving side has raised the bar. Those need opposite conversations, and the rate is what tells them apart — the raw count cannot, because it moves with volume.',
      evidence: [
        { label: 'Escalated this week', value: esc[0].sum },
        { label: 'Rejected this week', value: rej[0].sum },
        { label: 'Rejection rate, this week', value: `${Math.round(rates[0] * 100)}%` },
        { label: 'Rejection rate, previous four weeks', value: rates.slice(1).map(r => `${Math.round(r * 100)}%`).join(', ') },
      ],
      horizonDays: 7,
      confidence: conf,
      confirm: 'Read five of this week\'s returned tickets. If they share a missing field or a missing step, it is the escalating side; if they look complete, it is the receiving side.',
      disprove: 'One ticket bounced repeatedly and accounts for most of the rise — check the rejection count against the number of DISTINCT tickets before treating it as a pattern.',
      action: 'Pull the five most recent returned tickets and read the rejection reasons. That sample decides which of the two conversations to have, and it takes ten minutes.',
    }),
  };
}

// ── Detector D — Development-owned drift ─────────────────────────────────────

/**
 * Is Development-owned work growing while the desk's own is not?
 *
 * ⚠ THIS IS NOT A FINDING ABOUT NICK, and the wording is deliberate throughout.
 * Work sitting with Development is not work he is failing to do; it is exposure
 * he carries and cannot clear himself. The reason it is worth a card at all is
 * that it is invisible in a total — an open-ticket count that is flat can hide
 * a Dev queue that has doubled, and the customer waiting does not care which
 * queue it is in.
 *
 * The divergence is the signal. Both queues growing is a busy month; Dev
 * growing while Customer Care is flat means work is moving across and not
 * coming back.
 */
function detectDevDrift({ series, asOf }) {
  const need = [series.nt_development, series.nt_oldest_development, series.nt_incidents, series.nt_production];
  const usable = windowUsable(need, asOf);
  if (!usable.ok) return { blocked: { id: 'D', name: 'Dev-owned drift', reason: usable.reason } };

  const dev = byDay(series.nt_development);
  const devAge = byDay(series.nt_oldest_development);
  const inc = byDay(series.nt_incidents);
  const prod = byDay(series.nt_production);

  // Rolling 14-day changes across the whole window give a distribution to score
  // this fortnight against — so the bar is "unusual for this queue" rather than
  // a percentage somebody picked.
  const changes = (map, span) => {
    const out = [];
    for (let i = 0; i + span < REQUIRED_DAYS + 2 * span; i += 1) {
      const to = addDays(asOf, -i);
      const from = addDays(to, -span);
      if (map.has(to) && map.has(from)) out.push(map.get(to) - map.get(from));
    }
    return out;
  };

  const SPAN = 14;
  const devChanges = changes(dev, SPAN);
  const ccMap = new Map();
  for (const [day, v] of inc) if (prod.has(day)) ccMap.set(day, v + prod.get(day));
  const ccChanges = changes(ccMap, SPAN);

  if (devChanges.length < 10 || ccChanges.length < 10) {
    return { blocked: { id: 'D', name: 'Dev-owned drift', reason: 'not enough overlapping days to score a fortnight against its own history' } };
  }

  const devNow = devChanges[0];
  const ccNow = ccChanges[0];
  const devZ = zScore(devNow, devChanges.slice(1));
  const ccZ = zScore(ccNow, ccChanges.slice(1));

  const ageNow = devAge.get(asOf);
  const ageThen = devAge.get(addDays(asOf, -SPAN));
  const ageRising = ageNow !== undefined && ageThen !== undefined && ageNow > ageThen;

  // All three conditions. Dev unusually up, its tail ageing with it, and the
  // desk's own queues NOT doing the same — without the third, this is just a
  // busy fortnight everywhere.
  if (devZ === null || devZ < Z_FIRE || !ageRising || (ccZ !== null && ccZ >= Z_FIRE)) return { quiet: 'D' };

  const conf = confidence(need, asOf);
  if (conf.score < MIN_CONFIDENCE) return { blocked: { id: 'D', name: 'Dev-owned drift', reason: `confidence ${conf.score} is below the floor` } };

  return {
    indicator: indicator({
      key: 'dev-drift',
      detector: 'D',
      severity: 'medium',
      title: `Development-held work grew by ${devNow} in a fortnight while Customer Care stayed flat`,
      change: `The Development queue moved ${devNow > 0 ? '+' : ''}${devNow} over ${SPAN} days (${round(devZ)} standard deviations from its own normal fortnight), its oldest ticket aged from ${ageThen} to ${ageNow} days, and Incidents plus Production moved ${ccNow > 0 ? '+' : ''}${ccNow} over the same period.`,
      whyItMatters: 'This is not work you can clear and it is not a failure of the desk — it is exposure you carry. It matters because it is invisible in a total: an open-ticket count that looks flat can hide a Development queue that has grown steadily, and the customer waiting does not care which queue their ticket is in. It becomes visible later as an SLA or a complaint, by which point the conversation is retrospective.',
      evidence: [
        { label: 'Development queue now', value: dev.get(asOf) },
        { label: `Development queue ${SPAN} days ago`, value: dev.get(addDays(asOf, -SPAN)) },
        { label: 'Oldest Development ticket', value: `${ageThen} → ${ageNow} days` },
        { label: 'Incidents + Production, same fortnight', value: `${ccNow > 0 ? '+' : ''}${ccNow}` },
        { label: 'Typical Development fortnight', value: `${round(mean(devChanges.slice(1)))} (sd ${round(stdev(devChanges.slice(1)))})` },
      ],
      horizonDays: 10,
      confidence: conf,
      confirm: 'Check whether escalations into Development are up over the same fortnight (`Tickets escalated to Development`). If they are, the growth is inflow; if they are not, it is Development\'s throughput.',
      disprove: 'A known release or a single large project moved a batch across deliberately. One transfer is not a drift — check whether the growth is spread across days or lands on one.',
      action: 'This is the one to raise rather than fix. Take the fortnight\'s numbers to your next conversation with Development, and put the figure on the weekly report so it is on the record before it becomes an SLA question.',
    }),
  };
}

// ── Detector E — capacity collision ──────────────────────────────────────────

const isWorkingDay = day => {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};

/**
 * A thin day landing on a normally busy one.
 *
 * Forward-looking, and the only detector that is. Leave is known in advance and
 * arrival volume is strongly day-of-week, so a collision between the two is
 * visible days out and is genuinely preventable — which is the tense the radar
 * has always been weakest in.
 *
 * ⚠ Two things are structurally missing, both of which understate the risk:
 * People HR returns APPROVED leave only, so a booking awaiting a manager is
 * absent; and a roster member with no People HR id never syncs and so always
 * looks available. Both lower confidence and both are said out loud — "nobody
 * is off" is a floor here, never a clear.
 */
function detectCapacityCollision({ series, capacity, asOf }) {
  if (!capacity?.available) {
    return { blocked: { id: 'E', name: 'Capacity collision', reason: capacity?.reason || 'availability was not read' } };
  }
  const usable = windowUsable([series.nt_new_tickets], asOf);
  if (!usable.ok) return { blocked: { id: 'E', name: 'Capacity collision', reason: usable.reason } };

  const arrivals = byDay(series.nt_new_tickets);

  // Typical arrivals for each weekday, from the last four weeks. Four, so each
  // weekday contributes exactly four samples and no day is better represented.
  const byWeekday = new Map();
  for (let i = 1; i <= BASELINE_WEEKS * WEEK; i += 1) {
    const day = addDays(asOf, -i);
    const v = arrivals.get(day);
    if (v === undefined) continue;
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    const list = byWeekday.get(wd);
    if (list) list.push(v); else byWeekday.set(wd, [v]);
  }
  const workingMedians = [...byWeekday.entries()].filter(([wd]) => wd >= 1 && wd <= 5).map(([, v]) => median(v));
  const overallBusy = median(workingMedians);

  const absencesByDay = new Map();
  for (const a of capacity.absences || []) {
    absencesByDay.set(a.date, (absencesByDay.get(a.date) || 0) + 1);
  }

  const ahead = [];
  for (let i = 1; ahead.length < LOOKAHEAD_WORKING_DAYS && i <= 21; i += 1) {
    const day = addDays(asOf, i);
    if (!isWorkingDay(day)) continue;
    const off = absencesByDay.get(day) || 0;
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    ahead.push({
      day,
      off,
      share: off / capacity.rosterCount,
      expected: median(byWeekday.get(wd) || []),
    });
  }

  const worst = ahead
    .filter(d => d.share >= THIN_TEAM_SHARE && d.expected !== null && overallBusy !== null && d.expected >= overallBusy)
    .sort((a, b) => b.share - a.share)[0];

  if (!worst) return { quiet: 'E' };

  const conf = confidence([series.nt_new_tickets], asOf, [
    { cost: 0.1, why: 'People HR returns APPROVED leave only, so a booking still awaiting a manager is not counted — the number off is a floor' },
    ...(capacity.unsyncable?.length
      ? [{ cost: 0.15, why: `${capacity.unsyncable.length} roster member(s) have no People HR id and never sync, so they always look available: ${capacity.unsyncable.join(', ')}` }]
      : []),
  ]);
  if (conf.score < MIN_CONFIDENCE) return { blocked: { id: 'E', name: 'Capacity collision', reason: `confidence ${conf.score} is below the floor` } };

  return {
    indicator: indicator({
      key: `capacity:${worst.day}`,
      detector: 'E',
      // No stock episode can confirm or refute a rota claim, so this is never
      // auto-labelled. It waits for a human verdict — which is also the only
      // honest way to score a warning whose success looks like nothing
      // happening.
      settledBy: 'human',
      severity: worst.share >= 0.4 ? 'high' : 'medium',
      title: `${worst.off} of ${capacity.rosterCount} are off on ${worst.day}, normally one of the busier days`,
      change: `${Math.round(worst.share * 100)}% of the roster is booked off on ${worst.day}, which typically takes ${worst.expected} new tickets — at or above the working-day median of ${overallBusy}.`,
      whyItMatters: 'Leave is known days ahead and arrival volume is strongly day-of-week, so this is one of the few things on this screen that can actually be prevented rather than absorbed. A thin day on a quiet Friday is nothing; a thin day on a normal Tuesday is a backlog on Wednesday.',
      evidence: [
        { label: 'Day', value: worst.day },
        { label: 'Off / roster', value: `${worst.off} / ${capacity.rosterCount}` },
        { label: 'Typical arrivals that weekday', value: worst.expected },
        { label: 'Working-day median', value: overallBusy },
        { label: 'Next five working days', value: ahead.map(d => `${d.day.slice(5)}: ${d.off} off, ~${d.expected ?? '?'} in`).join('; ') },
        // Stated as EVIDENCE rather than buried in metadata, because it is a
        // fact about how much this card is worth and belongs next to the
        // numbers it qualifies.
        { label: 'Status', value: 'ADVISORY — never back-tested, needs your judgement before it becomes an action' },
      ],
      // The checkable claim, kept so this detector can be scored PROSPECTIVELY
      // — which is the only way it will ever be scored, there being no history
      // to replay. Recorded on the day of the fire, about a day still in the
      // future, so what it said cannot be revised after the fact.
      prospective: {
        forDay: worst.day,
        predictedOff: worst.off,
        rosterCount: capacity.rosterCount,
        expectedArrivals: worst.expected,
        workingDayMedian: overallBusy,
        // What would have to be read back from kpi_org_daily on the day, to
        // decide whether this was worth saying. Named here so a later scorer
        // uses the measure the claim was made against, not one chosen with
        // hindsight to suit the answer.
        scoreAgainst: ['nt_new_tickets', 'nt_solved_team', 'nt_solved_nova'],
      },
      horizonDays: Math.max(1, between(asOf, worst.day)),
      confidence: conf,
      confirm: 'Check the same day in NOVA\'s Team Availability. If more names appear there than here, the extra leave was approved after this read or set manually.',
      disprove: 'The people off are not the ones who take the front line that day, or cover is already arranged and simply not recorded anywhere this can see.',
      action: `Decide cover for ${worst.day} now, while it is still a choice — who picks up first line, and whether anything scheduled for that day can move. It takes one message today and cannot be done retrospectively.`,
    }),
  };
}


// ── SHADOW: the independent-family composite (S1) ────────────────────────────

/**
 * Four EVIDENCE FAMILIES that are not derived from one another.
 *
 * ⚠ This constraint is the whole reason the discovery-era composite was thrown
 * away. That one corroborated net flow with the three stock KPIs — and stock is
 * the INTEGRAL of net flow. Of course they agreed: it was one fact counted four
 * times, dressed up as four weak signals converging. On its firing days it was
 * typically net flow at z = 1.79-1.97 — detector A at a lower bar wearing a
 * composite's clothes — and against rise episodes it underperformed A outright.
 *
 * So a family here has to be able to move while the others do not:
 *
 *   FLOW        net arrivals against throughput. What A already watches.
 *   OWNERSHIP   unassigned work. A queue can grow with everything owned, or
 *               shrink while nothing is. Not derivable from flow.
 *   REJECTION   the share of escalations coming back. A behaviour of two tiers,
 *               independent of how much work arrives.
 *   CAPACITY    leave booked in the next working week. Exogenous — caused by
 *               holidays, not by the queue.
 *
 * Stocks are DELIBERATELY ABSENT from the corroboration set. They are the thing
 * being predicted, and using them as evidence for their own future is how the
 * last attempt fooled itself.
 *
 * ── Shadow mode ─────────────────────────────────────────────────────────────
 *
 * NO card, NO finding, NO NEURO action. It runs, it is recorded in the ledger,
 * and it earns promotion on PROSPECTIVE evidence only. The holdout that would
 * have validated it historically has been consumed — it was looked at during
 * discovery — so any back-test of it now would be a curve fitted to history
 * already seen. Saying so is cheaper than pretending otherwise and being caught
 * by the live numbers later.
 */
const SHADOW_FAMILY_Z = 1.0;
const SHADOW_FAMILIES_TO_FIRE = 2;
const SHADOW_MIN_FAMILIES_AVAILABLE = 3;

function familyFlow(series, asOf) {
  const arrivals = byDay(series.nt_new_tickets);
  const team = byDay(series.nt_solved_team);
  const nova = byDay(series.nt_solved_nova);
  const net = new Map();
  for (const [day, v] of arrivals) {
    if (team.has(day) && nova.has(day)) net.set(day, v - team.get(day) - nova.get(day));
  }
  const b = weekBuckets(net, asOf, BASELINE_WEEKS + 1);
  if (!b.every(x => x.complete)) return null;
  const zz = zScore(b[0].sum, b.slice(1).map(x => x.sum));
  if (zz === null) return null;
  return { name: 'flow', z: round(zz, 2), detail: `net ${b[0].sum} this week against a four-week mean of ${round(mean(b.slice(1).map(x => x.sum)))}` };
}

function familyOwnership(series, asOf) {
  const s = series.nt_legacy_unassigned;
  if (!s) return null;
  const b = weekBuckets(byDay(s), asOf, BASELINE_WEEKS + 1);
  if (!b.every(x => x.complete)) return null;
  const zz = zScore(b[0].mean, b.slice(1).map(x => x.mean));
  if (zz === null) return null;
  return { name: 'ownership', z: round(zz, 2), detail: `${round(b[0].mean)} unassigned on average this week against ${round(mean(b.slice(1).map(x => x.mean)))}` };
}

function familyRejection(series, asOf) {
  const esc = weekBuckets(byDay(series.nt_escalated), asOf, BASELINE_WEEKS + 1);
  const rej = weekBuckets(byDay(series.nt_rejected), asOf, BASELINE_WEEKS + 1);
  if (!esc.every(x => x.complete) || !rej.every(x => x.complete)) return null;
  // A week with nothing escalated has no rate. Measured live: nt_rejected is 0
  // on 29 of the last 30 days, so this family is weekly or it is nothing.
  if (esc.some(x => x.sum === 0)) return null;
  const rates = esc.map((x, i) => rej[i].sum / x.sum);
  const zz = zScore(rates[0], rates.slice(1));
  if (zz === null) return null;
  return { name: 'rejection', z: round(zz, 2), detail: `${Math.round(rates[0] * 100)}% of escalations returned this week against ${Math.round(mean(rates.slice(1)) * 100)}% normally` };
}

function familyCapacity(capacity, asOf) {
  if (!capacity?.available || !capacity.rosterCount) return null;
  const off = new Map();
  for (const a of capacity.absences || []) off.set(a.date, (off.get(a.date) || 0) + 1);
  let worst = 0;
  let worstDay = null;
  for (let i = 1; i <= 7; i += 1) {
    const day = addDays(asOf, i);
    if (!isWorkingDay(day)) continue;
    const share = (off.get(day) || 0) / capacity.rosterCount;
    if (share > worst) { worst = share; worstDay = day; }
  }
  // Put on the same scale as the others so families can be compared: a quarter
  // of the roster off is one unit of concern.
  return {
    name: 'capacity',
    z: round(worst / THIN_TEAM_SHARE, 2),
    detail: worstDay ? `${Math.round(worst * 100)}% of the roster off on ${worstDay}` : 'nobody booked off in the next working week',
  };
}

function detectShadowComposite({ series, capacity, asOf }) {
  const fams = [
    familyFlow(series, asOf),
    familyOwnership(series, asOf),
    familyRejection(series, asOf),
    familyCapacity(capacity, asOf),
  ];
  const available = fams.filter(Boolean);
  if (available.length < SHADOW_MIN_FAMILIES_AVAILABLE) {
    return {
      blocked: {
        id: 'S1', name: 'Independent-family composite (shadow)', shadow: true,
        reason: `only ${available.length} of 4 evidence families could be computed; ${SHADOW_MIN_FAMILIES_AVAILABLE} are required`,
      },
    };
  }
  const elevated = available.filter(f => f.z >= SHADOW_FAMILY_Z);
  if (elevated.length < SHADOW_FAMILIES_TO_FIRE) return { quiet: 'S1' };

  return {
    indicator: indicator({
      key: `shadow-composite:${elevated.map(f => f.name).sort().join('+')}`,
      detector: 'S1',
      shadow: true,
      severity: 'medium',
      title: `${elevated.length} independent signals are elevated together`,
      change: `${elevated.map(f => `${f.name} z=${f.z}`).join(', ')}.`,
      whyItMatters: 'Each of these alone is below the bar any single detector fires at. They come from families that do not derive from one another — flow, ownership, escalation behaviour and booked capacity — so agreement between them is not one fact counted several times, which is exactly how the first composite fooled itself.',
      evidence: available.map(f => ({ label: f.name, value: `z=${f.z} — ${f.detail}` })),
      horizonDays: 10,
      confidence: confidence([series.nt_new_tickets].filter(Boolean), asOf),
      confirm: 'A stock KPI subsequently rises its whole green-to-red span inside a fortnight. The ledger records that automatically.',
      disprove: 'The families move apart again within the week, or one turns out to be a one-off — a bulk import, or a single bounced ticket inflating the rejection rate.',
      action: 'Nothing. This is in SHADOW and produces no card; it is accumulating a prospective record so it can be judged on live evidence rather than on history already looked at.',
    }),
  };
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Shadow detectors. Run every pass, recorded in the ledger, NEVER rendered.
 *
 * Kept in their own list rather than flagged inside `DETECTORS`, so the one
 * thing that must not happen — a shadow reaching the radar — is prevented by
 * the shape of the code rather than by a filter somebody could later forget.
 */
const SHADOW_DETECTORS = [
  { id: 'S1', name: 'Independent-family composite', run: detectShadowComposite },
];

const DETECTORS = [
  { id: 'A', name: 'Net flow divergence', run: detectNetFlow },
  { id: 'B', name: 'Ageing acceleration', run: detectAgeing },
  { id: 'C', name: 'Escalation quality shift', run: detectEscalationQuality },
  { id: 'D', name: 'Dev-owned drift', run: detectDevDrift },
  { id: 'E', name: 'Capacity collision', run: detectCapacityCollision },
];

/**
 * Why each switched-off detector is off, in the words the screen will use.
 *
 * "Measured and failed" and "could not be measured" are different findings with
 * different fixes, and a single word like "disabled" would hide which is which.
 */
const DISABLED_REASON = {
  B: 'not measurable, and built on a counter — nt_oldest_development rises +1 on 316 of 319 days and has fallen twice in 320, so the "frozen tail" it looks for is the permanent default state rather than a signal. Its KPI is also RAG red on every day, so there was no outcome to score against either.',
  C: 'not measurable — nt_rejected is RAG green on every day of the history, and 34 of 285 replay days had no escalations to take a rate from.',
  D: 'measured and failed — over 285 days it fired twice, both false, and missed both Development backlog crossings. Off until the approach changes, not until the threshold does.',
};

/** How many cards may reach the screen, however many fire. */
const MAX_INDICATORS = 5;

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * Run every detector over a snapshot of data. PURE.
 *
 * `disabled` is the set of detector ids to skip — the switch the back-test
 * result operates. A detector that cannot show useful lead time is turned off
 * HERE, by name, rather than deleted or quietly weakened, so what is off and
 * why stays visible.
 */
function detect({ series = {}, capacity = null, asOf, disabled = [] } = {}) {
  if (!asOf) throw new Error('detect() needs an asOf day — a detector with no clock would read the future');

  const indicators = [];
  const blocked = [];
  const quiet = [];

  for (const d of DETECTORS) {
    if (disabled.includes(d.id)) {
      // The reason is per-detector because the reasons are genuinely different,
      // and collapsing them would tell Nick that a detector nobody could test
      // had been tested and failed.
      // `disabled: true` distinguishes a STANDING DECISION from a detector that
      // could not run today. The radar renders them differently and must: a
      // transient fault belongs in the blind-spots warning, and a thing that was
      // measured and switched off belongs in a quiet line stated once. Putting a
      // permanent entry in a warning banner is how a banner becomes wallpaper —
      // on the screen of someone who stops reading screens that are always red.
      blocked.push({
        id: d.id, name: d.name, disabled: true,
        reason: DISABLED_REASON[d.id] || 'disabled by configuration',
      });
      continue;
    }
    let result;
    try {
      result = d.run({ series, capacity, asOf });
    } catch (err) {
      // One detector throwing must not lose the other four, and must not look
      // like a quiet department either.
      blocked.push({ id: d.id, name: d.name, reason: `threw: ${err.message}` });
      continue;
    }
    if (result.indicator) indicators.push(result.indicator);
    if (result.indicators) indicators.push(...result.indicators);
    if (result.blocked) blocked.push(...(Array.isArray(result.blocked) ? result.blocked : [result.blocked]));
    if (result.quiet) quiet.push(result.quiet);
  }

  // Shadows run in their own pass and NEVER join `indicators`.
  const shadow = [];
  for (const d of SHADOW_DETECTORS) {
    let r;
    try {
      r = d.run({ series, capacity, asOf });
    } catch (err) {
      blocked.push({ id: d.id, name: d.name, shadow: true, reason: `threw: ${err.message}` });
      continue;
    }
    if (r.indicator) shadow.push(r.indicator);
    if (r.blocked) blocked.push(...(Array.isArray(r.blocked) ? r.blocked : [r.blocked]));
    if (r.quiet) quiet.push(r.quiet);
  }

  indicators.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || (b.confidence.score - a.confidence.score)
    || (a.horizonDays - b.horizonDays));

  return {
    asOf,
    indicators: indicators.slice(0, MAX_INDICATORS),
    // Returned so `current()` can record them and a test can assert they exist.
    // No caller renders this.
    shadow,
    // Ranked out rather than lost. Five is a display limit, not a claim that
    // nothing else fired.
    suppressed: indicators.slice(MAX_INDICATORS).map(i => ({ key: i.key, title: i.title })),
    blocked,
    quiet,
  };
}

// ── The impure half ──────────────────────────────────────────────────────────
//
// Everything above is pure and is what the replay runs. Everything below reads
// and remembers. The split is the same one `friction.js` and `pi-health.js`
// hold in NEURO, for the same reason: the judgement has to be testable without
// a database, and a back-test has to exercise the deployed logic rather than a
// copy of it.

/**
 * Detectors switched OFF, and why — measured, not assumed.
 *
 * From `tools/replay-indicators.js` over 285 days of history (2025-12-06 to
 * 2026-09-16).
 *
 * ⚠ THE OUTCOME LABEL CHANGED ON 17 SEP 2026 and the numbers below are the
 * corrected ones. V1 scored against RAG CROSSINGS; discovery showed that label
 * is mostly noise, because `nt_production` sits above its red line 69% of the
 * time and `nt_incidents` 65% — so a "crossing" is usually the series dipping
 * under the line and coming back, and several happened while the stock was
 * FALLING. The canonical measure is now a RISE EPISODE: a stock climbing its
 * whole green-to-red span within 14 days. See `VALIDATED.supersedes`.
 *
 *   A  net flow        6 of 19 rise episodes warned, MEDIAN LEAD 12 DAYS,
 *                      1 false positive — and 3 fires landed ON the episode
 *                      day, scoring zero. Against the 6 genuinely rising
 *                      members of the old RAG set: 3 warned, median lead 7. ON.
 *
 *   D  dev drift       2 runs, BOTH false positives, and it missed both
 *                      Development crossings in the window. Measured and
 *                      failed. OFF — and the thresholds are NOT to be widened
 *                      until it passes; a detector fitted to two events is not
 *                      a detector.
 *
 *   B  ageing          UNMEASURABLE, and now also known to be BUILT ON A
 *                      COUNTER. `nt_oldest_development` rises +1 on 316 of 319
 *                      days and has fallen TWICE in 320 — there is one ancient
 *                      ticket nobody will ever clear (109 days in February,
 *                      235 in July). B's "frozen tail" is the permanent default
 *                      state, not a signal. The KPI is also RAG red on every
 *                      day, so there was no transition to score against either.
 *                      It fired 17 times in 285 days, which is not spam, but
 *                      "did not fire often" is not "gave useful warning".
 *
 *   C  escalation      UNMEASURABLE. `nt_rejected` is RAG green on every day.
 *                      Also blocked on 34 of 285 days by weeks with no
 *                      escalations at all.
 *
 * B and C are off by DEFAULT rather than by verdict. The difference matters and
 * is not pedantry: D was tested and failed, B and C could not be tested, and
 * the fix for each is different. B and C need an outcome marker that does not
 * exist yet — a target those KPIs can actually cross — not a threshold change.
 *
 * E (capacity collision) is deliberately NOT in this list, and that is a
 * judgement rather than a measurement: it cannot be replayed either, because
 * availability has no history anywhere in the estate. It stays on because it
 * makes no statistical claim to validate — "four of twelve are booked off on
 * Wednesday and Wednesday is normally busy" is a lookup against the rota and
 * the arrival pattern, not an inference about what will happen. If that
 * argument does not hold for you, add E here; it is one character.
 *
 * Override with `LEADING_DISABLED_DETECTORS=A,B` — or `=none` to run all five.
 */
const DISABLED_BY_DEFAULT = ['B', 'C', 'D'];

function disabledDetectors() {
  const env = (process.env.LEADING_DISABLED_DETECTORS || '').trim();
  if (!env) return [...DISABLED_BY_DEFAULT];
  if (env.toLowerCase() === 'none') return [];
  return env.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Today's indicators, read, detected and reconciled.
 *
 * NEVER throws — the radar calls it, and an exception here would take the whole
 * screen down over a slow database. Unavailability is a state with a reason,
 * and it is NEVER an empty list: "no early warnings" and "the early warning
 * system could not see anything" are opposite messages and the difference is
 * the whole contract this repo runs on.
 */
async function current({ force = false } = {}) {
  const kpiSeries = require('./kpi-series');

  const [history, capacity] = await Promise.all([
    kpiSeries.current({ force }),
    kpiSeries.capacity({ force }),
  ]);

  if (!history.available) {
    return { available: false, reason: history.reason, capacityAvailable: Boolean(capacity?.available) };
  }

  // The most recent day that actually carries values across the feed. NOT
  // today: the 18:00 freeze means today's row does not exist for most of the
  // working day, and asking detectors about a day with no data would block
  // every one of them every morning.
  const asOf = latestCommonDay(history.series);
  if (!asOf) {
    return { available: false, reason: 'no day in the feed carries a value across the detector KPIs' };
  }

  const result = detect({
    series: history.series,
    // Passed through unavailable-and-all. `detectCapacityCollision` turns that
    // into a named blocked detector, which is the honest rendering; filtering
    // it to null here would make an unread source look like a quiet one.
    capacity,
    asOf,
    disabled: disabledDetectors(),
  });

  let lifecycle;
  try {
    const log = require('./indicator-log');
    // Shadows are reconciled in the SAME ledger and in the same call, so a
    // shadow run accumulates history exactly as a live one does. They are then
    // dropped from what this function returns.
    lifecycle = log.reconcile([...result.indicators, ...(result.shadow || [])], asOf);
    // Label whatever the department has since done. Runs AFTER reconcile so a
    // warning first seen today can be settled by an episode that completed
    // today — which is a zero-lead coincidence, and has to be recorded as one.
    log.settle(history.series, asOf);
  } catch (err) {
    // The register failing must not lose the detection, and must not look like
    // a clean history either.
    lifecycle = { active: result.indicators, normalised: [], error: err.message };
  }

  return {
    available: true,
    asOf,
    dataAsOf: history.asOf,
    stale: Boolean(history.stale),
    // ⚠ Shadows are filtered OUT of what anything renders. They went into the
    // ledger above; they do not come back out to a screen.
    indicators: lifecycle.active.filter(i => i.shadow !== true),
    // Counted, not shown. "Two shadow detectors fired" is worth knowing on the
    // admin page without any of them becoming a card.
    shadowFired: (result.shadow || []).length,
    normalised: lifecycle.normalised,
    suppressed: result.suppressed,
    blocked: result.blocked,
    quiet: result.quiet,
    // Carried through so the screen can say what is not being measured at all,
    // rather than letting the absence pass as coverage.
    excluded: history.excluded,
    absentKpis: history.absent,
    capacity: capacity?.available
      ? { rosterCount: capacity.rosterCount, unsyncable: capacity.unsyncable, approvedOnly: true }
      : { available: false, reason: capacity?.reason || 'not read' },
    registerError: lifecycle.error || null,
  };
}

/** The newest day for which every detector KPI carries a value. */
function latestCommonDay(series) {
  const keys = ['nt_new_tickets', 'nt_solved_team', 'nt_solved_nova', 'nt_development'];
  const maps = keys.map(k => byDay(series[k])).filter(m => m.size);
  if (maps.length !== keys.length) return null;

  const candidates = [...maps[0].keys()].sort((a, b) => b.localeCompare(a));
  return candidates.find(day => maps.every(m => m.has(day))) || null;
}

/**
 * Indicators as radar cards.
 *
 * They join the existing radar rather than getting a screen of their own. The
 * radar's `could` tense — "has not gone wrong yet" — has always been the one
 * with the weakest sources, and this is what it was for. A separate screen
 * would also mean a second place to look, which for this reader is the same as
 * nowhere.
 *
 * A blocked detector produces NO card. It is reported through the radar's
 * `blind` list instead, which is where "we could not see this" already lives.
 */
function toRadarItems(state) {
  if (!state?.available) return [];

  return (state.indicators || [])
    // Second guard. `current()` already filters shadows out; this makes the
    // radar independently incapable of rendering one, because "no card" is the
    // promise that makes shadow mode mean anything.
    .filter(i => i.shadow !== true)
    .map(i => ({
    tense: i.tense,
    severity: i.severity,
    title: i.title,
    detail: [
      i.change,
      i.whyItMatters,
      i.standing && i.strengthened ? i.standing : null,
      `Evidence: ${(i.evidence || []).map(e => `${e.label} ${e.value}`).join(' · ')}.`,
      `Useful for about ${i.horizonDays} day${i.horizonDays === 1 ? '' : 's'}. Confidence ${i.confidence.level} (${i.confidence.score}) — ${i.confidence.basis.join('; ')}.`,
      i.validation?.autoActionable === false
        ? `⚠ ${i.validation.label}. ${i.validation.detail} Nothing acts on this until you decide it should.`
        : null,
      `Confirms it: ${i.confirm}`,
      `Rules it out: ${i.disprove}`,
    ].filter(Boolean).join(' '),
    source: 'Leading',
    remedy: i.action,
    // Carried so the register can match and the UI can show the run without
    // re-deriving it.
    leadingKey: i.key,
    detector: i.detector,
    // What the verdict buttons post against, and what they show instead once a
    // verdict exists. A card nobody can judge is a data point lost for good —
    // the ledger only ever sees warnings somebody looked at.
    logId: i.recordId ?? null,
    verdict: i.outcome ?? null,
    verdictSource: i.outcomeSource ?? null,
    actionTaken: i.actionTaken ?? null,
    // Travels onto the card and, through `+ log`, onto the finding. This is
    // what stops an unvalidated advisory being written into NEURO unattended.
    validation: i.validation,
    advisory: i.validation?.autoActionable === false,
    firstSeenOn: i.firstSeenOn || null,
    sightings: i.sightings || 1,
  }));
}

module.exports = {
  detect, current, toRadarItems, latestCommonDay, disabledDetectors,
  // Exported for the tests and the replay, which have to be able to drive each
  // detector alone to know which one produced a result.
  detectNetFlow, detectAgeing, detectEscalationQuality, detectDevDrift, detectCapacityCollision,
  detectShadowComposite, SHADOW_DETECTORS,
  weekBuckets, zScore, windowUsable, confidence, byDay,
  Z_FIRE, BASELINE_WEEKS, REQUIRED_DAYS, AGE_SLOPE_FROZEN, THIN_TEAM_SHARE, MIN_CONFIDENCE, MAX_INDICATORS,
};
