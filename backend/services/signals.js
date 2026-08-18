'use strict';

/**
 * Service desk signals, read from NOVA's bridge.
 *
 * VANTAGE does not compute these. NOVA owns them, and a second implementation
 * would drift from the one feeding the weekly report — which is the report that
 * goes to Nick's manager. This is a reader, nothing more.
 *
 * Cached because the endpoint is deliberately sequential against a DTU-limited
 * Azure SQL instance and takes 60–110 seconds. Refetching that on every page
 * load would be unkind to a production database that is also serving the actual
 * service desk.
 */

const BUILD_EXPECTED = '2026-08-18-classifier-b';
const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 150_000;

let cache = { at: 0, data: null };

function isConfigured() {
  return Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

async function fetchFlow(days = 30) {
  const base = (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '')
    .replace(/\/$/, '');

  const res = await fetch(`${base}/api/neuro-bridge/flow-signals?days=${days}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NOVA returned ${res.status}`);
  }
  return payload.data;
}

/**
 * A one-line-per-signal summary, for the coach's system prompt and the UI.
 *
 * Every unavailable signal is named. The coach must never be handed a partial
 * picture that reads as a complete one — it would give confident advice about a
 * department it cannot fully see.
 */
function summarise(flow) {
  const lines = [];
  const h = flow.handbacks;
  if (h?.ok) {
    lines.push(
      `- Rejections (evidenced): ${h.data.total} in ${flow.window.days}d`
      + ` (previous ${h.data.previous}${h.data.changePct === null ? '' : `, ${h.data.changePct > 0 ? '+' : ''}${h.data.changePct}%`}).`
      + ` Returns after a released fix: ${h.data.returnsAfterFix}. Unclassified moves: ${h.data.unclassified}.`,
    );
    if (h.data.reasons?.top?.length) {
      lines.push(`- Top rejection reasons: ${h.data.reasons.top.slice(0, 3).map(r => `"${r.reason}" (${r.count})`).join(', ')}`);
    }
  } else lines.push(`- Rejections: UNAVAILABLE (${h?.error || 'not returned'})`);

  const p = flow.pingPong;
  lines.push(p?.ok
    ? `- Ping-pong: ${p.data.ticketsAffected} tickets crossed queues ${p.data.threshold}+ times`
      + (p.data.worst?.[0] ? `; worst ${p.data.worst[0].ticket_key} at ${p.data.worst[0].moves} moves` : '')
    : `- Ping-pong: UNAVAILABLE (${p?.error || 'not returned'})`);

  const b = flow.breachesByQueue;
  lines.push(b?.ok
    ? `- Open tickets over SLA: ${b.data.total} of ${b.data.openTickets} open`
      + (b.data.byTier?.[0] ? `; most in ${b.data.byTier[0].tier} (${b.data.byTier[0].breaches})` : '')
      + `. This is a snapshot by CURRENT queue, not breaches-by-queue-at-time-of-breach.`
    : `- Over SLA: UNAVAILABLE (${b?.error || 'not returned'})`);

  const u = flow.unowned;
  lines.push(u?.ok
    ? `- Open with no assignee: ${u.data.total}`
      + (u.data.byTier?.[0] ? `; worst ${u.data.byTier[0].tier} ${u.data.byTier[0].count}, oldest ${u.data.byTier[0].oldest_days}d` : '')
    : `- Unowned: UNAVAILABLE (${u?.error || 'not returned'})`);

  const s = flow.stalled;
  lines.push(s?.ok
    ? `- Untouched ${s.data.staleDays}+ days: ${s.data.total}`
      + (s.data.worst?.[0] ? `; worst ${s.data.worst[0].issue_key} at ${s.data.worst[0].days_untouched}d` : '')
    : `- Stalled: UNAVAILABLE (${s?.error || 'not returned'})`);

  lines.push(`- Scope: project ${flow.scope?.projects?.join(', ') || 'unknown'}`
    + (flow.scope?.excluded?.length ? ` (excludes ${flow.scope.excluded.map(e => e.project).join(', ')})` : ''));

  return lines.join('\n');
}

/**
 * Current signals, cached.
 *
 * NEVER throws. Callers render it, and an exception here would take down the
 * dashboard over a slow database. Unavailability is a first-class state carrying
 * its own reason — same contract as everything else in this chain.
 */
async function current({ force = false } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured (NOVA_BRIDGE_URL / NOVA_BRIDGE_SECRET)' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const flow = await fetchFlow();

    // A build we do not recognise counts every downward tier move as a
    // rejection. Its numbers are wrong in a specific direction — overstating
    // friction — so they are refused rather than shown with a caveat nobody
    // reads.
    if (flow.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on build "${flow.build || 'unknown'}"; VANTAGE reads "${BUILD_EXPECTED}". Redeploy NOVA.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const data = {
      available: true,
      asOf: new Date().toISOString(),
      window: flow.window,
      scope: flow.scope,
      summary: summarise(flow),
      raw: flow,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    // Cached-but-stale beats nothing, as long as it says which it is.
    if (cache.data?.available) {
      return { ...cache.data, stale: true, staleReason: err.message };
    }
    return { available: false, reason: err.message };
  }
}

module.exports = { current, summarise, isConfigured, BUILD_EXPECTED };
