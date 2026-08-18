import React, { useEffect, useState } from 'react';
import { api, getPin, setPin } from './api.js';
import Radar from './views/Radar.jsx';
import Coach from './views/Coach.jsx';
import Patterns from './views/Patterns.jsx';
import Admin from './views/Admin.jsx';

/** PIP dates, fixed by the plan itself. */
const PIP_END = new Date('2026-10-11T00:00:00');
const NEXT_REVIEW = new Date('2026-08-24T00:00:00');

function daysUntil(d) {
  return Math.ceil((d - new Date()) / 86_400_000);
}

/**
 * The PIN gate.
 *
 * Deliberately not a login — there is one user and no session. It exists so the
 * coaching layer is not readable by anyone who reaches the URL, which matters
 * because the API is Funnelled to the public internet.
 */
function Gate({ onDone }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  const submit = async e => {
    e.preventDefault();
    setPin(value.trim());
    try {
      await api.sessions();
      onDone();
    } catch {
      setError('That PIN was not accepted.');
    }
  };

  return (
    <div className="wrap gate">
      <div className="card">
        <h2>VANTAGE</h2>
        <p className="sub">This holds the private coaching layer. Enter your PIN.</p>
        <form onSubmit={submit}>
          <input
            type="password" value={value} autoFocus
            onChange={e => { setValue(e.target.value); setError(null); }}
            placeholder="PIN"
          />
          {error && <p className="small" style={{ color: 'var(--bad)' }}>{error}</p>}
          <div style={{ marginTop: 10 }}>
            <button className="primary" type="submit" disabled={!value.trim()}>Unlock</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState('radar');

  useEffect(() => {
    if (!getPin()) { setChecking(false); return; }
    api.sessions().then(() => setReady(true)).catch(() => {}).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="empty">Loading…</div>;
  if (!ready) return <Gate onDone={() => setReady(true)} />;

  const toReview = daysUntil(NEXT_REVIEW);
  const toEnd = daysUntil(PIP_END);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">VANT<span>AGE</span></div>
        <nav>
          {[['radar', 'Radar'], ['coach', 'Coach'], ['patterns', 'Patterns'], ['admin', 'Admin']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="clock">
          {toReview > 0 ? <>review in <b>{toReview}d</b> · </> : null}
          PIP ends in {toEnd}d
        </div>
      </header>

      <main>
        {tab === 'radar' && <Radar />}
        {tab === 'coach' && <Coach />}
        {tab === 'patterns' && <Patterns />}
        {tab === 'admin' && <Admin />}
      </main>
    </div>
  );
}
