import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * What has gone wrong, what is going wrong, and what could.
 *
 * This replaced a tile dashboard that duplicated NOVA. The rule that keeps it
 * from drifting back: nothing on this screen should be answerable by looking at
 * NOVA. Everything here is either a JUDGEMENT about a number, or a signal that
 * only exists because three sources were combined.
 *
 * The blind-spots banner is load-bearing. A radar that quietly drops a source it
 * could not reach will report "all clear" about a thing it cannot see, which is
 * worse than showing nothing at all.
 */

const TENSES = [
  {
    key: 'happened',
    title: 'Already gone wrong',
    sub: 'Cannot be prevented now. The question is who has been told.',
  },
  {
    key: 'happening',
    title: 'Going wrong now',
    sub: 'Still steerable. This is where intervening actually changes the outcome.',
  },
  {
    key: 'could',
    title: 'Could go wrong',
    sub: 'Nothing has failed yet. The only tense where being early counts for anything.',
  },
];

const SEVERITY_COLOUR = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };

/**
 * One line on the radar, with a one-click route into the findings register.
 *
 * That button is the whole bridge between noticing and evidencing. A radar you
 * read and close leaves no trace that you looked; the register is what turns
 * "I saw that" into something dated that survives to a review.
 */
function Item({ it }) {
  const [logged, setLogged] = useState(false);
  const [busy, setBusy] = useState(false);

  const log = async () => {
    setBusy(true);
    try {
      await api.addFinding({
        title: it.title,
        detail: `${it.detail}${it.meeting ? ` (${it.meeting})` : ''}`,
        source: it.source,
        severity: it.severity,
      });
      setLogged(true);
    } catch { /* the button reverts; the radar is not the place to shout */ }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 8, marginBottom: 3 }}>
        <span style={{
          width: 7, height: 7, borderRadius: 99,
          background: SEVERITY_COLOUR[it.severity] || 'var(--muted)', flexShrink: 0,
        }} />
        <strong style={{ fontSize: 14, flex: 1 }}>{it.title}</strong>
        <span className="pill">{it.source}</span>
        <button className="ghost small" style={{ border: 'none', padding: '0 6px' }}
          onClick={log} disabled={busy || logged}
          title="Add to the findings register">
          {logged ? '✓ logged' : busy ? '…' : '+ log'}
        </button>
      </div>
      <div className="small" style={{ color: 'var(--muted)', paddingLeft: 15 }}>
        {it.detail}
        {it.meeting && <> <em>— {it.meeting}</em></>}
      </div>
    </div>
  );
}

export default function Radar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = async (force = false) => {
    force ? setRefreshing(true) : setLoading(true);
    try {
      setData(await api.radar(force));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="empty">
        Reading NOVA, NEURO and your recent meetings…
        <div className="small" style={{ marginTop: 8 }}>
          First run only — after this it is kept warm in the background and opens instantly.
        </div>
      </div>
    );
  }

  // How old the picture is, said plainly. The radar is served from cache so it
  // can open immediately; the honest trade is that the reader is told the age
  // rather than being made to wait for freshness they may not need.
  const ageMin = data?.asOf ? Math.round((Date.now() - Date.parse(data.asOf)) / 60_000) : null;
  const freshness = ageMin === null ? null
    : ageMin < 1 ? 'just now'
      : ageMin < 60 ? `${ageMin} min ago`
        : `${Math.round(ageMin / 60)}h ago`;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      {data?.blind?.length > 0 && (
        <div className="banner warn">
          <strong>Blind spots.</strong> {data.blind.length} source
          {data.blind.length === 1 ? '' : 's'} could not be read, so nothing below covers
          {data.blind.length === 1 ? ' it' : ' them'}:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {data.blind.map(b => <li key={b.name}><code>{b.name}</code> — {b.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="small muted">
            {data?.counts && (
              <>{data.counts.happened} already wrong · {data.counts.happening} going wrong · {data.counts.could} could</>
            )}
            {data?.meetingsRead?.length > 0 && (
              <> · read {data.meetingsRead.length} recent meeting{data.meetingsRead.length === 1 ? '' : 's'}</>
            )}
            {freshness && <> · as at <strong>{freshness}</strong></>}
            {data?.refreshing && <> · refreshing in the background</>}
          </div>
        </div>
        <button className="ghost" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? 'Re-reading…' : 'Refresh now'}
        </button>
      </div>

      {TENSES.map(t => {
        const items = (data?.items || []).filter(i => i.tense === t.key);
        return (
          <div className="card" key={t.key}>
            <h2>{t.title}</h2>
            <p className="sub">{t.sub}</p>
            {items.length === 0
              ? (
                <p className="small muted">
                  Nothing surfaced — from the sources that answered. That is not the same as nothing being there.
                </p>
              )
              : items.map((it, i) => <Item key={i} it={it} />)}
          </div>
        );
      })}

      {data?.meetingsRead?.length > 0 && (
        <div className="card">
          <h2>Meetings read</h2>
          <p className="sub">
            Scanned for things that were said and never became a ticket or an action.
          </p>
          {data.meetingsRead.map(m => (
            <div key={m} className="small muted" style={{ padding: '3px 0' }}>{m}</div>
          ))}
        </div>
      )}
    </div>
  );
}
