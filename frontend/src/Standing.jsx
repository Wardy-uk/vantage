import React, { useEffect, useState } from 'react';
import { api } from './api.js';

/**
 * Where things stand — permanently visible, on every screen.
 *
 * This exists because of a correction: the first design measured what had not
 * been done and told Nick about it; the second swung too far and made the tool
 * mostly scaffolding, which risked the numbers going quiet once the brief had
 * named a pattern and moved on.
 *
 * Both are needed, and the way to have both is to separate them:
 *
 *   the FACT        — here, always, no commentary
 *   the DIAGNOSIS   — the brief, said once
 *   the NEXT STEP   — offered wherever the fact appears
 *
 * No judgement in this strip. "6 unraised" is a number. Whether that is
 * avoidance or a busy fortnight is not this component's business, and a bar that
 * editorialises every time he opens the app becomes something to avoid opening.
 *
 * It carries a link into the action rather than only reporting — out of sight is
 * genuinely out of mind, and a number with no route into doing something about
 * it is just a reminder of a debt.
 */

const REVIEW = new Date('2026-08-24T00:00:00');
const PIP_END = new Date('2026-10-11T00:00:00');
const daysUntil = d => Math.ceil((d - new Date()) / 86_400_000);

function Stat({ n, label, tone, title }) {
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700,
        color: tone || 'var(--text)',
      }}>{n}</span>
      <span className="small muted">{label}</span>
    </div>
  );
}

export default function Standing({ onGoTo }) {
  const [d, setD] = useState(null);
  const [moved, setMoved] = useState(null);

  /**
   * Two loads on purpose. `selfQuick` is local reads only, so the bar renders
   * the instant the app opens; what moved comes from NEURO's ledger over the
   * network and fills in behind it.
   *
   * A failure shows NOTHING rather than a zero. "You finished nothing this
   * week" is the single most damaging thing this bar could say wrongly, and an
   * unreachable Pi must never be able to say it.
   */
  const load = () => {
    api.selfQuick().then(setD).catch(() => {});
    api.moved().then(r => setMoved(r?.moved || null)).catch(() => setMoved(null));
  };
  useEffect(() => {
    load();
    // Refresh on focus rather than on a timer: the numbers change when he does
    // something, and a ticking poll is noise on a page he leaves open.
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  if (!d) return null;

  const toReview = daysUntil(REVIEW);
  const f = d.findings;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      padding: '7px 20px', borderBottom: '1px solid var(--line)',
      background: 'var(--panel-2)',
    }}>
      <Stat
        n={f.unraised}
        label={`unraised${f.highUnraised ? ` (${f.highUnraised} high)` : ''}`}
        tone={f.highUnraised ? 'var(--warn)' : undefined}
        title="Findings you have logged but not told anyone about"
      />
      {f.oldestUnraisedDays !== null && (
        <Stat
          n={`${f.oldestUnraisedDays}d`}
          label="oldest"
          tone={f.oldestUnraisedDays >= 7 ? 'var(--bad)' : 'var(--warn)'}
          title={f.oldestUnraisedTitle || ''}
        />
      )}
      <Stat n={`${d.plan.mineMoving}/${d.plan.mineTotal}`} label="plan actions moving" />
      {d.done.findingsRaised > 0 && (
        <Stat n={d.done.findingsRaised} label="raised this week" tone="var(--good)" />
      )}
      {/* The other half of the report. Everything to the left is what is
          outstanding; without this the bar only ever shows the debt. */}
      {moved?.thisWeek != null && (
        <Stat
          n={moved.thisWeek}
          label="finished this week"
          tone="var(--good)"
          title={`Detected by NEURO, not self-reported${moved.typicalDay != null ? ` — a usual day is ${moved.typicalDay}` : ''}${moved.knownGaps?.length ? `. Does not include: ${moved.knownGaps.length} source(s) the ledger cannot see, so it is a floor.` : ''}`}
        />
      )}

      <div style={{ flex: 1 }} />

      {/* The route into doing something, not just the number. */}
      {f.unraised > 0 && (
        <button className="ghost small" style={{ padding: '3px 9px' }} onClick={() => onGoTo('findings')}>
          Raise one
        </button>
      )}
      <span className="small muted" style={{ fontFamily: 'var(--mono)' }}>
        {toReview > 0 ? `review ${toReview}d` : `PIP ends ${daysUntil(PIP_END)}d`}
      </span>
    </div>
  );
}
