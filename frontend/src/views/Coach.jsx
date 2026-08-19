import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * The private coaching layer.
 *
 * Nothing here is exported, summarised or quoted into anything outward-facing.
 * That boundary is enforced on the server — this view has no path to the weekly
 * report or the vault — but it is worth stating in the UI too, because the value
 * of the thing depends on Nick believing it.
 */

/**
 * The brief — the coach speaking first.
 *
 * This replaced an empty box and a hint. The failure mode being coached is *not
 * noticing*, and a tool you have to remember to consult cannot help with not
 * remembering. So the screen opens with what the evidence suggests is worth his
 * attention, and each theme can be opened as a conversation carrying its own
 * question.
 */
function Brief({ onStarted, mode }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(null);

  const load = async (force = false) => {
    setLoading(true);
    try { setData(await api.brief(force)); setError(null); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const start = async theme => {
    setStarting(theme.title);
    try { onStarted(await api.startFromTheme(theme)); }
    catch (e) { setError(e.message); }
    finally { setStarting(null); }
  };

  if (loading) {
    return (
      <div className="empty">
        Reading the signals and your own record…
        <div className="small" style={{ marginTop: 8 }}>This takes a minute or two the first time each day.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      {error && <div className="banner bad">{error}</div>}

      <div className="row" style={{ marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Worth your attention</div>
          <div className="small muted">
            Unprompted, from the radar and your own record. Private — nothing here leaves this app.
          </div>
        </div>
        <button className="ghost small" onClick={() => load(true)}>Regenerate</button>
      </div>

      {data?.unavailable?.length > 0 && (
        <div className="banner warn small">
          {data.unavailable.length} source(s) unreadable, so this is drawn from an incomplete picture:{' '}
          {data.unavailable.map(u => u.name).join(', ')}
        </div>
      )}

      {data?.themes?.length === 0 && (
        <div className="card">
          <p className="small">
            Nothing stands out this week. That is a real answer rather than a gap —
            a brief that always finds three things to work on is a horoscope.
          </p>
          <p className="small muted">Start a conversation below if something is on your mind.</p>
        </div>
      )}

      {data?.done && (
        <div className="banner info small" style={{ marginBottom: 12 }}>
          <strong>Moved:</strong> {data.done}
        </div>
      )}

      {data?.themes?.map((t, i) => (
        <div className="card" key={i}>
          <h2 style={{ fontSize: 14 }}>{t.title}</h2>
          {t.evidence && <p className="small" style={{ color: 'var(--muted)', margin: '0 0 8px' }}>{t.evidence}</p>}
          {t.why && <p className="small" style={{ margin: '0 0 10px' }}>{t.why}</p>}

          {t.nextStep && (
            <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', margin: '0 0 10px' }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Next step — already started for you</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{t.nextStep}</div>
            </div>
          )}

          {t.question && (
            <p style={{ fontSize: 14, fontWeight: 600, borderLeft: '2px solid var(--accent)', paddingLeft: 10, margin: '0 0 10px' }}>
              {t.question}
            </p>
          )}
          <button onClick={() => start(t)} disabled={starting === t.title}>
            {starting === t.title ? 'Opening...' : 'Talk it through'}
          </button>
        </div>
      ))}

      <p className="small muted" style={{ textAlign: 'center', marginTop: 18 }}>
        {MODE_HINT[mode]} — or just start typing below.
      </p>
    </div>
  );
}

const MODE_HINT = {
  coach: 'Open thinking partner. Expect to be asked what the problem actually is before getting an answer.',
  prep: 'A conversation is coming. It will play the other person properly, including their strongest objection.',
  reflect: 'Something has happened. It will look for the pattern rather than treat it as a one-off.',
};

export default function Coach() {
  const [sessions, setSessions] = useState([]);
  const [current, setCurrent] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('coach');
  const endRef = useRef(null);

  const loadSessions = async () => setSessions(await api.sessions());

  useEffect(() => { loadSessions().catch(e => setError(e.message)); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [current?.messages?.length, sending]);

  const open = async id => {
    setError(null);
    try { setCurrent(await api.session(id)); } catch (e) { setError(e.message); }
  };

  const startNew = async () => {
    setError(null);
    try {
      const s = await api.createSession('Untitled', mode);
      setCurrent(s);
      await loadSessions();
    } catch (e) { setError(e.message); }
  };

  const send = async e => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    let session = current;
    if (!session) {
      try { session = await api.createSession('Untitled', mode); setCurrent(session); }
      catch (err) { setError(err.message); return; }
    }

    setDraft('');
    setSending(true);
    setError(null);
    // Show the message immediately. The model call takes seconds and an input
    // that empties into nothing feels broken.
    setCurrent(c => ({ ...c, messages: [...(c?.messages || []), { id: 'pending', role: 'user', content: text }] }));

    try {
      setCurrent(await api.sendMessage(session.id, text));
      await loadSessions();
    } catch (err) {
      setError(err.message);
      // Give the text back rather than losing it to a failed request.
      setDraft(text);
      setCurrent(c => ({ ...c, messages: (c?.messages || []).filter(m => m.id !== 'pending') }));
    } finally {
      setSending(false);
    }
  };

  const remove = async id => {
    if (!confirm('Delete this conversation? It cannot be recovered.')) return;
    await api.deleteSession(id);
    if (current?.id === id) setCurrent(null);
    await loadSessions();
  };

  return (
    <div className="coach">
      <aside className="sessions">
        <select value={mode} onChange={e => setMode(e.target.value)} style={{ marginBottom: 8 }}>
          <option value="coach">Coach</option>
          <option value="prep">Conversation prep</option>
          <option value="reflect">Reflect</option>
        </select>
        <button className="primary" style={{ width: '100%', marginBottom: 12 }} onClick={startNew}>
          New conversation
        </button>

        {sessions.length === 0 && <p className="small muted">No conversations yet.</p>}
        {sessions.map(s => (
          <div
            key={s.id}
            className={`item${current?.id === s.id ? ' on' : ''}`}
            onClick={() => open(s.id)}
          >
            <div className="t">{s.title}</div>
            <div className="m">
              {s.mode} · {s.message_count} msg
              <button
                className="ghost danger small"
                style={{ float: 'right', padding: '0 5px', border: 'none' }}
                onClick={e => { e.stopPropagation(); remove(s.id); }}
                title="Delete"
              >×</button>
            </div>
          </div>
        ))}
      </aside>

      <section className="thread">
        <div className="messages">
          {!current && <Brief onStarted={s => { setCurrent(s); loadSessions(); }} mode={mode} />}

          {current?.messages?.map((m, i) => (
            <div key={m.id ?? i} className={`msg ${m.role}`}>
              <div className="who">{m.role === 'user' ? 'You' : 'VANTAGE'}</div>
              <div className="body">{m.content}</div>
            </div>
          ))}

          {sending && (
            <div className="msg assistant">
              <div className="who">VANTAGE</div>
              <div className="body muted">Thinking…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && <div className="banner bad" style={{ margin: '0 20px' }}>{error}</div>}

        <form className="composer" onSubmit={send}>
          <div className="inner">
            <textarea
              rows={2}
              value={draft}
              placeholder={current ? 'Say what is actually going on…' : `New ${mode} conversation…`}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
              }}
            />
            <button className="primary" type="submit" disabled={!draft.trim() || sending}>
              {sending ? '…' : 'Send'}
            </button>
          </div>
          <div className="inner small muted" style={{ marginTop: 6 }}>
            ⌘/Ctrl + Enter to send · this conversation is private and never leaves this machine's database
          </div>
        </form>
      </section>
    </div>
  );
}
