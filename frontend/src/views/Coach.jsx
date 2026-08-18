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
          {!current && (
            <div className="empty">
              <p><strong>Private.</strong> Nothing here reaches the weekly report, the vault, or anyone else.</p>
              <p className="small">{MODE_HINT[mode]}</p>
              <p className="small">Start typing below, or pick a past conversation.</p>
            </div>
          )}

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
