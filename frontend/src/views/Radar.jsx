import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { familyFor, countByFamily } from '../sources.js';

/**
 * What has gone wrong, what is going wrong, and what could.
 *
 * This replaced a tile dashboard that duplicated NOVA. The rule that keeps it
 * from drifting back: nothing on this screen should be answerable by looking at
 * NOVA. Everything here is either a JUDGEMENT about a number, or a signal that
 * only exists because three sources were combined.
 *
 * The blind-spots banner is load-bearing. A radar that quietly drops a source it
 * could not reach will report "all clear" about a thing it cannot see, which is
 * worse than showing nothing at all.
 */

const TENSES = [
  {
    key: 'happened',
    title: 'Already gone wrong',
    sub: 'Cannot be prevented now. The question is who has been told.',
  },
  {
    key: 'happening',
    title: 'Going wrong now',
    sub: 'Still steerable. This is where intervening actually changes the outcome.',
  },
  {
    key: 'could',
    title: 'Could go wrong',
    sub: 'Nothing has failed yet. The only tense where being early counts for anything.',
  },
];

const SEVERITY_COLOUR = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };

/**
 * One line on the radar: collapsed to its headline, opened for the detail, the
 * suggested remediation, and the button that logs it.
 *
 * Collapsed by default because the radar's job is to be READ — a screen of
 * fifteen open paragraphs is one that gets skimmed and closed, and the tense
 * headings above only mean anything if you can see all of them at once.
 *
 * The remedy is a SUGGESTION and is labelled as one. It is not written into the
 * finding when you log it: the register's `action` field records what Nick
 * actually did, and pre-filling it with something a model proposed would put
 * words in the evidence that nobody has done yet.
 *
 * An item with no remedy shows no remedy line. Not every signal has a next step
 * that can be named without guessing, and a generic one ("monitor this") reads
 * exactly like a real one while being worth nothing.
 */
function Item({ it }) {
  const [open, setOpen] = useState(false);
  const [logged, setLogged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState(it.verdict || null);
  const [judging, setJudging] = useState(false);

  /**
   * Judge this warning.
   *
   * The only control in VANTAGE that produces INDEPENDENT evidence about
   * whether a detector is any good. Everything else scores a KPI against
   * another KPI; this is a person saying what actually happened. It matters
   * most for the case the automatic label gets backwards — Nick reads a
   * warning, acts on it, the problem never arrives, and the ledger records a
   * false positive for the warning that worked.
   */
  const judge = async (v, actionTaken) => {
    setJudging(true);
    try {
      await api.leadingVerdict(it.logId, { verdict: v, actionTaken });
      setVerdict(v);
    } catch { /* the buttons stay; the radar is not the place to shout */ }
    finally { setJudging(false); }
  };

  const log = async () => {
    setBusy(true);
    try {
      await api.addFinding({
        title: it.title,
        detail: `${it.detail}${it.meeting ? ` (${it.meeting})` : ''}`,
        source: it.source,
        severity: it.severity,
        tense: it.tense,
        // An unvalidated advisory stays an advisory once logged. Without this
        // the flag dies at the card and the finding looks like any other.
        advisory: it.advisory === true,
        validationStatus: it.validation?.status || null,
      });
      setLogged(true);
    } catch { /* the button reverts; the radar is not the place to shout */ }
    finally { setBusy(false); }
  };

  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          all: 'unset', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
          gap: 8, width: '100%', padding: '11px 0', cursor: 'pointer',
        }}
      >
        <span style={{
          width: 7, height: 7, borderRadius: 99,
          background: SEVERITY_COLOUR[it.severity] || 'var(--muted)', flexShrink: 0,
        }} />
        <strong style={{ fontSize: 14, flex: 1 }}>{it.title}</strong>
        {it.pinned && (
          <span className="small" style={{ color: 'var(--warn)' }} title="The live signal has gone, but this was logged and never resolved">
            pinned
          </span>
        )}
        {(logged || it.findingId) && <span className="small" style={{ color: 'var(--muted)' }}>✓ logged</span>}
        {/* Source colour lives HERE and only here on a card — a tinted border
            and text on a transparent ground. The severity dot to the left keeps
            the saturated status colour, so the two encodings never compete. */}
        <span className="pill" style={{
          color: familyFor(it.source).colour,
          borderColor: familyFor(it.source).colour,
        }} title={familyFor(it.source).blurb}>{it.source}</span>
        <span className="small" style={{
          color: 'var(--muted)', width: 12, textAlign: 'center', flexShrink: 0,
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s',
        }}>›</span>
      </button>

      {open && (
        <div style={{ padding: '0 0 12px 15px' }}>
          <div className="small" style={{ color: 'var(--muted)' }}>
            {it.detail}
            {it.meeting && <> <em>— {it.meeting}</em></>}
          </div>

          {it.remedy && (
            <div className="small" style={{
              marginTop: 9, paddingLeft: 9, borderLeft: '2px solid var(--line)',
            }}>
              <strong style={{ color: 'var(--muted)' }}>Suggested: </strong>
              {it.remedy}
            </div>
          )}

          {/* Judging a live warning. Only on Leading cards, and only when the
              ledger actually has a row to attach the verdict to.

              Deliberately NOT a modal and not required: a warning nobody
              judges stays pending for ever, which is honest. Forcing a verdict
              would get one clicked to clear the prompt, and a coerced label is
              worse than none — it looks exactly like evidence. */}
          {it.source === 'Leading' && it.logId && (
            <div style={{ marginTop: 10, paddingTop: 9, borderTop: '1px solid var(--line)' }}>
              {verdict
                ? (
                  <span className="small" style={{ color: 'var(--muted)' }}>
                    Judged <strong>{verdict === 'false' ? 'a false alarm' : verdict}</strong>
                    {it.verdictSource === 'auto' && ' automatically, from what the queues did next'}.
                    {it.actionTaken && <> You noted: {it.actionTaken}</>}
                  </span>
                )
                : (
                  <>
                    <div className="small" style={{ color: 'var(--muted)', marginBottom: 6 }}>
                      Was this worth telling you? It is the only way this detector gets judged on
                      real evidence rather than on history.
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="ghost small" disabled={judging}
                        onClick={() => judge('useful', null)}
                        title="It told me something I could act on">useful</button>
                      <button className="ghost small" disabled={judging}
                        onClick={() => judge('useful', 'acted on it')}
                        title="I acted on it — so the problem it predicted may never arrive, and the automatic label would call that a false positive">
                        useful — I acted
                      </button>
                      <button className="ghost small" disabled={judging}
                        onClick={() => judge('false', null)}
                        title="Nothing was wrong">false alarm</button>
                      <button className="ghost small" disabled={judging}
                        onClick={() => judge('inconclusive', null)}
                        title="Cannot tell either way">can't tell</button>
                    </div>
                  </>
                )}
            </div>
          )}

          {/* A card already in the register does not offer to log again — the
              register is the record, and a second copy of one risk is a worse
              answer than no button. What it offers instead is the truth about
              where that finding has got to. */}
          <div className="row" style={{ marginTop: 10 }}>
            {it.findingId || logged
              ? (
                <span className="small" style={{ color: 'var(--muted)' }}>
                  {it.pinned
                    ? 'Logged, and the live signal has since gone — it stays here until it is resolved.'
                    : 'In the findings register.'}
                  {it.findingStatus === 'resolved_pending' && (
                    <span style={{ color: 'var(--warn)' }}> Marked done in NEURO — say what was done, in Findings.</span>
                  )}
                  {' '}Resolve it in Findings.
                </span>
              )
              : (
                <button className="ghost small" onClick={log} disabled={busy}
                  title="Add to the findings register">
                  {busy ? '…' : '+ log'}
                </button>
              )}
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * What is on the radar, by where it came from — and a filter.
 *
 * NOT a chart. Six counts do not need a plot; a stat row reads faster and cannot
 * mislead about proportion the way a tiny pie would. This is the one place
 * source colour is solid, because there is no severity beside it to compete
 * with and the colour is doing the whole identifying job.
 *
 * It doubles as the filter, in one row above the list, so the question "why are
 * there thirty-four of these" and the act of narrowing them are the same
 * control rather than two.
 */
function SourceStrip({ items, active, onPick }) {
  const families = countByFamily(items);
  if (families.length < 2) return null;

  return (
    <div className="card" style={{ padding: '10px 12px' }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {families.map(f => {
          const on = active === f.key;
          return (
            <button
              key={f.key}
              onClick={() => onPick(on ? null : f.key)}
              title={f.blurb}
              aria-pressed={on}
              style={{
                all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 10px', borderRadius: 999,
                border: `1px solid ${on ? f.colour : 'var(--line)'}`,
                background: on ? 'var(--panel-2)' : 'transparent',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 2, background: f.colour, flexShrink: 0 }} />
              {/* Text wears text tokens, never the series colour — the swatch
                  beside it carries identity. */}
              <span className="small" style={{ color: on ? 'var(--text)' : 'var(--muted)' }}>{f.label}</span>
              <strong style={{ fontSize: 13 }}>{f.count}</strong>
            </button>
          );
        })}
        {active && (
          <button className="ghost small" onClick={() => onPick(null)} style={{ marginLeft: 4 }}>
            show all
          </button>
        )}
      </div>
    </div>
  );
}

export default function Radar() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [family, setFamily] = useState(null);

  const load = async (force = false) => {
    force ? setRefreshing(true) : setLoading(true);
    try {
      setData(await api.radar(force));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="empty">
        Reading NOVA, NEURO and your recent meetings…
        <div className="small" style={{ marginTop: 8 }}>
          First run only — after this it is kept warm in the background and opens instantly.
        </div>
      </div>
    );
  }

  // How old the picture is, said plainly. The radar is served from cache so it
  // can open immediately; the honest trade is that the reader is told the age
  // rather than being made to wait for freshness they may not need.
  const ageMin = data?.asOf ? Math.round((Date.now() - Date.parse(data.asOf)) / 60_000) : null;
  const freshness = ageMin === null ? null
    : ageMin < 1 ? 'just now'
      : ageMin < 60 ? `${ageMin} min ago`
        : `${Math.round(ageMin / 60)}h ago`;

  return (
    <div className="wrap">
      {error && <div className="banner bad">{error}</div>}

      {/* Switched off by decision, not by fault. Quiet, small, and OUTSIDE the
          blind-spots banner above — a permanent entry in a warning is how the
          warning stops being read, and that banner has to keep working for the
          transient failures it exists for. Still shown, because a detector
          nobody is told about is one nobody can ask to have fixed. */}
      {data?.notWatched?.length > 0 && (
        <div className="small" style={{ color: 'var(--muted)', margin: '0 0 10px' }}>
          <strong>Not watched:</strong>{' '}
          {data.notWatched.map(d => d.name).join(', ')}.{' '}
          <span title={data.notWatched.map(d => `${d.name}: ${d.reason}`).join('\n\n')}
            style={{ borderBottom: '1px dotted var(--line)', cursor: 'help' }}>
            why
          </span>
        </div>
      )}

      {data?.blind?.length > 0 && (
        <div className="banner warn">
          <strong>Blind spots.</strong> {data.blind.length} source
          {data.blind.length === 1 ? '' : 's'} could not be read, so nothing below covers
          {data.blind.length === 1 ? ' it' : ' them'}:
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {data.blind.map(b => <li key={b.name}><code>{b.name}</code> — {b.reason}</li>)}
          </ul>
        </div>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div className="small muted">
            {data?.counts && (
              <>{data.counts.happened} already wrong · {data.counts.happening} going wrong · {data.counts.could} could</>
            )}
            {/* Findings typed in by hand carry no tense, and are not given one — the
          three tenses demand different responses and a guessed one is worse
          than an unplaced card. */}
      {(data?.items || []).some(i => i.pinned && !i.tense) && (
        <div className="card">
          <h2>Logged, not resolved</h2>
          <p className="sub">Findings with no radar tense — logged by hand, still open.</p>
          {(data.items || []).filter(i => i.pinned && !i.tense).map((it, i) => <Item key={i} it={it} />)}
        </div>
      )}

      {/* Closed, and kept. Collapsed because the radar is about what is still
          wrong — but present, because "we fixed that" is the only part of this
          screen that is good news, and it is the part worth having at a review. */}
      {data?.resolved?.length > 0 && (
        <div className="card">
          <button onClick={() => setShowResolved(v => !v)} aria-expanded={showResolved}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <h2 style={{ flex: 1 }}>Resolved ({data.resolved.length})</h2>
            <span className="small muted">{showResolved ? 'hide' : 'show'}</span>
          </button>
          {showResolved && data.resolved.map(r => (
            <div key={r.findingId} style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 8 }}>
                <strong style={{ fontSize: 14, flex: 1 }}>{r.title}</strong>
                <span className="small muted">{r.foundOn} → {r.resolvedOn || '—'}</span>
                <span className="pill">{r.source}</span>
              </div>
              <div className="small" style={{ color: 'var(--good)', marginTop: 3 }}>
                {r.how || 'No resolution recorded.'}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Indicators whose evidence went back to normal.
          NOT collapsed, and deliberately above the fold of the closed sections.
          Every other part of this screen is an outstanding column, and this tool
          is built for someone who systematically under-registers completion —
          a warning that quietly evaporates when the number recovers teaches him
          nothing at all. The wording is careful: the EVIDENCE normalised. What
          anybody did about it is not something this can see, and saying
          otherwise would be the same inference-from-silence the rest of this
          codebase keeps having to unlearn. */}
      {data?.normalised?.length > 0 && (
        <div className="card">
          <h2>Went back to normal ({data.normalised.length})</h2>
          {data.normalised.map(n => (
            <div key={n.key} style={{ padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 8 }}>
                <strong style={{ fontSize: 14, flex: 1 }}>{n.title}</strong>
                <span className="small muted">{n.firstSeenOn} → {n.closedOn}</span>
                <span className="pill">{n.detector}</span>
              </div>
              <div className="small" style={{ color: 'var(--good)', marginTop: 3 }}>{n.note}</div>
            </div>
          ))}
        </div>
      )}

      {data?.registerRead === false && (
        <div className="banner warn">
          The findings register could not be read — {data.registerError}. Nothing logged is shown
          below, and that is not the same as nothing having been logged.
        </div>
      )}

      {data?.meetingsRead?.length > 0 && (
              <> · read {data.meetingsRead.length} recent meeting{data.meetingsRead.length === 1 ? '' : 's'}</>
            )}
            {freshness && <> · as at <strong>{freshness}</strong></>}
            {data?.refreshing && <> · refreshing in the background</>}
          </div>
        </div>
        <button className="ghost" onClick={() => load(true)} disabled={refreshing}>
          {refreshing ? 'Re-reading…' : 'Refresh now'}
        </button>
      </div>

      <SourceStrip items={data?.items || []} active={family} onPick={setFamily} />

      {TENSES.map(t => {
        const all = (data?.items || []).filter(i => i.tense === t.key);
        const items = family ? all.filter(i => familyFor(i.source).key === family) : all;
        const hidden = all.length - items.length;
        return (
          <div className="card" key={t.key}>
            <h2>{t.title}</h2>
            <p className="sub">{t.sub}</p>
            {items.length === 0
              ? (
                <p className="small muted">
                  {/* A filter hiding everything and a tense with nothing in it are
                      different facts, and only one of them is about the department. */}
                  {hidden > 0
                    ? `Nothing from this source in this tense — ${hidden} other card${hidden === 1 ? '' : 's'} here are filtered out.`
                    : 'Nothing surfaced — from the sources that answered. That is not the same as nothing being there.'}
                </p>
              )
              : (
                <>
                  {items.map((it, i) => <Item key={i} it={it} />)}
                  {hidden > 0 && (
                    <p className="small muted" style={{ marginTop: 8 }}>
                      {hidden} more here from other sources, hidden by the filter.
                    </p>
                  )}
                </>
              )}
          </div>
        );
      })}

      {data?.meetingsRead?.length > 0 && (
        <div className="card">
          <h2>Meetings read</h2>
          <p className="sub">
            Scanned for things that were said and never became a ticket or an action.
          </p>
          {data.meetingsRead.map(m => (
            <div key={m} className="small muted" style={{ padding: '3px 0' }}>{m}</div>
          ))}
        </div>
      )}
    </div>
  );
}
