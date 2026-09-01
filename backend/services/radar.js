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
const sentiment = require('./sentiment');
const cache = require('./cache');
const findings = require('./findings');

const CACHE_MS = 10 * 60 * 1000;
/** Untouched longer than this and it is not queued, it is forgotten. */
const STALE_TICKET_DAYS = 14;
/** A vault commitment older than this with no due date has probably been dropped. */
const DROPPED_COMMITMENT_DAYS = 21;


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
      { source: 'NOVA', remedy: "Cannot be un-breached. Pull the list by queue, decide which customers get told today, and record who was told — the breach is a fact; the silence is the part still in your hands." }));
  }

  const s = flow?.stalled;
  if (s?.ok && s.data.total > 0) {
    const worst = s.data.worst?.[0];
    out.push(item('happening', 'high',
      `${s.data.total} tickets untouched for ${s.data.staleDays}+ days`,
      `${worst ? `Worst is ${worst.issue_key} at ${worst.days_untouched} days${worst.assignee ? `, with ${worst.assignee}` : ' and unassigned'}. ` : ''}Measured from last update, not creation — these are forgotten, not queued.`,
      { source: 'NOVA', remedy: "Take the worst ten by days-untouched into the next stand-up and give each a name and a next date. The unassigned ones need an owner before they need a plan." }));
  }

  const u = flow?.unowned;
  if (u?.ok && u.data.total > 0) {
    const worst = u.data.byTier?.[0];
    out.push(item('could', 'medium',
      `${u.data.total} open tickets have nobody's name on them`,
      `${worst ? `Worst ${worst.tier}: ${worst.count}, oldest ${worst.oldest_days} days. ` : ''}Unowned work is the review's number one finding, and it is the state a ticket is in just before it is forgotten.`,
      { source: 'NOVA', remedy: "Assign the oldest in the worst tier first — an unowned ticket has nobody to notice it. If one tier keeps producing them, the routing rule is the fix, not the assigning." }));
  }

  const h = flow?.handbacks;
  if (h?.ok) {
    if (h.data.total > 0 && h.data.changePct !== null && h.data.changePct > 25) {
      out.push(item('happening', 'high',
        `Rejections up ${h.data.changePct}% — ${h.data.total} tickets returned`,
        `Against ${h.data.previous} the period before. Something changed in what is being escalated, or in what is being accepted.`,
        { source: 'NOVA', remedy: "Read five of the returned tickets and find out why they came back. Either the escalating side is sending less complete work or the receiving side has raised the bar; those need opposite conversations, and the sample tells you which." }));
    }
    if (h.data.unclassified > 50) {
      out.push(item('could', 'low',
        `${h.data.unclassified} tier moves cannot be classified`,
        'Recorded before evidence capture started, so they are neither rejections nor returns-after-fix. The number falls as new moves accumulate; it is not a backlog to clear.',
        { source: 'NOVA', remedy: "Nothing to clear. Leave it and watch the number fall as new moves accumulate — if it does not fall, evidence capture is not running." }));
    }
  }

  const p = flow?.pingPong;
  if (p?.ok && p.data.worst?.length) {
    const bad = p.data.worst.filter(t => t.moves >= 6);
    if (bad.length) {
      out.push(item('happening', 'medium',
        `${bad.length} tickets have crossed queues 6+ times`,
        `${bad.slice(0, 3).map(t => `${t.ticket_key} (${t.moves})`).join(', ')}. Each move was a chance to own it that nobody took.`,
        { source: 'NOVA', remedy: "Stop the next move rather than reviewing the past ones: name an owner for each of the worst tickets today and make them the one who hands it on, if it moves at all." }));
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
        { source: 'NEURO', remedy: "Book them, with dates, before the end of today. A booking in the diary is the evidence; an intention is not." }));
    }

    const others = high.filter(i => i.type !== 'overdue_1to1');
    if (others.length) {
      out.push(item('could', 'medium',
        `${others.length} people issues flagged high`,
        others.slice(0, 4).map(i => `${i.person}: ${i.title}`).join('; '),
        { source: 'NEURO', remedy: "Take the named people into your next 1:1 and write what was said into their note afterwards. Unwritten, it evidences nothing." }));
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
        { source: 'NEURO', remedy: "Work the most recent first: close it, re-date it, or drop it out loud. A commitment quietly left past its date is the one that gets noticed." }));
    }
    // Deliberately NOT reported as a count.
    //
    // The first run returned 2,890 undated open commitments — every unticked
    // checkbox in the vault, going back years. That is not a signal, it is the
    // shape of how notes get written, and putting it on a risk radar trains you
    // to ignore the radar. Only recent undated commitments are worth surfacing,
    // because those are the ones still live enough to chase.
    // Scoped to MEETINGS, and recent.
    //
    // Dating by file alone still returned 1,092 — every unticked line in every
    // daily note. The commitments that matter are the ones made in front of
    // someone: those carry an implicit promise, and those are the ones whose
    // absence gets noticed. A checkbox in a personal daily note is a to-do.
    const recentUndated = undated.filter(i => {
      if (!/^Meetings\//i.test(i.file || '')) return false;
      const d = (i.file || '').match(/(\d{4}-\d{2}-\d{2})/)?.[1];
      return d && (daysSince(`${d}T00:00:00Z`) ?? 999) <= DROPPED_COMMITMENT_DAYS;
    });
    if (recentUndated.length > 3) {
      out.push(item('could', 'medium',
        `${recentUndated.length} commitments made in meetings have no due date`,
        `From the last ${DROPPED_COMMITMENT_DAYS} days: ${recentUndated.slice(0, 3).map(i => `"${(i.text || '').slice(0, 50)}"`).join('; ')}. Said in front of someone, so someone is expecting them.`,
        { source: 'NEURO', remedy: "Put a date on each, or hand it back to whoever is expecting it. Said in front of someone means someone is waiting for it." }));
    }
  }

  if (waiting?.ok) {
    const items = waiting.data.items || [];
    const stale = items.filter(i => (daysSince(i.created_at || i.since) ?? 0) > (waiting.data.staleAfterDays || 7));
    if (stale.length) {
      out.push(item('happening', 'medium',
        `${stale.length} things you are waiting on have gone quiet`,
        `${stale.slice(0, 3).map(i => `${i.person || 'someone'}: ${(i.summary || i.what || '').slice(0, 50)}`).join('; ')}. Waiting is not the same as chasing, and only one of them is evidence.`,
        { source: 'NEURO', remedy: "Chase them in writing today. Waiting leaves no trace; a chase is dated and survives to a review." }));
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
        { source: 'NEURO', remedy: "Clear or re-date them before 11 September. Competency 4 is measured on this number and the target is zero, so a re-dated task counts and a silent one does not." }));
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
/**
 * Pull every COMPLETE object out of a model's JSON, tolerating a broken tail.
 *
 * Three runs failed on malformed output — truncated, then an unescaped
 * character, then again at position 6228 despite asking OpenRouter for
 * `response_format: json_object`, which Claude models appear to ignore. Three
 * strikes is enough: the answer is to stop requiring the whole response to be
 * valid and salvage what is.
 *
 * Scans for balanced braces at depth 1 (string- and escape-aware, so a `}` in a
 * quoted meeting excerpt does not end an object early), parses each candidate
 * independently, and discards any that fail. A truncated final object costs one
 * finding instead of all of them.
 */
/**
 * `required` is the field that makes an object real. It defaults to `title` for
 * the radar's own items; the plan matcher passes `plan`, because its objects are
 * pairs and a pair with no action id is noise the same way a titled item with no
 * title is.
 */
function extractItems(text, { required = 'title' } = {}) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }

    if (ch === '{') {
      depth += 1;
      // Depth 1 is the wrapper object; the items sit at depth 2.
      if (depth === 2) start = i;
    } else if (ch === '}') {
      if (depth === 2 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && obj[required]) out.push(obj);
        } catch { /* an unparseable item costs that item, not the run */ }
        start = -1;
      }
      depth -= 1;
    }
  }
  return out;
}

async function fromMeetings(notes, schedule = []) {
  if (!notes?.length) return [];
  if (!openrouter.isConfigured()) return [];

  // What IS booked, handed to the model as ground truth.
  //
  // Without this it read "a nice big uptick by the next one-to-one" out of a
  // transcript and asserted the next 1:1 was the following day, when it was
  // booked for a week later — and separately reported a risk assessment as
  // having "no date set" when a date existed in the person's note. Both are the
  // same mistake this codebase keeps making in different clothes: treating the
  // absence of a mention as the absence of a fact.
  const known = schedule.length
    ? `\n\nKNOWN SCHEDULE (authoritative — these ARE booked):\n${schedule.map(s => `- 1:1 with ${s.person}: ${s.booked}`).join('\n')}`
    : '\n\nKNOWN SCHEDULE: not available. Do not assert that anything is unscheduled.';

  const corpus = notes.map(n => `### ${n.title}\n${n.content}${n.truncated ? '\n[truncated]' : ''}`).join('\n\n---\n\n')
    + known;

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
- Where you can name ONE concrete next step, put it in "remedy": what Nick would
  actually do next, specific enough to start today. If you cannot name one
  without guessing, OMIT the field. A vague remedy ("monitor the situation") is
  worse than none, because it reads as advice and costs nothing to ignore.
- Ignore anything purely personal or pastoral.

DATES AND SCHEDULING — read this carefully:
- A meeting note is NOT the system of record for what is scheduled. Diaries,
  calendars and people notes are. If a note does not mention a date, that means
  it was not mentioned, NOT that nothing is booked.
- NEVER infer or state a date that is not explicitly written in the note. Do not
  reason that "the next one-to-one" means the following day.
- The KNOWN SCHEDULE section below is authoritative. If something is listed
  there, it IS booked — do not raise it as unscheduled, undated or deferred.
- If you believe something needs a date and none appears anywhere, say "no date
  is mentioned in the note" rather than "no date has been set".

Respond ONLY with JSON: {"items":[{"tense":"happened|happening|could","severity":"high|medium|low","title":"short","detail":"what was said and why it matters","remedy":"one concrete next step, or omit","meeting":"note title"}]}`;

  const reply = await openrouter.complete(
    [{ role: 'system', content: system }, { role: 'user', content: corpus }],
    // 4000, not 1600. The first run was truncated mid-JSON — "Unterminated
    // string at position 6289" — which failed the whole source. Six meetings of
    // genuine risk does not fit in 1600 tokens, and a cap that silently
    // decapitates the answer is worse than a slower call.
    { temperature: 0.2, maxTokens: 4000, json: true },
  );

  const parsed = { items: extractItems(reply.text) };
  return (parsed.items || []).map(i => item(
    ['happened', 'happening', 'could'].includes(i.tense) ? i.tense : 'could',
    ['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'medium',
    i.title, i.detail,
    // No remedy is left absent rather than filled in. A generated next step the
    // model could not actually name would read exactly like one it could.
    { source: 'Meetings', meeting: i.meeting, remedy: typeof i.remedy === 'string' && i.remedy.trim() ? i.remedy.trim() : null },
  ));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

const TENSE_ORDER = { happened: 0, happening: 1, could: 2 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * Build the radar, ignoring any cache. Slow by design — see `build()`.
 */
async function compute({ force = false } = {}) {
  const signals = await nova.current({ force });
  const mood = await sentiment.current({ force });

  const neuroReady = neuro.isConfigured();
  const [health, actions, waiting, tasks, meetings, booked] = neuroReady
    ? await Promise.all([
      source('team-health', neuro.teamHealth),
      source('vault-actions', () => neuro.vaultActions(90)),
      source('waiting-on', neuro.waitingOn),
      source('tasks', neuro.tasks),
      source('meetings', () => neuro.recentMeetings(6)),
      source('booked-1to1s', neuro.bookedOneToOnes),
    ])
    : ['team-health', 'vault-actions', 'waiting-on', 'tasks', 'meetings', 'booked-1to1s']
      .map(name => ({ name, ok: false, error: 'NEURO not configured (NEURO_API_TOKEN)', data: null }));

  const meetingAnalysis = meetings.ok
    ? await source('meeting-analysis', () => fromMeetings(meetings.data, booked.data || []))
    : { name: 'meeting-analysis', ok: false, error: 'no meeting notes available', data: null };

  const items = [
    ...fromNova(signals),
    ...sentiment.toRadarItems(mood),
    ...fromNeuro({ health, actions, waiting, tasks }),
    ...(meetingAnalysis.data || []),
  ].sort((a, b) =>
    (TENSE_ORDER[a.tense] - TENSE_ORDER[b.tense])
    || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]));

  const sources = [
    { name: 'nova-flow', ok: Boolean(signals?.available), error: signals?.available ? null : signals?.reason },
    { name: 'sentiment', ok: Boolean(mood?.available), error: mood?.available ? null : mood?.reason },
    health, actions, waiting, tasks, meetings, booked, meetingAnalysis,
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
    sentiment: mood?.available ? mood.raw : null,
  };

  return data;
}

/**
 * The radar, served from cache.
 *
 * `compute()` takes 60-110 seconds. Nobody waits for that: a stored value comes
 * back immediately with its timestamp, and a refresh runs behind it when stale.
 * The value survives restarts, so a deploy does not hand the next visitor a cold
 * two-minute load.
 */
/**
 * Fold the findings register back into the live picture.
 *
 * The radar is recomputed from live signals, so an item DISAPPEARS the moment
 * its number moves — a stalled-ticket count falling below a threshold, a 1:1
 * being booked, a meeting note scrolling out of the window. Most of the time
 * that is right. It is wrong for anything Nick has actually logged: a signal
 * going quiet is not the same as the problem being dealt with, and a radar that
 * silently drops a logged risk is a radar that quietly forgets what he noticed.
 *
 * So an unresolved finding is PINNED back on, and a live item that has already
 * been logged says so rather than offering to log it twice. Resolved findings
 * come back separately — visible, closed, with what was done — because the
 * register is a history and the radar is where he is actually looking.
 *
 * Matched on title, which is exactly what `+ log` copies across. A reworded
 * finding pins as a second card, which is visible and correctable; the opposite
 * error, silently treating two different risks as one, is not.
 *
 * Applied at SERVE time rather than inside `compute()`: the radar is cached for
 * ten minutes and the register changes the second something is logged, so a
 * finding folded into the cached value would not appear until the next rebuild.
 * It is a local read, so it costs nothing on a path that is polled.
 */
function foldFindings(data) {
  let register;
  try {
    register = findings.list({ limit: 500 });
  } catch (err) {
    // The register failing must not take the radar down, but it must not look
    // like an empty register either — that would read as "nothing logged".
    return { ...data, registerRead: false, registerError: err.message, resolved: [] };
  }

  const byTitle = new Map(register.map(f => [f.title, f]));
  const items = (data.items || []).map(i => {
    const f = byTitle.get(i.title);
    return f ? { ...i, findingId: f.id, findingStatus: f.status, loggedOn: f.found_on } : i;
  });

  const liveTitles = new Set(items.map(i => i.title));
  const open = register.filter(f => f.status !== 'resolved' && f.status !== 'accepted');

  const pinned = open
    .filter(f => !liveTitles.has(f.title))
    .map(f => ({
      tense: f.tense || null,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      source: f.source,
      // Says WHY it is still here, which is the whole point of pinning it: the
      // signal has gone and the finding has not been closed.
      pinned: true,
      findingId: f.id,
      findingStatus: f.status,
      loggedOn: f.found_on,
    }));

  const all = [...items, ...pinned];
  return {
    ...data,
    items: all,
    registerRead: true,
    counts: {
      happened: all.filter(i => i.tense === 'happened').length,
      happening: all.filter(i => i.tense === 'happening').length,
      could: all.filter(i => i.tense === 'could').length,
      // Findings typed in by hand carry no tense and are not given one. They
      // render in their own group rather than being filed under a guess.
      unplaced: all.filter(i => i.pinned && !i.tense).length,
    },
    resolved: register
      .filter(f => f.status === 'resolved')
      .map(f => ({
        findingId: f.id,
        title: f.title,
        severity: f.severity,
        source: f.source,
        foundOn: f.found_on,
        resolvedOn: f.resolved_on || null,
        how: f.resolved_how || null,
      })),
  };
}

async function build({ force = false } = {}) {
  const hit = await cache.get('radar', () => compute({ force }), { maxAgeMs: CACHE_MS, force });
  return foldFindings({ ...hit.value, asOf: hit.at, stale: hit.stale, refreshing: hit.refreshing });
}

module.exports = { build, compute, foldFindings, fromNova, fromNeuro, extractItems, STALE_TICKET_DAYS, DROPPED_COMMITMENT_DAYS };
