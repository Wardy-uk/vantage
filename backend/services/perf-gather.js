'use strict';

/**
 * Performance Evidence — gather and triage (29 Oct 2026).
 *
 * GATHER pulls candidate items from NEURO (`/api/perf-evidence/candidates`) and
 * NOVA (perf-nova.js), both GET only, into the store as `queued`. It walks the
 * last week every run, and a BACKFILL cursor walks back a week at a time to 12
 * months (Nick's decision), newest first so recent evidence arrives first.
 *
 * TRIAGE has a model read queued items in batches against BOTH active role
 * profiles and propose, per item: the skill(s) it bears on, for which role,
 * whether it is evidence FOR or AGAINST, and why. An item the model ties to no
 * skill is filed `not-relevant` (kept, so it is never bought again). Nothing the
 * model says counts until Nick accepts it.
 *
 * Caps (Nick's decision): a hard daily spend cap and a daily item cap, in
 * perf_state.caps. Hitting a cap STOPS the run; the queue is untouched and the
 * next day carries on. Nothing is ever skipped to stay under a cap.
 */

const store = require('./perf-store');
const novaEv = require('./perf-nova');

const DEFAULT_CAPS = Object.freeze({ dailyUsd: 1, dailyItems: 300 });
const BACKFILL_DAYS = 365;
const WEEK = 7;
const BATCH = 20;
const MAX_QUEUE_BEFORE_BACKFILL = 400;
const UNKNOWN_COST_USD = 0.05;   // a call whose cost OpenRouter did not report is counted at this, never at 0

const localKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const addDays = (key, n) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Automated noise that is never evidence. Free, deterministic. Pure. */
const NOISE = /^(accepted|declined|tentative|automatic reply|auto(matic)?-?reply|out of office|undeliverable|delivery has failed)\b/i;
function isNoise(item) {
  const t = String(item?.title || '').replace(/^Replied:\s*/i, '');
  return NOISE.test(t) || t.trim().length < 6;
}

function caps() {
  const c = store.getState('caps', null) || {};
  return {
    dailyUsd: Number.isFinite(c.dailyUsd) && c.dailyUsd >= 0 ? c.dailyUsd : DEFAULT_CAPS.dailyUsd,
    dailyItems: Number.isInteger(c.dailyItems) && c.dailyItems >= 0 ? c.dailyItems : DEFAULT_CAPS.dailyItems,
  };
}

/** Validate and save caps. Refused, never clamped. */
function setCaps({ dailyUsd, dailyItems } = {}) {
  const usd = Number(dailyUsd);
  const items = Number(dailyItems);
  if (!Number.isFinite(usd) || usd < 0 || usd > 20) { const e = new Error('dailyUsd must be between 0 and 20'); e.status = 400; throw e; }
  if (!Number.isInteger(items) || items < 0 || items > 5000) { const e = new Error('dailyItems must be a whole number between 0 and 5000'); e.status = 400; throw e; }
  store.setState('caps', { dailyUsd: usd, dailyItems: items });
  return caps();
}

/** Today's triage spend, from VANTAGE's own LLM ledger. Unknown costs counted, not zeroed. */
function spentToday(today = new Date().toISOString().slice(0, 10)) {
  try {
    const rows = require('../db').find('llm_calls', (r) => r.date_key === today && r.call_type === 'perf_evidence');
    let usd = 0; let unknown = 0;
    for (const r of rows) {
      if (r.cost_usd == null && r.costUsd == null) { unknown += 1; usd += UNKNOWN_COST_USD; } else usd += Number(r.cost_usd ?? r.costUsd) || 0;
    }
    return { usd: Math.round(usd * 1000) / 1000, calls: rows.length, unknownCost: unknown };
  } catch { return { usd: 0, calls: 0, unknownCost: 0, unreadable: true }; }
}

function itemsToday(today = localKey()) {
  const s = store.getState('items_today', null);
  return s && s.date === today ? s.count : 0;
}
function bumpItems(n, today = localKey()) {
  store.setState('items_today', { date: today, count: itemsToday(today) + n });
}

// ── gather ───────────────────────────────────────────────────────────────────

async function fetchWindow(from, to, today) {
  const neuro = require('./neuro');
  const sources = {};
  const items = [];
  try {
    const r = await neuro.call(`/api/perf-evidence/candidates?from=${from}&to=${to}`, { timeoutMs: 60_000 });
    for (const [k, v] of Object.entries(r.sources || {})) sources[`neuro-${k}`] = v;
    if (r.truncated) sources['neuro-truncated'] = { ok: false, error: 'NEURO capped this window — some items not fetched' };
    items.push(...(r.items || []).map((i) => ({ ...i, origin: 'neuro' })));
  } catch (e) { sources.neuro = { ok: false, error: e.message }; }
  const nova = await novaEv.candidates({ from, to, today });
  Object.assign(sources, nova.sources);
  items.push(...nova.items);
  for (const it of items) if (isNoise(it)) it.skip = true;
  return { items, sources };
}

async function gather({ today = localKey() } = {}) {
  const report = { windows: [], added: 0 };
  // 1. the last week, every run
  const recent = await fetchWindow(addDays(today, -(WEEK - 1)), today, today);
  report.added += store.enqueue(recent.items);
  report.windows.push({ from: addDays(today, -(WEEK - 1)), to: today, count: recent.items.length });
  let lastSources = recent.sources;

  // 2. backfill, a week at a time, while the queue is not already deep
  const floor = addDays(today, -BACKFILL_DAYS);
  let cursor = store.getState('backfill_cursor', addDays(today, -WEEK));
  for (let i = 0; i < 4 && cursor > floor && store.counts().queued < MAX_QUEUE_BEFORE_BACKFILL; i++) {
    const from = addDays(cursor, -(WEEK - 1)) < floor ? floor : addDays(cursor, -(WEEK - 1));
    const got = await fetchWindow(from, cursor, today);
    // A window where every source failed does not advance the cursor — it is retried next run.
    const anyOk = Object.values(got.sources).some((s) => s.ok);
    if (!anyOk) { report.backfillStalled = got.sources; break; }
    report.added += store.enqueue(got.items);
    report.windows.push({ from, to: cursor, count: got.items.length });
    cursor = addDays(from, -1);
    store.setState('backfill_cursor', cursor);
    lastSources = { ...got.sources, ...recent.sources };
  }
  store.setState('last_sources', { at: new Date().toISOString(), sources: lastSources });
  report.backfill = { cursor, floor, done: cursor <= floor };
  return report;
}

// ── triage ───────────────────────────────────────────────────────────────────

function profileBlock(role) {
  if (!role) return null;
  const p = role.profile;
  return `${role.slot.toUpperCase()} ROLE — ${p.title}\n`
    + p.skills.map((s) => `  ${s.code} ${s.name} (target L${s.level})`).join('\n');
}

const TRIAGE_PROMPT = `You sort evidence of one manager's performance (Nick) against SFIA skills for his role(s).
For EACH item decide which skills it is genuine evidence of, for which role, and whether it is evidence FOR (he did the thing well / at level) or AGAINST (missed, late, below level).
Answer ONLY with JSON: {"items":[{"i":0,"tags":[{"slot":"current","code":"SLMO","stance":"for","why":"one short sentence"}]}]}
RULES
- Every item index must appear exactly once. tags:[] means it is not evidence of any listed skill.
- Use only the skill codes listed for each role, with that role's slot.
- An item can carry tags for both roles.
- Routine admin with no skill content gets tags:[].
- A missed or late task is AGAINST only if it plainly bears on the skill; a set date can be a plan, not a promise.
- why: what in the item shows it. Never invent facts not in the item.`;

/** Validate the model's triage answer for a batch. Pure. Refuses the whole batch if any item is missing. */
function parseTriage(raw, batchSize, codesBySlot) {
  let j;
  try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('unreadable JSON'); }
  if (!j || !Array.isArray(j.items)) throw new Error('no items array');
  const out = new Map();
  for (const r of j.items) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= batchSize || out.has(i)) continue;
    const tags = [];
    for (const t of Array.isArray(r.tags) ? r.tags : []) {
      const slot = t?.slot === 'future' ? 'future' : t?.slot === 'current' ? 'current' : null;
      const code = String(t?.code || '').toUpperCase();
      const stance = t?.stance === 'against' ? 'against' : t?.stance === 'for' ? 'for' : null;
      if (!slot || !stance || !codesBySlot[slot]?.has(code)) continue;
      if (tags.some((x) => x.slot === slot && x.code === code)) continue;
      tags.push({ slot, code, stance, why: String(t.why || '').replace(/\s+/g, ' ').trim().slice(0, 240) || null });
    }
    out.set(i, tags);
  }
  if (out.size !== batchSize) throw new Error(`answer covered ${out.size} of ${batchSize} items`);
  return out;
}

let running = false;

async function triage({ today = localKey() } = {}) {
  const openrouter = require('./openrouter');
  const roles = { current: store.activeRole('current'), future: store.activeRole('future') };
  if (!roles.current && !roles.future) return { stopped: 'no-roles', judged: 0 };
  if (!openrouter.isConfigured()) return { stopped: 'no-model-key', judged: 0 };
  const codesBySlot = {
    current: new Set((roles.current?.profile.skills || []).map((s) => s.code)),
    future: new Set((roles.future?.profile.skills || []).map((s) => s.code)),
  };
  const rolesKey = `${roles.current?.id || '-'}/${roles.future?.id || '-'}`;
  const system = `${TRIAGE_PROMPT}\n\n${[profileBlock(roles.current), profileBlock(roles.future)].filter(Boolean).join('\n\n')}`;
  const c = caps();
  let judged = 0; let proposed = 0; let failures = 0;
  for (;;) {
    const room = c.dailyItems - itemsToday(today);
    if (room <= 0) return { stopped: 'item-cap', judged, proposed, failures };
    if (spentToday().usd >= c.dailyUsd) return { stopped: 'spend-cap', judged, proposed, failures };
    const batch = store.queued(Math.min(BATCH, room));
    if (!batch.length) return { stopped: 'queue-empty', judged, proposed, failures };
    const lines = batch.map((e, i) => JSON.stringify({ i, kind: e.kind, hint: e.hint, date: String(e.occurredAt || '').slice(0, 10), title: e.title, detail: String(e.detail || '').slice(0, 600) }));
    let tagsByIndex;
    try {
      const reply = await openrouter.complete([
        { role: 'system', content: system },
        { role: 'user', content: lines.join('\n') },
      ], { temperature: 0.1, maxTokens: 3500, json: true, callType: 'perf_evidence' });
      tagsByIndex = parseTriage(reply.text, batch.length, codesBySlot);
    } catch (e) {
      failures += 1;
      console.warn(`[VANTAGE] perf triage batch failed: ${e.message}`);
      if (failures >= 2) return { stopped: 'model-failed', error: e.message, judged, proposed, failures };
      continue;
    }
    for (const [i, tags] of tagsByIndex) {
      store.setTriage(batch[i].id, { state: tags.length ? 'proposed' : 'not-relevant', tags, rolesKey });
      if (tags.length) proposed += 1;
    }
    judged += batch.length;
    bumpItems(batch.length, today);
  }
}

/** One full pass: gather, then triage within the caps. Never two at once. */
async function run(reason = 'timer') {
  if (running) return { skipped: 'already running' };
  running = true;
  const started = Date.now();
  try {
    const g = await gather();
    const t = await triage();
    const out = { reason, gather: g, triage: t, ms: Date.now() - started, at: new Date().toISOString() };
    store.setState('last_run', out);
    return out;
  } catch (e) {
    const out = { reason, error: e.message, at: new Date().toISOString() };
    store.setState('last_run', out);
    throw e;
  } finally { running = false; }
}

function status() {
  return {
    caps: caps(), spentToday: spentToday(), itemsToday: itemsToday(),
    counts: store.counts(),
    backfill: { cursor: store.getState('backfill_cursor', null), floorDays: BACKFILL_DAYS },
    lastRun: store.getState('last_run', null),
    lastSources: store.getState('last_sources', null),
    running,
  };
}

module.exports = { run, gather, triage, status, setCaps, caps, isNoise, parseTriage, DEFAULT_CAPS, _internals: { addDays } };
