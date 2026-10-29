import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

/**
 * Performance Evidence (29 Oct 2026).
 *
 * Two roles (Current, Future), each a SFIA 9 profile drafted from a job
 * description and confirmed by Nick. Evidence comes from NEURO and NOVA, and
 * from Nick directly. The model PROPOSES which skill an item bears on; only
 * items Nick accepts count. The assessment rates each skill against target and
 * cites the evidence behind it; a skill with nothing accepted reads
 * "No evidence yet", never "Not yet".
 */

const SLOTS = [['current', 'Current role'], ['future', 'Future role']];
const LEVEL_NAMES = { 1: 'Follow', 2: 'Assist', 3: 'Apply', 4: 'Enable', 5: 'Ensure, advise', 6: 'Initiate, influence', 7: 'Set strategy' };
const ATTRS = [['autonomy', 'Autonomy'], ['influence', 'Influence'], ['complexity', 'Complexity'], ['knowledge', 'Knowledge'], ['business_skills', 'Business skills']];
const RATING = {
  met: { label: 'Met', color: 'var(--good)' },
  partly: { label: 'Partly', color: 'var(--warn)' },
  'not-yet': { label: 'Not yet', color: 'var(--bad)' },
  'no-evidence': { label: 'No evidence yet', color: 'var(--muted)' },
  unrated: { label: 'Not rated', color: 'var(--muted)' },
};
const READY = { ready: 'Ready', nearly: 'Nearly', 'not-yet': 'Not yet', 'too-little-evidence': 'Too little evidence to say' };
const ORIGIN = { neuro: 'NEURO', nova: 'NOVA', manual: 'You' };
const STOP = {
  'queue-empty': 'everything gathered has been read',
  'item-cap': 'stopped at today\'s item cap — carries on tomorrow',
  'spend-cap': 'stopped at today\'s spend cap — carries on tomorrow',
  'no-roles': 'waiting for a role profile before it can read anything',
  'no-model-key': 'no OpenRouter key',
  'model-failed': 'the model failed twice — will retry next run',
};

const today = () => new Date().toLocaleDateString('en-CA');

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('The file could not be read'));
    r.readAsDataURL(file);
  });
}

function Pill({ children, color, title }) {
  return <span className="pill" title={title} style={color ? { color, borderColor: color } : undefined}>{children}</span>;
}

/**
 * One plain line per skill: "Incident management (USUP) — both roles — evidence for",
 * the reason underneath. A tag the model gave for both roles with the same
 * reason is ONE line, not two.
 */
function SkillLines({ tags, roles }) {
  if (!tags?.length) return <div className="small muted">Not tied to a skill yet — Re-tag to choose one.</div>;
  const groups = new Map();
  for (const t of tags) {
    const k = `${t.code}|${t.stance}|${t.why || ''}`;
    if (!groups.has(k)) groups.set(k, { ...t, slots: [] });
    groups.get(k).slots.push(t.slot);
  }
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {[...groups.values()].map((g, i) => {
        const name = roles.current?.profile.skills.find((s) => s.code === g.code)?.name
          || roles.future?.profile.skills.find((s) => s.code === g.code)?.name || g.code;
        const which = g.slots.length > 1 ? 'both roles' : g.slots[0] === 'future' ? 'future role' : 'current role';
        const against = g.stance === 'against';
        return (
          <div key={i} style={{ borderLeft: `3px solid ${against ? 'var(--bad)' : 'var(--good)'}`, paddingLeft: 10 }}>
            <div style={{ fontSize: 13 }}>
              <b>{name}</b> <span className="muted">({g.code}) · {which} · </span>
              <span style={{ color: against ? 'var(--bad)' : 'var(--good)' }}>{against ? 'evidence against' : 'evidence for'}</span>
            </div>
            {g.why && <div className="small muted" style={{ marginTop: 2 }}>{g.why}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Strip markdown leftovers from text stored before NEURO cleaned it. Pure. */
function cleanText(s) {
  return String(s || '')
    .replace(/!?\[[^\]]*\]\((?:plaud|https?):[^)]*\)/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .split('\n').map((l) => l.trim()).filter((l) => l && !/^(Summary|Overview|Meeting Notes)$/i.test(l)).join('\n');
}

/** The source text, three lines unless asked for more. */
function Detail({ text }) {
  const [open, setOpen] = useState(false);
  const t = cleanText(text);
  if (!t) return null;
  const withheld = /^Details withheld/.test(t);
  const long = t.length > 260 || t.split('\n').length > 3;
  return (
    <div className="small muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap', fontStyle: withheld ? 'italic' : 'normal' }}>
      <div style={open ? undefined : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t}</div>
      {long && <button className="small" style={{ marginTop: 4, padding: '2px 8px' }} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>}
    </div>
  );
}

/** Edit an item's tags against the two active profiles. */
function TagEditor({ tags, roles, onChange }) {
  const avail = SLOTS.filter(([s]) => roles[s]);
  const add = () => {
    const slot = avail[0]?.[0];
    if (!slot) return;
    onChange([...tags, { slot, code: roles[slot].profile.skills[0].code, stance: 'for', why: null }]);
  };
  const set = (i, patch) => onChange(tags.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div>
      {tags.map((t, i) => (
        <div className="row" key={i} style={{ marginBottom: 4, flexWrap: 'wrap' }}>
          <select value={t.slot} onChange={(e) => set(i, { slot: e.target.value, code: roles[e.target.value].profile.skills[0].code })}>
            {avail.map(([s, l]) => <option key={s} value={s}>{l}</option>)}
          </select>
          <select value={t.code} onChange={(e) => set(i, { code: e.target.value })}>
            {(roles[t.slot]?.profile.skills || []).map((s) => <option key={s.code} value={s.code}>{s.code} {s.name}</option>)}
          </select>
          <select value={t.stance} onChange={(e) => set(i, { stance: e.target.value })}>
            <option value="for">evidence for</option>
            <option value="against">evidence against</option>
          </select>
          <button className="small" onClick={() => onChange(tags.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      {avail.length ? <button className="small" onClick={add}>+ Skill</button> : <span className="small muted">Save a role profile first.</span>}
    </div>
  );
}

function EvidenceRow({ e, roles, selectable, selected, onSelect, onChanged, mode }) {
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState(e.tags);
  const [caseOpen, setCaseOpen] = useState(false);
  const [summary, setSummary] = useState(e.caseSummary || '');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); await onChanged(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {selectable && <input type="checkbox" checked={selected} onChange={(x) => onSelect(x.target.checked)} style={{ marginTop: 3 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="small muted" style={{ fontFamily: 'var(--mono)' }}>{String(e.occurredAt || '').slice(0, 10)}</span>
            <Pill>{ORIGIN[e.origin] || e.origin}</Pill>
            <b style={{ fontSize: 13 }}>{e.title}</b>
            {e.inCase && <Pill color="var(--accent)" title={e.caseSummary}>In case</Pill>}
          </div>
          <Detail text={e.detail} />
          <div style={{ marginTop: 8 }}>
            {editing ? <TagEditor tags={tags} roles={roles} onChange={setTags} /> : <SkillLines tags={e.tags} roles={roles} />}
          </div>
          {caseOpen && (
            <div style={{ marginTop: 8 }}>
              <div className="small muted">The line that appears in your case. The item above is never exported.</div>
              <textarea rows={2} style={{ width: '100%' }} value={summary} onChange={(x) => setSummary(x.target.value)} />
              <div className="row" style={{ marginTop: 4 }}>
                <button className="primary small" disabled={busy || !summary.trim()} onClick={() => act(async () => { await api.perfCase(e.id, true, summary); setCaseOpen(false); })}>Add to case</button>
                <button className="small" onClick={() => setCaseOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
          {err && <div className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>{err}</div>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 320 }}>
          {editing ? (
            <>
              <button className="primary small" disabled={busy} onClick={() => act(async () => { await api.perfUpdate(e.id, { tags }); setEditing(false); })}>Save skills</button>
              <button className="small" onClick={() => { setTags(e.tags); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <>
              {mode === 'review' && <button className="primary small" disabled={busy || !e.tags.length} onClick={() => act(() => api.perfDecide(e.id, 'accept'))}>Accept</button>}
              {mode === 'review' && <button className="small" disabled={busy} onClick={() => act(() => api.perfDecide(e.id, 'reject'))}>Reject</button>}
              <button className="small" disabled={busy} onClick={() => setEditing(true)}>Re-tag</button>
              {mode === 'accepted' && !e.inCase && <button className="small" disabled={busy} onClick={() => setCaseOpen(true)}>Add to case…</button>}
              {mode === 'accepted' && e.inCase && <button className="small" disabled={busy} onClick={() => act(() => api.perfCase(e.id, false))}>Remove from case</button>}
              {mode === 'accepted' && e.origin !== 'manual' && <button className="small" disabled={busy} onClick={() => act(() => api.perfDecide(e.id, 'restore'))}>Back to review</button>}
              {mode === 'accepted' && e.origin === 'manual' && <button className="small danger" disabled={busy} onClick={() => act(() => api.perfDelete(e.id))}>Delete</button>}
              {mode === 'closed' && <button className="small" disabled={busy} onClick={() => act(() => api.perfDecide(e.id, 'restore'))}>Restore to review</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EvidenceList({ state, roles, mode, onChanged, emptyText }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const load = useCallback(async () => {
    try { setData(await api.perfEvidence(state, PAGE, page * PAGE)); setErr(null); } catch (x) { setErr(x.message); }
  }, [state, page]);
  useEffect(() => { load(); }, [load]);
  const changed = async () => { setSel(new Set()); await load(); await onChanged(); };
  if (err) return <div className="banner bad">Could not read evidence — {err}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const items = filter ? data.items.filter((e) => e.tags.some((t) => `${t.slot}:${t.code}` === filter)) : data.items;
  const skillOpts = SLOTS.flatMap(([s, l]) => (roles[s]?.profile.skills || []).map((k) => [`${s}:${k.code}`, `${l} · ${k.code} ${k.name}`]));
  const batch = async (decision) => {
    const r = await api.perfDecideBatch([...sel], decision);
    if (r.refused?.length) alertRefused(r.refused);
    await changed();
  };
  return (
    <div>
      <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="small muted">{data.total} item{data.total === 1 ? '' : 's'}</span>
        {mode === 'accepted' && (
          <select value={filter} onChange={(x) => setFilter(x.target.value)}>
            <option value="">All skills</option>
            {skillOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {mode === 'review' && (
          <>
            <button className="small" onClick={() => setSel(new Set(items.map((e) => e.id)))}>Select page</button>
            <button className="primary small" disabled={!sel.size} onClick={() => batch('accept')}>Accept {sel.size || ''}</button>
            <button className="small" disabled={!sel.size} onClick={() => batch('reject')}>Reject {sel.size || ''}</button>
          </>
        )}
        <span className="spacer" />
        <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Newer</button>
        <button className="small" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Older ›</button>
      </div>
      {!items.length && <div className="card"><p className="small muted">{emptyText}</p></div>}
      {items.map((e) => (
        <EvidenceRow key={e.id} e={e} roles={roles} mode={mode} onChanged={changed}
          selectable={mode === 'review'} selected={sel.has(e.id)}
          onSelect={(on) => { const n = new Set(sel); on ? n.add(e.id) : n.delete(e.id); setSel(n); }} />
      ))}
    </div>
  );
}

// Batch refusals are shown in the page's own banner rather than a browser dialog.
let refusedSink = null;
function alertRefused(refused) { if (refusedSink) refusedSink(refused); }

// ── Roles ────────────────────────────────────────────────────────────────────

function ProfileView({ role }) {
  const p = role.profile;
  return (
    <div>
      <p className="sub">{p.summary || ''} {role.sourceName ? <span className="muted">· from {role.sourceName}</span> : null} <span className="muted">· saved {role.createdAt.slice(0, 10)}</span></p>
      <table className="table" style={{ width: '100%' }}>
        <thead><tr><th style={{ textAlign: 'left' }}>Skill</th><th>Target</th><th style={{ textAlign: 'left' }}>Why (from the JD)</th></tr></thead>
        <tbody>
          {p.skills.map((s) => (
            <tr key={s.code}>
              <td><b>{s.code}</b> {s.name}{s.check === 'unknown-code' && <Pill color="var(--warn)" title="Not in the SFIA 9 catalogue on the Pi">check code</Pill>}</td>
              <td style={{ textAlign: 'center' }}>L{s.level} <span className="small muted">{LEVEL_NAMES[s.level]}</span></td>
              <td className="small muted">{s.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {ATTRS.map(([k, l]) => <Pill key={k} title={p.attributes?.[k]?.why || ''}>{l} L{p.attributes?.[k]?.level ?? '?'}</Pill>)}
      </div>
    </div>
  );
}

function RoleImport({ slot, onSaved, onCancel }) {
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [prop, setProp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const propose = async () => {
    setBusy(true); setErr(null);
    try {
      const body = file ? { filename: file.name, fileBase64: await readFileBase64(file) } : { text };
      setProp(await api.perfPropose(body));
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.perfSaveRole({ slot, profile: prop.profile, sourceName: prop.sourceName, sourceText: prop.sourceText }); await onSaved(); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const p = prop?.profile;
  const setP = (patch) => setProp({ ...prop, profile: { ...p, ...patch } });
  const setSkill = (i, patch) => setP({ skills: p.skills.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="card">
      <h2>{slot === 'future' ? 'Future' : 'Current'} role — from a job description or framework</h2>
      {!prop && (
        <>
          <p className="sub">Attach a .docx, .pdf, .md or .txt, or paste the text. VANTAGE drafts a SFIA 9 profile; nothing is saved until you press Save.</p>
          <input type="file" accept=".docx,.pdf,.md,.txt" onChange={(x) => setFile(x.target.files?.[0] || null)} />
          {!file && <textarea rows={8} style={{ width: '100%', marginTop: 8 }} placeholder="…or paste the job description" value={text} onChange={(x) => setText(x.target.value)} />}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || (!file && !text.trim())} onClick={propose}>{busy ? 'Reading…' : 'Draft the profile'}</button>
            <button onClick={onCancel}>Cancel</button>
          </div>
        </>
      )}
      {p && (
        <>
          {prop.catalogue === 'not-checked' && <div className="banner info">Skill codes are not checked: there is no SFIA 9 catalogue on the Pi. Make sure each code is right before saving.</div>}
          {p.problems?.length > 0 && <div className="banner warn">{p.problems.join(' · ')}</div>}
          <div className="row" style={{ marginBottom: 8 }}>
            <input style={{ flex: 1 }} value={p.title} onChange={(x) => setP({ title: x.target.value })} />
          </div>
          <table className="table" style={{ width: '100%' }}>
            <thead><tr><th style={{ textAlign: 'left' }}>Code</th><th style={{ textAlign: 'left' }}>Skill</th><th>Target</th><th style={{ textAlign: 'left' }}>Why</th><th /></tr></thead>
            <tbody>
              {p.skills.map((s, i) => (
                <tr key={i}>
                  <td><input style={{ width: 70 }} value={s.code} onChange={(x) => setSkill(i, { code: x.target.value.toUpperCase() })} /></td>
                  <td><input style={{ width: '100%' }} value={s.name} onChange={(x) => setSkill(i, { name: x.target.value })} /></td>
                  <td><select value={s.level} onChange={(x) => setSkill(i, { level: Number(x.target.value) })}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>L{n} {LEVEL_NAMES[n]}</option>)}</select></td>
                  <td className="small muted">{s.why}</td>
                  <td><button className="small" onClick={() => setP({ skills: p.skills.filter((_, j) => j !== i) })}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="small" style={{ marginTop: 6 }} onClick={() => setP({ skills: [...p.skills, { code: '', name: '', level: 5, why: 'Added by Nick' }] })}>+ Skill</button>
          <h3 style={{ fontSize: 13, marginTop: 14 }}>Generic attributes</h3>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {ATTRS.map(([k, l]) => (
              <label key={k} className="small" title={p.attributes?.[k]?.why || ''}>
                {l}{' '}
                <select value={p.attributes?.[k]?.level || ''} onChange={(x) => setP({ attributes: { ...p.attributes, [k]: { ...(p.attributes?.[k] || {}), level: Number(x.target.value) } } })}>
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>L{n}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save profile'}</button>
            <button onClick={onCancel}>Cancel</button>
            <span className="small muted">Saving replaces the {slot} role. The old one is kept in history.</span>
          </div>
        </>
      )}
      {err && <div className="banner bad" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function RolesTab({ data, reload }) {
  const [importing, setImporting] = useState(null);
  return (
    <div>
      {SLOTS.map(([slot, label]) => {
        const role = data.roles[slot];
        if (importing === slot) return <RoleImport key={slot} slot={slot} onCancel={() => setImporting(null)} onSaved={async () => { setImporting(null); await reload(); }} />;
        const hist = data.roles.history[slot];
        return (
          <div className="card" key={slot}>
            <div className="row"><h2 style={{ margin: 0 }}>{label}{role ? ` — ${role.profile.title}` : ''}</h2><span className="spacer" />
              <button onClick={() => setImporting(slot)}>{role ? 'Replace from a job description' : 'Add from a job description'}</button></div>
            {role ? <ProfileView role={role} /> : <p className="small muted">Not set. Upload the job description or framework for your {slot} role.</p>}
            {hist.length > 0 && <p className="small muted" style={{ marginTop: 8 }}>Earlier: {hist.map((h) => `${h.profile?.title} (until ${h.archivedAt?.slice(0, 10)})`).join(' · ')}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ── Assessment ───────────────────────────────────────────────────────────────

function AssessTab({ data, reload }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [md, setMd] = useState(null);
  const run = async (slot) => {
    setBusy(slot); setErr(null);
    try { await api.perfAssess(slot); await reload(); } catch (x) { setErr(x.message); } finally { setBusy(null); }
  };
  const exp = async (slot) => {
    setErr(null);
    try { setMd((await api.perfExport(slot)).markdown); } catch (x) { setErr(x.message); }
  };
  return (
    <div>
      {err && <div className="banner bad">{err}</div>}
      <p className="sub">VANTAGE's reading, from accepted evidence only. Every rating cites the items behind it; a skill with nothing accepted reads "No evidence yet", not "Not yet". Private until you export it.</p>
      {SLOTS.map(([slot, label]) => {
        const role = data.roles[slot];
        const a = data.assessments[slot];
        return (
          <div className="card" key={slot}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>{label}{role ? ` — ${role.profile.title}` : ''}</h2>
              <span className="spacer" />
              {a && <span className="small muted">Assessed {new Date(a.createdAt).toLocaleString('en-GB')} from {a.evidenceRead} item(s)</span>}
              <button className="primary" disabled={!role || busy} onClick={() => run(slot)}>{busy === slot ? 'Assessing…' : 'Reassess'}</button>
              <button disabled={!role} onClick={() => exp(slot)}>Build my case</button>
            </div>
            {!role && <p className="small muted">Add this role's profile first.</p>}
            {role && !a && <p className="small muted">Not assessed yet. Accept some evidence, then press Reassess.</p>}
            {a && (
              <>
                <div className="grid" style={{ margin: '12px 0' }}>
                  <div className="metric"><div className="n" style={{ fontSize: 18 }}>{READY[a.readiness?.rating] || '—'}</div><div className="l">Readiness</div><div className="d">{a.readiness?.why}</div></div>
                  {['met', 'partly', 'not-yet', 'no-evidence'].map((k) => (
                    <div className="metric" key={k}><div className="n" style={{ color: RATING[k].color }}>{a.counts?.[k] ?? 0}</div><div className="l">{RATING[k].label}</div></div>
                  ))}
                </div>
                {a.summary && <p className="small">{a.summary}</p>}
                <table className="table" style={{ width: '100%' }}>
                  <thead><tr><th style={{ textAlign: 'left' }}>Skill</th><th>Target</th><th>Rating</th><th>Seen at</th><th style={{ textAlign: 'left' }}>Why</th><th>Evidence</th></tr></thead>
                  <tbody>
                    {a.skills.map((s) => (
                      <tr key={s.code}>
                        <td><b>{s.code}</b> {s.name}</td>
                        <td style={{ textAlign: 'center' }}>L{s.target}</td>
                        <td style={{ textAlign: 'center', color: RATING[s.rating]?.color }}>{RATING[s.rating]?.label || s.rating}</td>
                        <td style={{ textAlign: 'center' }}>{s.observedLevel ? `L${s.observedLevel}` : '—'}</td>
                        <td className="small muted">{s.why}</td>
                        <td className="small muted" style={{ fontFamily: 'var(--mono)' }}>{s.cite.length ? s.cite.map((c) => `#${c}`).join(' ') : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  {ATTRS.map(([k, l]) => (
                    <Pill key={k} title={a.attributes?.[k]?.why || ''}>{l}: target L{role?.profile.attributes?.[k]?.level ?? '?'} · seen {a.attributes?.[k]?.observedLevel ? `L${a.attributes[k].observedLevel}` : '—'}</Pill>
                  ))}
                </div>
                {data.assessments.history[slot].length > 1 && (
                  <p className="small muted" style={{ marginTop: 8 }}>History: {data.assessments.history[slot].map((h) => `${h.createdAt.slice(0, 10)} ${READY[h.readiness] || '—'}`).join(' · ')}</p>
                )}
              </>
            )}
          </div>
        );
      })}
      {md && (
        <div className="card">
          <div className="row"><h2 style={{ margin: 0 }}>Your case</h2><span className="spacer" />
            <button onClick={() => navigator.clipboard?.writeText(md)}>Copy</button><button onClick={() => setMd(null)}>Close</button></div>
          <p className="sub">Only items you added to the case, in your words. Paste into Confluence, an email or a document.</p>
          <textarea readOnly rows={18} style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} value={md} />
        </div>
      )}
    </div>
  );
}

// ── Add evidence ─────────────────────────────────────────────────────────────

function AddTab({ data, onAdded }) {
  const [form, setForm] = useState({ occurredAt: today(), title: '', detail: '', ref: '', tags: [] });
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const roles = data.roles;
  const submit = async () => {
    setBusy(true); setErr(null); setDone(null);
    try {
      await api.perfAdd(form);
      setDone(`Added: ${form.title}`);
      setForm({ occurredAt: today(), title: '', detail: '', ref: '', tags: [] });
      await onAdded();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>Add evidence yourself</h2>
      <p className="sub">Something NEURO and NOVA cannot see: feedback you were given, a problem you solved in a conversation, a result. It counts straight away.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input type="date" value={form.occurredAt} onChange={(x) => setForm({ ...form, occurredAt: x.target.value })} />
        <input style={{ flex: 1, minWidth: 260 }} placeholder="What happened (one line)" value={form.title} onChange={(x) => setForm({ ...form, title: x.target.value })} />
      </div>
      <textarea rows={4} style={{ width: '100%', marginTop: 8 }} placeholder="Detail — what you did, what it changed (optional)" value={form.detail} onChange={(x) => setForm({ ...form, detail: x.target.value })} />
      <input style={{ width: '100%', marginTop: 8 }} placeholder="Link or where it is recorded (optional)" value={form.ref} onChange={(x) => setForm({ ...form, ref: x.target.value })} />
      <div style={{ marginTop: 10 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Which skills is this evidence of?</div>
        <TagEditor tags={form.tags} roles={roles} onChange={(tags) => setForm({ ...form, tags })} />
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" disabled={busy || !form.title.trim() || !form.tags.length} onClick={submit}>{busy ? 'Adding…' : 'Add evidence'}</button>
        {done && <span className="small" style={{ color: 'var(--good)' }}>{done}</span>}
      </div>
      {err && <div className="banner bad" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// ── Gathering ────────────────────────────────────────────────────────────────

function GatherTab({ data, reload }) {
  const g = data.gather;
  const [caps, setCaps] = useState({ dailyUsd: g.caps.dailyUsd, dailyItems: g.caps.dailyItems });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const run = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api.perfGather(); setMsg(r.skipped ? `Already running.` : `Gathered ${r.gather?.added ?? 0} new; read ${r.triage?.judged ?? 0} — ${STOP[r.triage?.stopped] || r.triage?.stopped || ''}`); await reload(); }
    catch (x) { setMsg(x.message); } finally { setBusy(false); }
  };
  const saveCaps = async () => {
    setMsg(null);
    try { await api.perfCaps({ dailyUsd: Number(caps.dailyUsd), dailyItems: Number(caps.dailyItems) }); setMsg('Caps saved.'); await reload(); } catch (x) { setMsg(x.message); }
  };
  const sources = Object.entries(g.lastSources?.sources || {});
  return (
    <div>
      <div className="card">
        <h2>Gathering</h2>
        <p className="sub">Every 30 minutes, 07:00–22:00: the last week from NEURO and NOVA, plus a week further back each time until it reaches 12 months. Automated mail is dropped before any model is paid; the rest is read in batches within today's caps.</p>
        <div className="grid">
          <div className="metric"><div className="n">{g.counts.queued}</div><div className="l">Waiting to be read</div></div>
          <div className="metric"><div className="n">{g.counts.proposed}</div><div className="l">Waiting for you</div></div>
          <div className="metric"><div className="n">{g.counts.accepted}</div><div className="l">Accepted</div></div>
          <div className="metric"><div className="n">{g.counts['not-relevant']}</div><div className="l">Not relevant</div></div>
          <div className="metric"><div className="n">{g.backfill.cursor ? g.backfill.cursor : '—'}</div><div className="l">Backfilled back to</div></div>
          <div className="metric"><div className="n">${g.spentToday.usd.toFixed(2)}</div><div className="l">Spent today of ${g.caps.dailyUsd}</div><div className="d">{g.itemsToday} of {g.caps.dailyItems} items{g.spentToday.unknownCost ? ` · ${g.spentToday.unknownCost} call(s) with no reported cost, counted at $0.05` : ''}</div></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" disabled={busy || g.running} onClick={run}>{busy || g.running ? 'Running…' : 'Run now'}</button>
          {g.lastRun && <span className="small muted">Last run {new Date(g.lastRun.at).toLocaleString('en-GB')}{g.lastRun.error ? ` — failed: ${g.lastRun.error}` : g.lastRun.triage ? ` — ${STOP[g.lastRun.triage.stopped] || g.lastRun.triage.stopped}` : ''}</span>}
        </div>
        {msg && <p className="small" style={{ marginTop: 6 }}>{msg}</p>}
      </div>
      <div className="card">
        <h2>Sources</h2>
        {!sources.length && <p className="small muted">Not run yet.</p>}
        <table className="table" style={{ width: '100%' }}><tbody>
          {sources.map(([k, v]) => (
            <tr key={k}><td>{k}</td><td style={{ color: v.ok ? 'var(--good)' : 'var(--bad)' }}>{v.ok ? `answered${v.count != null ? ` · ${v.count}` : ''}` : `could not read — ${v.error}`}</td></tr>
          ))}
        </tbody></table>
        <p className="small muted" style={{ marginTop: 6 }}>Not gathered yet: Outlook Sent Items not sent through NEURO, and Jira ticket work. A source that could not be read is a gap, not evidence that nothing happened.</p>
      </div>
      <div className="card">
        <h2>Backfill override</h2>
        <p className="sub">Lifts the daily caps until the 12-month backfill is fully read, then switches itself off and the caps above come back. Hard safety ceiling: $15 a day.</p>
        <div className="row">
          <span className="small">{g.override?.on ? <b style={{ color: 'var(--warn)' }}>On</b> : 'Off'}{g.override?.by === 'auto' ? ` — switched off automatically (${g.override.reason})` : ''}</span>
          <button onClick={async () => { setMsg(null); try { await api.perfOverride(!g.override?.on); await reload(); } catch (x) { setMsg(x.message); } }}>
            {g.override?.on ? 'Switch off' : 'Switch on'}
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Daily caps</h2>
        <div className="row">
          <label className="small">Spend $ <input type="number" step="0.5" min="0" max="20" style={{ width: 80 }} value={caps.dailyUsd} onChange={(x) => setCaps({ ...caps, dailyUsd: x.target.value })} /></label>
          <label className="small">Items <input type="number" min="0" max="5000" style={{ width: 90 }} value={caps.dailyItems} onChange={(x) => setCaps({ ...caps, dailyItems: x.target.value })} /></label>
          <button onClick={saveCaps}>Save</button>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>Hitting a cap pauses until tomorrow. Nothing is skipped.</p>
      </div>
    </div>
  );
}

/**
 * One line, always on screen: is VANTAGE reading right now, and if not, why
 * not and when it carries on. Composed only from what /api/perf reports.
 */
function statusLine(g) {
  const s = statusCore(g);
  if (g.override?.on) s.text = `Backfill override on — daily caps lifted until the year is read (safety ceiling $${g.caps.dailyUsd}/day). ${s.text}`;
  return s;
}

function statusCore(g) {
  const left = g.counts.queued;
  const today = `${g.itemsToday} of ${g.caps.dailyItems} items today, $${g.spentToday.usd.toFixed(2)} of $${g.caps.dailyUsd}`;
  if (g.running) return { tone: 'info', text: `Reading now — ${left} still to read (${today}).` };
  if (g.lastRun?.inProgress) return { tone: 'warn', text: `The last pass was interrupted (VANTAGE restarted). It resumes by itself within a few minutes — ${left} still to read.` };
  const stop = g.lastRun?.triage?.stopped;
  const at = g.lastRun?.at ? new Date(g.lastRun.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  if (g.lastRun?.error) return { tone: 'bad', text: `The last pass${at ? ` at ${at}` : ''} failed: ${g.lastRun.error}. It tries again within 30 minutes.` };
  const capHit = stop === 'item-cap' ? g.itemsToday >= g.caps.dailyItems : stop === 'spend-cap' ? g.spentToday.usd >= g.caps.dailyUsd : false;
  if (capHit) return { tone: 'warn', text: `Paused — today's ${stop === 'item-cap' ? 'item' : 'spend'} cap is reached (${today}). ${left} still to read; carries on tomorrow from 07:00.` };
  if (stop === 'no-roles') return { tone: 'warn', text: 'Waiting for a role profile — add one under Roles.' };
  if (stop === 'model-failed') return { tone: 'bad', text: `The model failed on the last pass${at ? ` (${at})` : ''}. It tries again within 30 minutes.` };
  if (left > 0) return { tone: 'info', text: `${left} still to read — the next pass runs within 30 minutes (07:00–22:00). Last pass ${at || 'not yet'}.` };
  return { tone: 'info', text: `Up to date — everything gathered has been read. Checks for new evidence every 30 minutes (07:00–22:00).${at ? ` Last pass ${at}.` : ''}` };
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function Evidence() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sub, setSub] = useState('review');
  const [refused, setRefused] = useState(null);
  const [bump, setBump] = useState(0);
  const reload = useCallback(async () => {
    try { setData(await api.perf()); setErr(null); } catch (x) { setErr(x.message); }
    setBump((b) => b + 1);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // Keep the status line current while the page is open. Only the overview is
  // re-read — the lists below keep their place.
  useEffect(() => {
    const t = setInterval(() => { api.perf().then(setData).catch(() => {}); }, 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { refusedSink = setRefused; return () => { refusedSink = null; }; }, []);
  const roles = useMemo(() => ({ current: data?.roles.current || null, future: data?.roles.future || null }), [data]);

  if (err) return <div className="wrap wide"><div className="banner bad">Could not load Performance Evidence — {err}</div></div>;
  if (!data) return <div className="empty">Loading…</div>;
  const c = data.gather.counts;
  const tabs = [
    ['review', `Review${c.proposed ? ` (${c.proposed})` : ''}`],
    ['accepted', `Evidence (${c.accepted})`],
    ['assess', 'Assessment'],
    ['roles', 'Roles'],
    ['add', 'Add evidence'],
    ['closed', 'Rejected & not relevant'],
    ['gather', 'Gathering'],
  ];
  return (
    <div className="wrap wide">
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {SLOTS.map(([s, l]) => (
          <div key={s} className="metric" style={{ minWidth: 260 }}>
            <div className="l">{l}</div>
            <div style={{ fontWeight: 600 }}>{data.roles[s]?.profile.title || 'Not set'}</div>
            <div className="d">{data.assessments[s] ? `Readiness: ${READY[data.assessments[s].readiness?.rating]} · ${data.assessments[s].counts?.met ?? 0} met of ${data.assessments[s].skills.length}` : 'Not assessed yet'}</div>
          </div>
        ))}
      </div>
      <nav style={{ marginBottom: 12 }}>
        {tabs.map(([k, l]) => <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{l}</button>)}
      </nav>
      {(() => { const s = statusLine(data.gather); return <div className={`banner ${s.tone}`}>{s.text}</div>; })()}
      {refused && <div className="banner warn">{refused.length} item(s) not changed: {refused.slice(0, 3).map((r) => r.error).join(' · ')} <button className="small" onClick={() => setRefused(null)}>OK</button></div>}
      {!roles.current && !roles.future && sub !== 'roles' && (
        <div className="banner info">Start with Roles: add the job description for your current role (and the one you are aiming for). Gathered items are read against those profiles.</div>
      )}
      {sub === 'review' && <EvidenceList key={`r${bump}`} state="proposed" roles={roles} mode="review" onChanged={reload} emptyText="Nothing waiting. New items appear here as the gather reads them." />}
      {sub === 'accepted' && <EvidenceList key={`a${bump}`} state="accepted" roles={roles} mode="accepted" onChanged={reload} emptyText="No accepted evidence yet." />}
      {sub === 'closed' && (
        <>
          <h3 style={{ fontSize: 13 }}>Rejected by you</h3>
          <EvidenceList key={`x${bump}`} state="rejected" roles={roles} mode="closed" onChanged={reload} emptyText="Nothing rejected." />
          <h3 style={{ fontSize: 13 }}>The model found no skill in these</h3>
          <EvidenceList key={`n${bump}`} state="not-relevant" roles={roles} mode="closed" onChanged={reload} emptyText="None." />
        </>
      )}
      {sub === 'assess' && <AssessTab data={data} reload={reload} />}
      {sub === 'roles' && <RolesTab data={data} reload={reload} />}
      {sub === 'add' && <AddTab data={data} onAdded={reload} />}
      {sub === 'gather' && <GatherTab data={data} reload={reload} />}
    </div>
  );
}
