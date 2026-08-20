'use strict';

/**
 * The improvement plan, connected to real tasks.
 *
 * The Plan tab was a closed loop: 35 actions with a status dropdown VANTAGE
 * invented and only VANTAGE could see. Meanwhile the same actions already
 * existed as work — some captured in NEURO, some on the MS Planner board Mel
 * set up. Three lists of the same 35 jobs, disagreeing quietly, is worse than
 * one list, and the one that gets worked is never the one in the tool nobody
 * has open.
 *
 * So: **NEURO owns the task, VANTAGE owns the link.** This module holds a map
 * of `planId -> taskId` and nothing else. Status, due date, MoSCoW and
 * completion are read live from NEURO on every call — copying them here would
 * create a fourth list.
 *
 * Planner is not spoken to directly. NEURO already syncs `/me/planner/tasks`
 * into the vault and already has a scorer that merges a Planner item with the
 * NEURO task that means the same thing (`task-dedupe`). Reaching for Graph from
 * here would be a second integration and a second matcher, and the two would
 * disagree in front of the person assessing the PIP.
 *
 * ── The absence rule ────────────────────────────────────────────────────────
 *
 * A plan action with no task attached can mean two completely different things:
 * nothing has been captured for it, or NEURO did not answer. Every payload
 * carries `available`, and an unreachable NEURO renders as unknown — never as a
 * tidy row of "no task yet".
 *
 * Planner has its own version of this. `fetchPlannerTasks()` reads
 * `/me/planner/tasks`, which is *assigned to Nick*, not *everything on Mel's
 * board*. An item sitting in her plan unassigned, or on someone else, is
 * invisible to this whole chain. `plannerScope` says so out loud, because
 * "no Planner task" here does not mean there isn't one.
 */

const db = require('../db');
const neuro = require('./neuro');
const plan = require('./plan');
const planMatch = require('./plan-match');

/** Stamped into tasks VANTAGE creates, so the link survives losing this store. */
const ORIGIN_PREFIX = 'vantage://plan/';

const originPath = planId => `${ORIGIN_PREFIX}${planId}`;
const planIdFromOrigin = path =>
  typeof path === 'string' && path.startsWith(ORIGIN_PREFIX) ? path.slice(ORIGIN_PREFIX.length) : null;

const PLANNER_SCOPE =
  'Planner shows only items assigned to you. Anything on Mel’s board that is '
  + 'unassigned or owned by someone else will not appear here.';

// ── The link map ─────────────────────────────────────────────────────────────

function linkRow() {
  return db.findOne('plan_tasks', () => true);
}

function links() {
  return linkRow()?.links || {};
}

function saveLinks(next) {
  const row = linkRow();
  if (row) db.update('plan_tasks', row.id, { links: next });
  else db.insert('plan_tasks', { links: next });
  return next;
}

function setLink(planId, taskId, via) {
  if (!plan.PLAN.some(p => p.id === planId)) throw new Error(`Unknown plan item "${planId}"`);
  const id = Number(taskId);
  if (!Number.isInteger(id)) throw new Error('taskId must be a NEURO task id');

  // One task cannot back two plan actions. The second link would show an action
  // as moving on the strength of work done for a different one.
  const current = links();
  const clash = Object.entries(current).find(([pid, l]) => l.taskId === id && pid !== planId);
  if (clash) throw new Error(`That task is already linked to plan item ${clash[0]}`);

  return saveLinks({ ...current, [planId]: { taskId: id, via, linkedAt: new Date().toISOString() } });
}

function clearLink(planId) {
  const next = { ...links() };
  delete next[planId];
  return saveLinks(next);
}

// ── Reading the truth back ───────────────────────────────────────────────────

/** The bits of a NEURO task this tool has any business showing. */
function present(task) {
  if (!task) return null;
  return {
    id: task.id,
    text: task.text,
    status: task.status,
    done: task.status === 'done',
    dueDate: task.due_date || null,
    moscow: task.moscow || null,
    source: task.source || null,
    // `ms_id` present means NEURO has merged this task with a Microsoft item —
    // Planner or To-Do. That is the "it's on Mel's board too" signal.
    microsoft: task.ms_id ? { id: task.ms_id, source: task.ms_source || 'Microsoft' } : null,
  };
}

/**
 * The Microsoft mirror — Planner and To-Do items NEURO has synced but not yet
 * merged with any task. These are vault lines, not task rows, which is why they
 * come from `/api/todos` and not `/api/tasks`.
 *
 * This list is the reason the picker exists. Measured 20 Aug 2026: 27 Microsoft
 * rows, none linked to a task, and several of them plainly Support Review
 * actions ("Re-instate reglar 121s with team", "Brief TPJ and Dev teams on
 * mandatory escalation standard for every handoff"). Word-overlap scoring does
 * not find those — the review's wording and Nick's shorthand share almost no
 * vocabulary — so a human picking from the real list is not a fallback here, it
 * is the primary path.
 */
function microsoftRows(todos) {
  return todos
    .filter(t => t.ms_id && /^MS /.test(t.source || '') && !t.done)
    .map(t => ({ msId: t.ms_id, text: t.text, dueDate: t.due_date || null, source: t.source }));
}

/**
 * Everything the Plan tab needs to render the task column.
 *
 * Three NEURO round trips: tasks, the Microsoft mirror, and the matching.
 * Suggestions are only requested for actions that have no link yet — scoring 35
 * texts against the whole store on every page load, most of them already
 * answered, is work nobody reads.
 */
async function overview({ suggest = true, match = true, rematch = false } = {}) {
  const saved = links();

  if (!neuro.isConfigured()) {
    return { available: false, reason: 'No NEURO credential is set', links: saved, items: {}, plannerScope: PLANNER_SCOPE };
  }

  let rows;
  try {
    const payload = await neuro.allTasks();
    rows = payload.tasks || payload.data?.tasks || [];
  } catch (err) {
    return { available: false, reason: `NEURO did not answer: ${err.message}`, links: saved, items: {}, plannerScope: PLANNER_SCOPE };
  }

  const byId = new Map(rows.map(t => [t.id, t]));

  // The Microsoft half is fetched separately and is allowed to fail on its own.
  // If it does, the picker says Planner is unavailable rather than showing an
  // empty Planner section, which would read as "nothing on the board".
  let microsoft = [];
  let microsoftAvailable = true;
  let microsoftReason = null;
  try {
    const payload = await neuro.todos();
    microsoft = microsoftRows(payload.todos || payload.data?.todos || []);
  } catch (err) {
    microsoftAvailable = false;
    microsoftReason = err.message;
  }

  // Links recovered from the tasks themselves. If this store were ever lost or
  // rebuilt, the tasks VANTAGE created still say which action they came from,
  // and adopting them back is better than silently showing 35 empty columns.
  const adopted = {};
  for (const t of rows) {
    const pid = planIdFromOrigin(t.origin_path);
    if (pid && !saved[pid] && plan.PLAN.some(p => p.id === pid)) {
      adopted[pid] = { taskId: t.id, via: 'origin', linkedAt: t.created_at || null };
    }
  }
  const effective = { ...adopted, ...saved };
  if (Object.keys(adopted).length) saveLinks(effective);

  const items = {};
  for (const p of plan.PLAN) {
    const link = effective[p.id];
    const task = link ? byId.get(link.taskId) : null;
    items[p.id] = {
      link: link || null,
      task: present(task),
      // Linked to a task that no longer exists — deleted in NEURO, or a store
      // restored from a different database. Say so; do not quietly unlink, which
      // would look identical to never having linked it.
      missing: Boolean(link && !task),
      suggestions: [],
    };
  }

  if (suggest) {
    const unlinked = plan.PLAN.filter(p => !effective[p.id]);
    if (unlinked.length) {
      try {
        const res = await neuro.matchTasks(unlinked.map(p => ({ id: p.id, text: p.title })));
        const linkedIds = new Set(Object.values(effective).map(l => l.taskId));
        for (const r of res.results || []) {
          if (!items[r.id]) continue;
          // A task already backing another action is not a suggestion for this one.
          items[r.id].suggestions = (r.matches || []).filter(m => !linkedIds.has(m.task.id));
        }
      } catch (err) {
        // Matching failing must not take the links down with it — the links are
        // the load-bearing half. Flagged, not swallowed.
        return { available: true, suggestionsAvailable: false, suggestionsReason: err.message, links: effective, items, plannerScope: PLANNER_SCOPE, taskCount: rows.length };
      }
    }
  }

  // The semantic pass, over the same catalogue the picker offers. Cached, so a
  // page load does not cost a model call; `rematch` forces it.
  const cat = catalogue(rows, microsoft, effective);
  const unlinkedIds = plan.PLAN.filter(p => !effective[p.id]).map(p => p.id);
  let proposals = { available: false, reason: 'not requested', pairs: {} };
  if (match && unlinkedIds.length) {
    try {
      // Asked about ALL 35, not just the unlinked ones, even though only the
      // unlinked ones are rendered. The cache is one key: narrowing the question
      // would mean a later unlink has no proposal until someone thinks to press
      // Re-match, and a proposal that silently is not there is the failure mode
      // this whole file is written around.
      const hit = await planMatch.cached(cat, { force: rematch });
      proposals = { ...hit.value, at: hit.at, stale: hit.stale };
    } catch (err) {
      proposals = { available: false, reason: err.message, pairs: {} };
    }
  }

  for (const [planId, p] of Object.entries(proposals.pairs || {})) {
    if (!items[planId] || items[planId].task) continue;
    const target = p.kind === 'microsoft'
      ? cat.microsoft.find(m => m.msId === p.ref)
      : cat.tasks.find(t => String(t.id) === String(p.ref));
    // The candidate list is a snapshot; a cached proposal can name something
    // since linked or completed. Dropping it beats offering a dead link.
    if (target) items[planId].proposal = { ...p, target };
  }

  return {
    available: true,
    suggestionsAvailable: suggest,
    proposals: {
      available: proposals.available,
      reason: proposals.reason || null,
      at: proposals.at || null,
      stale: Boolean(proposals.stale),
      model: proposals.model || null,
      dropped: proposals.dropped ?? null,
    },
    links: effective,
    items,
    taskCount: rows.length,
    plannerScope: PLANNER_SCOPE,
    microsoftAvailable,
    microsoftReason,
    // What the picker offers. Both populations, already filtered to what is
    // still attachable — a task backing another action is not on the menu.
    catalogue: cat,
    counts: {
      linked: Object.keys(effective).length,
      total: plan.PLAN.length,
      microsoft: microsoftAvailable ? microsoft.length : null,
      // Actions whose task is done but whose plan status is not. He under-registers
      // completion; this is the gap between having done it and having said so.
      doneInNeuro: Object.values(items).filter(i => i.task?.done).length,
    },
  };
}

/** The attachable universe, for the picker. */
function catalogue(rows, microsoft, effective) {
  const taken = new Set(Object.values(effective).map(l => l.taskId));
  const linkedMs = new Set(rows.map(t => t.ms_id).filter(Boolean));
  return {
    tasks: rows
      .filter(t => t.status !== 'done' && !taken.has(t.id))
      .map(t => ({ id: t.id, text: t.text, dueDate: t.due_date || null, source: t.source || null,
        microsoft: t.ms_id ? { id: t.ms_id, source: t.ms_source || 'Microsoft' } : null })),
    // A Planner line already merged into a task is offered as that task, once.
    microsoft: microsoft.filter(m => !linkedMs.has(m.msId)),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Adopt an existing NEURO task as the delivery of a plan action. */
async function link(planId, taskId) {
  setLink(planId, taskId, 'matched');
  return overview();
}

async function unlink(planId) {
  clearLink(planId);
  return overview();
}

/**
 * Create the task in NEURO for an action that has none, and link it.
 *
 * The starting-from-nothing part is done here: the text is the action as the
 * Support Review wrote it, and the note carries the horizon and the plan id so
 * the task is self-explanatory in NEURO three weeks later, opened on a phone,
 * with no memory of this screen.
 *
 * NEURO's createTask folds duplicates by normalised text, so if the action was
 * already captured under this wording the result is a link to that task and
 * `created: false` — not a second copy.
 */
async function createFor(planId, { dueDate, moscow } = {}) {
  const item = plan.PLAN.find(p => p.id === planId);
  if (!item) throw new Error(`Unknown plan item "${planId}"`);
  if (links()[planId]) throw new Error(`${planId} is already linked to a task`);

  const res = await neuro.createTask({
    text: item.title,
    dueDate,
    moscow,
    originPath: originPath(planId),
    notes: `Support Review improvement plan — ${plan.HORIZONS[item.horizon]} (${planId})`,
  });

  const taskId = res.id ?? res.task?.id ?? res.data?.id;
  if (!taskId) throw new Error('NEURO created the task but returned no id');

  setLink(planId, taskId, res.created === false ? 'existing' : 'created');
  return { created: res.created !== false, taskId, ...(await overview()) };
}

/**
 * Attach a Planner or To-Do item to a plan action.
 *
 * Nick's rule: the task is held in NEURO and merged with Planner where a Planner
 * task exists. A Microsoft item on its own is not a NEURO task — it is a vault
 * line — so this does both halves in order:
 *
 *   1. create the task in NEURO, worded as the Planner item is worded, so the
 *      two are recognisably the same thing on both boards;
 *   2. ask NEURO to merge them (`ms_id`), after which the Planner line stops
 *      listing separately and completing either side completes both.
 *
 * If the merge fails the task still exists and is still linked to the action —
 * so the failure is reported rather than swallowed, but nothing is lost and a
 * retry does not duplicate (createTask folds on text).
 */
async function adoptMicrosoft(planId, { msId, msSource, text } = {}) {
  const item = plan.PLAN.find(p => p.id === planId);
  if (!item) throw new Error(`Unknown plan item "${planId}"`);
  if (!msId || !text) throw new Error('msId and text are required');
  if (links()[planId]) throw new Error(`${planId} is already linked to a task`);

  const res = await neuro.createTask({
    text,
    originPath: originPath(planId),
    notes: `Support Review improvement plan — ${plan.HORIZONS[item.horizon]} (${planId})`,
  });
  const taskId = res.id ?? res.task?.id ?? res.data?.id;
  if (!taskId) throw new Error('NEURO created the task but returned no id');
  setLink(planId, taskId, 'planner');

  let merged = true;
  let mergeReason = null;
  try {
    const link = await neuro.linkTaskToMicrosoft(taskId, msId, msSource);
    if (link.ok === false) { merged = false; mergeReason = link.reason || 'NEURO refused the merge'; }
  } catch (err) {
    merged = false;
    mergeReason = err.message;
  }

  return { taskId, merged, mergeReason, ...(await overview()) };
}

module.exports = {
  overview, link, unlink, createFor, adoptMicrosoft,
  links, originPath, planIdFromOrigin, PLANNER_SCOPE,
};
