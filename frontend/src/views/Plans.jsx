import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { SipPlan } from './Plan.jsx';

/**
 * Every plan (29 Oct 2026).
 *
 * Each plan is a vault project whose action register is the truth. This screen
 * switches between them, shows them all on one list, adds new ones (a vault
 * project, a Planner board, an imported document) and ranks plans and tasks.
 *
 * The only things written from here are: a new register/project, plan rank,
 * task rank and the star. Status, owners and dates are still changed in the
 * vault. A task write carries the register's version; if Nick edited the note
 * in Obsidian since this screen loaded, the server refuses and the screen
 * reloads rather than writing over his edit.
 */

const SELECTED_KEY = 'vantage.plan.selected';
const KEY_COLOUR = { done: 'var(--good)', doing: 'var(--accent)', todo: 'var(--warn)', dropped: 'var(--muted)' };
const OPEN = new Set(['todo', 'doing']);

function readSelected() {
  try { return localStorage.getItem(SELECTED_KEY) || 'all'; } catch { return 'all'; }
}
function saveSelected(v) {
  try { localStorage.setItem(SELECTED_KEY, v); } catch { /* per-device convenience only */ }
}

/** `21/08` before today (this year) and still open → overdue. A blank or vague date is never overdue. */
function isOverdue(due, statusKey) {
  if (!OPEN.has(statusKey)) return false;
  const m = String(due || '').match(/^(\d{2})\/(\d{2})/);
  if (!m) return false;
  const now = new Date();
  const d = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[1]), 23, 59);
  return d < now;
}

function Chips({ label, value, options, onChange }) {
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className="muted" style={{ minWidth: 56 }}>{label}</span>
      {options.map(([k, text]) => (
        <button key={k} className={value === k ? 'primary small' : 'ghost small'} onClick={() => onChange(k)}>{text}</button>
      ))}
    </div>
  );
}

/** A drag-to-reorder list. HTML5 drag; the new order is handed back, never applied locally first. */
function DragList({ items, keyOf, render, onReorder, disabled }) {
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const drop = target => {
    if (dragging == null || dragging === target) return;
    const next = items.filter(i => keyOf(i) !== dragging);
    const at = next.findIndex(i => keyOf(i) === target);
    const moved = items.find(i => keyOf(i) === dragging);
    const before = items.findIndex(i => keyOf(i) === dragging) > items.findIndex(i => keyOf(i) === target);
    next.splice(before ? at : at + 1, 0, moved);
    onReorder(next);
  };
  return (
    <div>
      {items.map(item => {
        const k = keyOf(item);
        return (
          <div key={k}
            draggable={!disabled}
            onDragStart={() => setDragging(k)}
            onDragEnd={() => { setDragging(null); setOver(null); }}
            onDragOver={e => { e.preventDefault(); setOver(k); }}
            onDrop={e => { e.preventDefault(); drop(k); setDragging(null); setOver(null); }}
            className="row"
            style={{
              gap: 8, padding: '7px 4px', borderBottom: '1px solid var(--line)',
              borderTop: over === k && dragging !== k ? '2px solid var(--accent)' : '2px solid transparent',
              opacity: dragging === k ? 0.4 : 1, cursor: disabled ? 'default' : 'grab',
            }}>
            <span className="muted" aria-hidden="true" style={{ userSelect: 'none' }}>⋮⋮</span>
            {render(item)}
          </div>
        );
      })}
    </div>
  );
}

function StarButton({ starred, onClick, busy }) {
  return (
    <button className="ghost small" disabled={busy} onClick={onClick}
      title={starred ? 'Starred — click to unstar' : 'Star this'}
      style={{ border: 'none', padding: '0 4px', color: starred ? 'var(--warn)' : 'var(--muted)', fontSize: 16 }}>
      {starred ? '★' : '☆'}
    </button>
  );
}

function StatusPill({ status, statusKey }) {
  const c = KEY_COLOUR[statusKey] || 'var(--bad)';
  return <span className="pill" style={{ color: c, borderColor: c }}>{status || 'no status'}</span>;
}

/**
 * Closing tasks (29 Oct 2026): a tick on every row, a Select mode for many at
 * once, and Undo straight after. One closer is shared by the whole page so a
 * change in one panel reloads the others (`stamp`). Every write carries the
 * register's version; a 409 means it was edited elsewhere — say so and reload.
 */
function useCloser() {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Map());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [undo, setUndo] = useState(null);
  const [stamp, setStamp] = useState(0);
  const versions = useRef({});

  const keyOf = r => `${r.planId}:${r.id}`;
  const group = items => items.reduce((m, r) => m.set(r.planId, [...(m.get(r.planId) || []), r]), new Map());

  const apply = async (items, to, label) => {
    setBusy(true); setMsg(null);
    const entries = [];
    try {
      for (const [planId, rows] of group(items)) {
        const r = await api.setTaskStatus(planId, versions.current[planId], rows.map(x => ({ id: x.id, to })));
        versions.current[planId] = r.version;
        entries.push({ planId, before: r.before });
      }
      setUndo({ entries, label });
      setSelected(new Map());
    } catch (e) {
      setMsg(e.status === 409 ? e.message : `Not saved — ${e.message}`);
      if (entries.length) setUndo({ entries, label: `${label} (partly)` });
    } finally { setBusy(false); setStamp(s => s + 1); }
  };

  const runUndo = async () => {
    if (!undo) return;
    setBusy(true); setMsg(null);
    try {
      for (const e of undo.entries) {
        const r = await api.setTaskStatus(e.planId, versions.current[e.planId], e.before.map(b => ({ id: b.id, status: b.status })));
        versions.current[e.planId] = r.version;
      }
      setUndo(null);
    } catch (e) { setMsg(`Undo failed — ${e.message}`); }
    finally { setBusy(false); setStamp(s => s + 1); }
  };

  return {
    selectMode, busy, msg, undo, stamp, selected, runUndo,
    setVersion: (planId, v) => { if (v) versions.current[planId] = v; },
    toggleSelectMode: () => { setSelectMode(m => !m); setSelected(new Map()); },
    isSelected: r => selected.has(keyOf(r)),
    toggle: r => setSelected(prev => { const n = new Map(prev); if (n.has(keyOf(r))) n.delete(keyOf(r)); else n.set(keyOf(r), r); return n; }),
    selectAll: rows => setSelected(prev => { const n = new Map(prev); rows.forEach(r => n.set(keyOf(r), r)); return n; }),
    tick: r => apply([r], r.statusKey === 'done' ? 'open' : 'done', r.statusKey === 'done' ? `Reopened ${r.id}` : `Marked ${r.id} done`),
    bulk: to => apply([...selected.values()], to, `${{ done: 'Marked', dropped: 'Set not doing on', open: 'Reopened' }[to]} ${selected.size} task${selected.size === 1 ? '' : 's'}${to === 'done' ? ' done' : ''}`),
  };
}

/** The tick (or, in Select mode, the selection box) for one task. */
function RowControls({ closer, row }) {
  if (!closer) return null;
  if (closer.selectMode) {
    return <input type="checkbox" checked={closer.isSelected(row)} onChange={() => closer.toggle(row)} title="Select" />;
  }
  const done = row.statusKey === 'done';
  return (
    <input type="checkbox" checked={done} disabled={closer.busy} onChange={() => closer.tick(row)}
      title={done ? 'Done — untick to reopen' : 'Mark done'} style={{ accentColor: 'var(--good)' }} />
  );
}

/** Select mode, the bulk actions with a confirm, Undo, and any refusal. */
function CloseBar({ closer, rows = [] }) {
  const [confirm, setConfirm] = useState(null);
  const n = closer.selected.size;
  const label = { done: 'Mark done', dropped: 'Not doing', open: 'Reopen' };
  return (
    <div className="row small" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      <button className={closer.selectMode ? 'primary small' : 'small'} onClick={() => { closer.toggleSelectMode(); setConfirm(null); }}>
        {closer.selectMode ? 'Done selecting' : 'Select tasks'}
      </button>
      {closer.selectMode && (
        <>
          <button className="ghost small" onClick={() => closer.selectAll(rows)}>Select all shown ({rows.length})</button>
          <span className="muted">{n} selected</span>
          {!confirm && ['done', 'dropped', 'open'].map(to => (
            <button key={to} className="small" disabled={!n || closer.busy} onClick={() => setConfirm(to)}>{label[to]}</button>
          ))}
          {confirm && (
            <>
              <span>{label[confirm]} for {n} task{n === 1 ? '' : 's'}? Written to the register in the vault.</span>
              <button className="primary small" disabled={closer.busy} onClick={async () => { await closer.bulk(confirm); setConfirm(null); }}>
                {closer.busy ? 'Saving…' : 'Yes'}
              </button>
              <button className="ghost small" onClick={() => setConfirm(null)}>Cancel</button>
            </>
          )}
        </>
      )}
      {closer.undo && !closer.busy && (
        <span>{closer.undo.label}. <button className="ghost small" onClick={closer.runUndo}>Undo</button></span>
      )}
      {closer.msg && <span style={{ color: 'var(--warn)' }}>{closer.msg}</span>}
    </div>
  );
}

/** A write that may come back 409 (register changed): say so, then reload. */
function useWrite(reload) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const run = async fn => {
    setBusy(true); setNote(null);
    try { await fn(); await reload(); } catch (e) {
      setNote(e.status === 409 ? `${e.message}` : `Not saved — ${e.message}`);
      if (e.status === 409) await reload();
    } finally { setBusy(false); }
  };
  return { busy, note, run };
}

/** Open tasks in this plan's priority order: drag to rank, star to lead the consolidated view. */
function PriorityPanel({ id, closer }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
    try { const x = await api.planDetail(id); setD(x); closer?.setVersion(id, x.version); setError(null); } catch (e) { setError(e.message); }
  };
  useEffect(() => { setD(null); load(); }, [id]);
  useEffect(() => { if (closer?.stamp) load(); }, [closer?.stamp]);
  const { busy, note, run } = useWrite(load);

  if (error) return <div className="banner bad">The plan could not be read for ranking ({error}).</div>;
  if (!d) return <div className="card"><p className="sub">Loading priorities…</p></div>;
  if (!d.available) return null;

  const open = d.actions.filter(a => OPEN.has(a.statusKey))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.order - b.order);

  return (
    <div className="card">
      <h2>Priority order — {open.length} open</h2>
      <p className="sub">
        Drag to rank; ★ puts a task at the top of the all-plans view. Written to the register's Rank and Star
        columns. Done and not-doing tasks lose their rank.
      </p>
      {note && <div className="banner warn">{note}</div>}
      {!open.length && <div className="empty">Nothing open in this plan.</div>}
      <DragList items={open} keyOf={a => a.id} disabled={busy}
        onReorder={next => run(() => api.rankTasks(id, d.version, next.map(a => a.id)))}
        render={a => (
          <>
            <RowControls closer={closer} row={{ planId: id, id: a.id, statusKey: a.statusKey }} />
            <StarButton starred={a.starred} busy={busy} onClick={() => run(() => api.starTask(id, a.id, d.version, !a.starred))} />
            <span className="small muted" style={{ fontFamily: 'var(--mono)', minWidth: 34 }}>{a.id}</span>
            <span style={{ flex: 1, fontSize: 13 }}>{a.action}</span>
            <span className="small muted">{a.owner}</span>
            {a.due && <span className="small" style={{ color: isOverdue(a.due, a.statusKey) ? 'var(--bad)' : 'var(--muted)' }}>
              {isOverdue(a.due, a.statusKey) ? 'overdue ' : 'due '}{a.due}
            </span>}
            <StatusPill status={a.status} statusKey={a.statusKey} />
          </>
        )} />
    </div>
  );
}

/** A plan that is not SIP: counts, problems, priority order, then the whole register by section. */
function GenericPlan({ id, closer }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('all');
  const load = async (refresh = false) => {
    setBusy(true);
    try { const x = await api.planDetail(id, refresh); setD(x); closer.setVersion(id, x.version); setError(null); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { setD(null); load(); }, [id]);
  useEffect(() => { if (closer.stamp) load(); }, [closer.stamp]);

  if (!d) return <div className="empty">{error || 'Loading…'}</div>;
  if (!d.available) {
    return <div className="banner bad">This plan's register could not be read ({d.reason}). It is unknown, not empty. Source: {d.path}</div>;
  }
  const s = d.summary;
  const shown = d.actions.filter(a => status === 'all' || (status === 'open' ? OPEN.has(a.statusKey) : a.statusKey === status));

  return (
    <>
      {d.problems.length > 0 && <div className="banner warn">The register has rows VANTAGE could not read cleanly: {d.problems.join('; ')}.</div>}
      {d.board?.linked && !d.board.available && (
        <div className="banner warn">The Planner board could not be read ({d.board.reason}). Nothing below says a task is or isn't on it.</div>
      )}
      <div className="card">
        <h2>{d.name}</h2>
        <p className="sub">
          From <span style={{ fontFamily: 'var(--mono)' }}>{d.path}</span> — the source of truth. Status, owners and dates change there.{' '}
          <button className="ghost small" style={{ border: 'none' }} disabled={busy} onClick={() => load(true)}>re-read</button>
        </p>
        <div className="grid">
          <div className="metric"><div className="n">{s.done}/{s.total}</div><div className="l">Done</div><div className="d">{s.dropped} not doing</div></div>
          <div className="metric"><div className="n">{s.open}</div><div className="l">Open</div><div className="d">{s.doing} in progress, {s.todo} to do</div></div>
          <div className="metric"><div className="n">{s.mine.done}/{s.mine.total}</div><div className="l">Yours done</div></div>
          <div className="metric warn"><div className="n">{s.starred}</div><div className="l">Starred</div></div>
          <div className={`metric ${s.drift ? 'warn' : ''}`}>
            <div className="n">{d.board?.linked ? (d.board.available ? s.drift : '—') : '—'}</div>
            <div className="l">Vault and board disagree</div>
            <div className="d">{d.board?.linked ? 'settle each one in the vault' : 'no Planner board linked'}</div>
          </div>
        </div>
      </div>

      <PriorityPanel id={id} closer={closer} />

      <div className="card">
        <Chips label="Status" value={status} onChange={setStatus}
          options={[['all', 'All'], ['open', 'Open'], ['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done'], ['dropped', 'Not doing']]} />
        <CloseBar closer={closer} rows={shown.map(a => ({ planId: id, id: a.id, statusKey: a.statusKey }))} />
      </div>
      {!d.actions.length && <div className="empty">This register has no actions yet. Add rows to its table in the vault.</div>}
      {d.sections.map(section => {
        const rows = shown.filter(a => a.section === section);
        if (!rows.length) return null;
        return (
          <div className="card" key={section}>
            <h2>{section}</h2>
            <p className="sub">{rows.filter(a => a.statusKey === 'done').length} of {rows.length} done</p>
            {rows.map(a => (
              <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ gap: 8 }}>
                  <RowControls closer={closer} row={{ planId: id, id: a.id, statusKey: a.statusKey }} />
                  <span style={{ color: a.starred ? 'var(--warn)' : 'transparent' }}>★</span>
                  <span className="small muted" style={{ fontFamily: 'var(--mono)', minWidth: 34 }}>{a.id}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>{a.action}</span>
                  {a.rank != null && <span className="small muted">#{a.rank}</span>}
                  <span className="small muted">{a.owner}</span>
                  <StatusPill status={a.status} statusKey={a.statusKey} />
                </div>
                {(a.due || a.notes) && <div className="small muted" style={{ paddingLeft: 58, marginTop: 3 }}>
                  {a.due && <span style={{ color: isOverdue(a.due, a.statusKey) ? 'var(--bad)' : undefined }}>due {a.due}</span>}
                  {a.due && a.notes && ' · '}{a.notes}
                </div>}
                {a.drift?.map(x => <div key={x} className="small" style={{ paddingLeft: 58, color: 'var(--warn)' }}>≠ {x}</div>)}
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
}

/** Every plan's tasks on one list: starred, then plan rank, then task rank (ordered by the server). */
function Consolidated({ plans, closer }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [planF, setPlanF] = useState('all');
  const [status, setStatus] = useState('open');
  const [owner, setOwner] = useState('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const load = async (refresh = false) => {
    try {
      const x = await api.plansConsolidated(refresh);
      x.plans.forEach(p => closer.setVersion(p.id, p.version));
      setD(x); setError(null);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (closer.stamp) load(); }, [closer.stamp]);
  const { busy, note, run } = useWrite(() => load());

  if (!d) return <div className="empty">{error || 'Loading…'}</div>;
  const version = Object.fromEntries(d.plans.map(p => [p.id, p.version]));
  const shown = d.tasks.filter(t =>
    (planF === 'all' || t.planId === planF)
    && (status === 'all' || (status === 'open' ? OPEN.has(t.statusKey) : t.statusKey === status))
    && (owner === 'all' || t.ownership === owner)
    && (!starredOnly || t.starred));

  return (
    <>
      {d.unavailable.length > 0 && (
        <div className="banner bad">
          Not on this list because their register could not be read: {d.unavailable.map(u => `${u.name} (${u.reason})`).join('; ')}.
          Their tasks are unknown, not absent.
        </div>
      )}
      {note && <div className="banner warn">{note}</div>}
      <div className="card">
        <h2>All plans</h2>
        <p className="sub">
          Starred first, then plan priority, then task priority. Overdue is marked, not re-sorted.{' '}
          <button className="ghost small" style={{ border: 'none' }} onClick={() => load(true)}>re-read</button>
        </p>
        <Chips label="Plan" value={planF} onChange={setPlanF} options={[['all', 'All'], ...plans.filter(p => p.available).map(p => [p.id, p.name])]} />
        <div style={{ height: 6 }} />
        <Chips label="Status" value={status} onChange={setStatus}
          options={[['open', 'Open'], ['all', 'All'], ['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']]} />
        <div style={{ height: 6 }} />
        <Chips label="Owner" value={owner} onChange={setOwner}
          options={[['all', 'All'], ['mine', 'Mine'], ['shared', 'Shared'], ['other', 'Others'], ['unknown', 'Unstated']]} />
        <div style={{ height: 6 }} />
        <label className="small row" style={{ gap: 6 }}>
          <input type="checkbox" checked={starredOnly} onChange={e => setStarredOnly(e.target.checked)} /> starred only
        </label>
        <CloseBar closer={closer} rows={shown.map(t => ({ planId: t.planId, id: t.id, statusKey: t.statusKey }))} />
      </div>
      <div className="card">
        <p className="sub">{shown.length} of {d.tasks.length} tasks</p>
        {!shown.length && <div className="empty">No tasks match these filters.</div>}
        {shown.map(t => (
          <div key={`${t.planId}:${t.id}`} className="row" style={{ gap: 8, padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
            <RowControls closer={closer} row={{ planId: t.planId, id: t.id, statusKey: t.statusKey }} />
            <StarButton starred={t.starred} busy={busy}
              onClick={() => run(() => api.starTask(t.planId, t.id, version[t.planId], !t.starred))} />
            <span className="pill" title={`Plan priority ${t.planRank ?? '—'}`} style={{ minWidth: 0 }}>{t.planName}</span>
            <span className="small muted" style={{ fontFamily: 'var(--mono)', minWidth: 34 }}>{t.id}</span>
            <span style={{ flex: 1, fontSize: 13 }}>{t.action}</span>
            {t.rank != null && <span className="small muted">#{t.rank}</span>}
            <span className="small muted">{t.owner}</span>
            {t.due && <span className="small" style={{ color: isOverdue(t.due, t.statusKey) ? 'var(--bad)' : 'var(--muted)' }}>
              {isOverdue(t.due, t.statusKey) ? 'overdue ' : 'due '}{t.due}
            </span>}
            <StatusPill status={t.status} statusKey={t.statusKey} />
          </div>
        ))}
      </div>
    </>
  );
}

function ReorderPlans({ plans, onDone }) {
  const [order, setOrder] = useState(plans);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { await api.rankPlans(order.map(p => p.id)); await onDone(true); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="card">
      <h2>Plan priority</h2>
      <p className="sub">Drag into order, then save. Written as plan-rank in each register's frontmatter.</p>
      {error && <div className="banner bad">{error}</div>}
      <DragList items={order} keyOf={p => p.id} onReorder={setOrder} disabled={busy}
        render={(p) => (
          <>
            <span className="small muted" style={{ minWidth: 22 }}>{order.indexOf(p) + 1}</span>
            <span style={{ flex: 1 }}>{p.name}</span>
            <span className="small muted">{p.summary ? `${p.summary.open} open` : 'unreadable'}</span>
          </>
        )} />
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save order'}</button>
        <button className="ghost small" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
      </div>
    </div>
  );
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('The file could not be read'));
    r.readAsDataURL(file);
  });
}

/** Import: AI proposes, Nick edits, Save writes the project. */
function ImportDoc({ onSaved }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [p, setP] = useState(null);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const propose = async () => {
    setBusy(true); setError(null);
    try {
      const body = file ? { filename: file.name, fileBase64: await readFileBase64(file) } : { text };
      const r = await api.proposeImport(body);
      r.sections = r.sections.map(s => ({ ...s, actions: s.actions.map(a => ({ ...a, keep: true })) }));
      setP(r); setFolder(r.name || '');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const edit = (si, ai, patch) => setP(prev => ({
    ...prev,
    sections: prev.sections.map((s, i) => i !== si ? s : { ...s, actions: s.actions.map((a, j) => j !== ai ? a : { ...a, ...patch }) }),
  }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const sections = p.sections.map(s => ({ title: s.title, actions: s.actions.filter(a => a.keep && a.action.trim()) }));
      const r = await api.saveImport({ folder, name: folder, sections, sourceText: p.sourceText, from: p.from });
      await onSaved(r.id);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  if (!p) {
    return (
      <div>
        <p className="sub">A Word, PDF, markdown or text file, or paste the text. One AI read proposes the plan; nothing is written until you save.</p>
        {error && <div className="banner bad">{error}</div>}
        <input type="file" accept=".docx,.pdf,.md,.txt,.markdown" onChange={e => setFile(e.target.files[0] || null)} />
        {!file && <textarea rows={6} style={{ width: '100%', marginTop: 8 }} placeholder="…or paste the document text" value={text} onChange={e => setText(e.target.value)} />}
        <div style={{ marginTop: 8 }}>
          <button className="primary small" disabled={busy || (!file && !text.trim())} onClick={propose}>{busy ? 'Reading…' : 'Read it'}</button>
        </div>
      </div>
    );
  }
  const kept = p.sections.reduce((n, s) => n + s.actions.filter(a => a.keep).length, 0);
  return (
    <div>
      {error && <div className="banner bad">{error}</div>}
      {p.problems.length > 0 && <div className="banner warn">{p.problems.join(' ')}</div>}
      {p.summary && <p className="sub">{p.summary}</p>}
      <label className="small">Plan / vault folder name{' '}
        <input value={folder} onChange={e => setFolder(e.target.value)} style={{ width: 340 }} />
      </label>
      <p className="small muted">Creates Projects/{folder || '…'}/ with a hub note, the document's text as "{folder} - Source", and the register. Owners and dates appear only where the document states them.</p>
      {p.sections.map((s, si) => (
        <div key={si} style={{ marginTop: 10 }}>
          <input value={s.title} onChange={e => setP(prev => ({ ...prev, sections: prev.sections.map((x, i) => i === si ? { ...x, title: e.target.value } : x) }))}
            style={{ fontWeight: 600, width: '50%' }} />
          {s.actions.map((a, ai) => (
            <div key={ai} className="row" style={{ gap: 6, marginTop: 4, opacity: a.keep ? 1 : 0.45 }}>
              <input type="checkbox" checked={a.keep} onChange={e => edit(si, ai, { keep: e.target.checked })} />
              <input value={a.action} onChange={e => edit(si, ai, { action: e.target.value })} style={{ flex: 1 }} />
              <input value={a.owner || ''} placeholder="owner" onChange={e => edit(si, ai, { owner: e.target.value })} style={{ width: 140 }} />
              <input type="date" value={a.due || ''} onChange={e => edit(si, ai, { due: e.target.value || null })} />
            </div>
          ))}
        </div>
      ))}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="primary small" disabled={busy || !folder.trim() || !kept} onClick={save}>{busy ? 'Saving…' : `Save plan (${kept} actions)`}</button>
        <button className="ghost small" disabled={busy} onClick={() => setP(null)}>Start again</button>
      </div>
    </div>
  );
}

function AddPlan({ onDone }) {
  const [mode, setMode] = useState('vault');
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => { api.planCandidates().then(setC, e => setError(e.message)); }, []);

  const act = async (key, fn) => {
    setBusy(key); setError(null);
    try { const r = await fn(); await onDone(r.id); } catch (e) { setError(e.message); setBusy(null); }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Add a plan</h2>
        <button className="ghost small" onClick={() => onDone(null)}>Close</button>
      </div>
      <Chips label="From" value={mode} onChange={setMode}
        options={[['vault', 'Vault project'], ['planner', 'Planner board'], ['import', 'Import a document']]} />
      <div style={{ height: 10 }} />
      {error && <div className="banner bad">{error}</div>}
      {mode === 'import' && <ImportDoc onSaved={id => onDone(id)} />}
      {mode !== 'import' && !c && !error && <p className="sub">Loading…</p>}
      {mode === 'vault' && c && (
        <>
          <p className="sub">Projects in your vault without an action register. Choosing one writes an empty register into its folder.</p>
          {!c.projects.length && <div className="empty">Every project already has a register.</div>}
          {c.projects.map(p => (
            <div key={p.folder} className="row" style={{ gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ flex: 1 }}>{p.folder}</span>
              {!p.readable && <span className="small muted">folder unreadable</span>}
              <button className="small" disabled={Boolean(busy)} onClick={() => act(p.folder, () => api.adoptPlan(p.folder))}>
                {busy === p.folder ? 'Adding…' : 'Make it a plan'}
              </button>
            </div>
          ))}
        </>
      )}
      {mode === 'planner' && c && (
        <>
          <p className="sub">Your Planner boards. Choosing one creates a vault project and a register seeded with every task on the board, linked by plan id.</p>
          {c.boards === null && <div className="banner warn">Planner boards could not be read ({c.boardsReason}). This is not a list of none.</div>}
          {c.boards && !c.boards.length && <div className="empty">No Planner boards found.</div>}
          {(c.boards || []).map(b => (
            <div key={b.id} className="row" style={{ gap: 8, padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ flex: 1 }}>{b.title || <em className="muted">name unreadable</em>}</span>
              <span className="small muted">{b.yourTasks} yours</span>
              {b.linked
                ? <span className="small muted">already a plan</span>
                : <button className="small" disabled={Boolean(busy) || !b.title} onClick={() => act(b.id, () => api.planFromPlanner({ planId: b.id }))}>
                  {busy === b.id ? 'Creating…' : 'Create plan'}
                </button>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default function Plans() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(readSelected);
  const [panel, setPanel] = useState(null); // 'add' | 'reorder'
  const [busy, setBusy] = useState(false);
  const closer = useCloser();

  const load = async (refresh = false) => {
    setBusy(true);
    try { setData(await api.plans(refresh)); setError(null); } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);
  // Counts on the plan buttons follow a close.
  useEffect(() => { if (closer.stamp) load(); }, [closer.stamp]);
  const choose = id => { setSelected(id); saveSelected(id); if (closer.selectMode) closer.toggleSelectMode(); };

  if (!data) return <div className="wrap wide"><div className="empty">{error || 'Loading plans…'}</div></div>;
  const plans = data.plans;
  const current = plans.find(p => p.id === selected);
  const view = selected === 'all' || !current ? 'all' : selected;

  return (
    <div className="wrap wide">
      {error && <div className="banner bad">{error}</div>}
      {data.unreadableFolders?.length > 0 && (
        <div className="banner warn">Project folders that could not be listed (a register in them would be missed): {data.unreadableFolders.join(', ')}.</div>
      )}
      <div className="card">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className={view === 'all' ? 'primary small' : 'ghost small'} onClick={() => choose('all')}>All plans</button>
          {plans.map(p => (
            <button key={p.id} className={view === p.id ? 'primary small' : 'ghost small'} onClick={() => choose(p.id)}
              title={p.available ? p.path : `Unreadable: ${p.reason}`}>
              {p.rank != null && <span className="muted" style={{ marginRight: 4 }}>{p.rank}.</span>}
              {p.name}
              {p.summary ? <span className="muted" style={{ marginLeft: 6 }}>{p.summary.open}{p.summary.starred ? ` · ★${p.summary.starred}` : ''}</span> : <span style={{ color: 'var(--bad)', marginLeft: 6 }}>!</span>}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button className="small" onClick={() => setPanel(panel === 'reorder' ? null : 'reorder')} disabled={plans.length < 2}>Reorder plans</button>
          <button className="small" onClick={() => setPanel(panel === 'add' ? null : 'add')}>+ Add plan</button>
          <button className="ghost small" disabled={busy} onClick={() => load(true)}>re-read</button>
        </div>
        {!plans.length && <p className="sub" style={{ marginTop: 8 }}>No plans yet — add one from a vault project, a Planner board or a document.</p>}
      </div>

      {panel === 'reorder' && <ReorderPlans plans={plans} onDone={async saved => { setPanel(null); if (saved) await load(true); }} />}
      {panel === 'add' && <AddPlan onDone={async id => { setPanel(null); if (id) { await load(true); choose(id); } }} />}

      {view === 'all' && <Consolidated key={plans.map(p => `${p.id}:${p.rank}`).join()} plans={plans} closer={closer} />}
      {view !== 'all' && current?.isSip && (<><PriorityPanel id={current.id} closer={closer} /><SipPlan planId={current.id} closer={closer} CloseBar={CloseBar} RowControls={RowControls} /></>)}
      {view !== 'all' && current && !current.isSip && <GenericPlan id={current.id} closer={closer} />}
    </div>
  );
}
