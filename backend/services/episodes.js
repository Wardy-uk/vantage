'use strict';

/**
 * Rise episodes — what counts as a departmental problem actually arriving.
 *
 * ── Why this replaced RAG crossings ─────────────────────────────────────────
 *
 * V1 scored every detector against "a stock KPI going red for three days", on
 * the reasoning that NOVA's own thresholds were somebody else's numbers and so
 * could not be marked as homework. The reasoning was right and the label was
 * still wrong, which is worth separating.
 *
 * Measured over 320 days: `nt_production` sits ABOVE its red line 69% of the
 * time and `nt_incidents` 65%. On a series that lives above its own line, a
 * "crossing" is usually the series dipping under and coming back — the end of a
 * recovery, not the start of a problem. Several of V1's events happened while
 * the stock was FALLING (2026-08-11: Production at 83 on a 14-day slope of
 * -3.3, then red). Only 6 of 19 were preceded by a sustained rise. And it was
 * incomplete as well as noisy: two thirds of genuine rises never produced a
 * crossing at all, because the series was already red.
 *
 * So every lead time measured against it averaged real warnings together with
 * coin-flips. That is why the correction to A's validation was a change of
 * LABEL and not a change of detector.
 *
 * ── The definition ──────────────────────────────────────────────────────────
 *
 * A stock KPI climbing its ENTIRE green-to-red span within 14 days.
 *
 * The span is still NOVA's number — the distance it treats as the difference
 * between a healthy queue and a failing one — so the size of a move that
 * matters is not something chosen here. What changed is that the EVENT is the
 * climb rather than the line-crossing, which makes it work identically whether
 * the series happens to be above or below its threshold at the time.
 *
 * The episode is dated at the day the climb COMPLETES. That is the earliest day
 * an observer holding only past data could know it had happened; dating it from
 * the start would credit a detector for seeing something that had not yet
 * finished occurring.
 *
 * PURE. No fetch, no store, no clock of its own — the replay walks history
 * through it and the live ledger passes it today's series, and both have to get
 * the same answer or a prospective score cannot be compared with a historical
 * one.
 */

/** Multiples of the green-to-red span. 1.0 — the whole distance NOVA calls the
 *  difference between healthy and failing. Sensitivity was checked at 0.3 /
 *  0.5 / 0.75 / 1.0 and reported rather than picked for the answer it gave. */
const RISE_SPANS = 1.0;
const RISE_WINDOW_DAYS = 14;
/** One climb is one episode however long it runs. Counting a month-long climb
 *  as twenty events would let a detector that fired once look like twenty. */
const EPISODE_GAP_DAYS = 10;

/** The stocks this applies to. Flow KPIs are excluded — they cross their daily
 *  target constantly (`nt_new_tickets` 21 times in 120 days) and a marker that
 *  fires every six days is not an event. */
const STOCK_KPIS = ['nt_incidents', 'nt_production', 'nt_development'];

const DAY_MS = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const between = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Episodes in one series.
 *
 * Returns `[]` — not null — when the series carries no usable RAG bands, and
 * the caller is expected to know the difference between "no episodes" and "this
 * KPI cannot produce episodes". `usable()` below answers the second.
 */
function forSeries(series) {
  if (!usable(series)) return [];
  const span = series.rag.amberMax - series.rag.greenMax;
  const byDay = new Map(series.points.map(p => [p.day, p.value]));

  const out = [];
  let last = null;
  for (const p of series.points) {
    const then = byDay.get(addDays(p.day, -RISE_WINDOW_DAYS));
    if (then === undefined) continue;
    const rose = p.value - then;
    if (rose < span * RISE_SPANS) continue;
    // Inside the gap: the same climb continuing, not a new problem.
    if (last !== null && between(last, p.day) <= EPISODE_GAP_DAYS) { last = p.day; continue; }
    out.push({
      kpi: series.key,
      day: p.day,
      rose: Math.round(rose),
      from: then,
      to: p.value,
      span,
      windowDays: RISE_WINDOW_DAYS,
    });
    last = p.day;
  }
  return out;
}

/** Can this series produce episodes at all? A KPI with no bands cannot, and
 *  saying so is different from saying it had none. */
function usable(series) {
  const b = series?.rag;
  return Boolean(series?.points?.length && b && b.greenMax !== undefined && b.amberMax !== undefined
    && (b.amberMax - b.greenMax) > 0);
}

/** Episodes across every stock KPI present, newest last. */
function all(seriesByKey) {
  const out = [];
  for (const key of STOCK_KPIS) {
    const s = seriesByKey?.[key];
    if (s) out.push(...forSeries(s));
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

/** Episodes that completed in the last `days` days, for the live ledger. */
function recent(seriesByKey, asOf, days = 21) {
  const cutoff = addDays(asOf, -days);
  return all(seriesByKey).filter(e => e.day > cutoff && e.day <= asOf);
}

module.exports = {
  forSeries, all, recent, usable,
  RISE_SPANS, RISE_WINDOW_DAYS, EPISODE_GAP_DAYS, STOCK_KPIS,
};
