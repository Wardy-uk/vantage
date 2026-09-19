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
 * 1. **`overall` is never read alone.** Two flags qualify it, and they mean
 *    different things: `controlsHealthy: false` says the checker is BLIND, so
 *    nothing on the report is evidence including the greens; `trustworthy:
 *    false` on its own says a section could not be evaluated, so what ran is
 *    sound but does not cover what the report claims. Rendering either as a
 *    green tick is the exact failure both systems are built against; rendering
 *    them as the same sentence would be the smaller version of it.
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

/**
 * The build this reader was written against. INFORMATION, not a gate.
 *
 * ⚠ It used to be a gate — strict equality, refuse anything else — and that was
 * wrong here. The stamp moved four times in a day while two sessions iterated
 * (-a, -b, -d, -e), and each time VANTAGE reported NOVA's health as an
 * unreadable blind spot on the screen Nick checks daily. The last of those,
 * -e, was a PERFORMANCE fix: "stop the health check scanning 723MB to ask what
 * time it is". The public contract was byte-identical to -d. It could not have
 * affected this reader, and it blocked it anyway.
 *
 * The stamp conflates two different facts — "the internals changed" and "the
 * shape changed" — and only the second one concerns a consumer. Strict equality
 * is right for a stable contract (`flow-signals` has moved once in a month) and
 * actively harmful for one under construction: it converts every upstream
 * improvement into a downstream outage.
 *
 * So the gate is now `readable()`, which checks the FIELDS THIS READER ACTUALLY
 * USES. That keeps the protection the stamp was introduced for — a stale `dist`
 * once served a plausible response with new fields silently `undefined`, and a
 * field read as undefined renders as a confident blank — while not caring
 * whether someone made a query faster.
 *
 * A mismatched stamp on a readable response is still reported, as a note beside
 * the data rather than instead of it.
 */
const BUILD_WRITTEN_AGAINST = '2026-09-18-e';

/**
 * Can this response be read at all?
 *
 * Every field named here is one `toRadar` or `allChecks` dereferences. If NOVA
 * drops or renames one, this catches it by NAME and says which — which is more
 * use than a version mismatch, and is the thing the version was standing in for.
 *
 * Deliberately NOT a full schema check. Extra fields are fine and expected; the
 * `database` section arrived that way. The question is only whether what this
 * reader depends on is present and the right kind of thing.
 */
function readable(raw) {
  const missing = [];
  if (!raw || typeof raw !== 'object') return { ok: false, missing: ['the response body'] };

  if (typeof raw.overall !== 'string') missing.push('overall');
  if (typeof raw.trustworthy !== 'boolean') missing.push('trustworthy');
  // `controlsHealthy` arrived in -b and is what separates "the checker is
  // blind" from "the report is incomplete". Without it the consumer cannot
  // tell those apart, which is the distinction it exists to draw.
  if (typeof raw.controlsHealthy !== 'boolean') missing.push('controlsHealthy');
  if (!Array.isArray(raw.unavailable)) missing.push('unavailable');

  for (const section of ['tables', 'columns', 'jobs']) {
    const sig = raw[section];
    if (!sig || typeof sig !== 'object') { missing.push(section); continue; }
    // The Signal<T> envelope, which is the contract both sides agreed on.
    if (typeof sig.ok !== 'boolean') missing.push(`${section}.ok`);
  }

  return { ok: missing.length === 0, missing };
}
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

    // The gate is the SHAPE, not the version. See `BUILD_WRITTEN_AGAINST`.
    const shape = readable(raw);
    if (!shape.ok) {
      const unusable = {
        available: false,
        reason: `NOVA's health report is missing ${shape.missing.join(', ')} — this reader cannot use it. `
          + `NOVA is on build "${raw?.build || 'unknown'}", written against "${BUILD_WRITTEN_AGAINST}". `
          + 'Either NOVA is serving a stale build, or the contract changed and this reader needs updating.',
      };
      cache = { at: Date.now(), data: unusable };
      return unusable;
    }

    const data = {
      available: true,
      asOf: new Date().toISOString(),
      raw,
      // Reported beside the data rather than instead of it. A newer NOVA whose
      // shape this reader still understands is worth reading, and worth saying
      // so about — it may carry a section nobody here has taught it to render.
      buildNote: raw.build === BUILD_WRITTEN_AGAINST
        ? null
        : `NOVA is on build "${raw.build}"; this reader was written against "${BUILD_WRITTEN_AGAINST}". Everything it reads is present, so the report is being used — but a newer build may carry checks this screen does not yet show.`,
    };
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

  // The DATABASE section, added in build -d by a third session chasing the
  // timeout that started all this. Enumerated explicitly rather than skipped:
  // a section this reader does not understand is a section whose failures do
  // not reach the screen, which is the quiet kind of gap.
  const db = raw?.database?.data;
  if (db) {
    if (db.pool) out.push({ kind: 'database', name: 'connection pool', severity: db.pool.severity, verdict: db.pool.note, unverified: false });
    if (db.resource) out.push({ kind: 'database', name: 'DTU headroom', severity: db.resource.severity, verdict: db.resource.note, unverified: false });
    // ⚠ `staleStatsReadable: false` is the report's own absent-is-not-zero
    // guard: an empty list of stale statistics and a DMV that could not be read
    // are opposite facts. Only the first is good news.
    if (db.staleStatsReadable === false) {
      out.push({ kind: 'database', name: 'stale statistics', severity: 'unknown',
        verdict: 'the statistics DMV could not be read, so an empty list here is not evidence that nothing is stale', unverified: false });
    } else {
      for (const st of db.staleStats || []) {
        out.push({ kind: 'database', name: `stats ${st.table}.${st.stat}`, severity: st.severity,
          verdict: `${st.modifications.toLocaleString()} modifications against ${st.rows.toLocaleString()} rows`, unverified: false });
      }
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
        reason: `NOVA's self-report could not be read — ${String(state?.reason || 'unknown').replace(/\.\s*$/, '')}. Nothing below reflects whether NOVA's own capture is working.`,
      }],
    };
  }

  const raw = state.raw;
  const checks = allChecks(raw);
  const blind = [];
  const items = [];

  // A readable-but-newer build. Not a refusal, but not silence either: if NOVA
  // has added a section, this screen is not showing it and should say so.
  if (state.buildNote) {
    blind.push({ name: 'nova-health (newer build)', reason: state.buildNote });
  }

  // ⚠ RULE 1 — and build -b split it into two, because the two causes want
  // genuinely different reactions:
  //
  //   controlsHealthy: false   the checker is BLIND. Nothing on the report is
  //                            evidence, including everything that came back
  //                            green.
  //   trustworthy: false only  what ran is sound; it just does not cover
  //                            everything the report claims to. Incomplete
  //                            rather than wrong.
  //
  // One sentence for both would tell Nick the numbers are worthless when they
  // are merely partial, and those are not the same problem or the same fix.
  if (raw.controlsHealthy === false) {
    blind.push({
      name: 'nova-health (blind)',
      reason: 'NOVA\'s own positive controls are unhealthy, so the checker cannot see — the checks that came back clean are not evidence of anything. Treat NOVA\'s instrumentation as unknown until this clears.',
    });
  } else if (raw.trustworthy === false) {
    blind.push({
      name: 'nova-health (partial)',
      reason: 'NOVA\'s controls are healthy, so what it did check is sound — but at least one section could not be evaluated, so the report does not cover everything it claims to. Incomplete rather than wrong.',
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

  return { items, blind, overall: raw.overall, trustworthy: raw.trustworthy, controlsHealthy: raw.controlsHealthy };
}

module.exports = { current, toRadar, allChecks, readable, isConfigured, BUILD_WRITTEN_AGAINST };
