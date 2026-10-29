'use strict';

/**
 * Performance Evidence — storage (29 Oct 2026).
 *
 * Real tables, not the `docs` collection: a year of gathered items is thousands
 * of rows queried by state and slot, and `docs` loads a whole collection to
 * filter it (db.js says that is the signal to give data real columns).
 *
 * Tables are created lazily on first use, so nothing here costs a store that
 * never opens the section.
 *
 * Evidence states:
 *   queued        gathered from NEURO, not yet read by the model
 *   proposed      the model tagged it; waiting for Nick
 *   accepted      Nick accepted it — the ONLY state the assessment reads
 *   rejected      Nick said no; never offered again (source_key is UNIQUE)
 *   not-relevant  the model found nothing it bears on; kept so it is never re-bought
 */

const STATES = ['queued', 'proposed', 'accepted', 'rejected', 'not-relevant'];
const SLOTS = ['current', 'future'];

let ready = false;
function db() {
  const d = require('../db').get();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS perf_roles (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        slot         TEXT NOT NULL CHECK (slot IN ('current','future')),
        status       TEXT NOT NULL CHECK (status IN ('active','archived')),
        title        TEXT NOT NULL,
        source_name  TEXT,
        source_text  TEXT,
        profile_json TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        archived_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perf_roles_slot ON perf_roles(slot, status);

      CREATE TABLE IF NOT EXISTS perf_evidence (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key     TEXT NOT NULL UNIQUE,
        origin         TEXT NOT NULL CHECK (origin IN ('neuro','nova','manual')),
        kind           TEXT NOT NULL,
        hint           TEXT,
        occurred_at    TEXT,
        title          TEXT NOT NULL,
        detail         TEXT,
        ref            TEXT,
        state          TEXT NOT NULL CHECK (state IN ('queued','proposed','accepted','rejected','not-relevant')),
        tags_json      TEXT NOT NULL DEFAULT '[]',
        judged_roles   TEXT,
        case_summary   TEXT,
        in_case        INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        decided_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_perf_ev_state ON perf_evidence(state, occurred_at);

      CREATE TABLE IF NOT EXISTS perf_assessments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slot       TEXT NOT NULL,
        role_id    INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        json       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS perf_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    ready = true;
  }
  return d;
}

const now = () => new Date().toISOString();
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ── state ────────────────────────────────────────────────────────────────────

function getState(key, dflt = null) {
  const r = db().prepare('SELECT value FROM perf_state WHERE key = ?').get(key);
  return r ? parse(r.value, dflt) : dflt;
}
function setState(key, value) {
  db().prepare('INSERT INTO perf_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ── roles ────────────────────────────────────────────────────────────────────

function roleRow(r) {
  return r ? {
    id: r.id, slot: r.slot, status: r.status, title: r.title, sourceName: r.source_name,
    hasSource: Boolean(r.source_text), profile: parse(r.profile_json, null),
    createdAt: r.created_at, archivedAt: r.archived_at,
  } : null;
}

function activeRole(slot) {
  return roleRow(db().prepare("SELECT * FROM perf_roles WHERE slot = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(slot));
}

function roleHistory(slot) {
  return db().prepare("SELECT * FROM perf_roles WHERE slot = ? AND status = 'archived' ORDER BY id DESC").all(slot).map(roleRow);
}

/** Save a confirmed profile into a slot, archiving the one it replaces. One transaction. */
function saveRole({ slot, title, sourceName, sourceText, profile }) {
  if (!SLOTS.includes(slot)) throw new Error('slot must be current or future');
  const d = db();
  let id;
  d.transaction(() => {
    d.prepare("UPDATE perf_roles SET status = 'archived', archived_at = ? WHERE slot = ? AND status = 'active'").run(now(), slot);
    id = d.prepare(`INSERT INTO perf_roles (slot, status, title, source_name, source_text, profile_json, created_at)
      VALUES (?, 'active', ?, ?, ?, ?, ?)`).run(slot, title, sourceName || null, sourceText || null, JSON.stringify(profile), now()).lastInsertRowid;
  })();
  return activeRole(slot);
}

// ── evidence ─────────────────────────────────────────────────────────────────

function evRow(r) {
  return r ? {
    id: r.id, sourceKey: r.source_key, origin: r.origin, kind: r.kind, hint: r.hint,
    occurredAt: r.occurred_at, title: r.title, detail: r.detail, ref: r.ref, state: r.state,
    tags: parse(r.tags_json, []), caseSummary: r.case_summary, inCase: Boolean(r.in_case),
    createdAt: r.created_at, decidedAt: r.decided_at,
  } : null;
}

/** Insert gathered items (`origin` 'neuro' | 'nova'). An existing source_key keeps its state and tags; its text is refreshed. Returns how many were new. */
function enqueue(items) {
  // A re-fetched item REFRESHES its text (title/detail/hint/ref) and keeps its
  // state and tags. The source is authoritative for what it says — and that is
  // how a tightened privacy screen in NEURO reaches items stored before it.
  const has = db().prepare('SELECT 1 FROM perf_evidence WHERE source_key = ?');
  const ins = db().prepare(`INSERT INTO perf_evidence
    (source_key, origin, kind, hint, occurred_at, title, detail, ref, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET title = excluded.title, detail = excluded.detail, hint = excluded.hint, ref = excluded.ref`);
  let added = 0;
  db().transaction(() => {
    for (const it of items) {
      const origin = it.origin === 'nova' ? 'nova' : 'neuro';
      const key = `${origin}:${it.id}`;
      const existed = Boolean(has.get(key));
      ins.run(key, origin, it.kind, it.hint || null, it.at || null, String(it.title).slice(0, 400),
        it.detail || null, it.ref || null, it.skip ? 'not-relevant' : 'queued', now());
      if (!existed) added += 1;
    }
  })();
  return added;
}

function addManual({ title, detail, occurredAt, ref, tags }) {
  const key = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const id = db().prepare(`INSERT INTO perf_evidence
    (source_key, origin, kind, occurred_at, title, detail, ref, state, tags_json, created_at, decided_at)
    VALUES (?, 'manual', 'manual', ?, ?, ?, ?, 'accepted', ?, ?, ?)`)
    .run(key, occurredAt, title, detail || null, ref || null, JSON.stringify(tags), now(), now()).lastInsertRowid;
  return getEvidence(id);
}

function getEvidence(id) {
  return evRow(db().prepare('SELECT * FROM perf_evidence WHERE id = ?').get(id));
}

function queued(limit) {
  return db().prepare("SELECT * FROM perf_evidence WHERE state = 'queued' ORDER BY occurred_at DESC LIMIT ?").all(limit).map(evRow);
}

function listEvidence({ state, limit = 200, offset = 0 } = {}) {
  const where = state ? 'WHERE state = ?' : '';
  const args = state ? [state] : [];
  const rows = db().prepare(`SELECT * FROM perf_evidence ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db().prepare(`SELECT COUNT(*) AS n FROM perf_evidence ${where}`).get(...args).n;
  return { items: rows.map(evRow), total };
}

function counts() {
  const out = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of db().prepare('SELECT state, COUNT(*) AS n FROM perf_evidence GROUP BY state').all()) out[r.state] = r.n;
  return out;
}

function update(id, patch) {
  const cur = getEvidence(id);
  if (!cur) { const e = new Error('No such evidence item'); e.status = 404; throw e; }
  const next = { ...cur, ...patch };
  db().prepare(`UPDATE perf_evidence SET state = ?, tags_json = ?, case_summary = ?, in_case = ?, decided_at = ?,
    title = ?, detail = ?, occurred_at = ?, ref = ? WHERE id = ?`)
    .run(next.state, JSON.stringify(next.tags || []), next.caseSummary || null, next.inCase ? 1 : 0,
      patch.state && patch.state !== cur.state ? now() : cur.decidedAt, next.title, next.detail, next.occurredAt, next.ref, id);
  return getEvidence(id);
}

function setTriage(id, { state, tags, rolesKey }) {
  db().prepare('UPDATE perf_evidence SET state = ?, tags_json = ?, judged_roles = ? WHERE id = ? AND state = ?')
    .run(state, JSON.stringify(tags || []), rolesKey || null, id, 'queued');
}

/** Accepted evidence tagged to a slot. */
function acceptedFor(slot) {
  return db().prepare("SELECT * FROM perf_evidence WHERE state = 'accepted' ORDER BY occurred_at DESC").all()
    .map(evRow).filter((e) => e.tags.some((t) => t.slot === slot));
}

function deleteManual(id) {
  const cur = getEvidence(id);
  if (!cur) { const e = new Error('No such evidence item'); e.status = 404; throw e; }
  if (cur.origin !== 'manual') { const e = new Error('Only evidence you entered yourself can be deleted — reject a gathered item instead'); e.status = 409; throw e; }
  db().prepare('DELETE FROM perf_evidence WHERE id = ?').run(id);
  return { deleted: true };
}

// ── assessments ──────────────────────────────────────────────────────────────

function saveAssessment(slot, roleId, result) {
  const id = db().prepare('INSERT INTO perf_assessments (slot, role_id, created_at, json) VALUES (?, ?, ?, ?)')
    .run(slot, roleId, now(), JSON.stringify(result)).lastInsertRowid;
  return { id, slot, roleId, createdAt: now(), ...result };
}

function latestAssessment(slot) {
  const r = db().prepare('SELECT * FROM perf_assessments WHERE slot = ? ORDER BY id DESC LIMIT 1').get(slot);
  return r ? { id: r.id, slot: r.slot, roleId: r.role_id, createdAt: r.created_at, ...parse(r.json, {}) } : null;
}

function assessmentHistory(slot, limit = 20) {
  return db().prepare('SELECT id, role_id, created_at, json FROM perf_assessments WHERE slot = ? ORDER BY id DESC LIMIT ?').all(slot, limit)
    .map((r) => { const j = parse(r.json, {}); return { id: r.id, roleId: r.role_id, createdAt: r.created_at, readiness: j.readiness?.rating || null, counts: j.counts || null }; });
}

module.exports = {
  STATES, SLOTS, getState, setState,
  activeRole, roleHistory, saveRole,
  enqueue, addManual, getEvidence, queued, listEvidence, counts, update, setTriage, acceptedFor, deleteManual,
  saveAssessment, latestAssessment, assessmentHistory,
};
