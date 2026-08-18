'use strict';

/**
 * The radar — what has gone wrong, what is going wrong, and what could.
 *
 * This is the screen's whole reason to exist. A dashboard of current ticket
 * counts adds nothing to NOVA, which already shows them better; the first cut of
 * this was exactly that and was rightly rejected. What NOVA cannot do is combine
 * three sources that only mean something together:
 *
 *   NOVA     — what the tickets are doing
 *   NEURO    — what the people are doing: 1:1s missed, things waited on
 *   MEETINGS — what was SAID and never became either of the above
 *
 * That third source is the point. "Proactively uncover issues before they become
 * a problem" is, in practice, almost always someone naming a risk in a meeting
 * that never turned into a ticket or an action. No ticket system can see it,
 * because by definition it never became a ticket.
 *
 * THREE TENSES, because they demand different responses:
 *
 *   happened  — already gone wrong. Cannot be prevented, must be acknowledged.
 *   happening — going wrong now. Still steerable.
 *   could     — has not gone wrong yet. The only tense where being early counts.
 *
 * Every source records whether it answered. A radar missing a source is a radar
 * that will report "all clear" about a thing it cannot see, which is worse than
 * showing nothing — the same contract the weekly report holds.
 */

const nova = require('./signals');
const neuro = require('./neuro');
const openrouter = require('./openrouter');

const CACHE_MS = 10 * 60 * 1000;
/** Untouched longer than this and it is not queued, it is forgotten. */
const STALE_TICKET_DAYS = 14;
/** A vault commitment older than this with no due date has probably been dropped. */
const DROPPED_COMMITMENT_DAYS = 21;

let cache = { at: 0, data: null };

const nowIso = () => new Date().toISOString();
const daysSince = iso => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86_400_000) : null);

/** Run one source so its failure degrades a section rather than losing the radar. */
async function source(name, fn) {
  try {
    return { name, ok: true, error: null, data: await fn() };
  } catch (err) {
    return { name, ok: false, error: err?.message || String(err), data: null };
  }
}

function item(tense, severity, title, detail, meta = {}) {
  return { tense, severity, title, detail, ...meta };
}

// ── NOVA: the tickets ────────────────────────────────────────────────────────

function fromNova(signals) {
  if (!signals?.available) return [];
  const flow = signals.raw;
  const out = [];

  const b = flow?.breachesByQueue;
  if (b?.ok && b.data.total > 0) {
    const top = b.data.byTier?.[0];
    out.push(item('happened', 'high',
      `${b.data.total} open tickets are already over SLA`,
      `Of ${b.data.openTickets} open.${top ? ` Most are sitting in ${top.tier} (${top.breaches}).` : ''} These have breached — the question is what the customer has been told, not whether it can be prevented.`,
      { source: 'NOVA' }));
  }

  const s = flow?.stalled;
  if (s?.ok && s.data.total > 0) {
    const worst = s.data.worst?.[0];
    out.push(item('happening', 'high',
      `${s.data.total} tickets untouched for ${s.data.staleDays}+ days`,
      `${worst ? `Worst is ${worst.issue_key} at ${worst.days_untouched} days${worst.assignee ? `, with ${worst.assignee}` : ' and unassigned'}. ` : ''}Measured from last update, not creation — these are forgotten, not queued.`,
      { source: 'NOVA' }));
  }

  const u = flow?.unowned;
  if (u?.ok && u.data.total > 0) {
    const worst = u.data.byTier?.[0];
    out.push(item('could', 'medium',
      `${u.data.total} open tickets have nobody's name on them`,
      `${worst ? `Worst ${worst.tier}: ${worst.count}, oldest ${worst.oldest_days} days. ` : ''}Unowned work is the review's number one finding, and it is the state a ticket is in just before it is forgotten.`,
      { source: 'NOVA' }));
  }

  const h = flow?.handbacks;
  if (h?.ok) {
    if (h.data.total > 0 && h.data.changePct !== null && h.data.changePct > 25) {
      out.push(item('happening', 'high',
        `Rejections up ${h.data.changePct}% — ${h.data.total} tickets returned`,
        `Against ${h.data.previous} the period before. Something changed in what is being escalated, or in what is being accepted.`,
        { source: 'NOVA' }));
    }
    if (h.data.unclassified > 50) {
      out.push(item('could', 'low',
        `${h.data.unclassified} tier moves cannot be classified`,
        'Recorded before evidence capture started, so they are neither rejections nor returns-after-fix. The number falls as new moves accumulate; it is not a backlog to clear.',
        { source: 'NOVA' }));
    }
  }

  const p = flow?.pingPong;
  if (p?.ok && p.data.worst?.length) {
    const bad = p.data.worst.filter(t => t.moves >= 6);
    if (bad.length) {
      out.push(item('happening', 'medium',
        `${bad.length} tickets have crossed queues 6+ times`,
        `${bad.slice(0, 3).map(t => `${t.ticket_key} (${t.moves})`).join(', ')}. Each move was a chance to own it that nobody took.`,
        { source: 'NOVA' }));
    }
  }

  return out;
}

// ── NEURO: the people ────────────────────────────────────────────────────────

function fromNeuro({ health, actions, waiting, tasks }) {
  const out = [];

  if (health?.ok) {
    const issues = health.data.issues || [];
    const high = issues.filter(i => i.severity === 'high');
    const overdue1to1 = issues.filter(i => i.type === 'overdue_1to1');

    if (overdue1to1.length) {
      out.push(item('happening', 'high',
        `${overdue1to1.length} overdue 1:1${overdue1to1.length === 1 ? '' : 's'}`,
        `${overdue1to1.map(i => i.person).join(', ')}. Management cadence is the one Support Review finding that sits squarely with you, and it is the easiest to evidence either way.`,
        { source: 'NEURO' }));
    }

    const others = high.filter(i => i.type !== 'overdue_1to1');
    if (others.length) {
      out.push(item('could', 'medium',
        `${others.length} people issues flagged high`,
        others.slice(0, 4).map(i => `${i.person}: ${i.title}`).join('; '),
        { source: 'NEURO' }));
    }
  }

  // Commitments written into notes and never closed. The `file` on each item is
  // what makes this usable — it points back at the conversation it came from.
  if (actions?.ok) {
    const items = actions.data.items || [];
    const today = nowIso().slice(0, 10);
    const overdue = items.filter(i => i.dueDate && i.dueDate < today);
    const undated = items.filter(i => !i.dueDate);

    if (overdue.length) {
      // Sorted most-recently-due first: a commitment that slipped last week is
      // still recoverable, one from March is history. The count includes both
      // because the total is honest, but the examples shown are the live ones.
      const recent = [...overdue].sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || ''));
      out.push(item('happened', 'high',
        `${overdue.length} commitments are past their due date`,
        `Most recent: ${recent.slice(0, 3).map(i => `"${(i.text || '').slice(0, 55)}" (due ${i.dueDate})`).join('; ')}. These were written down and the date has gone.`,
        { source: 'NEURO' }));
    }
    // Deliberately NOT reported as a count.
    //
    // The first run returned 2,890 undated open commitments — every unticked
    // checkbox in the vault, going back years. That is not a signal, it is the
    // shape of how notes get written, and putting it on a risk radar trains you
    // to ignore the radar. Only recent undated commitments are worth surfacing,
    // because those are the ones still live enough to chase.
    const recentUndated = undated.filter(i => {
      const d = (i.file || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      return d && (daysSince(`${d}T00:00:00Z`) ?? 999) <= DROPPED_COMMITMENT_DAYS;
    });
    if (recentUndated.length > 3) {
      out.push(item('could', 'medium',
        `${recentUndated.length} commitments from the last ${DROPPED_COMMITMENT_DAYS} days have no due date`,
        `${recentUndated.slice(0, 3).map(i => `"${(i.text || '').slice(0, 50)}"`).join('; ')}. An action with no date cannot be chased and cannot be evidenced as met.`,
        { source: 'NEURO' }));
    }
  }

  if (waiting?.ok) {
    const items = waiting.data.items || [];
    const stale = items.filter(i => (daysSince(i.created_at || i.since) ?? 0) > (waiting.data.staleAfterDays || 7));
    if (stale.length) {
      out.push(item('happening', 'medium',
        `${stale.length} things you are waiting on have gone quiet`,
        `${stale.slice(0, 3).map(i => `${i.person || 'someone'}: ${(i.summary || i.what || '').slice(0, 50)}`).join('; ')}. Waiting is not the same as chasing, and only one of them is evidence.`,
        { source: 'NEURO' }));
    }
  }

  if (tasks?.ok) {
    const list = tasks.data.tasks || [];
    const today = nowIso().slice(0, 10);
    const overdue = list.filter(t => t.due_date && t.due_date < today);
    if (overdue.length) {
      out.push(item('happened', overdue.length > 10 ? 'high' : 'medium',
        `${overdue.length} of your own tasks are overdue`,
        `PIP competency 4 measures exactly this, with a target of zero overdue management actions by 11 September.`,
        { source: 'NEURO' }));
    }
  }

  return out;
}

// ── Meetings: what was said ──────────────────────────────────────────────────

/**
 * Read the recent meeting notes for risks nobody logged.
 *
 * This is the one source that genuinely requires a model. The signal is not a
 * field or a count — it is somebody saying "we're going to struggle to cover
 * that in September" in the middle of a transcript, which becomes a problem in
 * September and was visible in August.
 *
 * The prompt is written to find things that did NOT become actions, and to say
 * so when it finds nothing. An analyst that always produces three risks will be
 * inventing them by the third week.
 */
async function fromMeetings(notes) {
  if (!notes?.length) return [];
  if (!openrouter.isConfigured()) return [];

  const corpus = notes.map(n => `### ${n.title}\n${n.content}${n.truncated ? '\n[truncated]' : ''}`).join('\n\n---\n\n');

  const system = `You are reading recent meeting notes belonging to Nick Ward, Head of Service Delivery at a proptech SaaS company, to find OPERATIONAL RISK he may not have registered.

You are looking specifically for things that were SAID but did not obviously become a ticket, an action or a decision:
- capacity, cover or absence problems mentioned in passing
- commitments made to a customer or another team, with no owner or date
- dependencies on one person
- concerns raised by someone that nobody responded to
- dates or deadlines that will collide
- decisions deferred without a date to revisit

Classify each into one tense:
- "happened"  — it has already gone wrong
- "happening" — it is going wrong now
- "could"     — it has not gone wrong yet

Rules:
- Quote or closely paraphrase the meeting so he can find it.
- Do NOT restate things that are plainly already being handled.
- Do NOT invent risk to fill a quota. Returning an empty list is a valid and useful answer.
- Ignore anything purely personal or pastoral.

Respond ONLY with JSON: {"items":[{"tense":"happened|happening|could","severity":"high|medium|low","title":"short","detail":"what was said and why it matters","meeting":"note title"}]}`;

  const reply = await openrouter.complete(
    [{ role: 'system', content: system }, { role: 'user', content: corpus }],
    // 4000, not 1600. The first run was truncated mid-JSON — "Unterminated
    // string at position 6289" — which failed the whole source. Six meetings of
    // genuine risk does not fit in 1600 tokens, and a cap that silently
    // decapitates the answer is worse than a slower call.
    { temperature: 0.2, maxTokens: 4000 },
  );

  // The model is asked for JSON but is not guaranteed to obey. A parse failure
  // is reported as a failed source rather than swallowed — an analyst that
  // silently returns nothing is indistinguishable from a quiet week.
  let text = reply.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  // Tolerate trailing prose after the object, which some models add.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text);
  return (parsed.items || []).map(i => item(
    ['happened', 'happening', 'could'].includes(i.tense) ? i.tense : 'could',
    ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
    i.title, i.detail,
    { source: 'Meetings', meeting: i.meeting },
  ));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const TENSE_ORDER = { happened: 0, happening: 1, could: 2 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

async function build({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const signals = await nova.current({ force });

  const neuroReady = neuro.isConfigured();
  const [health, actions, waiting, tasks, meetings] = neuroReady
    ? await Promise.all([
      source('team-health', neuro.teamHealth),
      source('vault-actions', () => neuro.vaultActions(90)),
      source('waiting-on', neuro.waitingOn),
      source('tasks', neuro.tasks),
      source('meetings', () => neuro.recentMeetings(6)),
    ])
    : ['team-health', 'vault-actions', 'waiting-on', 'tasks', 'meetings']
      .map(name => ({ name, ok: false, error: 'NEURO not configured (NEURO_API_TOKEN)', data: null }));

  const meetingAnalysis = meetings.ok
    ? await source('meeting-analysis', () => fromMeetings(meetings.data))
    : { name: 'meeting-analysis', ok: false, error: 'no meeting notes available', data: null };

  const items = [
    ...fromNova(signals),
    ...fromNeuro({ health, actions, waiting, tasks }),
    ...(meetingAnalysis.data || []),
  ].sort((a, b) =>
    (TENSE_ORDER[a.tense] - TENSE_ORDER[b.tense])
    || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]));

  const sources = [
    { name: 'nova-flow', ok: Boolean(signals?.available), error: signals?.available ? null : signals?.reason },
    health, actions, waiting, tasks, meetings, meetingAnalysis,
  ].map(s => ({ name: s.name, ok: s.ok, error: s.error || null }));

  const data = {
    generatedAt: nowIso(),
    sources,
    // Named so the UI can say what it could not see, rather than implying the
    // radar covered everything.
    blind: sources.filter(s => !s.ok).map(s => ({ name: s.name, reason: s.error })),
    items,
    counts: {
      happened: items.filter(i => i.tense === 'happened').length,
      happening: items.filter(i => i.tense === 'happening').length,
      could: items.filter(i => i.tense === 'could').length,
    },
    meetingsRead: (meetings.data || []).map(m => m.title),
  };

  cache = { at: Date.now(), data };
  return data;
}

module.exports = { build, fromNova, fromNeuro, STALE_TICKET_DAYS, DROPPED_COMMITMENT_DAYS };
