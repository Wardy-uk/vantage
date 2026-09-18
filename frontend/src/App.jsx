import React, { useEffect, useRef, useState } from 'react';
import { createInteractionBuffer, attachInteractionListener } from './interactions.js';
import { api, getPin, setPin } from './api.js';
import Radar from './views/Radar.jsx';
import Tracker from './views/Tracker.jsx';
import Findings from './views/Findings.jsx';
import Plan from './views/Plan.jsx';
import Standing from './Standing.jsx';
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
 * Reload the app, picking up a new deploy.
 *
 * Installed to the home screen there is no address bar and no pull-to-refresh,
 * so without this a deploy sits behind whatever shell the service worker
 * already has. `registration.update()` is what makes the button honest: it
 * forces the browser to re-fetch sw.js rather than waiting for its own schedule,
 * and the worker calls `skipWaiting()` on install, so the new one is in charge
 * by the time the page comes back.
 *
 * It is deliberately best-effort — no service worker, or a failed update check,
 * still reloads. A refresh button that can refuse to refresh is worse than one
 * that occasionally only does half the job.
 */
async function reloadApp() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } catch { /* the reload below is the point; the update check is a bonus */ }
  window.location.reload();
}

function ReloadButton() {
  const [going, setGoing] = useState(false);
  return (
    <button
      className={`reload${going ? ' spin' : ''}`}
      title="Reload app"
      aria-label="Reload app"
      disabled={going}
      onClick={() => { setGoing(true); reloadApp(); }}
    >
      <span>↻</span>
    </button>
  );
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

  // Which view is on, for NEURO's usage heatmap.
  //
  // ⚠ It sits ABOVE the early returns below — a hook under a conditional return
  // changes the hook count between renders and React rejects it outright. It is
  // gated on `ready` instead, so the PIN gate is not recorded as a screen.
  //
  // ⚠ Fire and forget: `.catch(() => {})`, never awaited. A grid is not worth a
  // navigation, and VANTAGE is the surface NEURO can only see by reading this
  // app's own store — a failure here is a blank cell, not a broken screen.
  useEffect(() => {
    if (!ready || !tab) return;
    api.screenOpen(tab).catch(() => {});
  }, [ready, tab]);

  // Control uses on the current view, coalesced and flushed.
  //
  // ⚠ Attached ONCE with a ref for the current tab, not per tab — the buffer is
  // keyed by screen and the tab is read at event time, so re-attaching on every
  // navigation would drop the clicks made on the view being left.
  // ⚠ Scoped to <main>: the nav sits outside it, so switching views is not
  // counted as working in one.
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    if (!ready) return undefined;
    const buffer = createInteractionBuffer({
      surface: 'vantage',
      send: ({ tab: t, count }) => api.screenInteract(t, count),
    });
    const detach = attachInteractionListener({ scope: 'main', getTab: () => tabRef.current, buffer });
    return () => { buffer.flush(); detach(); };
  }, [ready]);

  if (checking) return <div className="empty">Loading…</div>;
  if (!ready) return <Gate onDone={() => setReady(true)} />;

  const toReview = daysUntil(NEXT_REVIEW);
  const toEnd = daysUntil(PIP_END);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">VANT<span>AGE</span></div>
        <nav>
          {[['radar', 'Radar'], ['tracker', 'KPIs'], ['findings', 'Findings'], ['plan', 'Plan'], ['coach', 'Coach'], ['patterns', 'Patterns'], ['admin', 'Admin']].map(([k, label]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="clock">
          {toReview > 0 ? <>review in <b>{toReview}d</b> · </> : null}
          PIP ends in {toEnd}d
        </div>
        <ReloadButton />
      </header>

      <Standing onGoTo={setTab} />

      <main>
        {tab === 'radar' && <Radar />}
        {tab === 'tracker' && <Tracker />}
        {tab === 'findings' && <Findings />}
        {tab === 'plan' && <Plan />}
        {tab === 'coach' && <Coach />}
        {tab === 'patterns' && <Patterns />}
        {tab === 'admin' && <Admin />}
      </main>
    </div>
  );
}
