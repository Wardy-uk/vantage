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

function config() {
  return {
    url: (process.env.NEURO_URL || 'http://127.0.0.1:3001').replace(/\/$/, ''),
    token: process.env.NEURO_API_TOKEN || '',
  };
}

function isConfigured() {
  return Boolean(config().token);
}

async function call(path, { timeoutMs = TIMEOUT_MS } = {}) {
  const c = config();
  if (!c.token) throw new Error('NEURO_API_TOKEN is not set');

  const res = await fetch(`${c.url}${path}`, {
    headers: { 'X-Neuro-Api-Token': c.token },
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

  // Newest first by the date in the filename.
  const newest = files
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

module.exports = { isConfigured, call, teamHealth, vaultActions, waitingOn, tasks, recentMeetings };
