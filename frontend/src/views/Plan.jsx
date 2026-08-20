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

/**
 * The delivery line under each action: the NEURO task doing the work.
 *
 * Three states, and they are not interchangeable. A linked task shows its live
 * NEURO state (and a Planner badge where NEURO has merged it with Mel's board).
 * An unlinked action offers what already looks like it — adopting beats creating
 * a duplicate. Only when nothing matches does it offer to create, and that is
 * one click because "write the task yourself first" is exactly the step that
 * doesn't happen.
 *
 * `unknown` is its own state on purpose: NEURO being unreachable must not read
 * as "no task exists".
 */
/**
 * Attach an existing task or Planner item by hand.
 *
 * This is the primary path, not a fallback. The scorer that suggests matches
 * works on shared words, and the Support Review's wording and the Planner
 * board's wording barely share any: "Reinstate regular 1:1s for every Customer
 * Care colleague" against "Re-instate reglar 121s with team" scores nothing at
 * all. Nick can see they are the same job in a second, so the tool's job is to
 * put the real list in front of him and get out of the way.
 */
function Picker({ id, catalogue, microsoftAvailable, busy, onLink, onAdopt, onClose }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = t => !needle || t.text.toLowerCase().includes(needle);

  const tasks = catalogue.tasks.filter(match).slice(0, 8);
  const ms = catalogue.microsoft.filter(match).slice(0, 8);

  return (
    <div style={{ marginTop: 6, padding: 8, border: '1px solid var(--line)', borderRadius: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <input autoFocus value={q} placeholder="Search your tasks and Planner board"
          onChange={e => setQ(e.target.value)} />
        <button className="ghost small" onClick={onClose}>close</button>
      </div>

      {tasks.map(t => (
        <div key={`t${t.id}`} className="row small" style={{ gap: 6, padding: '4px 0' }}>
          <button className="ghost small" disabled={busy} onClick={() => onLink(id, t.id)}>attach</button>
          <span style={{ flex: 1 }}>{t.text}</span>
          {t.microsoft && <span className="muted">{t.microsoft.source}</span>}
          {t.dueDate && <span className="muted">{t.dueDate}</span>}
        </div>
      ))}

      {ms.map(m => (
        <div key={m.msId} className="row small" style={{ gap: 6, padding: '4px 0' }}>
          {/* Adopting a Planner item creates the NEURO task and merges the two,
              which is the shape Nick asked for: NEURO holds it, Planner keeps it. */}
          <button className="ghost small" disabled={busy} onClick={() => onAdopt(id, m)}>attach</button>
          <span style={{ flex: 1 }}>{m.text}</span>
          <span className="pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>{m.source}</span>
          {m.dueDate && <span className="muted">{m.dueDate}</span>}
        </div>
      ))}

      {!tasks.length && !ms.length && (
        <div className="small muted" style={{ padding: '4px 0' }}>
          nothing matches “{q}”{!microsoftAvailable && ' — and the Planner board could not be read, so it is not being searched'}
        </div>
      )}
    </div>
  );
}

function TaskLine({ id, state, busy, onCreate, onLink, onUnlink, onAdopt, onPick }) {
  if (!state) {
    return <span className="small muted">task — <em>unknown, NEURO did not answer</em></span>;
  }

  const { task, suggestions = [], missing, proposal } = state;

  if (missing) {
    return (
      <span className="small" style={{ color: 'var(--warn)' }}>
        linked to task #{state.link.taskId}, which NEURO no longer has{' '}
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={() => onUnlink(id)}>unlink</button>
      </span>
    );
  }

  if (task) {
    return (
      <span className="small row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span style={{ color: task.done ? 'var(--good)' : 'var(--accent)' }}>
          {task.done ? '✓' : '→'} {task.text}
        </span>
        <span className="muted">#{task.id}</span>
        {task.dueDate && <span className="muted">due {task.dueDate}</span>}
        {task.microsoft && (
          <span className="pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>
            {task.microsoft.source}
          </span>
        )}
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={() => onUnlink(id)}>unlink</button>
      </span>
    );
  }

  // The model's reading comes first when it has one: it matches on meaning,
  // which is what these two vocabularies need. It is a proposal — accepting is
  // still a click, and the reason is shown so the click is informed.
  if (proposal) {
    const { target, kind, confidence, why } = proposal;
    return (
      <span className="small row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="muted">looks like</span>
        <span>{target.text}</span>
        {kind === 'microsoft' && (
          <span className="pill" style={{ color: 'var(--warn)', borderColor: 'var(--warn)' }}>{target.source}</span>
        )}
        <span className="muted" style={{ fontStyle: 'italic' }}>{why} ({confidence})</span>
        <button className="ghost small" disabled={busy}
          onClick={() => (kind === 'microsoft'
            ? onAdopt(id, { msId: target.msId, msSource: target.source, text: target.text })
            : onLink(id, target.id))}>
          yes, attach it
        </button>
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={onPick}>no — something else…</button>
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={() => onCreate(id)}>create new</button>
      </span>
    );
  }

  if (suggestions.length) {
    const s = suggestions[0];
    const it = s.kind === 'microsoft' ? s.ms : s.task;
    return (
      <span className="small row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="muted">already captured?</span>
        <span>{it.text}</span>
        <span className="muted">
          {Math.round(s.score * 100)}% on wording
          {s.kind === 'microsoft' ? ` · ${it.ms_source}` : it.ms_source ? ` · ${it.ms_source}` : ''}
        </span>
        <button className="ghost small" disabled={busy}
          onClick={() => (s.kind === 'microsoft'
            ? onAdopt(id, { msId: it.ms_id, msSource: it.ms_source, text: it.text })
            : onLink(id, it.id))}>
          that's this one
        </button>
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={onPick}>something else…</button>
        <button className="ghost small" style={{ border: 'none' }} disabled={busy}
          onClick={() => onCreate(id)}>create new</button>
      </span>
    );
  }

  return (
    <span className="small row" style={{ gap: 6 }}>
      {/* Not "no task exists". Matching is on shared words and the review's
          wording rarely shares any with how the work was actually written down,
          so silence here is the matcher's, not the board's. */}
      <span className="muted">nothing matched on wording</span>
      <button className="ghost small" disabled={busy} onClick={onPick}>attach existing</button>
      <button className="ghost small" disabled={busy} onClick={() => onCreate(id)}>create it</button>
    </span>
  );
}

function Item({ it, onChange, tasks, taskState, busy, onCreate, onLink, onUnlink, onAdopt }) {
  const [note, setNote] = useState(it.note || '');
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  const close = () => setPicking(false);
  const linkAnd = async (...args) => { await onLink(...args); close(); };
  const adoptAnd = async (...args) => { await onAdopt(...args); close(); };

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
      <div style={{ paddingLeft: 38, marginTop: 3 }}>
        {tasks === null
          ? <span className="small muted">task — <em>loading…</em></span>
          : tasks.available
            ? (
              <>
                <TaskLine id={it.id} state={taskState} busy={busy}
                  onCreate={onCreate} onLink={onLink} onUnlink={onUnlink}
                  onAdopt={onAdopt} onPick={() => setPicking(true)} />
                {picking && (
                  <Picker id={it.id} catalogue={tasks.catalogue}
                    microsoftAvailable={tasks.microsoftAvailable} busy={busy}
                    onLink={linkAnd} onAdopt={adoptAnd} onClose={close} />
                )}
              </>
            )
            : <span className="small muted">task — <em>unknown, NEURO did not answer</em></span>}
      </div>
    </div>
  );
}

export default function Plan() {
  const [data, setData] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try { setData(await api.plan()); } catch (e) { setError(e.message); }
    // Separate call, separate failure. The plan renders with NEURO down; only
    // the task column goes unknown.
    try { setTasks(await api.planTasks()); } catch (e) {
      setTasks({ available: false, reason: e.message, items: {} });
    }
  };
  useEffect(() => { load(); }, []);

  const change = async (id, patch) => {
    try { setData(await api.setPlanStatus(id, patch)); } catch (e) { setError(e.message); }
  };

  /** Every task write returns the whole overview, so there is one refresh path. */
  const act = fn => async (...args) => {
    setBusy(true);
    setError(null);
    try { setTasks(await fn(...args)); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const create = act(id => api.createPlanTask(id));
  const link = act((id, taskId) => api.linkPlanTask(id, taskId));
  const unlink = act(id => api.unlinkPlanTask(id));
  const adopt = act((id, item) => api.adoptPlannerTask(id, item));
  const rematch = act(() => api.planTasks(true));

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
          {/* Deliberately not shown as "0 linked" when NEURO is down. A zero
              here would read as "nothing has been captured", which is a
              different claim from "we could not ask". */}
          <div className="metric">
            <div className="n">
              {tasks === null ? '…' : tasks.available ? `${tasks.counts.linked}/${tasks.counts.total}` : '—'}
            </div>
            <div className="l">Actions with a real task</div>
            <div className="d">
              {tasks === null ? 'asking NEURO' : tasks.available ? 'held in NEURO, merged with Planner there' : 'NEURO did not answer'}
            </div>
          </div>
        </div>
        {tasks?.available && (
          <p className="small muted" style={{ marginTop: 8 }}>
            {tasks.proposals.available
              ? <>Matches are proposed by reading meaning, not words, and every one needs your click.
                {tasks.proposals.at && ` Read at ${new Date(tasks.proposals.at).toLocaleString()}.`}
                {tasks.proposals.dropped ? ` ${tasks.proposals.dropped} proposal${tasks.proposals.dropped === 1 ? '' : 's'} discarded as unverifiable.` : ''}
                {' '}<button className="ghost small" style={{ border: 'none' }} disabled={busy}
                  onClick={rematch}>re-match</button></>
              // Not "no matches found". The distinction is the whole point.
              : <>Matching did not run ({tasks.proposals.reason}) — no action below is claiming
                that nothing exists for it. </>}
            {' '}“Attach existing” searches your {tasks.counts.microsoft ?? '—'} Planner and To-Do
            items directly. {tasks.plannerScope}
          </p>
        )}
      </div>

      {tasks && !tasks.available && (
        <div className="banner warn">
          Task links are unavailable — {tasks.reason}. The actions below show
          <strong> unknown</strong>, not "no task": nothing here says work has or hasn't been captured.
        </div>
      )}

      {tasks?.available && tasks.microsoftAvailable === false && (
        <div className="banner warn">
          The Planner and To-Do board could not be read ({tasks.microsoftReason}) — it is not being
          searched or offered. Nothing below says an action is or isn't on Mel's board.
        </div>
      )}

      {tasks?.available && tasks.suggestionsAvailable === false && (
        <div className="banner warn">
          Links are live, but matching did not run ({tasks.suggestionsReason}) — an action with no task
          shown may still already exist in NEURO or Planner.
        </div>
      )}

      {/* Report what moved. A task finished in NEURO but still "not started"
          here is completion he has done and not registered. */}
      {tasks?.available && tasks.counts.doneInNeuro > data.counts.done && (
        <div className="banner info">
          {tasks.counts.doneInNeuro} plan {tasks.counts.doneInNeuro === 1 ? 'action is' : 'actions are'} done
          in NEURO but not marked done here. That is finished work not showing in your numbers.
        </div>
      )}

      {Object.entries(data.horizons).map(([key, label]) => {
        const items = data.items.filter(i => i.horizon === key);
        return (
          <div className="card" key={key}>
            <h2>{label}</h2>
            <p className="sub">
              {items.filter(i => i.status === 'done').length} of {items.length} done
            </p>
            {items.map(it => (
              <Item key={it.id} it={it} onChange={change}
                tasks={tasks} taskState={tasks?.items?.[it.id]} busy={busy}
                onCreate={create} onLink={link} onUnlink={unlink} onAdopt={adopt} />
            ))}
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
