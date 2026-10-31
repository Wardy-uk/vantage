'use strict';

/**
 * Performance evidence from NOVA (29 Oct 2026, Nick: "it also needs to look at
 * NOVA for evidence").
 *
 * Read over the existing bridge, GET only, like signals.js. Three sources, each
 * about Nick's OWN work as a manager:
 *
 *  - 1-2-1s he held (`/121/completed`), with how many actions were agreed and how
 *    many earlier ones were reviewed as delivered or missed.
 *  - Escalations raised under his name (`/escalations?type=manual`, filtered to
 *    `escalated_by` naming him).
 *  - The department's weekly results against target (`/kpi-org-period`) — the
 *    outcomes his role is judged on.
 *
 * ⚠ Deliberately NOT read: any per-agent ticket count. `context/role.md` is
 * explicit that ticket counts are verification inputs, never performance
 * judgements, and that rule holds when the person being judged is Nick.
 *
 * A source that fails is a named gap. A week whose KPI period has not finished
 * is not emitted (a half week reads as a bad week).
 */

const TIMEOUT_MS = 30_000;
const ME = /\bnick(\s+ward)?\b/i;

function base() {
  return (process.env.NOVA_BRIDGE_URL || '').replace(/\/api\/neuro-bridge\/?$/, '').replace(/\/$/, '');
}
const isConfigured = () => Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);

async function get(pathAndQuery) {
  const res = await fetch(`${base()}/api/neuro-bridge${pathAndQuery}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `NOVA returned ${res.status}`);
  return payload.data;
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ── shapers (pure) ───────────────────────────────────────────────────────────

/**
 * ⚠ The bridge's `completedAt` is a DISPLAY string ("Tue Mar 10" — no year),
 * because NOVA slices the first 10 characters of a JS Date's toString. Compared
 * as a date it matched nothing, so VANTAGE read ZERO 1-2-1s for a year while
 * NOVA held them all (29 Oct 2026). NEURO's nova-121-writeback learned this in
 * a five-night outage: use completedAt only when it IS a date, else scheduledDate.
 */
const isoDay = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
const sessionDay = (s) => isoDay(s.completedAt) || isoDay(s.scheduledDate);

function oneToOneItems(sessions, from, to) {
  return (sessions || []).map((s) => ({ ...s, completedAt: sessionDay(s) }))
    .filter((s) => s.completedAt && s.completedAt >= from && s.completedAt <= to).map((s) => {
    const delivered = (s.reviewedActions || []).filter((a) => a.status === 'delivered').length;
    const missed = (s.reviewedActions || []).filter((a) => a.status === 'missed').length;
    const agreed = (s.actions || []).length;
    return {
      origin: 'nova', id: `121:${s.sessionId}`, kind: '121-held', hint: 'for',
      at: `${s.completedAt}T12:00:00`,
      title: `1-2-1 held with ${s.agentName}`,
      detail: clip(`${agreed} action(s) agreed.${delivered || missed ? ` Earlier actions reviewed: ${delivered} delivered, ${missed} missed.` : ''}`, 700),
      // ⚠ Never the session notes: a 1-2-1 is a colleague's conversation (health,
      // personal circumstances). That it was held, and what was agreed, is the evidence.
      ref: `nova:121:${s.sessionId}`,
    };
  });
}

function escalationItems(rows, from, to) {
  return (rows || []).filter((e) => ME.test(String(e.escalated_by || '')))
    .filter((e) => { const d = String(e.created_at || '').slice(0, 10); return d >= from && d <= to; })
    .map((e) => ({
      origin: 'nova', id: `esc:${e.escalation_id}`, kind: 'escalation-raised', hint: null,
      at: e.created_at,
      title: `Escalated ${e.ticket_key}${e.to_tier ? ` to ${e.to_tier}` : ''}: ${e.reason_label || e.reason_code || 'no reason given'}`,
      detail: clip(e.notes || '', 500) || null,
      ref: `jira:${e.ticket_key}`,
    }));
}

function kpiWeekItem(period, anchor) {
  const rows = (period?.kpis || []).filter((k) => !k.rebuilding && k.value != null);
  if (!rows.length) return null;
  const line = (k) => `${k.label}: ${k.value}${k.unit === '%' ? '%' : k.unit ? ` ${k.unit}` : ''}${k.target != null ? ` (target ${k.target}${k.unit === '%' ? '%' : ''}${k.rag ? `, ${k.rag}` : ''})` : ''}`;
  const red = rows.filter((k) => k.rag === 'red').length;
  const green = rows.filter((k) => k.rag === 'green').length;
  return {
    origin: 'nova', id: `kpi-week:${anchor}`, kind: 'department-kpis', hint: null,
    at: `${anchor}T18:00:00`,
    title: `Department results, week to ${anchor}: ${green} on target, ${red} red`,
    detail: clip(rows.map(line).join('; '), 900),
    ref: `nova:kpi-org-period:${anchor}`,
  };
}

/** Sundays in [from, to] that are before `today` (the week has finished). Pure. */
function finishedSundays(from, to, today) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  for (; d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 7)) {
    const k = d.toISOString().slice(0, 10);
    if (k < today) out.push(k);
  }
  return out;
}

// ── read ─────────────────────────────────────────────────────────────────────

let escCache = { at: 0, rows: null };

/** Items for a window, with a per-source answered/gap record. Never throws. */
async function candidates({ from, to, today }) {
  const sources = {};
  const items = [];
  if (!isConfigured()) {
    for (const k of ['nova-121', 'nova-escalations', 'nova-kpis']) sources[k] = { ok: false, error: 'NOVA bridge not configured' };
    return { items, sources };
  }
  try {
    const d = await get(`/121/completed?since=${from}`);
    const got = oneToOneItems(d?.sessions, from, to);
    items.push(...got); sources['nova-121'] = { ok: true, count: got.length };
  } catch (e) { sources['nova-121'] = { ok: false, error: e.message }; }

  try {
    if (!escCache.rows || Date.now() - escCache.at > 30 * 60_000) {
      escCache = { at: Date.now(), rows: await get('/escalations?days=365&type=manual') };
    }
    const got = escalationItems(escCache.rows, from, to);
    items.push(...got); sources['nova-escalations'] = { ok: true, count: got.length };
  } catch (e) { sources['nova-escalations'] = { ok: false, error: e.message }; }

  const weeks = finishedSundays(from, to, today);
  let kOk = 0; let kErr = null;
  for (const anchor of weeks) {
    try {
      const it = kpiWeekItem(await get(`/kpi-org-period?period=week&anchor=${anchor}`), anchor);
      if (it) items.push(it);
      kOk += 1;
    } catch (e) { kErr = e.message; }
  }
  sources['nova-kpis'] = kErr && !kOk ? { ok: false, error: kErr } : { ok: true, count: kOk, ...(kErr ? { partial: kErr } : {}) };

  // Nick's own activity in NOVA (v1.1.763, 29 Oct 2026): 1-2-1 commitments, people
  // conversations (fact and category only), standups, escalation and Dev Review
  // decisions, AI oversight, KB, MI and ops packs, triage, leave approvals, workforce
  // changes, customer and cross-team work, backlog, NOVA commits. NOVA screens and
  // folds it; every one of its sources is reported here under its own name.
  try {
    const d = await get(`/perf-activity?from=${from}&to=${to}`);
    const got = (d?.items || []).map((i) => ({ ...i, origin: 'nova', id: `act:${i.id}` }));
    items.push(...got);
    for (const [k, v] of Object.entries(d?.sources || {})) sources[`nova-${k}`] = v;
  } catch (e) {
    // An unknown route on NOVA falls through to its JWT middleware and answers
    // "Not authenticated" — which is what /perf-activity looks like before v1.1.763
    // is deployed. Said plainly rather than passed on as an auth fault.
    sources['nova-activity'] = { ok: false, error: /404|Cannot GET|Not authenticated/i.test(e.message) ? 'not deployed on NOVA yet (needs v1.1.763)' : e.message };
  }
  return { items, sources };
}

/** One window of Nick's NOVA activity alone, with NOVA's build stamp (for the year re-sweep). */
async function activity(from, to) {
  const d = await get(`/perf-activity?from=${from}&to=${to}`);
  return { build: d?.build || null, items: (d?.items || []).map((i) => ({ ...i, origin: 'nova', id: `act:${i.id}` })) };
}

module.exports = { candidates, activity, isConfigured, _internals: { oneToOneItems, escalationItems, kpiWeekItem, finishedSundays } };
