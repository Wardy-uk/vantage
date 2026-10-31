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
const BATCH = 10;
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

/**
 * The backfill override (Nick, 29 Oct 2026: "override the cap for this
 * backfill"). While on, the daily caps are replaced by a hard safety ceiling
 * and the backfill walks the whole year in one pass. It switches ITSELF off once
 * the backfill reaches its floor and the queue is empty, so the normal caps come
 * back for the daily trickle without anyone remembering to restore them.
 */
const OVERRIDE_CAPS = Object.freeze({ dailyUsd: 15, dailyItems: 5000 });
const overrideOn = () => Boolean(store.getState('backfill_override', null)?.on);
function setBackfillOverride(on) {
  store.setState('backfill_override', { on: Boolean(on), at: new Date().toISOString(), by: 'nick' });
  return { on: overrideOn(), caps: caps() };
}

function caps() {
  if (overrideOn()) return { ...OVERRIDE_CAPS, override: true };
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
  const fast = overrideOn();
  for (let i = 0; i < (fast ? 60 : 4) && cursor > floor && (fast || store.counts().queued < MAX_QUEUE_BEFORE_BACKFILL); i++) {
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

  // 3. Year sweeps (30 Oct 2026). NEURO finds some evidence long after the
  // backfill has passed its week — feedback read out of OLD meetings overnight,
  // and Confluence pages read hourly — so once a day the whole year is re-read
  // for those sources only. Enqueue is idempotent on the item id, so a repeat
  // adds nothing; a window that fails is skipped and the sweep retried.
  for (const [source, key] of [['feedback', 'feedback_sweep_at'], ['confluence', 'confluence_sweep_at'], ['reports', 'reports_sweep_at'], ['sends', 'sends_sweep_at'], ['tickets', 'tickets_sweep_at'], ['workforce', 'workforce_sweep_at'], ['people', 'people_sweep_at'], ['work-notes', 'work_notes_sweep_at'], ['mail', 'mail_sweep_at']]) {
    const last = store.getState(key, null);
    if (last && Date.now() - Date.parse(last) <= 20 * 3600_000) continue;
    let added = 0; let failed = 0;
    for (let to = today; to > floor; to = addDays(to, -31)) {
      const from = addDays(to, -30) < floor ? floor : addDays(to, -30);
      try {
        const r = await require('./neuro').call(`/api/perf-evidence/candidates?from=${from}&to=${to}`, { timeoutMs: 60_000 });
        if (r.sources?.[source] && r.sources[source].ok === false) { failed += 1; continue; }
        added += store.enqueue((r.items || []).filter((i) => i.source === source).map((i) => ({ ...i, origin: 'neuro' })));
      } catch { failed += 1; }
    }
    if (!failed) store.setState(key, new Date().toISOString());
    report[`${source}Sweep`] = { added, failed };
    report.added += added;
  }

  // 4. NOVA year re-sweep (31 Oct 2026). NOVA adds evidence sources by
  // shipping a new /perf-activity build (Jira replies, KPI decisions, AI
  // governance); the backfill passed those weeks long ago. When the build
  // NOVA reports differs from the one last swept, the year is re-read once.
  // Enqueue is idempotent on item id, so old kinds add nothing.
  try {
    const nova = require('./perf-nova');
    if (nova.isConfigured()) {
      const head = await nova.activity(addDays(today, -6), today);
      if (head.build && head.build !== store.getState('nova_activity_swept_build', null)) {
        let added = 0; let failed = 0;
        // A WEEK at a time: a month of Nick's Jira replies is past NOVA's 30 s query limit.
        for (let to = today; to > floor; to = addDays(to, -7)) {
          const from = addDays(to, -6) < floor ? floor : addDays(to, -6);
          try {
            const got = await nova.activity(from, to);
            if (got.failed.length) failed += 1;
            added += store.enqueue(got.items);
          } catch { failed += 1; }
        }
        if (!failed) store.setState('nova_activity_swept_build', head.build);
        report.novaSweep = { build: head.build, added, failed };
        report.added += added;
      }
    }
  } catch (e) { report.novaSweep = { error: e.message }; }
  return report;
}

// ── triage ───────────────────────────────────────────────────────────────────

function profileBlock(role) {
  if (!role) return null;
  const p = role.profile;
  return `${role.slot.toUpperCase()} ROLE — ${p.title}\n`
    // A skill whose note starts "Scope:" carries what Nick can actually influence —
    // the sorter needs it to recognise the evidence (e.g. leave approval as WFPL).
    + p.skills.map((s) => `  ${s.code} ${s.name} (target L${s.level})${/^Scope:/i.test(s.why || '') ? ` — ${String(s.why).slice(0, 200)}` : ''}`).join('\n');
}

/**
 * ⚠ Rewritten 29 Oct 2026 after Nick's review: the first version treated
 * lateness as evidence against, and a one-day slip on an SLA field Nick FOUND
 * AND FIXED was sorted as evidence against service level management. Judge the
 * substance of the work; timing is context, almost never the verdict.
 */
const TRIAGE_PROMPT = `You sort evidence of one manager's performance (Nick) against SFIA skills for his role(s).
For EACH item decide which skills its SUBSTANCE is genuine evidence of, for which role, and the stance.
Answer ONLY with JSON: {"items":[{"i":0,"tags":[{"slot":"current","code":"SLMO","stance":"for","why":"one short sentence"}]}]}
WHAT COUNTS
- Judge WHAT the work was, not when it was done. Finding and fixing a problem, building a process, analysing data, raising and resolving issues, running meetings, coaching, deciding — is evidence FOR the skill it exercises, whether or not it finished on its due date.
- Timing is context, never the verdict. A task finished late is still evidence FOR the skill its work shows. Lateness of up to 14 days is ignored completely.
- AGAINST needs the item itself to show a poor outcome attributable to Nick: a commitment to someone left open more than 14 days past due, work dropped, a decision of his that caused a problem, or a failure he owned. "Done late" is not that. A problem Nick discovered or fixed is never against him — finding it is the skill.
- Nick's own improvement goals (origin "improvement" or not classified) are never AGAINST for timing.
RULES
- Every item index must appear exactly once. tags:[] means it is not evidence of any listed skill.
- Use only the skill codes listed for each role, with that role's slot. An item can carry tags for both roles.
- Routine admin with no skill content gets tags:[]. A task is NOT routine admin when its title is service-desk work: identifying or reducing escalations, planning or preparing a project, evaluating a new support channel or tool, investigating or migrating a system, routing, quality, reporting, staffing. Judge a task by what its TITLE says the work is; the "Due … / Done … / still open" line is timing context only.
- A work meeting is evidence of the skills its TITLE shows (escalations, KPIs, capacity, quality, customers, process improvement, staffing...), even when its detail is short, missing or reads "Details withheld". Only a meeting that is not work (Nick's own personal appointments) or has no meaningful title gets tags:[].
- Commits are judged by what the work is FOR, not by which repo it is in. Tooling for the job — the service desk, the team, 1-2-1s, overtime and payroll, KPIs and reporting (weekly risk, SOAP), escalations, VANTAGE, NOVA — is evidence of the skills it serves. Features for Nick's personal life (nutrition, health, home, family, car, kiosk, watch, location, music, hobbies) are not.
- why: what in the item shows it. Never invent facts not in the item.`;

/** Validate the model's triage answer for a batch. Pure. Refuses the whole batch if any item is missing. */
function parseTriage(raw, batchSize, codesBySlot) {
  let j;
  try { j = require('./perf-json').parseModelJson(raw); } catch { throw new Error('unreadable JSON'); }
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

/** Bump when the sorting rules change: everything judged under an older version is re-read. */
const RULES_VERSION = 'r3'; // r3 (30 Oct 2026): tasks judged by their title, not as admin

/**
 * What the sorting depends on: the skills (code + level) in each role — NOT the
 * role's row id. A profile reworded with the same skills (29 Oct 2026, the HoTS
 * profile aligned to SFIA) must not re-buy a sort of the whole year; a skill
 * added, removed or re-levelled still does.
 */
function rolesKeyFor(roles) {
  const sig = (r) => (r ? r.profile.skills.map((x) => `${x.code}${x.level}`).sort().join('.') : '-');
  return `${RULES_VERSION}:${sig(roles.current)}/${sig(roles.future)}`;
}

/**
 * mode 'queued'   — read new items (the normal pass).
 * mode 'retriage' — re-read items already proposed or accepted that were judged
 *   under older rules or an older role profile. Nick's decisions stand: an
 *   accepted item stays accepted whatever the re-sort finds (30 Oct 2026). Manual entries are his
 *   own tagging and are never re-read.
 */
async function triage({ today = localKey(), mode = 'queued' } = {}) {
  const openrouter = require('./openrouter');
  const roles = { current: store.activeRole('current'), future: store.activeRole('future') };
  if (!roles.current && !roles.future) return { stopped: 'no-roles', judged: 0 };
  if (!openrouter.isConfigured()) return { stopped: 'no-model-key', judged: 0 };
  const codesBySlot = {
    current: new Set((roles.current?.profile.skills || []).map((s) => s.code)),
    future: new Set((roles.future?.profile.skills || []).map((s) => s.code)),
  };
  const rolesKey = rolesKeyFor(roles);
  const system = `${TRIAGE_PROMPT}\n\n${[profileBlock(roles.current), profileBlock(roles.future)].filter(Boolean).join('\n\n')}`;
  const c = caps();
  let judged = 0; let proposed = 0; let failures = 0;
  // ⚠ 29 Oct 2026: batches of 20 began failing as "unreadable JSON" once items
  // could carry tags for both roles — the answer ran out of room — and two
  // failures in a row ended the pass, so the re-sort never ran. Now: smaller
  // batches with more room; a failed batch is SPLIT and retried; an item that
  // fails on its own is skipped for THIS pass (and tried again next pass), never
  // dropped and never allowed to block the rest. A pass gives up only when the
  // model fails repeatedly on whole batches (an outage, not a bad item).
  const skipped = new Set();
  const pick = (n) => {
    const rows = mode === 'retriage' ? store.forRetriage(rolesKey, n + skipped.size) : store.queued(n + skipped.size);
    return rows.filter((e) => !skipped.has(e.id)).slice(0, n);
  };
  async function judge(batch) {
    const lines = batch.map((e, i) => JSON.stringify({ i, kind: e.kind, hint: e.hint, date: String(e.occurredAt || '').slice(0, 10), title: e.title, detail: String(e.detail || '').slice(0, 600) }));
    const reply = await openrouter.complete([
      { role: 'system', content: system },
      { role: 'user', content: lines.join('\n') },
    ], { temperature: 0.1, maxTokens: 6000, json: true, callType: 'perf_evidence' });
    return parseTriage(reply.text, batch.length, codesBySlot);
  }
  async function judgeSplitting(batch) {
    try {
      return [{ batch, tagsByIndex: await judge(batch) }];
    } catch (e) {
      console.warn(`[VANTAGE] perf triage batch of ${batch.length} failed: ${e.message}`);
      if (batch.length === 1) { skipped.add(batch[0].id); return []; }
      const mid = Math.ceil(batch.length / 2);
      return [...await judgeSplitting(batch.slice(0, mid)), ...await judgeSplitting(batch.slice(mid))];
    }
  }
  for (;;) {
    const room = c.dailyItems - itemsToday(today);
    if (room <= 0) return { stopped: 'item-cap', judged, proposed, failures, skipped: skipped.size };
    if (spentToday().usd >= c.dailyUsd) return { stopped: 'spend-cap', judged, proposed, failures, skipped: skipped.size };
    const batch = pick(Math.min(BATCH, room));
    if (!batch.length) return { stopped: mode === 'retriage' ? 'retriage-done' : 'queue-empty', judged, proposed, failures, skipped: skipped.size };
    const parts = await judgeSplitting(batch);
    if (!parts.length) {
      failures += 1;
      if (failures >= 3) return { stopped: 'model-failed', error: 'the model could not answer three whole batches', judged, proposed, failures, skipped: skipped.size };
      continue;
    }
    failures = 0;
    for (const { batch: b, tagsByIndex } of parts) {
      for (const [i, tags] of tagsByIndex) {
        if (mode === 'retriage') store.setRetriage(b[i].id, { tags, rolesKey });
        else store.setTriage(b[i].id, { state: tags.length ? 'proposed' : 'not-relevant', tags, rolesKey });
        if (tags.length) proposed += 1;
      }
      judged += b.length;
      bumpItems(b.length, today);
    }
  }
}

/** One full pass: gather, then triage within the caps. Never two at once. */
async function run(reason = 'timer') {
  if (running) return { skipped: 'already running' };
  running = true;
  const started = Date.now();
  // Recorded at the START, so a pass cut off by a restart is visible as
  // interrupted rather than leaving the previous pass's result on screen.
  store.setState('last_run', { reason, at: new Date(started).toISOString(), inProgress: true });
  try {
    const g = await gather();
    const t = await triage();
    const rt = (t.stopped === 'queue-empty') ? await triage({ mode: 'retriage' }) : null;
    const out = { reason, gather: g, triage: t, retriage: rt, ms: Date.now() - started, at: new Date().toISOString() };
    if (overrideOn() && g.backfill?.done && store.counts().queued === 0 && rt?.stopped === 'retriage-done') {
      store.setState('backfill_override', { on: false, at: out.at, by: 'auto', reason: 'backfill complete' });
      out.overrideEnded = true;
    }
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
    override: store.getState('backfill_override', null),
    counts: store.counts(),
    retriageLeft: (() => {
      const roles = { current: store.activeRole('current'), future: store.activeRole('future') };
      return roles.current || roles.future ? store.retriageLeft(rolesKeyFor(roles)) : 0;
    })(),
    backfill: { cursor: store.getState('backfill_cursor', null), floorDays: BACKFILL_DAYS },
    lastRun: store.getState('last_run', null),
    lastSources: store.getState('last_sources', null),
    running,
  };
}

module.exports = { rolesKeyFor, run, gather, triage, status, setCaps, caps, setBackfillOverride, OVERRIDE_CAPS, isNoise, parseTriage, DEFAULT_CAPS, _internals: { addDays, fetchWindow } };
