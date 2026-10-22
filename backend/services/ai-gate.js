'use strict';

/* ───────────────────────────────────────────────────────────────────────────
 * AI GATE — the ONE way a paid, metered or local model call is admitted, in
 * NEURO and in VANTAGE alike (22 Oct 2026).
 *
 * ⚠ THIS FILE IS A DELIBERATE COPY. The two repos deploy separately and cannot
 * share code, so `nuero/backend/services/ai-gate.js` and
 * `vantage/backend/services/ai-gate.js` are BYTE-IDENTICAL, pinned by a parity
 * test in each repo. Change both or neither. What differs per app is the class
 * registry, which each app passes in (`ai-gate-classes.js`).
 *
 * What it does:
 *   · reserve(spec) BEFORE a call: the call names a CLASS, a MODEL, a provider
 *     and bounded input/output. The gate prices the worst case (the dearest model
 *     the request could be served by, at its full output bound) and writes a
 *     single-use TICKET into ONE shared London-day ledger, inside a SQLite
 *     IMMEDIATE transaction — the same file, opened by both apps on the same box,
 *     so a reservation is atomic across processes.
 *   · settle(ticket, usage) AFTER the call: the vendor's own charged cost when it
 *     reports one, else tokens × the table price, else the reserved worst case
 *     (PESSIMISTIC — never zero for "we were not told"), else unknown (null).
 *     A ticket settles ONCE: a second settle is refused and recorded, so a loop
 *     cannot double-spend or double-count.
 *   · profile(): today's shared spend, per class and per app, Radar's share, and
 *     every refusal reason.
 *
 * ⚠ SHADOW MODE IS THE DEFAULT AND THE ONLY MODE NICK HAS AGREED TO. In shadow
 * the gate WORKS OUT whether it would refuse (unknown class / model / price,
 * unbounded input or output, concurrency, volume) and records why, but the call
 * goes ahead. There is NO daily spending cap: Nick has not chosen one, and a
 * guessed cap is the one thing this must not impose (`dailyCapUsd` is null by
 * design). `AI_GATE_MODE=enforce` exists so turning it on is one decision, not a
 * rebuild — and it still has no daily cap.
 *
 * ⚠ The gate must never be the reason a call fails in shadow: an unreadable or
 * unwritable ledger degrades to "admitted, not recorded" and SAYS so in the
 * profile (`degraded`), rather than taking chat or the standup down.
 * ─────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE_VERSION = 1;

// USD per MILLION tokens (embeddings: input only). The gate's own price list,
// shared by both apps because it IS this file. Dated — a price is a fact about
// the world that goes stale silently, so an absent price is UNKNOWN (null),
// never zero, and the profile says which calls could not be priced.
// Last checked 2026-10-22 against the vendors' published per-token prices.
const PRICES_CHECKED = '2026-10-22';
const PRICES = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'anthropic/claude-sonnet-4.5': { input: 3, output: 15 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'voyage-3.5-lite': { input: 0.02, output: 0 },
};

// Providers that run on Nick's own hardware: free at the point of use, but still
// admitted through the gate so concurrency and volume apply to them too.
const LOCAL_PROVIDERS = new Set(['ollama', 'pi4worker', 'whisper', 'piper']);

const RESERVATION_TTL_MS = 15 * 60 * 1000; // an unsettled ticket older than this expired (settled pessimistically)

function _mode() { return String(process.env.AI_GATE_MODE || 'shadow').toLowerCase() === 'enforce' ? 'enforce' : 'shadow'; }
function ledgerPath() {
  if (process.env.AI_GATE_DB_PATH) return process.env.AI_GATE_DB_PATH;
  // Under `node --test` a test that forgot to set a path must never write the
  // real shared ledger: it gets its own throwaway file instead.
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `ai-gate-test-${process.pid}.db`);
  return path.join(os.homedir(), '.ai-gate', 'ledger.db');
}

const _london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
/** PURE. The Europe/London calendar day of an instant ('YYYY-MM-DD'). */
function londonDay(ms) {
  const p = {}; for (const x of _london.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

function priceOf(model) {
  return PRICES[String(model || '').trim().toLowerCase()] || null;
}
function isLocal(provider) { return LOCAL_PROVIDERS.has(String(provider || '').toLowerCase()); }

/**
 * PURE. The worst case a request could cost: every model it might be served by
 * (primary + fallbacks), at the full input and output bounds. Null when any of
 * them is unpriced — an estimate that skipped a model would be a lower bound
 * dressed as a ceiling.
 */
function worstCaseUsd({ provider, model, fallbackModels = [], maxInputTokens, maxOutputTokens }) {
  if (isLocal(provider)) return 0;
  const inT = Number(maxInputTokens); const outT = Number(maxOutputTokens) || 0;
  if (!Number.isFinite(inT) || inT < 0) return null;
  let worst = 0;
  for (const m of [model, ...fallbackModels]) {
    const p = priceOf(m);
    if (!p) return null;
    worst = Math.max(worst, (inT * p.input + outT * p.output) / 1e6);
  }
  return worst;
}

/**
 * PURE. Why the gate would refuse this request — [] means admitted. The class
 * registry is the app's own; the reasons are a closed vocabulary so the profile
 * can count them.
 */
function refusalReasons(spec, registry, counts = {}) {
  const r = [];
  const cls = spec.callClass && registry ? registry[spec.callClass] : null;
  if (!cls) { r.push('unknown-class'); return r; }
  const local = isLocal(spec.provider);
  if (cls.local !== undefined && Boolean(cls.local) !== local) r.push('provider-not-allowed');
  if (!spec.model) r.push('unknown-model');
  else if (!local && !priceOf(spec.model)) r.push('unknown-price');
  if (!local) for (const f of spec.fallbackModels || []) if (!priceOf(f)) { r.push('unknown-price'); break; }
  if (Array.isArray(cls.models) && spec.model && !cls.models.includes(String(spec.model).toLowerCase())) r.push('model-not-allowed');
  const inT = Number(spec.maxInputTokens); const outT = Number(spec.maxOutputTokens);
  if (!Number.isFinite(inT) || inT < 0) r.push('unbounded-input');
  else if (cls.maxInputTokens && inT > cls.maxInputTokens) r.push('input-over-bound');
  if (!cls.noOutput && (!Number.isFinite(outT) || outT <= 0)) r.push('unbounded-output');
  else if (cls.maxOutputTokens && outT > cls.maxOutputTokens) r.push('output-over-bound');
  if (cls.maxConcurrent && (counts.open || 0) >= cls.maxConcurrent) r.push('concurrency');
  // A provider-wide limit too: two classes can contend for the same local model server.
  const prov = registry.$providers && registry.$providers[String(spec.provider || '').toLowerCase()];
  if (prov && prov.maxConcurrent && (counts.openProvider || 0) >= prov.maxConcurrent) r.push('concurrency');
  if (cls.maxPerDay && (counts.today || 0) >= cls.maxPerDay) r.push('volume');
  return [...new Set(r)];
}

/* ── the shared ledger ─────────────────────────────────────────────────── */

let _db = null; let _dbPath = null; let _degraded = null;

function _open() {
  const want = ledgerPath();
  if (_db && _dbPath === want) return _db;
  if (_db) { try { _db.close(); } catch { /* ignore */ } _db = null; }
  try {
    fs.mkdirSync(path.dirname(want), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(want);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS gate_tickets (
        id TEXT PRIMARY KEY, app TEXT NOT NULL, call_class TEXT, provider TEXT, model TEXT,
        fallback_models TEXT, day TEXT NOT NULL, reserved_at TEXT NOT NULL,
        max_in INTEGER, max_out INTEGER, est_usd REAL,
        decision TEXT NOT NULL, reasons TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, settled_at TEXT, served_model TEXT,
        prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, cost_basis TEXT,
        ok INTEGER, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gate_day ON gate_tickets(day, call_class);
      CREATE INDEX IF NOT EXISTS idx_gate_open ON gate_tickets(status, call_class);
      CREATE TABLE IF NOT EXISTS gate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL,
        app TEXT, ticket_id TEXT, kind TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gate_events_day ON gate_events(day, kind);
    `);
    _db = db; _dbPath = want; _degraded = null;
    return db;
  } catch (e) {
    _degraded = `The shared AI ledger could not be opened (${e.message}).`;
    return null;
  }
}

function _iso(ms) { return new Date(ms).toISOString(); }

function _expire(db, now) {
  const cutoff = _iso(now - RESERVATION_TTL_MS);
  db.prepare(`UPDATE gate_tickets SET status='expired', settled_at=?, cost_usd=est_usd,
      cost_basis=CASE WHEN est_usd IS NULL THEN 'unknown' ELSE 'pessimistic' END, ok=0, error='never settled'
    WHERE status='reserved' AND reserved_at < ?`).run(_iso(now), cutoff);
}

function _event(db, { app, ticketId = null, kind, detail = null, now }) {
  db.prepare('INSERT INTO gate_events (at, day, app, ticket_id, kind, detail) VALUES (?,?,?,?,?,?)')
    .run(_iso(now), londonDay(now), app || null, ticketId, kind, detail == null ? null : String(detail).slice(0, 300));
}

/**
 * Reserve BEFORE a call. Returns a single-use ticket:
 *   { id, decision: 'allow'|'refuse', reasons, admitted, mode, estUsd, degraded? }
 * `admitted` is what the caller obeys: always true in shadow; in enforce, false
 * on any refusal. Never throws.
 */
function reserve(spec, registry, { now = Date.now() } = {}) {
  const mode = _mode();
  const db = _open();
  const fallbackModels = Array.isArray(spec.fallbackModels) ? spec.fallbackModels : [];
  const estUsd = worstCaseUsd({ ...spec, fallbackModels });
  if (!db) {
    const reasons = refusalReasons({ ...spec, fallbackModels }, registry, {});
    return { id: null, decision: reasons.length ? 'refuse' : 'allow', reasons, admitted: mode === 'shadow' || !reasons.length, mode, estUsd, degraded: _degraded };
  }
  try {
    const id = crypto.randomUUID();
    const day = londonDay(now);
    let out = null;
    db.transaction(() => {
      _expire(db, now);
      const open = db.prepare(`SELECT COUNT(*) n FROM gate_tickets WHERE status='reserved' AND call_class=?`).get(spec.callClass || '').n;
      const today = db.prepare(`SELECT COUNT(*) n FROM gate_tickets WHERE day=? AND call_class=? AND decision='allow'`).get(day, spec.callClass || '').n;
      const openProvider = db.prepare(`SELECT COUNT(*) n FROM gate_tickets WHERE status='reserved' AND provider=?`).get(String(spec.provider || '').toLowerCase()).n;
      const reasons = refusalReasons({ ...spec, fallbackModels }, registry, { open, today, openProvider });
      const decision = reasons.length ? 'refuse' : 'allow';
      const admitted = mode === 'shadow' || decision === 'allow';
      db.prepare(`INSERT INTO gate_tickets (id, app, call_class, provider, model, fallback_models, day, reserved_at,
          max_in, max_out, est_usd, decision, reasons, mode, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, String(spec.app || 'unknown'), spec.callClass || null, spec.provider ? String(spec.provider).toLowerCase() : null, spec.model || null,
          fallbackModels.length ? JSON.stringify(fallbackModels) : null, day, _iso(now),
          Number.isFinite(Number(spec.maxInputTokens)) ? Math.round(Number(spec.maxInputTokens)) : null,
          Number.isFinite(Number(spec.maxOutputTokens)) ? Math.round(Number(spec.maxOutputTokens)) : null,
          estUsd, decision, JSON.stringify(reasons), mode, admitted ? 'reserved' : 'refused');
      out = { id, decision, reasons, admitted, mode, estUsd };
    }).immediate();
    return out;
  } catch (e) {
    _degraded = `The shared AI ledger could not be written (${e.message}).`;
    return { id: null, decision: 'allow', reasons: [], admitted: true, mode, estUsd, degraded: _degraded };
  }
}

/** PURE. What a settled call cost and on what basis. */
function settledCost(row, usage) {
  if (isLocal(row.provider)) return { costUsd: 0, basis: 'local' };
  const vendor = Number(usage && usage.costUsd);
  if (usage && usage.costUsd != null && Number.isFinite(vendor) && vendor >= 0) return { costUsd: vendor, basis: 'vendor' };
  const p = priceOf((usage && usage.model) || row.model);
  const pt = Number(usage && usage.promptTokens); const ct = Number(usage && usage.completionTokens);
  if (p && Number.isFinite(pt) && Number.isFinite(ct) && (pt + ct) > 0) return { costUsd: (pt * p.input + ct * p.output) / 1e6, basis: 'priced' };
  if (row.est_usd != null) return { costUsd: row.est_usd, basis: 'pessimistic' };
  return { costUsd: null, basis: 'unknown' };
}

/**
 * Settle AFTER a call, exactly once. `usage` = { ok, model, promptTokens,
 * completionTokens, costUsd, error }. A second settle of the same ticket is
 * REFUSED and recorded (`duplicate-settle`). Never throws.
 */
function settle(ticket, usage = {}, { now = Date.now() } = {}) {
  const id = ticket && typeof ticket === 'object' ? ticket.id : ticket;
  if (!id) return { ok: false, reason: 'no-ticket' };
  const db = _open();
  if (!db) return { ok: false, reason: 'degraded' };
  try {
    let out = null;
    db.transaction(() => {
      const row = db.prepare('SELECT * FROM gate_tickets WHERE id=?').get(id);
      if (!row) { _event(db, { kind: 'settle-unknown-ticket', ticketId: id, now }); out = { ok: false, reason: 'unknown-ticket' }; return; }
      if (row.status !== 'reserved') {
        _event(db, { app: row.app, kind: 'duplicate-settle', ticketId: id, detail: row.status, now });
        out = { ok: false, reason: 'duplicate-settle', status: row.status };
        return;
      }
      const { costUsd, basis } = settledCost(row, usage);
      const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
      db.prepare(`UPDATE gate_tickets SET status='settled', settled_at=?, served_model=?, prompt_tokens=?, completion_tokens=?,
          cost_usd=?, cost_basis=?, ok=?, error=? WHERE id=? AND status='reserved'`)
        .run(_iso(now), usage.model || null, n(usage.promptTokens), n(usage.completionTokens), costUsd, basis,
          usage.ok === false ? 0 : 1, usage.error ? String(usage.error).slice(0, 300) : null, id);
      out = { ok: true, costUsd, basis };
    }).immediate();
    return out;
  } catch (e) {
    _degraded = `The shared AI ledger could not be written (${e.message}).`;
    return { ok: false, reason: 'degraded' };
  }
}

/** Thrown only in enforce mode. In shadow nothing is refused. */
class GateRefused extends Error {
  constructor(t) { super(`AI gate refused this call: ${t.reasons.join(', ')}`); this.name = 'GateRefused'; this.ticket = t; }
}

/**
 * Reserve → run → settle, the shape every provider uses. `fn(ticket)` returns
 * { value, usage }; a throw settles the ticket as failed (pessimistic) and is
 * re-thrown unchanged.
 */
async function run(spec, registry, fn) {
  const t = reserve(spec, registry);
  if (!t.admitted) throw new GateRefused(t);
  let out;
  try { out = await fn(t); } catch (e) { settle(t, { ok: false, error: e.message }); throw e; }
  settle(t, { ok: true, ...(out && out.usage) });
  return out ? out.value : undefined;
}

const round = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);

/**
 * READ. The shared profile for a London day (default today): spend, per class,
 * per app, a named class's share, every refusal reason, and what could not be
 * priced. `dailyCapUsd` is null — Nick has not chosen one.
 */
function profile({ day = null, now = Date.now(), shareOf = 'radar', days = 14 } = {}) {
  const base = { ok: true, gateVersion: GATE_VERSION, mode: _mode(), currency: 'USD', pricesCheckedOn: PRICES_CHECKED,
    dailyCapUsd: null, capSay: 'No daily cap — Nick has not chosen one. Shadow mode records what the gate would refuse; nothing is blocked.' };
  const db = _open();
  if (!db) return { ...base, ok: false, degraded: _degraded || 'The shared AI ledger is unavailable.', known: false };
  try {
    _expire(db, now);
    const d = day || londonDay(now);
    const rows = db.prepare('SELECT * FROM gate_tickets WHERE day=?').all(d);
    const settled = rows.filter((r) => r.status === 'settled' || r.status === 'expired');
    const sum = (rs) => rs.reduce((a, r) => a + (r.cost_usd || 0), 0);
    const spendUsd = sum(settled);
    const openUsd = rows.filter((r) => r.status === 'reserved').reduce((a, r) => a + (r.est_usd || 0), 0);
    const byKey = (keyOf) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        const e = m.get(k) || { calls: 0, usd: 0, unknownCost: 0, pessimistic: 0, wouldRefuse: 0 };
        e.calls += 1;
        if (r.cost_usd != null) e.usd += r.cost_usd;
        if ((r.status === 'settled' || r.status === 'expired') && r.cost_basis === 'unknown') e.unknownCost += 1;
        if (r.cost_basis === 'pessimistic') e.pessimistic += 1;
        if (r.decision === 'refuse') e.wouldRefuse += 1;
        m.set(k, e);
      }
      return [...m.entries()].map(([k, e]) => ({ key: k, ...e, usd: round(e.usd) })).sort((a, b) => b.usd - a.usd || b.calls - a.calls);
    };
    const byClass = byKey((r) => `${r.app}:${r.call_class || '(unnamed)'}`).map((e) => {
      const [app, ...cls] = e.key.split(':');
      return { app, callClass: cls.join(':'), ...e };
    });
    const byApp = byKey((r) => r.app).map((e) => ({ app: e.key, ...e }));
    const shareUsd = sum(settled.filter((r) => r.call_class === shareOf));
    const reasons = new Map();
    for (const r of rows) {
      let rs = []; try { rs = JSON.parse(r.reasons || '[]'); } catch { rs = []; }
      for (const x of rs) {
        const e = reasons.get(x) || { reason: x, count: 0, classes: new Set() };
        e.count += 1; e.classes.add(`${r.app}:${r.call_class || '(unnamed)'}`);
        reasons.set(x, e);
      }
    }
    const events = db.prepare('SELECT kind, COUNT(*) n FROM gate_events WHERE day=? GROUP BY kind').all(d);
    const unpricedModels = [...new Set(rows.filter((r) => r.cost_basis === 'unknown' || /unknown-price/.test(r.reasons)).map((r) => r.served_model || r.model).filter(Boolean))];
    const history = db.prepare(`SELECT day, COUNT(*) calls, SUM(COALESCE(cost_usd,0)) usd,
        SUM(CASE WHEN call_class=? THEN COALESCE(cost_usd,0) ELSE 0 END) share_usd,
        SUM(CASE WHEN decision='refuse' THEN 1 ELSE 0 END) would_refuse
      FROM gate_tickets WHERE day >= ? GROUP BY day ORDER BY day`).all(shareOf, londonDay(now - days * 86400000));
    return {
      ...base, known: true, day: d, ledger: path.basename(_dbPath || ''),
      spendUsd: round(spendUsd), openReservedUsd: round(openUsd), calls: rows.length,
      unknownCostCalls: settled.filter((r) => r.cost_basis === 'unknown').length,
      pessimisticCalls: rows.filter((r) => r.cost_basis === 'pessimistic').length,
      share: { callClass: shareOf, usd: round(shareUsd), fraction: spendUsd > 0 ? round(shareUsd / spendUsd) : null },
      byClass, byApp,
      wouldRefuse: rows.filter((r) => r.decision === 'refuse').length,
      refusals: [...reasons.values()].map((e) => ({ reason: e.reason, count: e.count, classes: [...e.classes] })).sort((a, b) => b.count - a.count),
      events: Object.fromEntries(events.map((e) => [e.kind, e.n])),
      unpricedModels,
      history: history.map((h) => ({ day: h.day, calls: h.calls, usd: round(h.usd), shareUsd: round(h.share_usd), wouldRefuse: h.would_refuse })),
      degraded: _degraded,
    };
  } catch (e) {
    return { ...base, ok: false, known: false, degraded: `The shared AI ledger could not be read (${e.message}).` };
  }
}

/** Test seam: forget the open handle (the path may have changed). */
function _reset() { if (_db) { try { _db.close(); } catch { /* ignore */ } } _db = null; _dbPath = null; _degraded = null; }

module.exports = {
  GATE_VERSION, PRICES, PRICES_CHECKED, LOCAL_PROVIDERS, RESERVATION_TTL_MS,
  ledgerPath, londonDay, priceOf, isLocal, worstCaseUsd, refusalReasons, settledCost,
  reserve, settle, run, profile, GateRefused, _reset,
};
