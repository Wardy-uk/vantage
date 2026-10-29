'use strict';

/**
 * Every plan, not just the Support Improvement Plan (29 Oct 2026).
 *
 * Nick runs several plans at once. The rule SIP established stands for all of
 * them (decided 29 Oct 2026): a plan is a vault project, `Projects/<Folder>/`,
 * and its ACTION REGISTER (`<anything> - Action Register.md` in that folder) is
 * the source of truth. VANTAGE discovers registers, reads them, holds each one
 * against its Planner board, and — the new half — writes a small, named set of
 * things into them through NEURO (`neuro.writePlanNote`, the fourth write):
 *
 *   - a new register for an existing project ("make this project a plan")
 *   - a new project seeded from a Planner board, or from an imported document
 *   - each plan's rank (`plan-rank:` in the register's frontmatter)
 *   - each task's Rank and Star (two columns in the register's tables)
 *
 * Nothing else. Status, owners and dates are still changed in the vault.
 *
 * ⚠ A register edit is read-modify-write of a whole file that Nick also edits
 * in Obsidian. Every task edit carries the VERSION (a content hash) the screen
 * was drawn from; a register that has changed since is REFUSED (409) rather
 * than written over, so an edit he made in Obsidian a minute ago is never lost.
 * Untouched lines are written back byte-for-byte.
 *
 * ⚠ The board feed is still `/me/planner/tasks` (tasks assigned to Nick), as on
 * the SIP screen: a row with no board match is "not visible", never "not on the
 * board". Whole boards are read only to SEED a new register.
 */

const crypto = require('crypto');
const neuro = require('./neuro');
const plan = require('./plan');

const PROJECTS = 'Projects';
const REGISTER_SUFFIX = ' - Action Register.md';
const CACHE_MS = 10 * 60 * 1000;
const TEMPLATE_COLUMNS = ['ID', 'Action', 'Owner', 'Due', 'Status', 'Rank', 'Star', 'Planner ID', 'Notes'];
const STAR = '★';

const versionOf = content => crypto.createHash('sha256').update(String(content)).digest('hex').slice(0, 16);
const slugOf = folder => String(folder).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function httpError(message, status, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

// ── Frontmatter (pure) ───────────────────────────────────────────────────────

function parseFrontmatter(md) {
  const m = String(md).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, present: false };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { data, present: true };
}

/** Set one `key: value` line, leaving every other line exactly as it was. */
function setFrontmatterKey(md, key, value) {
  const text = String(md);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = `${key}: ${value}`;
  if (!m) return `---${nl}${line}${nl}---${nl}${text}`;
  const lines = m[1].split(/\r?\n/);
  const i = lines.findIndex(l => l.startsWith(`${key}:`));
  if (i >= 0) lines[i] = line; else lines.push(line);
  return `---${nl}${lines.join(nl)}${nl}---${text.slice(m[0].length)}`;
}

// ── Register tables (pure) ───────────────────────────────────────────────────

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const joinRow = cells => `| ${cells.join(' | ')} |`.replace(/\|  \|/g, '| |').replace(/\|  \|/g, '| |');
const cellSafe = v => String(v == null ? '' : v).replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim();

/**
 * Set named cells on action rows, by ID. `updates` is Map<id, {Rank?, Star?}>.
 * A column the table lacks is ADDED (header, separator and every row), which is
 * safe because the reader matches columns by header name. A row whose cell
 * count does not match its header (a stray pipe, an aliased wikilink) is left
 * alone and reported — never rewritten on a guess.
 */
function setTaskCells(md, updates, columns = ['Rank', 'Star']) {
  const nl = String(md).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(md).split(/\r?\n/);
  const problems = [];
  const touched = new Set();
  let header = null;      // lower-cased header names for the current table
  let addCols = [];       // columns appended to this table
  let isActions = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) { header = null; continue; }
    const cells = splitRow(line);
    if (!header) {
      header = cells.map(c => c.toLowerCase());
      isActions = header.includes('id');
      addCols = isActions ? columns.filter(c => !header.includes(c.toLowerCase())) : [];
      if (addCols.length) {
        lines[i] = joinRow([...cells, ...addCols]);
        header = [...header, ...addCols.map(c => c.toLowerCase())];
      }
      continue;
    }
    if (cells.every(c => /^:?-+:?$/.test(c))) {
      if (addCols.length) lines[i] = joinRow([...cells, ...addCols.map(() => '---')]).replace(/\| /g, '|').replace(/ \|/g, '|');
      continue;
    }
    if (!isActions) continue;
    const width = header.length - addCols.length;
    const id = cells[header.indexOf('id')];
    if (cells.length !== width) {
      if (updates.has(id) || addCols.length) problems.push(`${id || `line ${i + 1}`}: ${cells.length} cells where the table has ${width} — left unchanged`);
      continue;
    }
    const row = [...cells, ...addCols.map(() => '')];
    let changed = addCols.length > 0;
    if (updates.has(id)) {
      for (const [col, value] of Object.entries(updates.get(id))) {
        const j = header.indexOf(col.toLowerCase());
        if (j >= 0 && row[j] !== value) { row[j] = value; changed = true; }
      }
      touched.add(id);
    }
    if (changed) lines[i] = joinRow(row);
  }
  for (const id of updates.keys()) if (!touched.has(id)) problems.push(`${id}: not found in the register`);
  return { markdown: lines.join(nl), problems };
}

/** A new register in the template shape. */
function buildRegister({ name, folder, rank, plannerPlanId = null, source = null, created, sections }) {
  const fm = [
    '---',
    'type: tracker',
    `project: ${name}`,
    `plan-name: ${name}`,
    `plan-rank: ${rank}`,
    ...(plannerPlanId ? [`planner-plan-id: ${plannerPlanId}`] : []),
    ...(source ? [`source: ${cellSafe(source)}`] : []),
    'owner: Nick Ward',
    `created: ${created}`,
    'tags: [plan, tracker, actions]',
    '---',
  ];
  const body = [
    '',
    `# ${folder} - Action Register`,
    '',
    `> Every action for [[${folder}]]. This register is the source of truth; VANTAGE reads it and writes only Rank and Star. Status key: To do, In progress, Done, Not doing.`,
    '',
  ];
  let n = 0;
  const list = sections && sections.length ? sections : [{ title: 'Actions', actions: [] }];
  for (const s of list) {
    body.push(`## ${cellSafe(s.title) || 'Actions'}`, '', joinRow(TEMPLATE_COLUMNS), `|${TEMPLATE_COLUMNS.map(() => '---').join('|')}|`);
    for (const a of s.actions || []) {
      n += 1;
      body.push(joinRow([
        `A${n}`, cellSafe(a.action), cellSafe(a.owner || 'Unstated'), cellSafe(a.due), cellSafe(a.status || 'To do'),
        '', '', cellSafe(a.plannerId), cellSafe(a.notes),
      ]));
    }
    body.push('');
  }
  return [...fm, ...body].join('\n');
}

function buildHub({ folder, name, created, sourceNote }) {
  return [
    '---',
    'type: project',
    'status: active',
    `created: ${created}`,
    'tags: [project, plan]',
    '---',
    '',
    `# ${name}`,
    '',
    `> A plan tracked in VANTAGE. Actions: [[${folder} - Action Register]].${sourceNote ? ` Source: [[${folder} - Source]].` : ''}`,
    '',
  ].join('\n');
}

/** `2026-10-29` or `2026-10-29T…` → `29/10`, the register's date format. */
const toDdmm = d => (/^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : (d || ''));

// ── Ordering (pure) ──────────────────────────────────────────────────────────

const byRankThen = (rank, name) => (a, b) => {
  const ra = rank(a) ?? Infinity; const rb = rank(b) ?? Infinity;
  if (ra !== rb) return ra - rb;
  return name(a, b);
};

/** Plans: rank, then name. An unranked plan sits below every ranked one. */
const sortPlans = plans => [...plans].sort(byRankThen(p => p.rank, (a, b) => a.name.localeCompare(b.name)));

/**
 * The consolidated order (Nick, 29 Oct 2026): starred first across every plan,
 * then plan rank, then task rank, then the order the register lists them.
 * Overdue is MARKED by the screen, never re-sorted here.
 */
function orderTasks(rows) {
  return [...rows].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    const pa = a.planRank ?? Infinity; const pb = b.planRank ?? Infinity;
    if (pa !== pb) return pa - pb;
    if (a.planName !== b.planName) return String(a.planName).localeCompare(String(b.planName));
    const ra = a.rank ?? Infinity; const rb = b.rank ?? Infinity;
    if (ra !== rb) return ra - rb;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

/** Generic counts for any register. */
function summariseGeneric(actions) {
  const by = k => actions.filter(a => a.statusKey === k).length;
  const mine = actions.filter(a => a.ownership === 'mine');
  return {
    total: actions.length,
    done: by('done'), doing: by('doing'), todo: by('todo'), dropped: by('dropped'),
    open: actions.filter(a => a.statusKey === 'todo' || a.statusKey === 'doing').length,
    starred: actions.filter(a => a.starred).length,
    mine: { total: mine.length, done: mine.filter(a => a.statusKey === 'done').length },
    drift: actions.filter(a => a.drift?.length).length,
  };
}

// ── Reading ──────────────────────────────────────────────────────────────────

let discovery = null; // { at, folders: [{ folder, files: [...] }] }
const reads = new Map(); // registerPath → { at, content }

async function listDir(dir) {
  const r = await neuro.call(`/api/vault/list?dir=${encodeURIComponent(dir)}`);
  return r.files || r.data?.files || [];
}

/** Every Projects/<Folder> and the files in it. Archive is excluded. */
async function discover({ force = false } = {}) {
  if (!force && discovery && Date.now() - discovery.at < CACHE_MS) return discovery.folders;
  const top = await listDir(PROJECTS);
  const names = top.filter(f => f.type === 'directory' && f.name !== 'Archive' && !f.name.startsWith('.')).map(f => f.name);
  const folders = [];
  for (let i = 0; i < names.length; i += 6) {
    const batch = names.slice(i, i + 6);
    const lists = await Promise.all(batch.map(n => listDir(`${PROJECTS}/${n}`).then(fs => fs, () => null)));
    batch.forEach((folder, j) => folders.push({
      folder,
      readable: lists[j] !== null,
      files: (lists[j] || []).filter(f => f.type === 'file').map(f => f.name),
    }));
  }
  discovery = { at: Date.now(), folders };
  return folders;
}

function registerOf(entry) {
  return entry.files.find(f => f.endsWith(REGISTER_SUFFIX)) || null;
}

async function readNote(path, { force = false } = {}) {
  const hit = reads.get(path);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.content;
  const doc = await neuro.call(`/api/vault/read?path=${encodeURIComponent(path)}`);
  const content = doc.content ?? doc.data?.content;
  if (typeof content !== 'string') throw new Error(`${path} could not be read`);
  reads.set(path, { at: Date.now(), content });
  return content;
}

function invalidate(path) {
  if (path) reads.delete(path); else reads.clear();
  discovery = null;
}

/** One register → a plan, without the board. Never throws: a broken register is reported, not dropped. */
async function readOne(entry, { force = false } = {}) {
  const file = registerOf(entry);
  const path = `${PROJECTS}/${entry.folder}/${file}`;
  const base = { id: slugOf(entry.folder), folder: entry.folder, path };
  let content;
  try { content = await readNote(path, { force }); } catch (e) {
    return { ...base, name: entry.folder, rank: null, available: false, reason: e.message };
  }
  const { data } = parseFrontmatter(content);
  const register = plan.parseRegister(content);
  const hasTable = /^\s*\|\s*ID\s*\|/im.test(content);
  const problems = [...register.problems];
  if (!hasTable) problems.push('no action table (a table with an ID column) was found');
  const isSip = path === plan.REGISTER_PATH;
  return {
    ...base,
    name: data['plan-name'] || entry.folder,
    rank: /^\d+$/.test(data['plan-rank'] || '') ? Number(data['plan-rank']) : null,
    plannerPlanId: data['planner-plan-id'] || (isSip ? plan.PLANNER_PLAN_ID : null),
    isSip,
    moved: data['moved-to-neuro'] || null,
    available: true,
    version: versionOf(content),
    sections: register.sections,
    problems,
    actions: register.actions,
  };
}

/** The board and NEURO, read once per request. Each degrades with its reason. */
async function sideReads() {
  let board = null; let boardError = null;
  try { board = await neuro.call('/api/microsoft/planner/tasks'); } catch (e) { boardError = e.message; }
  let neuroMsIds = null; let neuroError = null;
  try {
    const t = await neuro.todos();
    neuroMsIds = new Set((t.todos || t.data?.todos || []).map(r => r.ms_id).filter(Boolean));
  } catch (e) { neuroError = e.message; }
  return { board, boardError, neuroMsIds, neuroError };
}

function withBoard(p, side) {
  if (!p.available) return p;
  if (!p.plannerPlanId) {
    return { ...p, board: { linked: false, available: null }, actions: p.actions.map(a => ({ ...a, planner: null, drift: [], inNeuro: null })), unregistered: null };
  }
  const board = side.board ? plan.boardFrom(side.board, p.plannerPlanId) : null;
  const { actions, unregistered } = plan.crossCheck(p.actions, board, side.neuroMsIds);
  return {
    ...p, actions, unregistered,
    board: { linked: true, available: Boolean(board), reason: side.boardError, total: board ? board.length : null },
  };
}

/** Every plan (registers found), full detail. */
async function readAll({ force = false } = {}) {
  const folders = await discover({ force });
  const entries = folders.filter(registerOf);
  const plans = await Promise.all(entries.map(e => readOne(e, { force })));
  const side = await sideReads();
  // A handed-over plan's tasks live in NEURO: read them live, once for all.
  let live = null; let liveError = null;
  if (plans.some(p => p.available && p.moved)) {
    try { live = await require('./plan-neuro').context(); } catch (e) { liveError = e.message; }
  }
  const shaped = plans.map(p => {
    if (!p.available || !p.moved) return withBoard(p, side);
    if (!live) return { ...p, available: false, reason: `its tasks live in NEURO, which could not be read (${liveError})` };
    return require('./plan-neuro').liveOf(p, live, toDdmm);
  });
  return {
    plans: sortPlans(shaped),
    neuro: { available: Boolean(side.neuroMsIds), reason: side.neuroError },
    unreadableFolders: folders.filter(f => !f.readable).map(f => f.folder),
  };
}

/** The switcher: every plan, rank order, counts only. */
async function list({ force = false } = {}) {
  const all = await readAll({ force });
  return {
    plans: all.plans.map(p => ({
      id: p.id, name: p.name, folder: p.folder, path: p.path, rank: p.rank, isSip: Boolean(p.isSip), moved: p.moved || null,
      available: p.available, reason: p.reason || null,
      plannerPlanId: p.plannerPlanId || null, board: p.board || null,
      problems: p.problems || [],
      summary: p.available ? summariseGeneric(p.actions) : null,
    })),
    unreadableFolders: all.unreadableFolders,
  };
}

async function detail(id, { force = false } = {}) {
  const all = await readAll({ force });
  const p = all.plans.find(x => x.id === id);
  if (!p) throw httpError(`No plan "${id}"`, 404);
  return { ...p, summary: p.available ? summariseGeneric(p.actions) : null, statuses: plan.TEMPLATE_STATUSES, neuro: all.neuro };
}

/** Every plan's tasks on one list, in Nick's order. */
async function consolidated({ force = false } = {}) {
  const all = await readAll({ force });
  const rows = [];
  for (const p of all.plans) {
    if (!p.available) continue;
    for (const a of p.actions) {
      rows.push({
        planId: p.id, planName: p.name, planRank: p.rank, planVersion: p.version,
        id: a.id, action: a.action, owner: a.owner, ownership: a.ownership, due: a.due,
        status: a.status, statusKey: a.statusKey, rank: a.rank, starred: a.starred, order: a.order,
        section: a.section, drift: a.drift || [], notes: a.notes,
        inNeuro: Boolean(a.inNeuro), readOnly: Boolean(a.readOnly), viaPlanner: Boolean(a.viaPlanner), neuroTaskId: a.neuroTaskId || null,
      });
    }
  }
  return {
    tasks: orderTasks(rows),
    plans: all.plans.map(p => ({ id: p.id, name: p.name, rank: p.rank, moved: p.moved || null, available: p.available, reason: p.reason || null, version: p.version || null })),
    unavailable: all.plans.filter(p => !p.available).map(p => ({ name: p.name, reason: p.reason })),
  };
}

/** What could become a plan: projects without a register, and Planner boards. */
async function candidates() {
  const folders = await discover({ force: true });
  const out = {
    projects: folders.filter(f => !registerOf(f)).map(f => ({ folder: f.folder, readable: f.readable })),
    boards: null, boardsReason: null,
  };
  const linked = new Set();
  for (const f of folders.filter(registerOf)) {
    try {
      const p = await readOne(f);
      if (p.plannerPlanId) linked.add(p.plannerPlanId);
    } catch { /* readOne does not throw */ }
  }
  try {
    const r = await neuro.call('/api/microsoft/planner/plans');
    out.boards = (r.plans || r.data?.plans || []).map(b => ({ ...b, linked: linked.has(b.id) }));
  } catch (e) { out.boardsReason = e.message; }
  return out;
}

// ── Writing ──────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

function folderProblem(folder) {
  const f = String(folder || '').trim();
  if (!f) return 'a folder name is required';
  if (f === 'Archive' || f.startsWith('.') || /[\\/\0<>:"|?*]/.test(f) || f.includes('..')) return 'that folder name is not allowed';
  if (f.length > 80) return 'folder names are limited to 80 characters';
  return null;
}

async function nextRank() {
  const all = await readAll();
  return all.plans.reduce((m, p) => Math.max(m, p.rank || 0), 0) + 1;
}

/** Make an existing project a plan: an empty register in its folder. */
async function adopt({ folder } = {}) {
  const folders = await discover({ force: true });
  const entry = folders.find(f => f.folder === folder);
  if (!entry) throw httpError(`No project folder "${folder}"`, 404);
  if (registerOf(entry)) throw httpError(`${folder} already has a register`, 409);
  const path = `${PROJECTS}/${folder}/${folder}${REGISTER_SUFFIX}`;
  await neuro.writePlanNote(path, buildRegister({ name: folder, folder, rank: await nextRank(), created: today() }));
  invalidate();
  return { id: slugOf(folder), path };
}

/** Write a brand-new plan: hub (unless the folder already has one), optional source, register. */
async function createPlan({ folder, name, sections, plannerPlanId = null, source = null, sourceText = null }) {
  const problem = folderProblem(folder);
  if (problem) throw httpError(problem, 400);
  const folders = await discover({ force: true });
  const entry = folders.find(f => f.folder === folder);
  if (entry && registerOf(entry)) throw httpError(`${folder} already has a register — pick another name`, 409);
  const created = today();
  const written = [];
  if (!entry || !entry.files.includes(`${folder}.md`)) {
    await neuro.writePlanNote(`${PROJECTS}/${folder}/${folder}.md`, buildHub({ folder, name, created, sourceNote: Boolean(sourceText) }));
    written.push(`${folder}.md`);
  }
  if (sourceText && !(entry && entry.files.includes(`${folder} - Source.md`))) {
    const src = ['---', 'type: source', `imported: ${created}`, ...(source ? [`original: ${cellSafe(source)}`] : []), '---', '', `# ${folder} - Source`, '', `> Text extracted from ${source || 'an imported document'} when this plan was created. The original file is not stored.`, '', sourceText].join('\n');
    await neuro.writePlanNote(`${PROJECTS}/${folder}/${folder} - Source.md`, src);
    written.push(`${folder} - Source.md`);
  }
  const path = `${PROJECTS}/${folder}/${folder}${REGISTER_SUFFIX}`;
  await neuro.writePlanNote(path, buildRegister({ name, folder, rank: await nextRank(), plannerPlanId, source, created, sections }));
  written.push(`${folder}${REGISTER_SUFFIX}`);
  invalidate();
  return { id: slugOf(folder), path, written };
}

/** Status for a board task: done when completed, in progress when started. */
const boardStatus = t => (t.completedDateTime ? 'Done' : (t.percentComplete > 0 ? 'In progress' : 'To do'));

/** A new plan seeded from a Planner board's whole task list. */
async function fromPlanner({ planId, folder, name } = {}) {
  if (!planId) throw httpError('planId is required', 400);
  const boards = await neuro.call('/api/microsoft/planner/plans');
  const board = (boards.plans || boards.data?.plans || []).find(b => b.id === planId);
  const title = (name || board?.title || '').trim();
  if (!title) throw httpError('That board has no readable name — give the plan a name', 400);
  const r = await neuro.call(`/api/microsoft/planner/plans/${encodeURIComponent(planId)}/tasks`);
  const tasks = r.tasks || r.data?.tasks || [];
  if (r.truncated || r.data?.truncated) throw httpError('The board has more tasks than one read returned — not seeding a partial register', 409);
  let mine = new Set();
  try {
    const m = await neuro.call('/api/microsoft/planner/tasks');
    mine = new Set((m.tasks || m.data?.tasks || []).map(t => t.id));
  } catch { /* owner then reads "Per Planner" for every row */ }
  const actions = tasks
    .sort((a, b) => String(a.orderHint || '').localeCompare(String(b.orderHint || '')))
    .map(t => ({
      action: t.title, owner: mine.has(t.id) ? 'Nick' : 'Per Planner',
      due: toDdmm(t.dueDateTime), status: boardStatus(t), plannerId: t.id,
    }));
  return createPlan({ folder: (folder || title).trim(), name: title, plannerPlanId: planId, source: `Planner board "${title}"`, sections: [{ title: 'Actions', actions }] });
}

/** One plan's register, read fresh, with no version check (the hand-off reads it twice itself). */
async function _readRegister(id) {
  const folders = await discover({ force: true });
  const entry = folders.find(f => slugOf(f.folder) === id && registerOf(f));
  if (!entry) throw httpError(`No plan "${id}"`, 404);
  const path = `${PROJECTS}/${entry.folder}/${registerOf(entry)}`;
  const content = await readNote(path, { force: true });
  return { entry, path, content, folder: entry.folder, name: parseFrontmatter(content).data['plan-name'] || entry.folder };
}

/** Read the register fresh and refuse if it changed since the screen was drawn. */
async function freshRegister(id, version) {
  if (!version) throw httpError('version is required — reload the plan', 400);
  const folders = await discover({ force: true });
  const entry = folders.find(f => slugOf(f.folder) === id && registerOf(f));
  if (!entry) throw httpError(`No plan "${id}"`, 404);
  const path = `${PROJECTS}/${entry.folder}/${registerOf(entry)}`;
  const content = await readNote(path, { force: true });
  if (version && versionOf(content) !== version) {
    throw httpError('The register has changed since this screen loaded (edited in Obsidian?). Reload and try again — nothing was written.', 409, 'stale-version');
  }
  return { path, content };
}

async function writeCells(id, version, updates, columns) {
  const { path, content } = await freshRegister(id, version);
  if (parseFrontmatter(content).data['moved-to-neuro']) {
    throw httpError('This plan was handed to NEURO — tick, star and reorder its tasks in NEURO. The register is history now.', 409, 'moved');
  }
  const { markdown, problems } = setTaskCells(content, updates, columns);
  const blocking = problems.filter(p => [...updates.keys()].some(k => p.startsWith(`${k}:`)));
  if (blocking.length) throw httpError(`Not written: ${blocking.join('; ')}`, 409, 'unwritable-row');
  if (markdown !== content) await neuro.writePlanNote(path, markdown);
  invalidate(path);
  return { version: versionOf(markdown), problems };
}

/** Rank a plan's tasks. `order` lists task IDs top to bottom; any task not listed loses its rank. */
async function rankTasks(id, { version, order } = {}) {
  if (!Array.isArray(order) || !order.length) throw httpError('order (task IDs, top first) is required', 400);
  if (new Set(order).size !== order.length) throw httpError('order lists a task twice', 400);
  const { content } = await freshRegister(id, version);
  const ids = plan.parseRegister(content).actions.map(a => a.id);
  const unknown = order.filter(t => !ids.includes(t));
  if (unknown.length) throw httpError(`Not in this register: ${unknown.join(', ')}`, 400);
  const updates = new Map(ids.map(t => [t, { Rank: order.includes(t) ? String(order.indexOf(t) + 1) : '' }]));
  return writeCells(id, version, updates);
}

async function star(id, taskId, { version, starred } = {}) {
  if (typeof starred !== 'boolean') throw httpError('starred must be true or false', 400);
  return writeCells(id, version, new Map([[taskId, { Star: starred ? STAR : '' }]]));
}

/**
 * Which status words this register speaks. SIP's tables say "Planner status"
 * with its own key; a template register says "Status". Pure.
 */
function vocabularyOf(content) {
  const sip = /\|\s*Planner status\s*\|/i.test(content);
  return sip
    ? { column: 'Planner status', words: plan.STATUSES, done: 'Done', dropped: 'Not adding', reopen: a => (a.plannerIds.length ? 'Added' : 'To be added') }
    : { column: 'Status', words: plan.TEMPLATE_STATUSES, done: 'Done', dropped: 'Not doing', reopen: () => 'To do' };
}

const MAX_STATUS_CHANGES = 200;

/**
 * Close, drop or reopen tasks (Nick, 29 Oct 2026: "a lot are already done").
 * `changes` is [{ id, to: 'done'|'dropped'|'open' }] or [{ id, status: '<exact word>' }]
 * — the second form is Undo, restoring exactly what was there. Each register
 * keeps its own words. Returns what each row WAS, so the screen can undo.
 */
async function setStatus(id, { version, changes } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw httpError('changes is required', 400);
  if (changes.length > MAX_STATUS_CHANGES) throw httpError(`At most ${MAX_STATUS_CHANGES} changes at once`, 400);
  if (new Set(changes.map(c => c.id)).size !== changes.length) throw httpError('a task is listed twice', 400);
  const { content } = await freshRegister(id, version);
  const vocab = vocabularyOf(content);
  const rows = new Map(plan.parseRegister(content).actions.map(a => [a.id, a]));
  const updates = new Map();
  const before = [];
  for (const c of changes) {
    const a = rows.get(c.id);
    if (!a) throw httpError(`${c.id} is not in this register`, 400);
    let word;
    if (c.status != null) {
      if (!vocab.words.includes(c.status)) throw httpError(`"${c.status}" is not a status this register uses (${vocab.words.join(', ')})`, 400);
      word = c.status;
    } else if (c.to === 'done') word = vocab.done;
    else if (c.to === 'dropped') word = vocab.dropped;
    else if (c.to === 'open') word = vocab.reopen(a);
    else throw httpError(`${c.id}: "to" must be done, dropped or open`, 400);
    before.push({ id: a.id, status: a.status });
    updates.set(a.id, { [vocab.column]: word });
  }
  const r = await writeCells(id, version, updates, []);
  return { ...r, before, changed: changes.length };
}

// ── Replan (Nick, 29 Oct 2026) ───────────────────────────────────────────────
//
// Spread the selected tasks over working days from a start date (N a day, in
// the consolidated priority order), shift their dates by N working days, or set
// one date for all. A PREVIEW is computed here and returned; nothing is written
// until the screen sends the exact dates back to `setDue`.

const pad2 = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const dayOf = iso => new Date(`${iso}T00:00:00Z`);
const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && isoOf(dayOf(s)) === s;

/** `21/08` (or `21/08, 24/08`) → this year's ISO date; anything else → null. Pure. */
function ddmmToIso(cell, year = new Date().getFullYear()) {
  const m = String(cell || '').match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const iso = `${year}-${pad2(m[2])}-${pad2(m[1])}`;
  return isIso(iso) ? iso : null;
}

function isWorking(iso, holidays) {
  const dow = dayOf(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(iso);
}
function nextWorking(iso, holidays) {
  let d = dayOf(iso);
  while (!isWorking(isoOf(d), holidays)) d.setUTCDate(d.getUTCDate() + 1);
  return isoOf(d);
}
function addWorking(iso, n, holidays) {
  let d = dayOf(iso); let left = Math.abs(n); const step = n < 0 ? -1 : 1;
  while (left > 0) { d.setUTCDate(d.getUTCDate() + step); if (isWorking(isoOf(d), holidays)) left -= 1; }
  return isoOf(d);
}

/**
 * The new dates. Pure. `rows` are in priority order and carry `due` (the
 * register cell). Returns [{ planId, id, from, to, skipped }].
 */
function computeReplan(rows, { mode, start, perDay, days, date }, holidays = new Set()) {
  if (mode === 'spread') {
    if (!isIso(start)) throw httpError('A start date is required', 400);
    const n = Number(perDay);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw httpError('Tasks per day must be 1 to 20', 400);
    let day = nextWorking(start, holidays); let used = 0;
    return rows.map(r => {
      if (used === n) { day = nextWorking(addWorking(day, 1, holidays), holidays); used = 0; }
      used += 1;
      return { planId: r.planId, id: r.id, from: r.due || '', to: day };
    });
  }
  if (mode === 'shift') {
    const n = Number(days);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 260) throw httpError('Shift must be a whole number of working days, not 0, at most 260', 400);
    return rows.map(r => {
      const from = r.dueIso || ddmmToIso(r.due);
      if (!from) return { planId: r.planId, id: r.id, from: r.due || '', to: null, skipped: 'no date to shift' };
      return { planId: r.planId, id: r.id, from: r.due, to: addWorking(from, n, holidays) };
    });
  }
  if (mode === 'set') {
    if (!isIso(date)) throw httpError('A date is required', 400);
    return rows.map(r => ({ planId: r.planId, id: r.id, from: r.due || '', to: date }));
  }
  throw httpError('mode must be spread, shift or set', 400);
}

let holidayCache = null;
/** NEURO's bank holiday list (its working-days calendar). Weekends-only, SAID, when NEURO cannot answer. */
async function holidays() {
  if (holidayCache && Date.now() - holidayCache.at < 12 * 3600 * 1000) return holidayCache;
  try {
    const r = await neuro.call('/api/time/working-days');
    const dates = r.dates || r.data?.dates;
    if (!Array.isArray(dates) || !dates.length) throw new Error('NEURO sent no holiday dates');
    holidayCache = { at: Date.now(), set: new Set(dates), known: true };
  } catch (e) {
    holidayCache = { at: Date.now() - 11.5 * 3600 * 1000, set: new Set(), known: false, reason: e.message };
  }
  return holidayCache;
}

/** Preview a replan of tasks across any plans. Writes nothing. */
async function replanPreview({ items, mode, start, perDay, days, date } = {}) {
  if (!Array.isArray(items) || !items.length) throw httpError('Select some tasks first', 400);
  if (items.length > MAX_STATUS_CHANGES) throw httpError(`At most ${MAX_STATUS_CHANGES} tasks at once`, 400);
  const want = new Set(items.map(i => `${i.planId}:${i.id}`));
  const all = await readAll();
  const rows = [];
  for (const p of all.plans) {
    if (!p.available) continue;
    for (const a of p.actions) {
      if (want.has(`${p.id}:${a.id}`)) rows.push({ planId: p.id, planName: p.name, planRank: p.rank, id: a.id, action: a.action, due: a.due, dueIso: a.dueIso || null, rank: a.rank, starred: a.starred, order: a.order });
    }
  }
  const ordered = orderTasks(rows);
  const cal = await holidays();
  const out = computeReplan(ordered, { mode, start, perDay, days, date }, cal.set);
  const byKey = new Map(ordered.map(r => [`${r.planId}:${r.id}`, r]));
  return {
    changes: out.map(c => ({ ...c, planName: byKey.get(`${c.planId}:${c.id}`).planName, action: byKey.get(`${c.planId}:${c.id}`).action, toDdmm: c.to ? toDdmm(c.to) : null })),
    missing: items.filter(i => !byKey.has(`${i.planId}:${i.id}`)).map(i => `${i.planId}:${i.id}`),
    calendar: cal.known ? 'weekends and bank holidays skipped' : `weekends skipped; bank holidays NOT known (${cal.reason})`,
  };
}

/**
 * Write due dates into one register. `changes` [{ id, due: 'YYYY-MM-DD'|null }]
 * or [{ id, dueRaw }] (Undo: the exact cell that was there). Returns `before`.
 */
async function setDue(id, { version, changes } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw httpError('changes is required', 400);
  if (changes.length > MAX_STATUS_CHANGES) throw httpError(`At most ${MAX_STATUS_CHANGES} changes at once`, 400);
  for (const c of changes) if (c.due != null && !isIso(c.due)) throw httpError(`${c.id}: "${c.due}" is not a date`, 400);
  // A handed-over plan's dates live in NEURO: Replan moves them there.
  const p = (await readAll()).plans.find(x => x.id === id);
  if (p && p.moved) {
    if (!p.available) throw httpError(`Not rescheduled: ${p.reason}`, 503);
    return require('./plan-neuro').setDueLive(p, changes);
  }
  const { content } = await freshRegister(id, version);
  const rows = new Map(plan.parseRegister(content).actions.map(a => [a.id, a]));
  const updates = new Map();
  const before = [];
  for (const c of changes) {
    const a = rows.get(c.id);
    if (!a) throw httpError(`${c.id} is not in this register`, 400);
    let cell;
    if (c.dueRaw !== undefined) cell = cellSafe(c.dueRaw);
    else if (c.due === null) cell = '';
    else if (isIso(c.due)) cell = toDdmm(c.due);
    else throw httpError(`${c.id}: "${c.due}" is not a date`, 400);
    before.push({ id: a.id, dueRaw: a.due });
    updates.set(a.id, { Due: cell });
  }
  const r = await writeCells(id, version, updates, []);
  return { ...r, before, changed: changes.length };
}

/** Rank the plans themselves. `order` lists plan IDs top first; every register's plan-rank is set. */
async function rankPlans({ order } = {}) {
  if (!Array.isArray(order) || !order.length) throw httpError('order (plan IDs, top first) is required', 400);
  const folders = await discover({ force: true });
  const entries = folders.filter(registerOf);
  const known = entries.map(e => slugOf(e.folder));
  const unknown = order.filter(o => !known.includes(o));
  if (unknown.length) throw httpError(`Unknown plans: ${unknown.join(', ')}`, 400);
  const full = [...order, ...known.filter(k => !order.includes(k))];
  let changed = 0;
  for (const e of entries) {
    const path = `${PROJECTS}/${e.folder}/${registerOf(e)}`;
    const content = await readNote(path, { force: true });
    const want = String(full.indexOf(slugOf(e.folder)) + 1);
    if (parseFrontmatter(content).data['plan-rank'] === want) continue;
    await neuro.writePlanNote(path, setFrontmatterKey(content, 'plan-rank', want));
    changed += 1;
  }
  invalidate();
  return { changed };
}

module.exports = {
  list, detail, consolidated, candidates, adopt, createPlan, fromPlanner, rankTasks, star, rankPlans, setStatus,
  replanPreview, setDue,
  // pure, for tests
  vocabularyOf, computeReplan, ddmmToIso, addWorking, parseFrontmatter, setFrontmatterKey, setTaskCells, buildRegister, buildHub, orderTasks, sortPlans,
  summariseGeneric, versionOf, slugOf, folderProblem, toDdmm, boardStatus,
  REGISTER_SUFFIX, TEMPLATE_COLUMNS, STAR,
  _invalidate: invalidate, _readRegister,
};
