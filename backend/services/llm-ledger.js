'use strict';

/**
 * What VANTAGE's model calls actually cost.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * VANTAGE is the biggest spender in the estate and was the only system with no
 * record of its own calls. Measured from an OpenRouter export on 1 Sep 2026,
 * over the seven days from 26 Aug it spent **$14.79 against NEURO's $2.17** on
 * the same shared key — 87% of the bill — and nobody knew, because the only
 * evidence lived on a dashboard nobody had reason to open. NEURO has
 * `ai_calls`; NOVA has `agent_llm_calls`; this is the missing third.
 *
 * The shape deliberately mirrors NEURO's `ai_calls`, so the two systems answer
 * "what is this costing" the same way and the numbers can be added up.
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 *
 *  ⚠ COST IS THE VENDOR'S OWN, not a local price table. `usage: {include:true}`
 *    asks OpenRouter what it actually charged, so the figure is what appears on
 *    the bill rather than a guess that drifts when pricing changes.
 *
 *  ⚠ AN UNKNOWN COST IS NULL, NEVER 0. NEURO's ledger learned this from NOVA's:
 *    a zero reads as free and silently vanishes from every total, so a call
 *    whose cost was not reported is recorded as unknown and counted as such.
 *
 *  ⚠ FAILURES ARE RECORDED. A ledger of successes cannot tell an expensive
 *    outage from a quiet week — the same reason NOVA stores `success` and
 *    `error`. A refused call still consumed a slot and still matters.
 *
 *  ⚠ IT NEVER BREAKS A CALL. Every write is wrapped: the answer has already
 *    been produced and paid for, so losing the bookkeeping must never lose it.
 */

const MAX_ROWS = 5000;   // ~3 months at the post-2 Sep cadence; bounded on write

function _db() {
  return require('../db');
}

/**
 * One row per model call.
 *
 * @param {object} row
 * @param {string} row.model      the model actually served (payload.model, not the request)
 * @param {string} row.callType   which VANTAGE feature asked — radar, coach, brief…
 * @param {number|null} row.costUsd
 * @param {boolean} row.ok
 */
function record(row) {
  try {
    const db = _db();
    db.insert('llm_calls', {
      at: new Date().toISOString(),
      date_key: new Date().toISOString().slice(0, 10),
      model: row.model || null,
      call_type: row.callType || null,
      prompt_tokens: row.promptTokens || 0,
      completion_tokens: row.completionTokens || 0,
      // Explicit null, never 0 — an unreported cost is not a free one.
      cost_usd: row.costUsd == null ? null : row.costUsd,
      latency_ms: row.latencyMs == null ? null : row.latencyMs,
      ok: row.ok !== false,
      error: row.error || null,
    });
    _trim(db);
  } catch { /* bookkeeping must never cost the answer */ }
}

function _trim(db) {
  try {
    const rows = db.find('llm_calls', () => true);
    if (rows.length <= MAX_ROWS) return;
    const cutoff = rows.length - MAX_ROWS;
    rows.slice(0, cutoff).forEach(r => db.remove('llm_calls', x => x.id === r.id));
  } catch { /* a full ledger is better than a broken one */ }
}

/** Totals for the admin page. Unknown cost is reported, never folded into the sum. */
function summary({ days = 7 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = _db().find('llm_calls', r => (r.date_key || '') >= since);
    if (!rows.length) return { known: true, days, calls: 0, note: 'nothing recorded in this window' };

    let cost = 0, unpriced = 0, failed = 0, promptTok = 0, completionTok = 0;
    const byModel = {};
    const byDay = {};
    for (const r of rows) {
      if (r.cost_usd == null) unpriced++; else cost += r.cost_usd;
      if (r.ok === false) failed++;
      promptTok += r.prompt_tokens || 0;
      completionTok += r.completion_tokens || 0;
      const m = (byModel[r.model || '(unknown)'] ||= { calls: 0, costUsd: 0 });
      m.calls++; if (r.cost_usd != null) m.costUsd += r.cost_usd;
      const d = (byDay[r.date_key] ||= { calls: 0, costUsd: 0 });
      d.calls++; if (r.cost_usd != null) d.costUsd += r.cost_usd;
    }
    return {
      known: true, days,
      calls: rows.length,
      failed,
      costUsd: Number(cost.toFixed(4)),
      // A total is only the whole story when this is 0 — NEURO's ledger reports
      // the same field for the same reason.
      unpriced,
      promptTokens: promptTok,
      completionTokens: completionTok,
      byModel, byDay,
    };
  } catch (e) {
    // "Could not read" is not "spent nothing".
    return { known: false, reason: e.message };
  }
}

module.exports = { record, summary, MAX_ROWS };
