'use strict';

/**
 * Sentiment, read from NOVA's bridge.
 *
 * VANTAGE does not compute or blend these. NOVA returns four separate measures
 * with different scales and populations, and the one thing this layer must not
 * do is average them into a single "sentiment score" — that number would be
 * comforting, portable, and meaningless.
 *
 * Cached: the underlying queries are sequential against a busy database, and
 * sentiment does not move minute to minute.
 */

const BUILD_EXPECTED = '2026-08-19-sentiment-a';
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 120_000;

let cache = { at: 0, data: null };

function isConfigured() {
  return Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);
}

async function fetchSentiment(days = 30) {
  const base = (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '').replace(/\/$/, '');

  const res = await fetch(`${base}/api/neuro-bridge/sentiment-signals?days=${days}`, {
    headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `NOVA returned ${res.status}`);
  return payload.data;
}

/** Never throws. Unavailability is a state with a reason, not an exception. */
async function current({ force = false, days = 30 } = {}) {
  if (!isConfigured()) {
    return { available: false, reason: 'NOVA bridge not configured' };
  }
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const raw = await fetchSentiment(days);
    if (raw.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA sentiment build "${raw.build || 'unknown'}"; VANTAGE reads "${BUILD_EXPECTED}". Redeploy NOVA.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }
    const data = { available: true, asOf: new Date().toISOString(), raw };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    if (cache.data?.available) return { ...cache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}

/**
 * Sentiment as radar items.
 *
 * Only the things that warrant an action. A CSAT average is a number for a
 * dashboard; an angry customer with a ticket number is something to do
 * something about today, which is what this screen is for.
 */
function toRadarItems(sentiment) {
  if (!sentiment?.available) return [];
  const raw = sentiment.raw;
  const out = [];

  const ai = raw.ai;
  if (ai?.ok && ai.data?.negative > 0) {
    const worst = ai.data.worst || [];
    out.push({
      tense: 'happening',
      severity: worst.some(w => w.score <= -0.7) ? 'high' : 'medium',
      title: `${ai.data.negative} customers sound unhappy on open problem tickets`,
      detail: `${worst.slice(0, 3).map(w => `${w.ticket} (${w.score})`).join(', ')}. `
        + 'Inferred from ticket comments, and only on tickets that already tripped a problem rule — '
        + 'so this is the worst of the bad, not a view of customers in general.',
      source: 'Sentiment',
    });
  }

  const p = raw.portalCsat;
  if (p?.ok && p.data) {
    // A response rate this low is a finding about the survey, not about
    // customers — and it is the reason no CSAT number here can carry weight.
    if (p.data.sent > 20 && p.data.responseRatePct !== null && p.data.responseRatePct < 10) {
      out.push({
        tense: 'happening',
        severity: 'medium',
        title: `Only ${p.data.responseRatePct}% of CSAT surveys are being answered`,
        detail: `${p.data.responded} of ${p.data.sent} sent. Any satisfaction figure drawn from this is a statement about the few who replied, and should not be quoted as customer satisfaction.`,
        source: 'Sentiment',
      });
    }
    if (p.data.thin && p.data.sent > 0) {
      out.push({
        tense: 'could',
        severity: 'low',
        title: 'CSAT sample too thin to report',
        detail: `${p.data.responded} responses in the window. Scores are withheld below 10 rather than shown with a caveat — but it does mean customer satisfaction is currently unmeasured, which is itself worth knowing.`,
        source: 'Sentiment',
      });
    }
  }

  const s = raw.surveys;
  if (s?.ok && s.data) {
    const cats = Object.entries(s.data.byCategory || {});
    if (!cats.length) {
      out.push({
        tense: 'could',
        severity: 'medium',
        title: 'No team or account-manager sentiment has ever been measured',
        detail: 'The Support Review flagged morale, trust and retention as significant risks and noted low confidence that previous feedback led to change. Nothing currently measures whether that is improving or worsening.',
        source: 'Sentiment',
      });
    } else {
      for (const [cat, runs] of cats) {
        const latest = runs[runs.length - 1];
        const prior = runs[runs.length - 2];
        if (latest?.avgScore !== null && prior?.avgScore !== null && latest && prior) {
          const delta = Math.round((latest.avgScore - prior.avgScore) * 100) / 100;
          if (delta <= -0.3) {
            out.push({
              tense: 'happening',
              severity: 'high',
              title: `${cat.replace(/_/g, ' ')} satisfaction fell ${Math.abs(delta)} points`,
              detail: `${prior.avgScore} → ${latest.avgScore} out of 5, across ${latest.responses} responses. A move this size between runs is a change in how people feel, not noise.`,
              source: 'Sentiment',
            });
          }
        }
      }
    }
  }

  return out;
}

module.exports = { current, toRadarItems, isConfigured, BUILD_EXPECTED };
