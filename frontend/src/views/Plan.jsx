import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Delivery against the Support Review improvement plan.
 *
 * The ownership column is the point. Roughly half of these actions sit above
 * Nick, and a tracker that showed 35 items all against his name would be
 * dishonest in both directions — overstating his failure, understating the real
 * blocker. Progress is therefore reported twice: overall, and on what is
 * actually his.
 */

const STATUS = {
  'not-started': { label: 'Not started', colour: 'var(--muted)' },
  'in-progress': { label: 'In progress', colour: 'var(--accent)' },
  blocked: { label: 'Blocked', colour: 'var(--bad)' },
  escalated: { label: 'Escalated', colour: 'var(--warn)' },
  done: { label: 'Done', colour: 'var(--good)' },
};

const OWNER = {
  mine: { label: 'Mine', colour: 'var(--accent)' },
  shared: { label: 'Shared', colour: 'var(--warn)' },
  above: { label: 'Above me', colour: 'var(--muted)' },
};

function Item({ it, onChange }) {
  const [note, setNote] = useState(it.note || '');
  const [editing, setEditing] = useState(false);

  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted" style={{ fontFamily: 'var(--mono)', minWidth: 30 }}>{it.id}</span>
        <span style={{ flex: 1, fontSize: 13 }}>{it.title}</span>
        <span className="pill" style={{ color: OWNER[it.owner].colour, borderColor: OWNER[it.owner].colour }}>
          {OWNER[it.owner].label}
        </span>
        <select
          value={it.status}
          onChange={e => onChange(it.id, { status: e.target.value })}
          style={{ maxWidth: 130, color: STATUS[it.status].colour }}
        >
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>
      <div style={{ paddingLeft: 38, marginTop: 3 }}>
        {editing
          ? (
            <div className="row" style={{ gap: 6 }}>
              <input value={note} placeholder="Evidence, blocker, who you escalated to"
                onChange={e => setNote(e.target.value)} />
              <button className="primary" onClick={() => { onChange(it.id, { note }); setEditing(false); }}>Save</button>
            </div>
          )
          : (
            <span className="small muted">
              {it.note || <em>no note</em>}{' '}
              <button className="ghost small" style={{ border: 'none', padding: '0 5px' }}
                onClick={() => setEditing(true)}>edit</button>
            </span>
          )}
      </div>
    </div>
  );
}

export default function Plan() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = async () => {
    try { setData(await api.plan()); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const change = async (id, patch) => {
    try { setData(await api.setPlanStatus(id, patch)); } catch (e) { setError(e.message); }
  };

  if (!data) return <div className="empty">{error || 'Loading…'}</div>;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      <div className="card">
        <h2>Improvement plan</h2>
        <p className="sub">
          The Support Review's 35 actions. Ownership is recorded honestly — about half sit above you,
          and "escalated and waiting" is a legitimate end state for those.
        </p>
        <div className="grid">
          <div className="metric">
            <div className="n">{data.mine.done}/{data.mine.total}</div>
            <div className="l">Done — yours</div>
            <div className="d">{data.mine.moving} moving or finished</div>
          </div>
          <div className="metric">
            <div className="n">{data.counts.done}</div>
            <div className="l">Done — all owners</div>
            <div className="d">of {data.items.length} actions</div>
          </div>
          <div className="metric warn">
            <div className="n">{data.counts.blocked + data.counts.escalated}</div>
            <div className="l">Blocked or escalated</div>
            <div className="d">waiting on someone else</div>
          </div>
          <div className="metric bad">
            <div className="n">{data.measurable}/13</div>
            <div className="l">Success measures measurable</div>
            <div className="d">the rest will be judged on impression</div>
          </div>
        </div>
      </div>

      {Object.entries(data.horizons).map(([key, label]) => {
        const items = data.items.filter(i => i.horizon === key);
        return (
          <div className="card" key={key}>
            <h2>{label}</h2>
            <p className="sub">
              {items.filter(i => i.status === 'done').length} of {items.length} done
            </p>
            {items.map(it => <Item key={it.id} it={it} onChange={change} />)}
          </div>
        );
      })}

      <div className="card">
        <h2>Measures of success</h2>
        <p className="sub">
          Only {data.measurable} of 13 can currently be measured. That is itself the finding —
          a plan whose success measures are mostly unmeasurable gets assessed on opinion.
        </p>
        {data.measures.map(m => (
          <div key={m.id} className="row" style={{ padding: '5px 0', gap: 8 }}>
            <span style={{ color: m.measurable ? 'var(--good)' : 'var(--muted)' }}>
              {m.measurable ? '✓' : '—'}
            </span>
            <span className="small" style={{ color: m.measurable ? 'var(--text)' : 'var(--muted)' }}>
              {m.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
