import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The Daily KPI Tracker — the sheet Nick reports to the business, live.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Not a second wallboard. NOVA shows these numbers already and shows them
 * better. What this adds is the COMPARISON: every row beside where it closed
 * yesterday and where it averaged last week, so "44 incidents" becomes "44,
 * against 33 yesterday and 29 the week before" without opening three screens.
 *
 * ── Two colour encodings, kept apart ────────────────────────────────────────
 *
 * RAG is NOVA's own status judgement and keeps the status colours. The CHANGE
 * column is a separate question — is today moving the right way — and is
 * direction-aware rather than sign-aware: "Total Solved" falling is bad and
 * "Oldest actionable ticket" falling is good, and only the registry direction
 * knows which. Neither borrows the other's colour.
 *
 * ── Rows that cannot be measured are SHOWN ──────────────────────────────────
 *
 * Three of the tracker's rows have no KPI key in NOVA — TPJ Tickets in Dev
 * (definition under revision), Failed Jobs, CI In Progress. They are rendered
 * greyed with the reason rather than filtered out, because a view showing only
 * the computable rows would quietly redefine the tracker as the subset NOVA
 * happens to know, and that is the same failure as a zero standing in for an
 * absent measurement.
 */

const DIM = 'var(--muted)';

/** A change worth colouring, once direction is taken into account. */
function changeTone(row) {
  if (row.change === null || row.change === 0) return DIM;
  const worseIsUp = row.direction !== 'higher-better';
  const worse = worseIsUp ? row.change > 0 : row.change < 0;
  return worse ? 'var(--bad)' : 'var(--good)';
}

const RAG_TONE = { red: 'var(--bad)', amber: 'var(--warn)', green: 'var(--good)' };

/**
 * Fourteen days at a glance.
 *
 * A bare polyline, no axes, no labels — it answers "is this shape going up or
 * down" and nothing else, which is all a 60-pixel sparkline can honestly do. A
 * row with no history renders nothing rather than a flat line, because a flat
 * line is a claim that the number did not move.
 */
function Spark({ points, direction }) {
  if (!points?.length || points.length < 3) {
    return <span className="small" style={{ color: DIM }}>—</span>;
  }
  const vals = points.map(p => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const w = 64;
  const h = 18;
  const d = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const rising = vals[vals.length - 1] > vals[0];
  const worseIsUp = direction !== 'higher-better';
  const tone = rising === worseIsUp ? 'var(--bad)' : 'var(--good)';

  return (
    <svg width={w} height={h} role="img" aria-label={`${points.length} day trend`} style={{ display: 'block' }}>
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

function Row({ r }) {
  if (!r.measured) {
    return (
      <tr style={{ borderTop: '1px solid var(--line)', opacity: 0.5 }}>
        <td style={{ padding: '7px 8px 7px 0' }}>{r.label}</td>
        <td colSpan={5} className="small" style={{ padding: '7px 8px', color: DIM }}>
          not watched — {r.reason}
        </td>
      </tr>
    );
  }
  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td style={{ padding: '7px 8px 7px 0' }}>
        {r.label}
        {r.extra && <span className="pill" style={{ marginLeft: 6 }} title="Beyond the sheet's row block">extra</span>}
      </td>
      <td style={{ padding: '7px 8px', textAlign: 'right' }}>
        <strong style={{ fontSize: 15 }}>{r.live ?? '—'}</strong>
        {r.rag && (
          <span style={{
            display: 'inline-block', width: 7, height: 7, borderRadius: 99, marginLeft: 7,
            background: RAG_TONE[r.rag] || DIM,
          }} title={`NOVA rates this ${r.rag}`} />
        )}
      </td>
      <td className="small" style={{ padding: '7px 8px', textAlign: 'right', color: DIM }}>
        {r.yesterday ? r.yesterday.value : '—'}
      </td>
      <td className="small" style={{ padding: '7px 8px', textAlign: 'right', color: changeTone(r) }}>
        {r.change === null ? '—' : `${r.change > 0 ? '+' : ''}${r.change}`}
      </td>
      <td className="small" style={{ padding: '7px 8px', textAlign: 'right', color: DIM }}>
        {r.weekMean ?? '—'}
        {r.prevWeekMean !== null && r.prevWeekMean !== undefined && (
          <span style={{ opacity: 0.6 }}> / {r.prevWeekMean}</span>
        )}
      </td>
      <td style={{ padding: '7px 0 7px 8px', width: 64 }}>
        <Spark points={r.points} direction={r.direction} />
      </td>
    </tr>
  );
}

export default function Tracker() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (force = false) => {
    setBusy(true);
    try {
      setData(await api.tracker(force));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(); }, []);

  if (!data && !error) return <div className="empty">Reading the tracker…</div>;

  const rows = data?.byRow || [];
  const measured = rows.filter(r => r.measured);
  const live = data?.live;
  const hourly = data?.hourly;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      {data && !data.available && (
        <div className="banner warn">
          The tracker could not be read — {data.reason}. Nothing below is current.
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="small muted">
            {measured.length} of {rows.length} rows watched
            {live?.available
              ? <> · live as at {live.day}, {Math.round((live.ageSeconds ?? 0) / 60)} min old</>
              : <> · <span style={{ color: 'var(--warn)' }}>no live values ({live?.error || 'not read'})</span></>}
          </div>
        </div>
        <button className="ghost" onClick={() => load(true)} disabled={busy}>
          {busy ? 'Reading…' : 'Refresh now'}
        </button>
      </div>

      {/* The honest state of the tactical half. Said once, at the top, rather
          than repeated on every row — and it disappears on its own once the
          readings exist, because it is computed from them. */}
      {hourly && !hourly.ready && (
        <div className="banner">
          <strong>Hourly readings: {hourly.daysCovered} of {hourly.needed} days.</strong>{' '}
          Until there are {hourly.needed}, a move can only be compared with yesterday's close —
          not with what this KPI normally looks like at this hour. The tactical warnings say so
          on their own cards.
        </div>
      )}

      <div className="card">
        <h2>Daily KPI Tracker</h2>
        <p className="sub">
          What you report to the business, live — each row beside yesterday's close and last
          week's average. NOVA owns these numbers; this is the comparison.
        </p>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr className="small" style={{ color: DIM, textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '4px 8px 4px 0' }}>KPI</th>
              <th style={{ padding: '4px 8px' }}>now</th>
              <th style={{ padding: '4px 8px' }}>yesterday</th>
              <th style={{ padding: '4px 8px' }}>change</th>
              <th style={{ padding: '4px 8px' }} title="This week / the week before">wk / prev</th>
              <th style={{ padding: '4px 0 4px 8px', textAlign: 'left' }}>14d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => <Row key={r.key || r.label} r={r} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
