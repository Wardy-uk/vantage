import React, { useEffect, useState } from 'react';
import { api, setPin } from '../api.js';

/**
 * Changing the PIN also updates the one this browser sends.
 *
 * Without that, a successful change immediately 401s every subsequent request
 * and looks exactly like a failure — the user would reasonably conclude the
 * change had not worked and try again with a PIN that is now wrong.
 */
function ChangePin() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState(null);

  const submit = async e => {
    e.preventDefault();
    if (next !== confirm) { setState({ ok: false, message: 'The two new PINs do not match.' }); return; }
    setState({ running: true });
    try {
      await api.changePin(current, next);
      setPin(next);
      setState({ ok: true, message: 'PIN changed. This browser is already using the new one.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (err) {
      setState({ ok: false, message: err.message });
    }
  };

  return (
    <div className="card">
      <h2>Change PIN</h2>
      <p className="sub">
        Takes effect immediately, on this device and every other. Stored in the server's
        <code> .env</code>, because it is read at startup to decide whether the service may run at all.
      </p>
      <form onSubmit={submit}>
        <div style={{ marginBottom: 8 }}>
          <input type="password" value={current} placeholder="Current PIN"
            onChange={e => setCurrent(e.target.value)} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <input type="password" value={next} placeholder="New PIN (6+ characters)"
            onChange={e => setNext(e.target.value)} />
        </div>
        <div style={{ marginBottom: 8 }}>
          <input type="password" value={confirm} placeholder="New PIN again"
            onChange={e => setConfirm(e.target.value)} />
        </div>
        <button className="primary" type="submit"
          disabled={!current || !next || !confirm || state?.running}>
          {state?.running ? 'Changing…' : 'Change PIN'}
        </button>
        {state && !state.running && (
          <span className="small" style={{ marginLeft: 10, color: state.ok ? 'var(--good)' : 'var(--bad)' }}>
            {state.ok ? '✓ ' : '✗ '}{state.message}
          </span>
        )}
      </form>
    </div>
  );
}

/**
 * Configuration, editable here rather than over SSH.
 *
 * Two properties worth preserving if this is ever changed:
 *
 * 1. Secrets render as a masked tail and are never sent back in full. Leaving a
 *    secret field blank means "leave it alone", not "clear it" — otherwise
 *    saving a model change would wipe the API key.
 * 2. Every setting can be TESTED. A form that accepts a key and fails three
 *    screens later, inside a coaching reply, is worse than no form.
 */

export default function Admin() {
  const [fields, setFields] = useState([]);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState({});

  const load = async () => {
    try { setFields(await api.settings()); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const save = async e => {
    e.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      setFields(await api.saveSettings(edits));
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const runTest = async what => {
    setTests(t => ({ ...t, [what]: { running: true } }));
    try {
      // Resolved BEFORE the state update — the updater callback is synchronous
      // and cannot await. The NOVA test in particular takes 60–110 seconds.
      const result = await api.testSetting(what);
      setTests(t => ({ ...t, [what]: result }));
    } catch (err) {
      setTests(t => ({ ...t, [what]: { ok: false, message: err.message } }));
    }
  };

  const sourceLabel = {
    saved: 'set here',
    environment: 'from .env',
    default: 'default',
    unset: 'not set',
  };

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}
      {saved && <div className="banner info">Saved.</div>}

      <div className="card">
        <h2>Configuration</h2>
        <p className="sub">
          Stored on the server, outside the repo. Secrets are shown masked and are never sent back to this page in full.
        </p>

        <form onSubmit={save}>
          {fields.map(f => (
            <div key={f.key} style={{ marginBottom: 16 }}>
              <div className="row" style={{ marginBottom: 4 }}>
                <label style={{ fontWeight: 600, fontSize: 13 }}>{f.label}</label>
                <span className={`pill${f.isSet ? '' : ' '}`} style={f.isSet ? { color: 'var(--good)', borderColor: 'var(--good)' } : {}}>
                  {/* An unset THRESHOLD is a deliberate state — that card is off —
                      not a half-configured install. "unset" would read as broken. */}
                  {f.numeric && !f.isSet ? 'card off' : (sourceLabel[f.source] || f.source)}
                </span>
              </div>
              <input
                type={f.secret ? 'password' : (f.numeric ? 'number' : 'text')}
                min={f.numeric ? f.min : undefined}
                max={f.numeric ? f.max : undefined}
                step={f.numeric ? 'any' : undefined}
                value={edits[f.key] ?? (f.secret ? '' : f.value)}
                placeholder={f.secret && f.isSet
                  ? `${f.value} — leave blank to keep`
                  : (f.numeric ? `${f.min}–${f.max}, blank to turn this card off` : f.hint)}
                onChange={e => setEdits(x => ({ ...x, [f.key]: e.target.value }))}
              />
              <div className="small muted" style={{ marginTop: 3 }}>{f.hint}</div>
            </div>
          ))}

          <button className="primary" type="submit" disabled={saving || Object.keys(edits).length === 0}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {Object.keys(edits).length === 0 && (
            <span className="small muted" style={{ marginLeft: 10 }}>Nothing changed.</span>
          )}
        </form>
      </div>

      <div className="card">
        <h2>Test connections</h2>
        <p className="sub">Prove it works now, rather than finding out inside a coaching reply.</p>

        {[
          ['openrouter', 'OpenRouter', 'Sends a one-word completion.'],
          ['nova', 'NOVA bridge', 'Fetches live flow signals. Takes 60–110 seconds.'],
        ].map(([key, label, note]) => (
          <div key={key} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
              <div className="small muted">{note}</div>
              {tests[key] && !tests[key].running && (
                <div className="small" style={{ color: tests[key].ok ? 'var(--good)' : 'var(--bad)', marginTop: 4 }}>
                  {tests[key].ok ? '✓ ' : '✗ '}{tests[key].message}
                </div>
              )}
            </div>
            <button onClick={() => runTest(key)} disabled={tests[key]?.running}>
              {tests[key]?.running ? 'Testing…' : 'Test'}
            </button>
          </div>
        ))}
      </div>

      <ChangePin />
    </div>
  );
}
