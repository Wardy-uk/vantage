import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Observations — the durable bits.
 *
 * Separate from conversations because a pattern is worth keeping when the chat
 * around it is not, and because scrolling six weeks of transcript to find "this
 * is the third time" defeats the point of noticing it.
 *
 * `avoidance` is a deliberate category. It is the failure mode Nick has named in
 * himself, and a tool that only records wins would be no use against it.
 */

const KINDS = [
  { key: 'pattern', label: 'Pattern', hint: 'Something that keeps happening' },
  { key: 'avoidance', label: 'Avoidance', hint: 'Something being worked around' },
  { key: 'blocker', label: 'Blocker', hint: 'Something genuinely in the way' },
  { key: 'win', label: 'Win', hint: 'Something that worked — these get under-recorded' },
];

export default function Patterns() {
  const [items, setItems] = useState([]);
  const [kind, setKind] = useState('pattern');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);

  const load = async () => {
    try { setItems(await api.observations(filter || undefined)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [filter]);

  const add = async e => {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      await api.addObservation(kind, note.trim());
      setNote('');
      await load();
    } catch (err) { setError(err.message); }
  };

  const remove = async id => {
    await api.deleteObservation(id);
    await load();
  };

  const counts = KINDS.map(k => ({ ...k, n: items.filter(i => i.kind === k.key).length }));

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      <div className="card">
        <h2>Note something</h2>
        <p className="sub">Kept apart from the conversations, so a pattern survives the chat it came from.</p>
        <form onSubmit={add}>
          <div className="row" style={{ marginBottom: 8 }}>
            <select value={kind} onChange={e => setKind(e.target.value)} style={{ maxWidth: 190 }}>
              {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <span className="small muted">{KINDS.find(k => k.key === kind)?.hint}</span>
          </div>
          <textarea
            rows={2} value={note} onChange={e => setNote(e.target.value)}
            placeholder="What did you notice?"
          />
          <div style={{ marginTop: 8 }}>
            <button className="primary" type="submit" disabled={!note.trim()}>Save</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <h2>Observations</h2>
            <p className="sub" style={{ margin: 0 }}>
              {counts.map(c => `${c.n} ${c.label.toLowerCase()}`).join(' · ')}
            </p>
          </div>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="">All</option>
            {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>

        {items.length === 0 && (
          <p className="muted small">
            Nothing recorded yet. The useful ones are usually the uncomfortable ones.
          </p>
        )}

        {items.map(i => (
          <div key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="pill">{i.kind}</span>
              <span className="small muted">{new Date(i.created_at).toLocaleDateString('en-GB')}</span>
              <div className="spacer" style={{ flex: 1 }} />
              <button className="ghost danger small" style={{ border: 'none' }} onClick={() => remove(i.id)}>×</button>
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{i.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
