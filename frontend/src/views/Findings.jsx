import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The findings register — the evidence half.
 *
 * The column that matters is "raised". Spotting something and telling someone
 * are different acts, and only the second is evidence of proactive escalation.
 * The UI keeps them visually separate for that reason, and says so rather than
 * letting a long list of private observations look like a good month.
 */

const SEV = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };

function Row({ f, onChange, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [raisedWith, setRaisedWith] = useState(f.raised_with || '');
  const [raisedOn, setRaisedOn] = useState(f.raised_on || new Date().toISOString().slice(0, 10));
  const [action, setAction] = useState(f.action || '');

  const save = async () => {
    await onChange(f.id, { raised_with: raisedWith || null, raised_on: raisedOn || null, action });
    setEditing(false);
  };

  return (
    <div style={{ padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="row" style={{ gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: SEV[f.severity], flexShrink: 0 }} />
        <strong style={{ fontSize: 14, flex: 1 }}>{f.title}</strong>
        <span className="small muted">{f.found_on}</span>
        <span className="pill">{f.source}</span>
      </div>

      {f.detail && <div className="small muted" style={{ paddingLeft: 15, marginTop: 3 }}>{f.detail}</div>}

      <div style={{ paddingLeft: 15, marginTop: 6 }}>
        {f.raised_on
          ? (
            <span className="small" style={{ color: 'var(--good)' }}>
              ✓ Raised with {f.raised_with || 'someone'} on {f.raised_on}
              {f.action && <span className="muted"> · {f.action}</span>}
            </span>
          )
          : <span className="small" style={{ color: 'var(--warn)' }}>Not yet raised with anyone</span>}
        {' '}
        <button className="ghost small" style={{ border: 'none', padding: '0 6px' }}
          onClick={() => setEditing(!editing)}>{editing ? 'cancel' : 'edit'}</button>
        <button className="ghost danger small" style={{ border: 'none', padding: '0 6px' }}
          onClick={() => onDelete(f.id)}>delete</button>
      </div>

      {editing && (
        <div style={{ paddingLeft: 15, marginTop: 8 }}>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <input placeholder="Raised with (e.g. Chris)" value={raisedWith}
              onChange={e => setRaisedWith(e.target.value)} />
            <input type="date" value={raisedOn} onChange={e => setRaisedOn(e.target.value)} style={{ maxWidth: 165 }} />
          </div>
          <input placeholder="What you did about it" value={action} onChange={e => setAction(e.target.value)} />
          <button className="primary" style={{ marginTop: 6 }} onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}

export default function Findings() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [md, setMd] = useState(null);
  const [form, setForm] = useState({ title: '', detail: '', severity: 'medium', foundOn: new Date().toISOString().slice(0, 10) });

  const load = async () => {
    try { setItems(await api.findings()); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const add = async e => {
    e.preventDefault();
    if (!form.title.trim()) return;
    try {
      await api.addFinding({ ...form, source: 'manual' });
      setForm({ title: '', detail: '', severity: 'medium', foundOn: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (err) { setError(err.message); }
  };

  const change = async (id, patch) => { await api.updateFinding(id, patch); await load(); };
  const del = async id => {
    if (!confirm('Delete this finding? The register is meant to be a history.')) return;
    await api.deleteFinding(id); await load();
  };

  const exportMd = async () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    setMd((await api.findingsMarkdown(since)).markdown);
  };

  const raised = items.filter(f => f.raised_on).length;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      <div className="card">
        <h2>Log a finding</h2>
        <p className="sub">
          Something you spotted. Date it when you <em>found</em> it, not when you typed it —
          the gap between the two is itself worth being honest about.
        </p>
        <form onSubmit={add}>
          <input placeholder="What did you find?" value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })} />
          <textarea rows={2} placeholder="Detail, evidence, where you saw it" style={{ marginTop: 6 }}
            value={form.detail} onChange={e => setForm({ ...form, detail: e.target.value })} />
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} style={{ maxWidth: 130 }}>
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select>
            <input type="date" value={form.foundOn} onChange={e => setForm({ ...form, foundOn: e.target.value })} style={{ maxWidth: 165 }} />
            <button className="primary" type="submit" disabled={!form.title.trim()}>Log it</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <h2>Register</h2>
            <p className="sub" style={{ margin: 0 }}>
              {items.length} finding{items.length === 1 ? '' : 's'} · <strong>{raised} raised</strong> · {items.length - raised} not yet
            </p>
          </div>
          <button className="ghost" onClick={exportMd}>Export last 7 days</button>
        </div>

        {items.length === 0 && (
          <p className="small muted">
            Nothing logged yet. Anything on the Radar worth telling someone about belongs here.
          </p>
        )}
        {items.map(f => <Row key={f.id} f={f} onChange={change} onDelete={del} />)}
      </div>

      {md && (
        <div className="card">
          <h2>For the weekly report</h2>
          <p className="sub">
            Paste into the Weekly Risk &amp; Anomaly Summary. Deliberately an export rather than an
            automatic write — what goes to Chris should be your decision, not a side effect.
          </p>
          <textarea rows={12} readOnly value={md} style={{ fontFamily: 'var(--mono)', fontSize: 12 }} />
        </div>
      )}
    </div>
  );
}
