'use strict';

/**
 * NEURO client — the second of VANTAGE's three signal sources.
 *
 * NOVA knows what the tickets are doing. NEURO knows what the PEOPLE are doing:
 * 1:1s that have not happened, commitments written into meeting notes and never
 * actioned, things being waited on that have gone quiet. That second half is
 * where "problems before they become problems" actually lives, and no amount of
 * ticket data will surface it.
 *
 * Read-only by default, with ONE deliberate exception.
 *
 * Every call here is a GET except three, added so the improvement plan can own
 * real tasks rather than a private checklist. The rule they narrow is unchanged
 * in spirit: one shared token unlocks NEURO's entire API including deletes, so
 * the discipline lives on this side. What is allowed is exactly:
 *
 *   POST /api/tasks              — create a task (idempotent on text)
 *   POST /api/task-dedupe/match  — scores candidates; changes nothing
 *   POST /api/task-dedupe/link   — merge a task with its Planner/To-Do item
 *   POST /api/weekly-risk/manual — put a finding on the report's escalation list
 *
 * Nothing here updates, completes or deletes anything, and the endpoints that
 * write or send (weekly-risk publish, queue-send, plaud sync) remain
 * deliberately unwrapped.
 *
 * NEURO holds the task; VANTAGE holds only the link to it. Merging that task
 * with Mel's Planner board is NEURO's job and already exists (`task-dedupe`),
 * which is why nothing here talks to Graph.
 *
 * `GET /api/weekly-risk` — the assembled report — is deliberately NOT used: it
 * triggers a NOVA round trip of its own, and VANTAGE already reads NOVA
 * directly. Calling it would double the load on a DTU-limited database to fetch
 * numbers we have. `/manual` is a different thing and is safe: NEURO split it
 * out precisely so the entry screen could be opened without paying for that
 * round trip, and it touches nothing but the sections Nick types himself.
 *
 * `publish`, `queue-send` and `test-send` remain unwrapped. VANTAGE can put a
 * line on the report; sending it to Chris stays a decision Nick makes in NEURO.
 */

const TIMEOUT_MS = 20_000;
/** Meeting notes are read from the vault; there is no meetings endpoint. */
const MEETINGS_DIR = 'Meetings';

/**
 * Token preferred, PIN accepted.
 *
 * NEURO takes either `X-Neuro-Api-Token` or `X-Neuro-Pin`. The token is the
 * machine credential and the one to use: the PIN is what Nick types into NEURO
 * himself, so borrowing it here would mean rotating his interactive login every
 * time this service's credential needed changing. The PIN is supported only as a
 * fallback for a box where no token has been issued yet.
 */
function config() {
  return {
    url: (process.env.NEURO_URL || 'http://127.0.0.1:3001').replace(/\/$/, ''),
    token: process.env.NEURO_API_TOKEN || '',
    pin: process.env.NEURO_PIN || '',
    // `/api/vault/*` has its OWN gate — `X-Api-Key` against VAULT_API_KEY —
    // layered under the global one. The API token opens every other route and
    // is refused here, which is a deliberate choice on NEURO's side: the vault
    // is the whole second brain, not just service-desk data.
    vaultKey: process.env.NEURO_VAULT_API_KEY || '',
  };
}

/** Is this a vault path, which needs the second credential? */
const isVaultPath = path => path.startsWith('/api/vault/');

function isConfigured() {
  const c = config();
  return Boolean(c.token || c.pin);
}

async function call(path, { timeoutMs = TIMEOUT_MS } = {}) {
  const c = config();
  if (!c.token && !c.pin) throw new Error('No NEURO credential set (NEURO_API_TOKEN preferred, NEURO_PIN accepted)');

  const headers = c.token ? { 'X-Neuro-Api-Token': c.token } : { 'X-Neuro-Pin': c.pin };
  if (isVaultPath(path)) {
    if (!c.vaultKey) {
      throw new Error('NEURO_VAULT_API_KEY is not set — vault reads need their own key (VAULT_API_KEY in NEURO)');
    }
    headers['X-Api-Key'] = c.vaultKey;
  }

  const res = await fetch(`${c.url}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NEURO ${path} returned ${res.status}`);
  }
  return payload;
}

/**
 * The two writes. Kept together and named so a grep for `method: 'POST'` in this
 * repo lands on the whole of what VANTAGE is allowed to change in NEURO.
 */
async function post(path, body, { timeoutMs = TIMEOUT_MS } = {}) {
  const c = config();
  if (!c.token && !c.pin) throw new Error('No NEURO credential set (NEURO_API_TOKEN preferred, NEURO_PIN accepted)');
  if (isVaultPath(path)) throw new Error('Refusing to write to the vault');

  const res = await fetch(`${c.url}${path}`, {
    method: 'POST',
    headers: {
      ...(c.token ? { 'X-Neuro-Api-Token': c.token } : { 'X-Neuro-Pin': c.pin }),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new Error(payload?.error || `NEURO ${path} returned ${res.status}`);
  }
  return payload;
}

/**
 * Score texts against NEURO's open tasks AND the Microsoft mirror. A read that
 * has to be a POST because the query is a list, not a query string. Changes
 * nothing.
 */
const matchTasks = (texts, { minScore, limit = 3 } = {}) =>
  post('/api/task-dedupe/match', { texts, minScore, limit });

/**
 * Merge a NEURO task with a Microsoft one — the third and last write.
 *
 * This is the "NEURO should merge its task with Planner" half. NEURO owns the
 * merge (`tasks.ms_id`), and once it exists the Planner line stops listing
 * separately and completing either side completes both.
 */
const linkTaskToMicrosoft = (taskId, msId, msSource = null) =>
  post('/api/task-dedupe/link', { taskId, msId, msSource });

/**
 * The manual half of the weekly risk report — the sections NOVA cannot answer.
 *
 * Read separately from the report itself on NEURO's own advice: `/manual` exists
 * so the entry screen can be opened without triggering the report's NOVA round
 * trip. Returns `{ week, manual, blockers }`.
 */
const weeklyRiskManual = (week = null) =>
  call(`/api/weekly-risk/manual${week ? `?week=${encodeURIComponent(week)}` : ''}`);

/**
 * The fourth and last write: put a line on the report's escalation list.
 *
 * A PATCH would be safer and NEURO does not offer one — `setManual` merges the
 * patch over the stored object, so a whole field is replaced wholesale. The
 * caller therefore has to read, append and write back, and this function stays
 * dumb about that on purpose: the appending is a judgement about duplicates and
 * belongs with the finding, not with the transport.
 */
const setWeeklyRiskManual = (patch, week = null) =>
  post('/api/weekly-risk/manual', { ...(week ? { week } : {}), ...patch });

/**
 * The whole todo list, which is the ONLY place the Microsoft mirror is exposed:
 * Planner and To-Do items live as vault lines with an `ms_id` until something
 * links them to a task. Measured 20 Aug 2026: 163 tasks, 27 Microsoft rows, and
 * not one link between them.
 */
const todos = () => call('/api/todos');

/**
 * Create a task in NEURO.
 *
 * Idempotent on NEURO's side: `createTask` keys on normalised text and folds a
 * second sighting into the existing row, returning `created: false`. So a race,
 * a double-click or a plan action worded like something already captured yields
 * a link to the existing task rather than a duplicate — which is the behaviour
 * wanted here, not a fallback.
 */
const createTask = ({ text, moscow, dueDate, notes, originPath, source = 'vantage-plan' }) =>
  post('/api/tasks', {
    text,
    source,
    moscow: moscow || null,
    due_date: dueDate || null,
    notes: notes || null,
    origin_path: originPath || null,
  });

/**
 * What has actually got in the way — NEURO's friction read.
 *
 * The one source in either system for the thing VANTAGE's Patterns screen was
 * built to hold: repeated deferrals with the reason Nick gave, tasks he has
 * made smaller more than once, a session parked as too big, recorded
 * step-aways. All of it evidence he produced himself, none of it inferred from
 * silence — which is why it can be shown next to his own notes without becoming
 * a second opinion about him.
 *
 * Read-only there and read-only here. `/api/friction/note` (dismissing a line)
 * is deliberately NOT wrapped: taking an observation on board is something Nick
 * does where the observation lives.
 */
const friction = () => call('/api/friction');

/**
 * The wins ledger — completion DETECTED, not self-reported.
 *
 * VANTAGE measures "what moved" from its own findings and plan, which is a
 * fraction of the work. NEURO derives it from six sources and carries the gaps
 * it knows it has, so this is the honest half of a report that would otherwise
 * only ever show the outstanding column.
 */
const wins = () => call('/api/wins');

/** People issues: overdue 1:1s, missing notes, probation and improvement windows. */
const teamHealth = () => call('/api/team-health?severity=all');

/**
 * Action items scraped out of vault notes — the checkboxes in meeting notes.
 *
 * This is the "commitments made in meetings that were never actioned" query.
 * Each item carries the `file` it came from, so a stale commitment can be traced
 * back to the conversation that produced it.
 */
const vaultActions = (daysBack = 90) => call(`/api/vault-actions?status=open&daysBack=${daysBack}`);

/** Things Nick is waiting on other people for — the ones that have gone quiet. */
const waitingOn = () => call('/api/waiting-on?status=open');

/** Nick's own task position. Overdue is computed here; NEURO has no filter for it. */
const tasks = () => call('/api/tasks?status=open');

/**
 * Every task including completed ones. NEURO has no GET /api/tasks/:id, so a
 * linked task's live state is read by indexing this by id — and a plan action
 * whose task has been DONE is the whole point, so `status=open` cannot answer it.
 */
const allTasks = () => call('/api/tasks?status=all');

/**
 * Recent meeting notes, read from the vault.
 *
 * NEURO has no endpoint that lists meetings with their content — the service
 * that does it (`meeting-notes-source`) is internal to task-blocks and wins. So
 * this lists the directory and reads the newest files directly.
 *
 * Filenames are date-prefixed (`2026-08-18 – One-on-One …`), which is the only
 * date filter available: `/api/vault/list` returns names and types, not mtimes.
 * Sorting by filename therefore sorts by meeting date, which is what is wanted
 * anyway — a note edited last week about a meeting in June is still June's.
 */
async function recentMeetings(limit = 6) {
  const listing = await call(`/api/vault/list?dir=${encodeURIComponent(MEETINGS_DIR)}`);
  const entries = listing.files || listing.data?.files || [];

  // The vault nests meetings by year/month, so walk one level where needed.
  const files = [];
  for (const entry of entries) {
    if (entry.type === 'file' && entry.name.endsWith('.md')) {
      files.push(`${MEETINGS_DIR}/${entry.name}`);
    } else if (entry.type === 'dir' || entry.type === 'directory') {
      try {
        const year = await call(`/api/vault/list?dir=${encodeURIComponent(`${MEETINGS_DIR}/${entry.name}`)}`);
        for (const sub of (year.files || year.data?.files || [])) {
          if (sub.type === 'file' && sub.name.endsWith('.md')) {
            files.push(`${MEETINGS_DIR}/${entry.name}/${sub.name}`);
          } else if (sub.type === 'dir' || sub.type === 'directory') {
            const month = await call(`/api/vault/list?dir=${encodeURIComponent(`${MEETINGS_DIR}/${entry.name}/${sub.name}`)}`);
            for (const leaf of (month.files || month.data?.files || [])) {
              if (leaf.type === 'file' && leaf.name.endsWith('.md')) {
                files.push(`${MEETINGS_DIR}/${entry.name}/${sub.name}/${leaf.name}`);
              }
            }
          }
        }
      } catch { /* one unreadable folder must not lose the rest */ }
    }
  }

  // Newest first by the date in the filename, and only files that HAVE a date.
  //
  // The first run surfaced a note called "Meetings" and one from April, because
  // the listing includes undated notes and they sort arbitrarily. A meeting
  // radar reading a five-month-old agenda is worse than reading five meetings.
  const newest = files
    .filter(p => /\d{4}-\d{2}-\d{2}/.test(p.split('/').pop()))
    .sort((a, b) => b.split('/').pop().localeCompare(a.split('/').pop()))
    .slice(0, limit);

  const notes = [];
  for (const path of newest) {
    try {
      const doc = await call(`/api/vault/read?path=${encodeURIComponent(path)}`);
      const content = doc.content || doc.data?.content || '';
      notes.push({
        path,
        title: path.split('/').pop().replace(/\.md$/, ''),
        // Capped: six meetings of full transcript would dominate the model's
        // context and push the ticket signals out of it.
        content: content.slice(0, 6000),
        truncated: content.length > 6000,
      });
    } catch { /* skip the unreadable one, keep the rest */ }
  }
  return notes;
}

/**
 * Booked 1:1s, from each person's vault note frontmatter (`1-2-1-booked`).
 *
 * This is the ground truth the meeting analyser needs. It exists in NEURO
 * already — the person card shows "Booked 2026-08-25" — but nothing was reading
 * it, so the analyser inferred scheduling from transcripts and got it wrong.
 *
 * Best-effort per person: one unreadable note must not cost the whole schedule.
 */
async function bookedOneToOnes() {
  const roster = await call('/api/team-health/roster');
  const people = (roster.people || roster.data?.people || []).map(p => p.name).filter(Boolean);

  const out = [];
  for (const person of people) {
    try {
      const detail = await call(`/api/person/${encodeURIComponent(person)}`);
      const fm = detail?.vaultNote?.frontmatter || detail?.data?.vaultNote?.frontmatter || {};
      const booked = fm['1-2-1-booked'];
      if (booked) out.push({ person, booked: String(booked).slice(0, 10), cadence: fm.cadence || null });
    } catch { /* skip */ }
  }
  return out;
}

/**
 * How often each 1:1 has been RESCHEDULED.
 *
 * The most directly coachable signal in the estate, and nothing was reading it.
 * A held 1:1 says the cadence works. A 1:1 that has moved four times says
 * something quite different about what gets displaced when the week gets busy —
 * and it is invisible in every other measure, because the meeting did
 * eventually happen.
 */
async function oneToOneMoves() {
  const roster = await call('/api/team-health/roster');
  const people = (roster.people || roster.data?.people || []).map(p => p.name).filter(Boolean);

  const out = [];
  for (const person of people) {
    try {
      const r = await call(`/api/1to1/moves/${encodeURIComponent(person)}`);
      const moveCount = r.moveCount ?? r.data?.moveCount ?? 0;
      if (moveCount > 0) out.push({ person, moveCount, moves: r.moves || r.data?.moves || [] });
    } catch { /* one unreadable person must not lose the rest */ }
  }
  return out.sort((a, b) => b.moveCount - a.moveCount);
}

/** NEURO's own assessment of what is wrong across the system. */
const stateOfPlay = () => call('/api/state-of-play');

/** Knowledge the team keeps asking for and the KB does not answer. */
const knowledgeGaps = (daysBack = 90) => call(`/api/knowledge-gaps?daysBack=${daysBack}`);

module.exports = {
  weeklyRiskManual, setWeeklyRiskManual,
  isConfigured, call, teamHealth, vaultActions, waitingOn, tasks, allTasks,
  recentMeetings, bookedOneToOnes, oneToOneMoves, stateOfPlay, knowledgeGaps,
  friction, wins,
  matchTasks, createTask, linkTaskToMicrosoft, todos,
};
