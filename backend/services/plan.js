'use strict';

/**
 * The Support Improvement Plan, read from the vault.
 *
 * ⚠ VANTAGE no longer holds the plan. Until 23 Sep 2026 it hardcoded the
 * Support Review's 35 actions and kept their status in its own store, which
 * made it a third tracker beside the vault and the Planner board — and it
 * disagreed with both: T1 read "done" here while the board had it open, and
 * the one task link it held pointed T3 at what was really Q9's briefing.
 *
 * The plan is now a vault project, `Projects/Support Improvement Plan`, and the
 * ACTION REGISTER there is the source of truth: every action, its source (Mel's
 * review, the Planner board, NEURO/NOVA, best practice), its owner and its
 * Planner status. Delivery happens on the Planner board "Support - Improvement
 * Plan", and NEURO shows each board task Nick is assigned (decision D11: items
 * reach NEURO by being put on the board, never by being created in NEURO — so
 * VANTAGE creates nothing here either).
 *
 * VANTAGE's job is therefore the one thing none of the three does alone:
 * read the register, hold it up against the board, and say where they
 * disagree. It renders the VAULT's status and never overrides it — a board
 * that says "done" where the vault says "added" is shown as DRIFT for Nick to
 * settle in the vault, because silently preferring one side is how the
 * previous tracker came to be wrong.
 *
 * ⚠ The board feed is `/me/planner/tasks`: it shows only tasks ASSIGNED TO
 * NICK. A register row with no matching board task is "not visible", never
 * "not on the board" — Stephen's, Nathan's and Mel's tasks are there and this
 * cannot see them.
 */

const db = require('../db');
const neuro = require('./neuro');

const REGISTER_PATH = 'Projects/Support Improvement Plan/SIP - Action Register.md';

/**
 * The board's Planner plan id. Graph returns a planId on each task and no plan
 * name, so the board is identified by id. Read live 23 Sep 2026.
 */
const PLANNER_PLAN_ID = process.env.SIP_PLANNER_PLAN_ID || 'xUF84iaFcECLqQ4NbH6FnJcACg-c';

/** The register's status key — see the project note. */
const STATUSES = ['Done', 'Added', 'To be added', 'Not adding'];

/** Source groups, in the order the register sections introduce them. */
const GROUPS = {
  review: 'Support Review',
  planner: 'Planner, not in the review',
  'neuro-nova': 'NEURO / NOVA',
  'best-practice': 'Best practice',
};

const CACHE_MS = 10 * 60 * 1000;

/** The 13 measures, with whether VANTAGE can currently measure them. VANTAGE's own judgement, not the register's. */
const MEASURES = [
  { id: 'M1', text: 'Aged/blocked tickets with no named case owner', measurable: true },
  { id: 'M2', text: 'Tickets recreated across Jira spaces', measurable: false },
  { id: 'M3', text: 'Tickets returned without clear guidance', measurable: true },
  { id: 'M4', text: 'Handbacks, queue moves, repeat customer chases', measurable: true },
  { id: 'M5', text: 'Average time in queue/status', measurable: false },
  { id: 'M6', text: 'Non-customer-actionable tickets reaching Customer Care', measurable: false },
  { id: 'M7', text: 'Troubleshooting guides and playbooks created', measurable: false },
  { id: 'M8', text: 'Nova deflection and resolution rate', measurable: true },
  { id: 'M9', text: 'Releases completing readiness checks', measurable: false },
  { id: 'M10', text: 'Update quality: owner, next action, next update date', measurable: false },
  { id: 'M11', text: 'Team feedback on workload, cadence and support', measurable: false },
  { id: 'M12', text: 'Staffing, skills and product complexity aligned', measurable: false },
  { id: 'M13', text: 'Dependency on individual knowledge holders reduced', measurable: false },
];

// ── Parsing (pure) ───────────────────────────────────────────────────────────

/** `[[Stephen Mitchell]]` → `Stephen Mitchell`, `[[a|b]]` → `b`. */
const unlink = s => s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a).trim();

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function groupOf(source) {
  if (/^Mel review/i.test(source)) return 'review';
  if (/^Planner/i.test(source)) return 'planner';
  if (/best practice/i.test(source)) return 'best-practice';
  return 'neuro-nova';
}

/**
 * Whose it is. "Nick" or "Nick with HR" is his; "Director ... with Nick" is
 * shared; "Per Planner" is a row that has not said, and is not guessed.
 */
function ownershipOf(owner) {
  if (/^nick\b/i.test(owner)) return 'mine';
  if (/\bnick\b/i.test(owner)) return 'shared';
  if (!owner || /^per planner$/i.test(owner)) return 'unknown';
  return 'other';
}

/**
 * Every action row in the register. Tables are read by HEADER NAME, not
 * position, so a column added in the vault (Planner ID, say) does not shift
 * the rest. Anything that looks like an action but does not parse cleanly is
 * reported in `problems` rather than dropped.
 */
function parseRegister(markdown) {
  const actions = [];
  const problems = [];
  const sections = [];
  let section = null;
  let header = null;

  for (const line of String(markdown).split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1]; header = null; continue; }
    if (!line.trim().startsWith('|')) { header = null; continue; }

    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    if (!header.includes('id')) continue;

    const col = name => {
      const i = header.indexOf(name);
      return i < 0 ? '' : unlink(cells[i] || '');
    };
    const id = col('id');
    if (!/^[A-Z]\d+$/.test(id)) continue;

    if (!sections.includes(section)) sections.push(section);
    const source = col('source');
    const status = col('planner status');
    const notes = col('notes');
    const owner = col('owner');

    if (!STATUSES.includes(status)) problems.push(`${id}: planner status "${status}" is not one of ${STATUSES.join(', ')}`);
    if (actions.some(a => a.id === id)) problems.push(`${id} appears more than once`);

    actions.push({
      id,
      section,
      action: col('action'),
      source,
      group: groupOf(source),
      owner,
      ownership: ownershipOf(owner),
      status,
      due: col('due'),
      notes,
      plannerIds: col('planner id').split(/[\s,;]+/).filter(Boolean),
      // `Planner: "title"` in the notes is how the register names a board task
      // today. A fallback only: board titles get edited, IDs do not.
      plannerTitles: [...notes.matchAll(/Planner(?: backlog)?:\s*"([^"]+)"/g)].map(m => m[1]),
      sameAs: (notes.match(/Same Planner task as ([A-Z]\d+)/) || [])[1] || null,
    });
  }

  return { actions, sections, problems };
}

// ── Cross-check (pure) ───────────────────────────────────────────────────────

/** Graph's task shape → the few fields that matter. Filtered to the board. */
function boardFrom(payload, planId = PLANNER_PLAN_ID) {
  const rows = payload?.tasks || payload?.data?.tasks || payload?.value || [];
  return rows
    .filter(t => t.planId === planId)
    .map(t => ({
      id: t.id,
      title: t.title,
      percent: t.percentComplete ?? 0,
      due: t.dueDateTime ? t.dueDateTime.slice(0, 10) : null,
      completed: t.completedDateTime ? t.completedDateTime.slice(0, 10) : null,
    }));
}

/** `2026-09-25` → `25/09`, the register's format. */
const ddmm = iso => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : null);

/**
 * Hold the register up against the board and NEURO.
 *
 * `board` null means the board could not be read and `neuroMsIds` null means
 * NEURO could not — both then yield null fields, never "not on the board" or
 * "not in NEURO".
 */
function crossCheck(actions, board, neuroMsIds) {
  const byId = new Map((board || []).map(t => [t.id, t]));
  const byTitle = new Map((board || []).map(t => [norm(t.title), t]));
  const claimed = new Set();

  const linked = actions.map(a => {
    if (!board) return { ...a, planner: null, drift: [], inNeuro: null };
    const found = [];
    for (const id of a.plannerIds) if (byId.has(id)) found.push(byId.get(id));
    if (!a.plannerIds.length) {
      for (const title of [...a.plannerTitles, a.action]) {
        const t = byTitle.get(norm(title));
        if (t && !found.includes(t)) found.push(t);
      }
    }
    return { ...a, planner: found, unknownIds: a.plannerIds.filter(id => !byId.has(id)) };
  });

  // "Same Planner task as Q8" — resolved after the first pass, so order in the
  // note does not matter.
  for (const a of linked) {
    if (a.planner && !a.planner.length && a.sameAs) {
      const other = linked.find(o => o.id === a.sameAs);
      if (other?.planner) a.planner = other.planner;
    }
  }

  for (const a of linked) {
    if (!a.planner) continue;
    a.planner.forEach(t => claimed.add(t.id));
    a.drift = driftOf(a);
    a.inNeuro = neuroMsIds && a.planner.length
      ? a.planner.filter(t => !t.completed).every(t => neuroMsIds.has(t.id))
      : null;
  }

  const unregistered = board ? board.filter(t => !claimed.has(t.id)) : null;
  return { actions: linked, unregistered };
}

/** Where the vault and the board disagree. The vault is not overridden; this is for Nick to settle. */
function driftOf(a) {
  const out = [];
  const tasks = a.planner;
  if (!tasks.length) return out;

  const allDone = tasks.every(t => t.completed);
  const open = tasks.filter(t => !t.completed);

  if (allDone && a.status !== 'Done') {
    out.push(`Done on the board (${ddmm(tasks.map(t => t.completed).sort().pop())}), "${a.status}" in the vault`);
  }
  if (a.status === 'Done' && open.length) {
    out.push(`Done in the vault, ${open.map(t => `${t.percent}%`).join(' / ')} on the board`);
  }
  if (['To be added', 'Not adding'].includes(a.status)) {
    out.push(`On the board, "${a.status}" in the vault`);
  }

  // Dates, only for work still open — a finished task's due date is history.
  if (a.status !== 'Done' && open.length === 1 && open[0].due) {
    const board = ddmm(open[0].due);
    if (/^\d{2}\/\d{2}$/.test(a.due) && a.due !== board) out.push(`Due ${a.due} in the vault, ${board} on the board`);
    else if (!/\d{2}\/\d{2}/.test(a.due)) out.push(`Due ${board} on the board, "${a.due || 'blank'}" in the vault`);
  }
  for (const id of a.unknownIds || []) out.push(`Planner ID ${id} is not among your board tasks`);
  return out;
}

/** The numbers, from the rows. */
function summarise(actions, unregistered) {
  const count = (rows, key) => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] || 0) + 1 }), {});
  const mine = actions.filter(a => a.ownership === 'mine');
  return {
    total: actions.length,
    byStatus: count(actions, 'status'),
    byGroup: count(actions, 'group'),
    mine: {
      total: mine.length,
      done: mine.filter(a => a.status === 'Done').length,
      onBoard: mine.filter(a => a.status === 'Added').length,
      toBeAdded: mine.filter(a => a.status === 'To be added').length,
    },
    drift: actions.filter(a => a.drift?.length).length,
    unregistered: unregistered ? unregistered.length : null,
  };
}

// ── Live read ────────────────────────────────────────────────────────────────

const COLLECTION = 'plan_register';

function cached() {
  return db.findOne(COLLECTION, () => true);
}

/**
 * Read the vault, the board and NEURO, and store the result.
 *
 * The register is required and THROWS: a plan that could not be read must
 * never render as an empty one. The board and NEURO degrade on their own,
 * each carrying its reason.
 */
async function refresh() {
  const doc = await neuro.call(`/api/vault/read?path=${encodeURIComponent(REGISTER_PATH)}`);
  const content = doc.content || doc.data?.content || '';
  const register = parseRegister(content);
  // Positive control: a note that parses to nothing is a broken read or a
  // reshaped note, not a plan with no actions.
  if (!register.actions.length) throw new Error(`${REGISTER_PATH} parsed to no actions — the note is missing or its tables have changed shape`);

  let board = null;
  let boardError = null;
  try { board = boardFrom(await neuro.call('/api/microsoft/planner/tasks')); } catch (e) { boardError = e.message; }

  let neuroMsIds = null;
  let neuroError = null;
  try {
    const t = await neuro.todos();
    neuroMsIds = new Set((t.todos || t.data?.todos || []).map(r => r.ms_id).filter(Boolean));
  } catch (e) { neuroError = e.message; }

  const { actions, unregistered } = crossCheck(register.actions, board, neuroMsIds);
  const snapshot = {
    readAt: new Date().toISOString(),
    path: REGISTER_PATH,
    sections: register.sections,
    problems: register.problems,
    actions,
    unregistered,
    board: { available: Boolean(board), reason: boardError, total: board ? board.length : null },
    neuro: { available: Boolean(neuroMsIds), reason: neuroError },
    summary: summarise(actions, unregistered),
  };

  const row = cached();
  if (row) db.update(COLLECTION, row.id, snapshot);
  else db.insert(COLLECTION, snapshot);
  return snapshot;
}

/**
 * The plan for the screen. Re-read at most every ten minutes; a failed read
 * falls back to the last good one and SAYS it is stale, and with no good read
 * ever it says the plan is unavailable rather than showing nothing.
 */
async function list({ force = false } = {}) {
  const row = cached();
  const fresh = row && Date.now() - Date.parse(row.readAt) < CACHE_MS;
  let snapshot = row;
  let stale = null;

  if (force || !fresh) {
    try { snapshot = await refresh(); } catch (e) {
      if (!row) return { available: false, reason: e.message, path: REGISTER_PATH };
      stale = e.message;
    }
  }
  const { id, ...rest } = snapshot;
  return { available: true, stale, groups: GROUPS, statuses: STATUSES, measures: MEASURES, measurable: MEASURES.filter(m => m.measurable).length, ...rest };
}

/**
 * The last good read, synchronously, for the standing bar and the brief —
 * which must not wait on the network. Null when the plan has never been read:
 * absent, never "none of yours are done".
 */
function lastRead() {
  const row = cached();
  if (!row) return null;
  return { readAt: row.readAt, ...row.summary.mine, drift: row.summary.drift };
}

module.exports = {
  list, refresh, lastRead,
  parseRegister, crossCheck, boardFrom, summarise,
  REGISTER_PATH, PLANNER_PLAN_ID, STATUSES, GROUPS, MEASURES,
};
