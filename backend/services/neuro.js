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
 * Read-only by construction. Every call here is a GET, and the endpoints that
 * write or send (weekly-risk publish, queue-send, plaud sync) are deliberately
 * not wrapped — one shared token unlocks NEURO's entire API including deletes,
 * so the discipline has to live on this side.
 *
 * `/api/weekly-risk` is also deliberately NOT used: it triggers a NOVA round
 * trip of its own, and VANTAGE already reads NOVA directly. Calling it would
 * double the load on a DTU-limited database to fetch numbers we have.
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
  isConfigured, call, teamHealth, vaultActions, waitingOn, tasks,
  recentMeetings, bookedOneToOnes, oneToOneMoves, stateOfPlay, knowledgeGaps,
};
