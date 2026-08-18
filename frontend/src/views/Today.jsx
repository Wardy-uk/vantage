import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The dashboard.
 *
 * Every tile can render "unavailable" and none can render a zero it did not
 * measure — the same contract the weekly report holds, for the same reason: a
 * false all-clear is worse than a blank.
 */

function Metric({ n, label, detail, tone }) {
  return (
    <div className={`metric${tone ? ` ${tone}` : ''}`}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
      {detail && <div className="d">{detail}</div>}
    </div>
  );
}

export default function Today() {
  const [signals, setSignals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = async (force = false) => {
    force ? setRefreshing(true) : setLoading(true);
    try {
      setSignals(await api.signals(force));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="empty">Loading signals…</div>;

  const flow = signals?.raw;
  const h = flow?.handbacks;
  const p = flow?.pingPong;
  const b = flow?.breachesByQueue;
  const u = flow?.unowned;
  const s = flow?.stalled;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      {signals && !signals.available && (
        <div className="banner warn">
          <strong>Signals unavailable.</strong> {signals.reason}
          <div style={{ marginTop: 4 }}>
            These are absent, not zero — nothing below is a measurement.
          </div>
        </div>
      )}

      {signals?.stale && (
        <div className="banner warn">
          Showing cached figures — the last refresh failed: {signals.staleReason}
        </div>
      )}

      <div className="card">
        <div className="row">
          <div style={{ flex: 1 }}>
            <h2>Service desk</h2>
            <p className="sub">
              {signals?.available
                ? `Project ${flow?.scope?.projects?.join(', ')} · last ${flow?.window?.days} days`
                : 'No live data'}
            </p>
          </div>
          <button className="ghost" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {signals?.available && (
          <div className="grid">
            <Metric
              n={u?.ok ? u.data.total : '—'}
              label="Open, no assignee"
              tone={u?.ok && u.data.total > 0 ? 'warn' : undefined}
              detail={u?.ok
                ? (u.data.byTier?.[0] && `worst ${u.data.byTier[0].tier}, oldest ${u.data.byTier[0].oldest_days}d`)
                : `unavailable — ${u?.error}`}
            />
            <Metric
              n={s?.ok ? s.data.total : '—'}
              label={`Untouched ${s?.data?.staleDays ?? 14}+ days`}
              tone={s?.ok && s.data.total > 50 ? 'bad' : 'warn'}
              detail={s?.ok
                ? (s.data.worst?.[0] && `worst ${s.data.worst[0].issue_key} at ${s.data.worst[0].days_untouched}d`)
                : `unavailable — ${s?.error}`}
            />
            <Metric
              n={b?.ok ? b.data.total : '—'}
              label="Open, over SLA"
              tone="bad"
              detail={b?.ok
                ? `of ${b.data.openTickets} open${b.data.byTier?.[0] ? ` · most in ${b.data.byTier[0].tier}` : ''}`
                : `unavailable — ${b?.error}`}
            />
            <Metric
              n={p?.ok ? p.data.ticketsAffected : '—'}
              label={`Crossed queues ${p?.data?.threshold ?? 3}+ times`}
              tone="warn"
              detail={p?.ok
                ? (p.data.worst?.[0] && `worst ${p.data.worst[0].ticket_key}, ${p.data.worst[0].moves} moves`)
                : `unavailable — ${p?.error}`}
            />
            <Metric
              n={h?.ok ? h.data.total : '—'}
              label="Rejections (evidenced)"
              detail={h?.ok
                ? `${h.data.returnsAfterFix} returned after a fix · ${h.data.unclassified} unclassified`
                : `unavailable — ${h?.error}`}
            />
          </div>
        )}
      </div>

      {h?.ok && h.data.total === 0 && h.data.unclassified > 0 && (
        <div className="banner info">
          <strong>Rejections read zero because classification only starts from 18 Aug 2026.</strong>{' '}
          The {h.data.unclassified} moves in this window predate it and carry no evidence either way.
          This is not "no rejections happened" — do not report it as such.
        </div>
      )}

      {b?.ok && b.data.byTier?.length > 0 && (
        <div className="card">
          <h2>Over SLA, by the queue holding it now</h2>
          <p className="sub">
            A snapshot of what is breached today — <strong>not</strong> the review's
            "breaches by queue at time of breach", which no NOVA source can produce.
          </p>
          <table>
            <thead><tr><th>Queue</th><th>Over SLA</th><th>Share</th></tr></thead>
            <tbody>
              {b.data.byTier.map(t => (
                <tr key={t.tier}>
                  <td>{t.tier}</td>
                  <td>{t.breaches}</td>
                  <td className="muted">{t.sharePct === null ? '—' : `${t.sharePct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s?.ok && s.data.worst?.length > 0 && (
        <div className="card">
          <h2>Longest untouched</h2>
          <p className="sub">Measured from last update, not creation. An old ticket being worked is a hard problem; an old ticket nobody has touched is a forgotten one.</p>
          <table>
            <thead><tr><th>Ticket</th><th>Queue</th><th>Owner</th><th>Untouched</th></tr></thead>
            <tbody>
              {s.data.worst.slice(0, 8).map(t => (
                <tr key={t.issue_key}>
                  <td style={{ fontFamily: 'var(--mono)' }}>{t.issue_key}</td>
                  <td className="muted">{t.tier}</td>
                  <td className="muted">{t.assignee || '—'}</td>
                  <td>{t.days_untouched}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
