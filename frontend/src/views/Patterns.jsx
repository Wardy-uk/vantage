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

/**
 * What NEURO has recorded — shown BESIDE the typed notes, never merged in.
 *
 * An observation is Nick saying "this keeps happening". A friction insight is a
 * count of things he actually did, with the evidence attached. Merging them
 * would either put words in his mouth or give a hunch the authority of a
 * measurement, so they are two sections with two headings.
 *
 * Every insight renders its own `because` line. A claim about somebody's week
 * that cannot show its working is exactly what NEURO refuses to produce, and a
 * surface that drops the working reintroduces the problem at the last step.
 *
 * Three states that must stay apart: could not ask, asked and could not see
 * everything, and asked and there is genuinely nothing. Only the last is good
 * news, and an empty list is not it.
 */
function FromNeuro({ data }) {
  if (!data) return null;

  if (!data.available) {
    return (
      <div className="card">
        <h2>What NEURO has recorded</h2>
        <p className="small muted">
          Could not read it — {data.reason}. That is not the same as nothing being in your way.
        </p>
      </div>
    );
  }

  const { insights = [], gaps = [], complete, evidenceCount, noted } = data;

  return (
    <div className="card">
      <h2>What NEURO has recorded</h2>
      <p className="sub">
        Deferrals with the reason you gave, tasks you made smaller, sessions parked as too big.
        Evidence only — nothing here is inferred from silence.
      </p>

      {gaps.length > 0 && (
        <div className="small" style={{ color: 'var(--warn)', marginBottom: 8 }}>
          {gaps.length} source{gaps.length === 1 ? '' : 's'} could not be read
          ({gaps.map(g => g.source).join(', ')}), so this is not a full picture.
        </div>
      )}

      {insights.length === 0 && (
        <p className="small muted">
          {complete
            ? `Nothing recorded is getting in your way${evidenceCount ? ` — ${evidenceCount} thing${evidenceCount === 1 ? '' : 's'} looked at${noted ? `, ${noted} already taken on board` : ''}` : ''}.`
            : 'Nothing to show from the sources that answered — which is not the same as nothing being there.'}
        </p>
      )}

      {insights.map(i => (
        <div key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 8 }}>
            <strong style={{ fontSize: 14, flex: 1 }}>{i.text}</strong>
            <span className="pill">{i.kind}</span>
          </div>
          {/* The working, always. */}
          <div className="small muted" style={{ marginTop: 3 }}>{i.because}</div>
          {i.evidence?.length > 0 && (
            <div className="small muted" style={{ marginTop: 4, paddingLeft: 10, borderLeft: '2px solid var(--line)' }}>
              {i.evidence.map((e, n) => (
                <div key={n}>{e.detail}{e.observedAt ? ` · ${String(e.observedAt).slice(0, 10)}` : ''}</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Patterns() {
  const [items, setItems] = useState([]);
  const [kind, setKind] = useState('pattern');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState(null);
  const [neuro, setNeuro] = useState(null);

  const load = async () => {
    try { setItems(await api.observations(filter || undefined)); }
    catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, [filter]);

  // Separate, and not refetched on filter: the filter is about his own notes,
  // and NEURO's read is a network call that must not be paid for a dropdown.
  useEffect(() => {
    api.friction()
      .then(setNeuro)
      .catch(e => setNeuro({ available: false, reason: e.message, insights: [] }));
  }, []);

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

      <FromNeuro data={neuro} />

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
