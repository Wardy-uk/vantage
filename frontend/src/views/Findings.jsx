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

/**
 * The three tenses, and what each one means for what happens next.
 *
 * Not decoration. `criticality.assess` reads the tense to decide whether a
 * finding is written straight into Nick's task list or waits in the approval
 * queue — a high-severity thing that has ALREADY gone wrong goes direct, and
 * one that has not happened yet waits, because being early is worth attention
 * rather than an interruption. Ten findings predate the field and carry none,
 * so this control is how they get one.
 */
const TENSE_LABELS = {
  happened: 'Already gone wrong',
  happening: 'Going wrong now',
  could: 'Could go wrong',
};

const TENSE_HELP = {
  happened: 'It has already cost something. High severity here goes straight to your NEURO tasks.',
  happening: 'It is going wrong right now. High severity here goes straight to your NEURO tasks.',
  could: 'It has not happened yet. Waits in the approval queue however severe — being early is worth your attention, not your task list.',
};

function Row({ f, onChange, onDelete }) {
  const [draft, setDraft] = useState(null);
  const [drafting, setDrafting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [neuro, setNeuro] = useState(null);
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [how, setHow] = useState('');

  /**
   * Put this finding on NEURO's weekly risk report.
   *
   * The chain up to here is all Nick's: the radar noticed, he logged it, he
   * kept it. This is the step that makes it visible to Chris — so it says what
   * it did rather than going quiet, and in particular it says when it has just
   * answered NEURO's "escalations confirmed?" question, because that stops
   * NEURO asking whether there was anything else to add.
   */
  const toNeuro = async () => {
    setSending(true);
    try { setNeuro(await api.escalateFinding(f.id)); }
    catch (e) { setNeuro({ error: e.message }); }
    finally { setSending(false); }
  };

  const onDraft = async () => {
    setDrafting(true);
    try { setDraft((await api.draftRaise(f.id, 'Chris')).draft); }
    catch (e) { setDraft('Could not draft: ' + e.message); }
    finally { setDrafting(false); }
  };

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

      {/* ⚠ "Not set" is shown rather than hidden. A finding with no tense routes
          `pending` for ever and there was previously no way to say otherwise —
          leaving the gap invisible is what let ten of them sit like that. */}
      <div className="row small" style={{ gap: 6, paddingLeft: 15, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="muted">When:</span>
        {Object.keys(TENSE_LABELS).map(t => (
          <button
            key={t}
            className="ghost small"
            title={TENSE_HELP[t]}
            onClick={() => onChange(f.id, { tense: f.tense === t ? null : t })}
            style={{
              border: '1px solid var(--line)', borderRadius: 99, padding: '1px 8px',
              color: f.tense === t ? 'var(--accent)' : 'var(--muted)',
              borderColor: f.tense === t ? 'var(--accent)' : 'var(--line)',
            }}
          >{TENSE_LABELS[t]}</button>
        ))}
        {!f.tense && (
          <span className="muted" title="Nothing has said whether this has happened yet, so it waits in the approval queue rather than reaching your tasks.">
            not set — waits for you
          </span>
        )}
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
        {/* The barrier to raising a finding is a blank page, not the decision.
            This removes the blank page — what is left is editing and sending,
            which is a different kind of task entirely. */}
        {!f.raised_on && (
          <button className="ghost small" style={{ border: 'none', padding: '0 6px', color: 'var(--accent)' }}
            onClick={onDraft} disabled={drafting}>
            {drafting ? 'writing…' : 'draft the message'}
          </button>
        )}
        <button className="ghost small" style={{ border: 'none', padding: '0 6px', color: 'var(--accent)' }}
          onClick={toNeuro} disabled={sending}
          title="Add to the Escalations to Chris section of NEURO's weekly risk report. Nothing is sent.">
          {sending ? 'sending…' : f.neuro_week ? 're-send to NEURO' : 'log to NEURO'}
        </button>
        {f.status === 'resolved'
          ? (
            <button className="ghost small" style={{ border: 'none', padding: '0 6px' }}
              onClick={() => onChange(f.id, null, 'reopen')}
              title="A resolution can turn out to be wrong. Nothing written is lost.">reopen</button>
          )
          : (
            <button className="ghost small" style={{ border: 'none', padding: '0 6px', color: 'var(--good)' }}
              onClick={() => setResolving(!resolving)}>
              {resolving ? 'cancel' : 'resolve'}
            </button>
          )}
        <button className="ghost small" style={{ border: 'none', padding: '0 6px' }}
          onClick={() => setEditing(!editing)}>{editing ? 'cancel' : 'edit'}</button>
        <button className="ghost danger small" style={{ border: 'none', padding: '0 6px' }}
          onClick={() => onDelete(f.id)}>delete</button>
      </div>

      {draft && (
        <div style={{ paddingLeft: 15, marginTop: 8 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            Draft — read it, change what is wrong, send it. Then mark it raised.
          </div>
          <textarea rows={6} value={draft} onChange={e => setDraft(e.target.value)}
            style={{ fontSize: 13 }} />
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button onClick={() => { navigator.clipboard?.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button className="primary" onClick={async () => {
              await onChange(f.id, {
                raised_with: raisedWith || 'Chris',
                raised_on: new Date().toISOString().slice(0, 10),
              });
              setDraft(null);
            }}>
              Sent it — mark raised
            </button>
            <button className="ghost" onClick={() => setDraft(null)}>Discard</button>
          </div>
        </div>
      )}

      {/* Said in full rather than as a tick. Landing on the report is not the
          same as having been sent, and the difference is the whole register. */}
      {neuro && (
        <div className="small" style={{ paddingLeft: 15, marginTop: 6 }}>
          {neuro.error
            ? <span style={{ color: 'var(--bad)' }}>Could not reach NEURO — {neuro.error}</span>
            : (
              <span style={{ color: 'var(--good)' }}>
                {neuro.already
                  ? `Already on the w/c ${neuro.week} report — left alone rather than added twice.`
                  : `On the w/c ${neuro.week} report, ${neuro.count} escalation${neuro.count === 1 ? '' : 's'} listed. Not sent — publish and send it in NEURO.`}
                {neuro.confirmedSection && (
                  <span style={{ color: 'var(--warn)', display: 'block', marginTop: 3 }}>
                    This also confirmed the escalations section, which was blocking that report.
                    NEURO will not ask again — add anything else you meant to include.
                  </span>
                )}
              </span>
            )}
        </div>
      )}

      {/* NEURO ticking the task proves the work happened and says nothing about
          what was done. That sentence is the finding's whole value at a review,
          so the register asks for it rather than closing itself. */}
      {f.status === 'resolved_pending' && !resolving && (
        <div className="small" style={{ paddingLeft: 15, marginTop: 6, color: 'var(--warn)' }}>
          Marked done in NEURO{f.neuro_resolved_on ? ' on ' + f.neuro_resolved_on : ''} — what was done?
          <button className="ghost small" style={{ border: 'none', padding: '0 6px', color: 'var(--accent)' }}
            onClick={() => setResolving(true)}>write it up</button>
        </div>
      )}

      {f.status === 'resolved' && (
        <div className="small" style={{ paddingLeft: 15, marginTop: 6, color: 'var(--good)' }}>
          ✓ Resolved{f.resolved_on ? ' ' + f.resolved_on : ''} — {f.resolved_how || 'no account recorded'}
        </div>
      )}

      {/* Dropping a task is abandoning it, which is not the same as fixing it. */}
      {f.neuro_task_status === 'dropped' && f.status !== 'resolved' && (
        <div className="small" style={{ paddingLeft: 15, marginTop: 4, color: 'var(--warn)' }}>
          The NEURO task was dropped, not completed — that is not a resolution, so this stays open.
        </div>
      )}

      {resolving && (
        <div style={{ paddingLeft: 15, marginTop: 8 }}>
          <div className="small muted" style={{ marginBottom: 4 }}>
            What was done to resolve this? Required — "resolved" on its own records nothing,
            and this sentence is what the finding is worth at a review.
          </div>
          <textarea rows={2} value={how} onChange={e => setHow(e.target.value)}
            placeholder="What changed, and what proves it" style={{ fontSize: 13 }} />
          <button className="primary" style={{ marginTop: 6 }} disabled={!how.trim()}
            onClick={async () => { await onChange(f.id, how.trim(), 'resolve'); setResolving(false); setHow(''); }}>
            Mark resolved
          </button>
        </div>
      )}

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
  const [synced, setSynced] = useState(0);
  const [showResolved, setShowResolved] = useState(false);
  const [form, setForm] = useState({ title: '', detail: '', severity: 'medium', foundOn: new Date().toISOString().slice(0, 10) });

  const load = async () => {
    try { setItems(await api.findings()); } catch (e) { setError(e.message); }
  };

  /**
   * Ask NEURO whether any linked task has been ticked, AFTER the register has
   * rendered. Separate on purpose: the register must still open with NEURO
   * down, and putting a network round trip in front of it would make an outage
   * in one system look like an empty register in the other.
   */
  const sync = async () => {
    try {
      const r = await api.syncFindings();
      if (r?.changed?.length) { setSynced(r.changed.length); await load(); }
    } catch { /* the register is already on screen; a failed sync is not news */ }
  };

  useEffect(() => { load().then(sync); }, []);

  const add = async e => {
    e.preventDefault();
    if (!form.title.trim()) return;
    try {
      await api.addFinding({ ...form, source: 'manual' });
      setForm({ title: '', detail: '', severity: 'medium', foundOn: new Date().toISOString().slice(0, 10) });
      await load();
    } catch (err) { setError(err.message); }
  };

  /**
   * `resolve` and `reopen` are their own routes rather than a status written
   * through the generic patch: closing a finding requires an account of what
   * was done, and a rule enforced only in the UI is one the next caller walks
   * straight past.
   */
  const change = async (id, patch, verb) => {
    if (verb === 'resolve') await api.resolveFinding(id, patch);
    else if (verb === 'reopen') await api.reopenFinding(id);
    else await api.updateFinding(id, patch);
    await load();
  };
  const del = async id => {
    if (!confirm('Delete this finding? The register is meant to be a history.')) return;
    await api.deleteFinding(id); await load();
  };

  const exportMd = async () => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    setMd((await api.findingsMarkdown(since)).markdown);
  };

  // "Open" means not closed. A finding NEURO says is done but which has no
  // account of what was done is NOT finished — filing it under resolved is how
  // it would never get written up.
  const open = items.filter(f => f.status !== 'resolved' && f.status !== 'accepted');
  const closed = items.filter(f => f.status === 'resolved');
  const raised = open.filter(f => f.raised_on).length;
  const pending = open.filter(f => f.status === 'resolved_pending').length;

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
              {open.length} open · <strong>{raised} raised</strong> · {open.length - raised} not yet
              {pending > 0 && <> · <span style={{ color: 'var(--warn)' }}>{pending} done in NEURO, not written up</span></>}
            </p>
          </div>
          <button className="ghost" onClick={exportMd}>Export last 7 days</button>
        </div>

        {synced > 0 && (
          <div className="small" style={{ color: 'var(--warn)', marginBottom: 8 }}>
            {synced} finding{synced === 1 ? '' : 's'} marked done in NEURO — say what was done and they close.
          </div>
        )}

        {open.length === 0 && (
          <p className="small muted">
            {closed.length
              ? 'Nothing open. Everything logged has been resolved.'
              : 'Nothing logged yet. Anything on the Radar worth telling someone about belongs here.'}
          </p>
        )}
        {open.map(f => <Row key={f.id} f={f} onChange={change} onDelete={del} />)}
      </div>

      {/* Kept, and collapsed. The register is a history — its value at a 90-day
          review is entirely in what it still remembers — but day to day the
          screen's job is what is still open. */}
      {closed.length > 0 && (
        <div className="card">
          <button onClick={() => setShowResolved(v => !v)} aria-expanded={showResolved}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <h2 style={{ flex: 1 }}>Resolved ({closed.length})</h2>
            <span className="small muted">{showResolved ? 'hide' : 'show'}</span>
          </button>
          {showResolved && closed.map(f => <Row key={f.id} f={f} onChange={change} onDelete={del} />)}
        </div>
      )}

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
