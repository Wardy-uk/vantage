import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The Support Improvement Plan — read from the vault's action register.
 *
 * Read-only on purpose. The register (Projects/Support Improvement Plan) is the
 * source of truth and the Planner board is where the work is done; this screen
 * holds the two against each other and says where they disagree. Status is
 * changed in the vault, never here — a third place to record it is how the old
 * tracker came to be wrong.
 *
 * Every action is shown, not only the review's: the Support Review's are
 * marked and filterable, the rest (Planner-only, NEURO/NOVA, best practice)
 * are the continual improvement plan around it.
 */

const STATUS = {
  Done: { colour: 'var(--good)' },
  Added: { colour: 'var(--accent)' },
  'To be added': { colour: 'var(--warn)' },
  'Not adding': { colour: 'var(--muted)' },
};

const OWNERSHIP = {
  mine: 'Mine',
  shared: 'Shared',
  other: 'Others',
  unknown: 'Unstated',
};

function Chips({ label, value, options, onChange }) {
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className="muted" style={{ minWidth: 56 }}>{label}</span>
      {options.map(([k, text]) => (
        <button key={k} className={value === k ? 'primary small' : 'ghost small'}
          onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

/** What the board says about one action. Null board = could not be read, not "not on it". */
function BoardLine({ a, boardAvailable }) {
  if (!boardAvailable || a.planner === null) {
    return <span className="small muted">board — <em>unknown, not read</em></span>;
  }
  if (!a.planner.length) {
    if (a.status === 'Done' || a.status === 'Added') {
      return (
        <span className="small muted">
          board — <em>not visible to you</em>: no Planner ID in the vault matches a task assigned to you
        </span>
      );
    }
    return null;
  }
  return (
    <span className="small row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {a.planner.map(t => (
        <span key={t.id} style={{ color: t.completed ? 'var(--good)' : 'var(--text)' }}>
          {t.completed ? '✓' : `${t.percent}%`} {t.title}
          {!t.completed && t.due && <span className="muted"> · due {t.due.slice(8, 10)}/{t.due.slice(5, 7)}</span>}
        </span>
      ))}
      {a.inNeuro === false && <span className="muted">· not in NEURO yet</span>}
    </span>
  );
}

function Action({ a, groups, boardAvailable }) {
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted" style={{ fontFamily: 'var(--mono)', minWidth: 30 }}>{a.id}</span>
        <span style={{ flex: 1, fontSize: 13 }}>{a.action}</span>
        {a.group === 'review' && (
          <span className="pill" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
            title={a.source}>Review</span>
        )}
        <span className="small muted" title={groups[a.group]}>{a.owner}</span>
        <span className="pill" style={{ color: STATUS[a.status]?.colour || 'var(--bad)', borderColor: STATUS[a.status]?.colour || 'var(--bad)' }}>
          {a.status || 'no status'}
        </span>
      </div>
      <div style={{ paddingLeft: 38, marginTop: 3 }} className="small muted">
        {a.source}{a.due && ` · due ${a.due}`}{a.notes && ` · ${a.notes}`}
      </div>
      <div style={{ paddingLeft: 38, marginTop: 3 }}>
        <BoardLine a={a} boardAvailable={boardAvailable} />
      </div>
      {a.drift?.map(d => (
        <div key={d} style={{ paddingLeft: 38, marginTop: 3 }} className="small">
          <span style={{ color: 'var(--warn)' }}>≠ {d}</span>
        </div>
      ))}
    </div>
  );
}

export default function Plan() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('all');
  const [status, setStatus] = useState('all');
  const [owner, setOwner] = useState('all');
  const [driftOnly, setDriftOnly] = useState(false);

  const load = async (refresh = false) => {
    setBusy(true);
    try { setData(await api.plan(refresh)); setError(null); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);

  if (!data) return <div className="empty">{error || 'Loading…'}</div>;

  if (!data.available) {
    return (
      <div className="wrap">
        <div className="banner bad">
          The plan could not be read from the vault ({data.reason}). Nothing below says what is or
          isn't done — it is unknown, not empty. Source: {data.path}
        </div>
      </div>
    );
  }

  const s = data.summary;
  const shown = data.actions.filter(a =>
    (group === 'all' || a.group === group)
    && (status === 'all' || a.status === status)
    && (owner === 'all' || a.ownership === owner)
    && (!driftOnly || a.drift?.length));

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}
      {data.stale && (
        <div className="banner warn">
          The vault could not be re-read ({data.stale}). Showing the read from {new Date(data.readAt).toLocaleString()}.
        </div>
      )}
      {!data.board.available && (
        <div className="banner warn">
          The Planner board could not be read ({data.board.reason}). Board columns show unknown —
          nothing below says an action is or isn't on it.
        </div>
      )}
      {data.problems.length > 0 && (
        <div className="banner warn">
          The register has rows VANTAGE could not read cleanly: {data.problems.join('; ')}.
        </div>
      )}

      <div className="card">
        <h2>Support Improvement Plan</h2>
        <p className="sub">
          From the vault's action register — the source of truth. Status changes there; this screen
          checks it against the Planner board. Read {new Date(data.readAt).toLocaleString()}.{' '}
          <button className="ghost small" style={{ border: 'none' }} disabled={busy} onClick={() => load(true)}>re-read</button>
        </p>
        <div className="grid">
          <div className="metric">
            <div className="n">{s.mine.done}/{s.mine.total}</div>
            <div className="l">Done — yours</div>
            <div className="d">{s.mine.onBoard} on the board and open, {s.mine.toBeAdded} not on it yet</div>
          </div>
          <div className="metric">
            <div className="n">{s.byStatus.Done || 0}</div>
            <div className="l">Done — all owners</div>
            <div className="d">of {s.total} actions, {s.byGroup.review || 0} from the review</div>
          </div>
          <div className="metric warn">
            <div className="n">{s.byStatus['To be added'] || 0}</div>
            <div className="l">Agreed, not on the board</div>
            <div className="d">nobody is working these until they are</div>
          </div>
          <div className={`metric ${s.drift ? 'warn' : ''}`}>
            <div className="n">{data.board.available ? s.drift : '—'}</div>
            <div className="l">Vault and board disagree</div>
            <div className="d">{data.board.available ? 'settle each one in the vault' : 'board not read'}</div>
          </div>
          <div className="metric bad">
            <div className="n">{data.measurable}/13</div>
            <div className="l">Success measures measurable</div>
            <div className="d">the rest will be judged on impression</div>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          The board feed shows only tasks assigned to you, so Stephen's, Nathan's, Mel's and others'
          tasks are not visible here — "not visible" below never means "not on the board".
        </p>
      </div>

      <div className="card">
        <Chips label="Source" value={group} onChange={setGroup}
          options={[['all', 'All'], ...Object.entries(data.groups)]} />
        <div style={{ height: 6 }} />
        <Chips label="Status" value={status} onChange={setStatus}
          options={[['all', 'All'], ...data.statuses.map(x => [x, x])]} />
        <div style={{ height: 6 }} />
        <Chips label="Owner" value={owner} onChange={setOwner}
          options={[['all', 'All'], ...Object.entries(OWNERSHIP)]} />
        <div style={{ height: 6 }} />
        <label className="small row" style={{ gap: 6 }}>
          <input type="checkbox" checked={driftOnly} onChange={e => setDriftOnly(e.target.checked)} />
          only where the vault and the board disagree
        </label>
      </div>

      {data.sections.map(section => {
        const rows = shown.filter(a => a.section === section);
        if (!rows.length) return null;
        return (
          <div className="card" key={section}>
            <h2>{section}</h2>
            <p className="sub">{rows.filter(a => a.status === 'Done').length} of {rows.length} done</p>
            {rows.map(a => <Action key={a.id} a={a} groups={data.groups} boardAvailable={data.board.available} />)}
          </div>
        );
      })}

      {!shown.length && <div className="empty">No actions match these filters.</div>}

      {data.unregistered?.length > 0 && (
        <div className="card">
          <h2>On the board, not linked to a register row</h2>
          <p className="sub">
            Either the vault row has no Planner ID yet, or the task is missing from the register.
            Until one of those is fixed, this work is not counted anywhere above.
          </p>
          {data.unregistered.map(t => (
            <div key={t.id} className="row small" style={{ padding: '5px 0', gap: 8 }}>
              <span style={{ color: t.completed ? 'var(--good)' : 'var(--text)', flex: 1 }}>
                {t.completed ? '✓' : `${t.percent}%`} {t.title}
              </span>
              <span className="muted" style={{ fontFamily: 'var(--mono)' }}>{t.id}</span>
            </div>
          ))}
        </div>
      )}

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
