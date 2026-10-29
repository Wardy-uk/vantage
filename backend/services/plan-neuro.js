'use strict';

/**
 * A plan's tasks move to NEURO, and VANTAGE becomes a live view (29 Oct 2026).
 *
 * Nick: "once I've sorted the plan, tasks should only ever live in NEURO —
 * importing them into VANTAGE should create them in NEURO." His answers:
 *
 *   - only HIS open tasks go (and, for an import or a Planner board, rows with
 *     no owner stated — it is his plan). Others' stay in the frozen register and
 *     are shown read-only, never dropped from sight.
 *   - they arrive as CONTINUAL IMPROVEMENT with their register dates (this year)
 *   - priority becomes NEURO's: a star → MoSCoW "must"; the register rank → the
 *     task's place in its NEURO band, written ONCE at hand-off
 *   - a SIP row NEURO already mirrors from the Planner board is LINKED to it
 *     (`ms:<id>`), never created a second time
 *   - the register is stamped `moved-to-neuro: <date>` and becomes history; its
 *     `NEURO ID` column is the map from row to NEURO task. After hand-off only
 *     its `plan-rank` line is ever written.
 *   - ticking and editing happen in NEURO; Replan moves NEURO's due dates
 *
 * A plan's live tasks = NEURO tasks whose id is in the register's NEURO ID
 * column, plus any NEURO task created from the plan's folder (`origin_path`).
 * The first catches tasks NEURO folded into an existing one with the same text.
 */

const neuro = require('./neuro');
const plan = require('./plan');

const COLUMN = 'NEURO ID';
const NEURO_URL = process.env.NEURO_PUBLIC_APP_URL || 'https://nuero.nickward.co.uk/?view=todos';
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function httpError(message, status) { const e = new Error(message); e.status = status; return e; }

/**
 * Which rows go, and how. Pure. Repeated wordings get the plan and row ID
 * appended, because NEURO folds identical text into ONE task — the 90 Day Plan
 * has "Weekly reflection." more than ten times, and they are separate tasks.
 */
function prepareHandoff(rows, { myBoardIds, includeUnstated = false, planName, ddmmToIso }) {
  const goes = rows.filter(a =>
    (a.statusKey === 'todo' || a.statusKey === 'doing') && !a.neuroId
    && (a.ownership === 'mine' || (includeUnstated && a.ownership === 'unknown')));
  const counts = goes.reduce((m, a) => m.set(norm(a.action), (m.get(norm(a.action)) || 0) + 1), new Map());
  return goes.map(a => {
    const onBoard = a.plannerIds.find(id => myBoardIds.has(id));
    if (onBoard) return { row: a, link: `ms:${onBoard}` };
    const dup = counts.get(norm(a.action)) > 1;
    return {
      row: a,
      create: {
        text: dup ? `${a.action} (${planName} ${a.id})` : a.action,
        moscow: a.starred ? 'must' : null,
        dueDate: ddmmToIso(a.due),
      },
    };
  });
}

/** The plan's rank order, for NEURO's bands. Pure. */
const byRank = (a, b) => ((a.rank ?? Infinity) - (b.rank ?? Infinity)) || (a.order - b.order);

/** What a hand-off would do, without doing it. */
async function previewHandoff(id, { includeUnstated = false } = {}) {
  const plans = require('./plans');
  const r = await plans._readRegister(id);
  if (plans.parseFrontmatter(r.content).data['moved-to-neuro']) throw httpError(`${r.name} was already handed to NEURO`, 409);
  const rows = plan.parseRegister(r.content).actions;
  const myBoardIds = await boardIds(r);
  const items = prepareHandoff(rows, { myBoardIds, includeUnstated, planName: r.name, ddmmToIso: plans.ddmmToIso });
  const staying = rows.filter(a => (a.statusKey === 'todo' || a.statusKey === 'doing') && !items.some(i => i.row.id === a.id));
  return {
    planId: id, name: r.name, version: plans.versionOf(r.content),
    create: items.filter(i => i.create).length,
    link: items.filter(i => i.link).length,
    must: items.filter(i => i.create?.moscow === 'must').length,
    renamed: items.filter(i => i.create && i.create.text !== i.row.action).map(i => i.create.text),
    othersOpen: staying.map(a => ({ id: a.id, action: a.action, owner: a.owner })),
    closed: rows.length - items.length - staying.length,
  };
}

/** Nick's Planner tasks (id → completed). Refuses for a board-linked plan when unreadable: guessing would duplicate. */
async function boardIds(r) {
  const plans = require('./plans');
  const fm = plans.parseFrontmatter(r.content).data;
  const linked = fm['planner-plan-id'] || r.path === plan.REGISTER_PATH;
  try {
    const b = await neuro.call('/api/microsoft/planner/tasks');
    return new Map((b.tasks || b.data?.tasks || []).map(t => [t.id, { completed: Boolean(t.completedDateTime), title: t.title, due: t.dueDateTime ? t.dueDateTime.slice(0, 10) : null }]));
  } catch (e) {
    if (linked) throw httpError(`The Planner board could not be read (${e.message}) — handing over now would create NEURO copies of tasks NEURO already shows from the board. Try again shortly.`, 503);
    return new Map();
  }
}

/**
 * Hand a plan's tasks to NEURO. Creates are sequential; NEURO's create folds on
 * text, so a hand-off that fails part-way can simply be pressed again — the
 * same tasks are found, not duplicated. The register is stamped as moved only
 * when every row went.
 */
async function handOff(id, { version, includeUnstated = false } = {}) {
  const plans = require('./plans');
  const r = await plans._readRegister(id);
  if (version && plans.versionOf(r.content) !== version) throw httpError('The register has changed since this screen loaded. Reload and try again — nothing was sent.', 409);
  if (plans.parseFrontmatter(r.content).data['moved-to-neuro']) throw httpError(`${r.name} was already handed to NEURO`, 409);
  const rows = plan.parseRegister(r.content).actions;
  const myBoardIds = await boardIds(r);
  const items = prepareHandoff(rows, { myBoardIds, includeUnstated, planName: r.name, ddmmToIso: plans.ddmmToIso });

  const links = new Map();
  const failed = [];
  let created = 0; let folded = 0;
  for (const it of items) {
    if (it.link) { links.set(it.row.id, it.link); continue; }
    try {
      const res = await neuro.createTask({
        ...it.create, origin: 'improvement', source: 'vantage-plan',
        notes: `Plan: ${r.name} · ${it.row.section || ''} · ${it.row.id}`, originPath: r.path,
      });
      const tid = res.id ?? res.task?.id ?? res.data?.id;
      if (!tid) { failed.push(`${it.row.id}: NEURO gave no task id`); continue; }
      links.set(it.row.id, String(tid));
      if (res.created === false) folded += 1; else created += 1;
    } catch (e) { failed.push(`${it.row.id}: ${e.message}`); }
  }

  // Applied to a FRESH read: only NEURO ID cells and one frontmatter line change.
  const fresh = (await plans._readRegister(id)).content;
  let md = plans.setTaskCells(fresh, new Map([...links].map(([rid, v]) => [rid, { [COLUMN]: v }])), [COLUMN]).markdown;
  const moved = failed.length === 0;
  if (moved) md = plans.setFrontmatterKey(md, 'moved-to-neuro', new Date().toISOString().slice(0, 10));
  if (md !== fresh) await neuro.writePlanNote(r.path, md);
  plans._invalidate(r.path);

  // Rank → NEURO's band order, once. Best effort: the tasks are already safe.
  let order = null;
  if (moved && links.size) {
    try {
      const t = await neuro.todos();
      const todos = t.todos || t.data?.todos || [];
      const keyOf = row => (row.task_id ? `task:${row.task_id}` : row.ms_id ? `ms:${row.ms_id}` : null);
      const bandOf = row => (['must', 'should', 'could', 'wont'].includes(row.moscow) ? row.moscow : 'none');
      const planKeys = new Map(items.filter(i => links.has(i.row.id)).sort((a, b) => byRank(a.row, b.row))
        .map((i, n) => [links.get(i.row.id).startsWith('ms:') ? links.get(i.row.id) : `task:${links.get(i.row.id)}`, n]));
      const bands = new Map();
      for (const row of todos) { const k = keyOf(row); if (k) bands.set(bandOf(row), [...(bands.get(bandOf(row)) || []), k]); }
      let written = 0;
      for (const [band, keys] of bands) {
        const mine = keys.filter(k => planKeys.has(k)).sort((a, b) => planKeys.get(a) - planKeys.get(b));
        if (!mine.length) continue;
        await neuro.setBandOrder(band, [...mine, ...keys.filter(k => !planKeys.has(k))]);
        written += 1;
      }
      order = { bands: written };
    } catch (e) { order = { error: e.message }; }
  }
  return { planId: id, created, folded, linked: [...links.values()].filter(v => v.startsWith('ms:')).length, failed, moved, order };
}

/** Status words for a NEURO task. Pure. */
function neuroStatus(t) {
  if (t.status === 'done') return { status: 'Done', statusKey: 'done' };
  if (t.status === 'dropped') return { status: 'Not doing', statusKey: 'dropped' };
  if (t.status === 'in-progress') return { status: 'In progress', statusKey: 'doing' };
  return { status: 'To do', statusKey: 'todo' };
}

/** NEURO's state, read once for every handed-over plan on a screen. */
async function context() {
  const [all, todos, board] = await Promise.all([
    neuro.allTasks(),
    neuro.todos().catch(() => null),
    neuro.call('/api/microsoft/planner/tasks').catch(() => null),
  ]);
  const tasks = new Map((all.tasks || all.data?.tasks || []).map(t => [Number(t.id), t]));
  const order = new Map();
  (todos?.todos || todos?.data?.todos || []).forEach((row, i) => {
    const k = row.task_id ? `task:${row.task_id}` : row.ms_id ? `ms:${row.ms_id}` : null;
    if (k && !order.has(k)) order.set(k, i + 1);
  });
  const boardMap = new Map(((board?.tasks || board?.data?.tasks) || []).map(t => [t.id, t]));
  return { tasks, order, board: board ? boardMap : null, orderKnown: Boolean(todos) };
}

/**
 * A handed-over plan as the screen shows it: NEURO's live tasks, plus the
 * register's rows that never went (others' work) read-only. Pure given ctx.
 */
function liveOf(p, ctx, toDdmm) {
  const folder = `Projects/${p.folder}/`;
  const byNeuro = new Map(p.actions.filter(a => /^\d+$/.test(a.neuroId || '')).map(a => [Number(a.neuroId), a]));
  const seen = new Set();
  const out = [];
  let order = 0;
  for (const t of ctx.tasks.values()) {
    const row = byNeuro.get(Number(t.id));
    if (!row && !String(t.origin_path || '').startsWith(folder)) continue;
    seen.add(Number(t.id));
    const due = t.due_date ? String(t.due_date).slice(0, 10) : null;
    out.push({
      id: row ? row.id : `N${t.id}`, neuroTaskId: Number(t.id), inNeuro: true,
      action: t.text, owner: 'Nick', ownership: 'mine', section: row?.section || 'Added in NEURO',
      due: due ? toDdmm(due) : '', dueIso: due, ...neuroStatus(t),
      starred: t.moscow === 'must', moscow: t.moscow || null,
      rank: ctx.order.get(`task:${t.id}`) ?? null, order: order++, notes: '', drift: [], plannerIds: [],
    });
  }
  for (const a of p.actions) {
    if (a.neuroId && a.neuroId.startsWith('ms:')) {
      const b = ctx.board?.get(a.neuroId.slice(3));
      out.push({
        ...a, inNeuro: true, viaPlanner: true, order: order++, drift: [],
        ...(b ? (b.completedDateTime ? { status: 'Done', statusKey: 'done' } : { status: 'In progress', statusKey: 'doing' }) : {}),
        due: b?.dueDateTime ? toDdmm(b.dueDateTime.slice(0, 10)) : a.due,
        rank: ctx.order.get(a.neuroId) ?? null,
        notes: b ? 'On the Planner board — NEURO shows it from there' : 'On the Planner board (could not be read just now)',
      });
    } else if (/^\d+$/.test(a.neuroId || '') && !seen.has(Number(a.neuroId))) {
      out.push({ ...a, inNeuro: true, missing: true, order: order++, drift: [], notes: `NEURO task #${a.neuroId} was not found` });
    } else if (!a.neuroId) {
      out.push({ ...a, inNeuro: false, readOnly: true, order: order++, drift: [] });
    }
  }
  const sections = [...new Set(out.map(a => a.section).filter(Boolean))];
  return { ...p, actions: out, sections, neuroUrl: NEURO_URL, orderKnown: ctx.orderKnown };
}

/** Replan for a handed-over plan: NEURO's due dates (write 5). `changes` [{ id, due }]. */
async function setDueLive(p, changes) {
  const rows = new Map(p.actions.map(a => [a.id, a]));
  const before = [];
  const problems = [];
  for (const c of changes) {
    const a = rows.get(c.id);
    if (!a) { problems.push(`${c.id}: not in this plan`); continue; }
    if (!a.neuroTaskId) { problems.push(`${c.id}: ${a.viaPlanner ? 'a Planner task — reschedule it on the board' : 'not in NEURO'}`); continue; }
    try {
      await neuro.setTaskDue(a.neuroTaskId, c.due ?? null);
      before.push({ id: a.id, due: a.dueIso });
    } catch (e) { problems.push(`${c.id}: ${e.message}`); }
  }
  if (!before.length && problems.length) throw httpError(`Not rescheduled: ${problems.join('; ')}`, 409);
  return { before, problems, changed: before.length };
}

module.exports = { handOff, previewHandoff, liveOf, context, setDueLive, prepareHandoff, neuroStatus, COLUMN, NEURO_URL };
