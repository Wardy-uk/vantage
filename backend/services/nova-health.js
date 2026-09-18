'use strict';

/**
 * NOVA reporting on its own machinery, read over the bridge.
 *
 * ── Why VANTAGE cares ───────────────────────────────────────────────────────
 *
 * Every number on the radar comes from NOVA. A NOVA table that quietly stopped
 * being written does not make the radar wrong in a visible way — it makes it
 * CONFIDENTLY wrong, which is worse. This is the layer below all the detectors:
 * not "is the department in trouble" but "is the instrument still working".
 *
 * It exists because of a specific failure. On 14 Sep a fault sent FRT breaches
 * from ~5 a day to 45 and nothing reported it; while chasing that, six NOVA
 * tables turned out to have writers and no rows, two more had stopped weeks
 * earlier, and two columns were constants. None of it announced itself.
 *
 * ── The three rules this consumer owes the producer ─────────────────────────
 *
 * The NOVA side asked for these explicitly and they are the whole reason the
 * report is worth having:
 *
 * 1. **`overall` is never read without `trustworthy`.** A report whose positive
 *    controls are themselves unhealthy is not evidence that NOVA is fine; it is
 *    evidence that the checker cannot see. Rendering that as a green tick is
 *    the exact failure both systems are built against.
 *
 * 2. **`unknown` is NOT `ok`.** It means "could not evaluate". Collapsing the
 *    two is the bug this whole estate keeps relearning — `sla_breached` read as
 *    a clean month, a missing day read as zero arrivals, an unwritten table read
 *    as nothing to report.
 *
 * 3. **`warmingUp` means NO job information, not healthy jobs.** NOVA's job
 *    registry holds `lastRun` in memory, so a restart makes every job look
 *    never-run. A consumer that read that as fine would be reassured precisely
 *    when it had least reason to be.
 *
 * Read-only, cached, and it never throws.
 */

/** The NOVA build whose shape this reader understands. */
const BUILD_EXPECTED = '2026-09-18-a';
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 120_000;

let cache = { at: 0, data: null };

const isConfigured = () => Boolean(process.env.NOVA_BRIDGE_URL && process.env.NOVA_BRIDGE_SECRET);

function base() {
  return (process.env.NOVA_BRIDGE_URL || '')
    .replace(/\/api\/neuro-bridge\/?$/, '').replace(/\/$/, '');
}

/**
 * Current NOVA self-report.
 *
 * NEVER throws. An unreadable health report is itself a health finding, and it
 * comes back as a state with a reason rather than as an exception that would
 * take the radar down — which would be an ironic way for a monitoring feature
 * to fail.
 */
async function current({ force = false } = {}) {
  if (!isConfigured()) return { available: false, reason: 'NOVA bridge not configured' };
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  try {
    const res = await fetch(`${base()}/api/neuro-bridge/health-signals`, {
      headers: { 'x-neuro-bridge-secret': process.env.NOVA_BRIDGE_SECRET },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload?.ok === false) {
      throw new Error(payload?.error || `NOVA returned ${res.status}`);
    }
    const raw = payload.data;

    if (raw.build !== BUILD_EXPECTED) {
      const stale = {
        available: false,
        reason: `NOVA is on health-signals build "${raw.build || 'unknown'}"; VANTAGE reads "${BUILD_EXPECTED}". Redeploy NOVA, or update this reader if the shape changed deliberately.`,
      };
      cache = { at: Date.now(), data: stale };
      return stale;
    }

    const data = { available: true, asOf: new Date().toISOString(), raw };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    // Stale-but-labelled beats nothing; nothing beats a false all-clear.
    if (cache.data?.available) return { ...cache.data, stale: true, staleReason: err.message };
    return { available: false, reason: err.message };
  }
}

/** Every check the report carries, flattened. PURE. */
function allChecks(raw) {
  const out = [];
  for (const t of raw?.tables?.data || []) {
    out.push({ kind: 'table', name: t.table, severity: t.severity, verdict: t.verdict, unverified: Boolean(t.unverified) });
  }
  for (const c of raw?.columns?.data || []) {
    out.push({ kind: 'column', name: `${c.table}.${c.column}`, severity: c.severity, verdict: c.verdict, unverified: false });
  }
  // ⚠ Jobs are INCLUDED only when the process has been up long enough for them
  // to mean anything. `warmingUp` is no information, and no information must
  // not arrive as a clean bill of health.
  const jobs = raw?.jobs?.data;
  if (jobs && !jobs.warmingUp) {
    for (const j of jobs.jobs || []) {
      out.push({ kind: 'job', name: j.id, severity: j.severity, verdict: j.verdict, unverified: false });
    }
  }
  return out;
}

/**
 * NOVA's self-report as radar material. PURE.
 *
 * Two outputs, because the report says two different kinds of thing:
 *
 *   CARDS   a FAILING check — something that was working has stopped, or a
 *           column is a constant. Tense `happening`: it is wrong now and can be
 *           fixed now.
 *   BLIND   everything that could not be evaluated, plus the whole report when
 *           it is untrustworthy. These belong in the blind-spots banner rather
 *           than as cards, because they are statements about what the screen
 *           CANNOT see — which is what that banner is for.
 *
 * `warn` produces neither. A table a day late is not worth a card on a screen
 * built to hold five, and it is visible in the full report for anyone looking.
 */
function toRadar(state) {
  if (!state?.available) {
    return {
      items: [],
      blind: [{
        name: 'nova-health',
        reason: `NOVA's self-report could not be read — ${state?.reason || 'unknown'}. Nothing below reflects whether NOVA's own capture is working.`,
      }],
    };
  }

  const raw = state.raw;
  const checks = allChecks(raw);
  const blind = [];
  const items = [];

  // ⚠ RULE 1. The controls are unhealthy, so the greens mean nothing. This goes
  // first and it goes in the banner, because it invalidates the rest of the
  // report rather than adding to it.
  if (raw.trustworthy === false) {
    blind.push({
      name: 'nova-health (untrustworthy)',
      reason: 'NOVA\'s own positive controls are unhealthy, so its health report cannot be believed — the checks that came back clean are not evidence of anything. Treat NOVA\'s instrumentation as unknown until this clears.',
    });
  }

  for (const s of raw.unavailable || []) {
    blind.push({ name: `nova-health: ${s.name}`, reason: s.error || 'section could not be evaluated' });
  }

  // ⚠ RULE 3. Said out loud rather than silently omitted — a reader who sees no
  // job findings should know whether that is because there are none or because
  // nobody could look.
  if (raw.jobs?.data?.warmingUp) {
    blind.push({
      name: 'nova-health: jobs',
      reason: `NOVA restarted ${Math.round((raw.jobs.data.uptimeSeconds || 0) / 60)} minutes ago and its job history is held in memory only, so no job can yet be said to have run or not run.`,
    });
  }

  // ⚠ RULE 2. `unknown` is a blind spot, never a pass.
  const unknowns = checks.filter(c => c.severity === 'unknown');
  if (unknowns.length) {
    blind.push({
      name: 'nova-health: not evaluated',
      reason: `${unknowns.length} NOVA check${unknowns.length === 1 ? '' : 's'} could not be evaluated: ${unknowns.map(u => u.name).join(', ')}. Not evaluated is not the same as fine.`,
    });
  }

  const failures = checks.filter(c => c.severity === 'fail');
  if (failures.length) {
    // One card, not one per failure. Six dead tables is a single fact about
    // NOVA's capture, and six cards would push every department signal off a
    // screen that holds five.
    const worst = failures.slice(0, 4);
    items.push({
      tense: 'happening',
      severity: failures.length > 2 ? 'high' : 'medium',
      title: `${failures.length} of NOVA's own checks ${failures.length === 1 ? 'is' : 'are'} failing`,
      detail: `${worst.map(f => `${f.name}: ${f.verdict}`).join(' · ')}${failures.length > worst.length ? ` · and ${failures.length - worst.length} more` : ''}. `
        + 'This is the instrument rather than the department — every figure on this screen comes from NOVA, and a capture that has stopped makes the numbers confidently wrong rather than visibly wrong.',
      source: 'NOVA health',
      remedy: 'Open NOVA\'s Health page. These are tables, columns or jobs, not tickets — the fix is a switch, a credential or a scheduler, and none of it gets better by being left.',
    });
  }

  return { items, blind, overall: raw.overall, trustworthy: raw.trustworthy };
}

module.exports = { current, toRadar, allChecks, isConfigured, BUILD_EXPECTED };
