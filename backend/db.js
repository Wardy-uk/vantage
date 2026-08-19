'use strict';

/**
 * VANTAGE's store — SQLite, on the Pi.
 *
 * The Pi is the only environment this ever runs in, so the native build cost of
 * `better-sqlite3` is paid once at deploy and never gets in the way. NEURO
 * already builds it on the same Node 22.22.2, which is what makes this safe.
 *
 * Documents are stored as JSON in a `docs` table rather than modelled as
 * columns. That is a deliberate trade: the volume here is one person's coaching
 * notes, the shapes change as the coaching layer evolves, and a schema migration
 * per field would be pure ceremony. What SQLite buys over the JSON file it
 * replaces is durability and atomicity — no whole-file rewrite on every message,
 * and no half-written store if the Pi loses power mid-save.
 *
 * If a collection ever needs querying by something other than "load and filter",
 * that is the signal to give it real columns.
 */

const path = require('path');
const fs = require('fs');

let db = null;

/**
 * `better-sqlite3` is required LAZILY, inside init().
 *
 * It is a native module and does not build everywhere. Requiring it at the top
 * would make every module that touches the store — which is most of them —
 * unloadable on a machine without a compiler, taking the pure logic and its
 * tests down with it. Nothing should fail to import because of a driver it has
 * not yet asked to use.
 */
function init(dbPath = process.env.VANTAGE_DB_PATH || path.join(__dirname, 'data', 'vantage.db')) {
  if (db) return db;
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_collection ON docs(collection);
  `);
  migrateFromJson(path.join(path.dirname(dbPath), 'vantage.json'));
  return db;
}

/**
 * Carry over anything written while the store was a JSON file.
 *
 * Runs once and renames the source, so a redeploy cannot double-import. Silent
 * data loss at a storage swap is the kind of thing nobody notices until they go
 * looking for a conversation that mattered.
 */
function migrateFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  try {
    const old = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const insert = db.prepare('INSERT INTO docs (collection, json) VALUES (?, ?)');
    let count = 0;
    db.transaction(() => {
      for (const collection of ['sessions', 'messages', 'observations', 'settings', 'findings', 'plan', 'brief_themes']) {
        for (const row of old[collection] || []) {
          insert.run(collection, JSON.stringify(row));
          count += 1;
        }
      }
    })();
    fs.renameSync(jsonPath, `${jsonPath}.migrated`);
    if (count) console.log(`[VANTAGE] Migrated ${count} records from the JSON store.`);
  } catch (err) {
    console.warn(`[VANTAGE] Could not migrate ${jsonPath}: ${err.message} — left in place, nothing lost.`);
  }
}

function get() {
  if (!db) throw new Error('Store not initialised — call init() first');
  return db;
}

/** Rows carry their own `id`, so it is stable across a reload. */
function hydrate(row) {
  return { ...JSON.parse(row.json), id: row.id };
}

function find(collection, predicate) {
  const rows = get().prepare('SELECT id, json FROM docs WHERE collection = ? ORDER BY id').all(collection);
  const docs = rows.map(hydrate);
  return predicate ? docs.filter(predicate) : docs;
}

function findOne(collection, predicate) {
  return find(collection, predicate)[0] ?? null;
}

function insert(collection, row) {
  const res = get().prepare('INSERT INTO docs (collection, json) VALUES (?, ?)').run(collection, JSON.stringify(row));
  return { ...row, id: res.lastInsertRowid };
}

function update(collection, id, patch) {
  const row = get().prepare('SELECT id, json FROM docs WHERE collection = ? AND id = ?').get(collection, id);
  if (!row) return null;
  const next = { ...hydrate(row), ...patch };
  delete next.id;
  get().prepare('UPDATE docs SET json = ? WHERE id = ?').run(JSON.stringify(next), id);
  return { ...next, id };
}

function remove(collection, predicate) {
  const doomed = find(collection, predicate);
  if (!doomed.length) return 0;
  const del = get().prepare('DELETE FROM docs WHERE id = ?');
  get().transaction(() => { for (const d of doomed) del.run(d.id); })();
  return doomed.length;
}

module.exports = { init, get, insert, update, remove, find, findOne };
