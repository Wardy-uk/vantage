import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The written case for Chris (30 Oct 2026).
 *
 * VANTAGE drafts each skill — an argument, the 3–5 strongest items as one-line
 * summaries, and for gaps an honest position plus the Plan tab's actions. Nick
 * unticks, edits, adds more, and presses "Happy with this skill". Only confirmed
 * skills are exported. Colleagues are never named: the server refuses a line
 * that names one, and this page shows which line and which name.
 */

const RATING = {
  met: { label: 'Met', color: 'var(--good)' },
  partly: { label: 'Partly', color: 'var(--warn)' },
  'not-yet': { label: 'Not yet', color: 'var(--bad)' },
  'no-evidence': { label: 'No evidence yet', color: 'var(--muted)' },
  unrated: { label: 'Not rated', color: 'var(--muted)' },
};
const READY = { ready: 'Ready', nearly: 'Nearly', 'not-yet': 'Not yet', 'too-little-evidence': 'Too little evidence to say' };
const GAP = ['partly', 'not-yet', 'no-evidence', 'unrated'];

function Pill({ children, color }) {
  return <span className="pill" style={color ? { color, borderColor: color } : undefined}>{children}</span>;
}

function NameWarn({ names }) {
  if (!names?.length) return null;
  return <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>Names {names.join(', ')} — use their role instead (e.g. "a direct report").</div>;
}

function SkillEditor({ slot, s, busyAll, onSaved, onRedraft }) {
  const [argument, setArgument] = useState(s.argument || '');
  const [position, setPosition] = useState(s.position || '');
  const [items, setItems] = useState(s.items);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [more, setMore] = useState(null);
  const [open, setOpen] = useState(!s.reviewed);
  // A fresh server copy replaces the local one only when nothing is being edited.
  useEffect(() => {
    if (dirty) return;
    setArgument(s.argument || ''); setPosition(s.position || ''); setItems(s.items);
  }, [s, dirty]);
  const gap = GAP.includes(s.rating);
  const r = RATING[s.rating] || {};
  const included = items.filter((i) => i.included);
  const edit = (fn) => { setDirty(true); fn(); };
  const save = async (reviewed) => {
    setBusy(reviewed === true ? 'confirm' : 'save'); setErr(null);
    try {
      const body = { argument: argument || null, position: position || null, items: items.map(({ id, line, included: inc }) => ({ id, line, included: inc })) };
      if (reviewed !== undefined) body.reviewed = reviewed;
      const next = await api.perfCaseSkill(slot, s.code, body);
      setDirty(false);
      onSaved(next);
      if (reviewed === true) setOpen(false);
    } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };
  const loadMore = async () => {
    setErr(null);
    try { setMore((await api.perfCaseCandidates(slot, s.code)).items); } catch (x) { setErr(x.message); }
  };
  const add = async (id) => {
    if (dirty) { setErr('Save your changes first — adding an item reloads this skill.'); return; }
    setBusy(`add${id}`); setErr(null);
    try {
      const next = await api.perfCaseAdd(slot, s.code, id);
      setMore((m) => (m || []).filter((x) => x.id !== id));
      onSaved(next);
    } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };

  return (
    <div className="case-skill" style={{ borderLeftColor: s.reviewed ? 'var(--good)' : r.color }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="ghost" style={{ padding: '2px 6px' }} onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
        <b>{s.code} {s.name}</b>
        <span className="small muted">target L{s.target}{s.observedLevel ? ` · seen L${s.observedLevel}` : ''}</span>
        <Pill color={r.color}>{r.label || s.rating}</Pill>
        {s.reviewed ? <Pill color="var(--good)">Confirmed ✓</Pill> : s.drafted ? <Pill color="var(--warn)">Draft — not in the export yet</Pill> : <Pill>Not drafted</Pill>}
        <span className="spacer" />
        {!open && <span className="small muted">{included.length} item(s) ticked</span>}
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          {s.error && <div className="banner warn">{s.error}</div>}
          {err && <div className="banner bad">{err}</div>}
          {s.why && <p className="small muted" style={{ marginTop: 0 }}>VANTAGE's reading: {s.why}</p>}
          {gap && (
            <>
              <label className="small"><b>Where I stand</b> — one honest sentence on what is not shown yet</label>
              <textarea rows={2} style={{ width: '100%' }} value={position} onChange={(e) => edit(() => setPosition(e.target.value))} />
              <NameWarn names={dirty ? [] : s.positionNames} />
            </>
          )}
          {(!gap || s.rating === 'partly' || argument) && (
            <>
              <label className="small"><b>The argument</b> — what the evidence shows, in your words</label>
              <textarea rows={3} style={{ width: '100%' }} value={argument} onChange={(e) => edit(() => setArgument(e.target.value))} />
              <NameWarn names={dirty ? [] : s.argumentNames} />
            </>
          )}
          <div className="small" style={{ margin: '10px 0 4px' }}><b>Evidence</b> — ticked items go in the case, as the line shown. Edit any line.</div>
          {!items.length && <div className="small muted">No items yet{s.available ? ' — use Add more below.' : ' — there is no accepted evidence for this skill.'}</div>}
          {items.map((it, i) => (
            <div key={it.id} className="case-item" style={{ opacity: it.included ? 1 : 0.55 }}>
              <input type="checkbox" checked={it.included} onChange={(e) => edit(() => setItems(items.map((x, j) => (j === i ? { ...x, included: e.target.checked } : x))))} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small muted">#{it.id} · {String(it.occurredAt || '').slice(0, 10)}{it.title ? ` · ${it.title}` : ''}{it.gone ? ' · no longer accepted' : ''}{it.fromList ? ' · added from the evidence list' : ''}</div>
                <input type="text" style={{ width: '100%' }} value={it.line} placeholder="One line on what you did and what came of it" onChange={(e) => edit(() => setItems(items.map((x, j) => (j === i ? { ...x, line: e.target.value } : x))))} />
                <NameWarn names={dirty ? [] : it.names} />
                {!dirty && it.personal && it.included && <div className="small" style={{ color: 'var(--warn)', marginTop: 4 }}>Reads as a personal matter (“{it.personal}”) — about someone else’s welfare, health, leaving or pay? Leave it out of a case Chris reads.</div>}
              </div>
            </div>
          ))}
          {gap && s.plan.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="small"><b>What I'm doing</b> — from the Development plan (change it on that tab):</div>
              <ul className="small" style={{ margin: '4px 0' }}>
                {s.plan.filter((p) => p.state !== 'dismissed').map((p) => <li key={p.id}>{p.action}{p.state === 'pushed' ? ' (in NEURO)' : ''}</li>)}
              </ul>
            </div>
          )}
          {gap && !s.plan.length && <div className="small muted" style={{ marginTop: 8 }}>No plan actions for this skill — the gap will read without a "what I'm doing" line. Add one on the Development plan tab.</div>}
          {more && (
            <div className="peek">
              <div className="row"><b className="small">More evidence for {s.code} ({more.length})</b><span className="spacer" /><button className="small" onClick={() => setMore(null)}>Close</button></div>
              {!more.length && <div className="small muted">Nothing else accepted for this skill.</div>}
              {more.map((e) => (
                <div key={e.id} className="peek-item row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div className="small muted">#{e.id} · {String(e.occurredAt || '').slice(0, 10)}{e.cited ? ' · cited by the assessment' : ''}{e.against ? ' · tagged as evidence AGAINST' : ''}</div>
                    <div className="small">{e.title}</div>
                  </div>
                  <button className="small" disabled={Boolean(busy)} onClick={() => add(e.id)}>{busy === `add${e.id}` ? 'Drafting…' : 'Add'}</button>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            {!s.reviewed && <button className="primary" disabled={Boolean(busy) || busyAll} onClick={() => save(true)}>{busy === 'confirm' ? 'Checking…' : 'Happy with this skill'}</button>}
            {s.reviewed && <button disabled={Boolean(busy)} onClick={() => save(false)}>Change it again</button>}
            {dirty && <button disabled={Boolean(busy)} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
            {s.available > 0 && <button disabled={Boolean(busy)} onClick={loadMore}>Add more ({s.available})</button>}
            <span className="spacer" />
            <button className="ghost" disabled={busyAll || Boolean(busy)} onClick={() => onRedraft(s)}>Redraft this skill</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CaseBuilder({ slot, onClose }) {
  const [v, setV] = useState(null);
  const [err, setErr] = useState(null);
  const [opening, setOpening] = useState('');
  const [openingDirty, setOpeningDirty] = useState(false);
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(async () => {
    try { const x = await api.perfCaseView(slot); setV(x); setErr(null); } catch (x) { setErr(x.message); }
  }, [slot]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!openingDirty) setOpening(v?.opening || ''); }, [v, openingDirty]);
  const running = Boolean(v?.run?.running);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  const draft = async (code = null) => {
    setErr(null); setBusy('draft');
    try { await api.perfCaseDraft(slot, code); await load(); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };
  const redraft = (s) => {
    if ((s.reviewed || s.drafted) && !window.confirm(`Redraft ${s.code}? Your edits to this skill will be replaced${s.reviewed ? ' and it will need confirming again' : ''}.`)) return;
    draft(s.code);
  };
  const saveOpening = async () => {
    setBusy('opening'); setErr(null);
    try { await api.perfCaseOpening(slot, opening || null); setOpeningDirty(false); await load(); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };
  const onSaved = (skill) => setV((cur) => {
    const skills = cur.skills.map((x) => (x.code === skill.code ? skill : x));
    return { ...cur, skills, reviewedCount: skills.filter((x) => x.reviewed).length };
  });
  const showText = async () => {
    setErr(null);
    try { setText(await api.perfCaseText(slot)); } catch (x) { setErr(x.message); }
  };
  const word = async () => {
    setErr(null); setBusy('word');
    try {
      const blob = await api.perfCaseDocx(slot);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(v.role.title || 'Case').replace(/[^A-Za-z0-9 -]+/g, '').trim()} - case.docx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };

  if (err && !v) return <div className="card"><div className="banner bad">Could not load the case — {err}</div><button onClick={onClose}>Close</button></div>;
  if (!v) return <div className="card"><div className="small muted">Loading the case…</div></div>;
  const drafted = v.skills.some((s) => s.drafted);
  const left = v.skills.length - v.reviewedCount;
  return (
    <div className="card">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>My case — {v.role.title}</h2>
        <span className="spacer" />
        <span className="small muted">{v.reviewedCount} of {v.skills.length} skills confirmed</span>
        <button disabled={!v.reviewedCount} onClick={showText}>Text for Confluence</button>
        <button className="primary" disabled={!v.reviewedCount || busy === 'word'} onClick={word}>{busy === 'word' ? 'Building…' : 'Download Word'}</button>
        <button onClick={onClose}>Close</button>
      </div>
      <p className="sub">Written for Chris. VANTAGE drafts each skill from the latest assessment — the strongest evidence, pre-ticked, in one line each. Untick, edit, add more, then press <b>Happy with this skill</b>. Only confirmed skills go in the export{left ? ` (${left} not confirmed yet, so left out)` : ''}. Customers can be named; colleagues never — by role only, and a line naming one cannot be confirmed.</p>
      {err && <div className="banner bad">{err}</div>}
      {!v.assessment && <div className="banner info">Assess this role first — the case is written from the assessment.</div>}
      {v.roleChanged && <div className="banner warn">The latest assessment was made against an earlier version of this role. Reassess, then redraft.</div>}
      {v.stale && <div className="banner warn">There is a newer assessment than the one this case was drafted from. <button className="small" disabled={running} onClick={() => draft()}>Redraft unconfirmed skills</button></div>}
      {!v.nameCheck.ready && drafted && <div className="banner warn">The colleague-name check has no roster yet (NEURO has not answered) — confirming will wait until it does.</div>}
      {v.run?.running && <div className="banner info">Drafting… {v.run.done} of {v.run.total} done. One call per skill — a minute or two. Confirmed skills are left alone.</div>}
      {!v.run?.running && v.run?.error && <div className="banner warn">Last draft: {v.run.error}</div>}
      {v.assessment && !drafted && !running && (
        <div className="banner info">
          Nothing drafted yet. <button className="primary small" disabled={busy === 'draft'} onClick={() => draft()}>{busy === 'draft' ? 'Starting…' : 'Draft my case'}</button>
        </div>
      )}
      {v.assessment && (
        <div className="grid" style={{ margin: '12px 0' }}>
          <div className="metric"><div className="n" style={{ fontSize: 18 }}>{READY[v.assessment.readiness?.rating] || '—'}</div><div className="l">Readiness</div><div className="d">assessed {v.assessment.createdAt.slice(0, 10)}</div></div>
          {['met', 'partly', 'not-yet', 'no-evidence'].map((k) => (
            <div className="metric" key={k}><div className="n" style={{ color: RATING[k].color }}>{v.skills.filter((s) => s.rating === k).length}</div><div className="l">{RATING[k].label}</div></div>
          ))}
        </div>
      )}
      {drafted && (
        <>
          <label className="small"><b>Where I stand</b> — the opening</label>
          <textarea rows={4} style={{ width: '100%' }} value={opening} onChange={(e) => { setOpening(e.target.value); setOpeningDirty(true); }} />
          <NameWarn names={openingDirty ? [] : v.openingNames} />
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            {openingDirty && <button disabled={busy === 'opening'} onClick={saveOpening}>{busy === 'opening' ? 'Saving…' : 'Save opening'}</button>}
            {!running && <button className="ghost" disabled={busy === 'draft'} onClick={() => draft()}>Redraft unconfirmed skills</button>}
          </div>
          <div className="case-skills">
            {v.skills.map((s) => <SkillEditor key={s.code} slot={slot} s={s} busyAll={running} onSaved={onSaved} onRedraft={redraft} />)}
          </div>
        </>
      )}
      {text && (
        <div className="peek" style={{ marginTop: 12 }}>
          <div className="row"><b className="small">Text for Confluence{text.left.length ? ` — leaves out ${text.left.map((x) => x.code).join(', ')} (not confirmed)` : ''}</b><span className="spacer" />
            <button className="small" onClick={() => navigator.clipboard?.writeText(text.markdown)}>Copy</button><button className="small" onClick={() => setText(null)}>Close</button></div>
          <textarea readOnly rows={18} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} value={text.markdown} />
        </div>
      )}
    </div>
  );
}
