'use strict';

/**
 * Who is allowed to say a warning was useful, and how that is recorded.
 *
 * ⚠⚠ `label()` used to default `by` to `'nick'`. That was safe while the only
 * caller was his own browser, and became unsafe the moment the route was
 * proposed for the MCP gateway: an assistant that simply omitted the field
 * would have recorded a HUMAN verdict attributed to Nick that he never gave.
 * This ledger is what assesses whether the detectors are worth trusting, so a
 * forged verdict corrupts the measurement rather than just a row — and it
 * corrupts it in the flattering direction, which is the one nobody checks.
 *
 * ⚠ `../db` IS STUBBED, deliberately, and that is why these tests exist at all.
 * `indicator-log.test.js` says in its own header that its first version needed
 * `better-sqlite3`, which does not build on this machine, so every test in it
 * SKIPPED — "a skipped test and an absent test differ only in how honest the
 * output is". `label()` and `scoreboard()` are database-backed, so the same
 * would have happened here. A ten-line in-memory store is the alternative to
 * not testing the write at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── The store, before indicator-log is loaded ───────────────────────────────

const DB_PATH = require.resolve('../db');
const rows = [];
let nextId = 1;

require.cache[DB_PATH] = {
  id: DB_PATH,
  filename: DB_PATH,
  loaded: true,
  exports: {
    init() {},
    find(_collection, pred) { return pred ? rows.filter(pred) : rows.slice(); },
    findOne(_collection, pred) { return rows.find(pred) || null; },
    insert(_collection, rec) { const r = { id: nextId++, ...rec }; rows.push(r); return r; },
    update(_collection, id, patch) {
      const r = rows.find(x => x.id === id);
      if (!r) return null;
      Object.assign(r, patch);
      return r;
    },
    remove(_collection, id) {
      const i = rows.findIndex(x => x.id === id);
      if (i > -1) rows.splice(i, 1);
    },
  },
};

const log = require('./indicator-log');

function seed(extra = {}) {
  rows.length = 0;
  nextId = 1;
  return require('../db').insert('indicators', {
    detector: 'A', subject: 'nt_open_stock', firstSeenOn: '2026-09-01',
    lastSeenOn: '2026-09-03', status: 'normalised', outcome: null,
    outcomeSource: null, ...extra,
  });
}

// ── The refusals ────────────────────────────────────────────────────────────

test('an omitted `by` is REFUSED, never recorded as Nick', () => {
  // ⚠⚠ The whole point. The old default meant leaving a field out produced a
  // verdict attributed to a person who had not been asked.
  const rec = seed();
  assert.throws(() => log.label(rec.id, { verdict: 'useful' }), /by is required/);
  // And nothing was written on the way out.
  assert.equal(require('../db').find('indicators')[0].outcome, null);
});

test('an empty or null `by` is refused too, not treated as absent-and-fine', () => {
  const rec = seed();
  for (const by of [null, '', undefined]) {
    assert.throws(() => log.label(rec.id, { verdict: 'useful', by }), /by is required/);
  }
});

test('"auto" cannot be forged through the human door', () => {
  // The automatic path writes its own label in observeOutcomes. Accepting it
  // here would be the same forgery in the other direction — a caller inventing
  // a system outcome.
  const rec = seed();
  assert.throws(() => log.label(rec.id, { verdict: 'useful', by: 'auto' }),
    /cannot be set here/);
  assert.throws(() => log.label(rec.id, { verdict: 'useful', by: 'system' }),
    /must be one of/);
});

test('an unknown attribution is refused rather than stored as free text', () => {
  const rec = seed();
  assert.throws(() => log.label(rec.id, { verdict: 'useful', by: 'someone else' }),
    /must be one of/);
});

test('a relayed verdict must record what Nick actually said', () => {
  // ⚠ The note is the only thing that makes "based on Nick's explicit
  // instruction" checkable rather than asserted. His own verdict needs none —
  // he is the evidence.
  const rec = seed();
  assert.throws(() => log.label(rec.id, { verdict: 'useful', by: 'assistant' }),
    /note is required/);
  assert.throws(() => log.label(rec.id, { verdict: 'useful', by: 'assistant', note: '   ' }),
    /note is required/);
  // Nick's own does not.
  assert.doesNotThrow(() => log.label(rec.id, { verdict: 'useful', by: 'nick' }));
});

test('an unknown verdict is still refused, before anything else', () => {
  const rec = seed();
  assert.throws(() => log.label(rec.id, { verdict: 'probably', by: 'nick' }),
    /verdict must be one of/);
});

// ── What gets stored ────────────────────────────────────────────────────────

test('Nick\'s own verdict stores the source the ledger has always used', () => {
  // ⚠ 'human' is PRESERVED rather than renamed: existing rows carry it and
  // observeOutcomes keys on it, so a new value would silently un-stick every
  // historical verdict.
  const rec = seed();
  log.label(rec.id, { verdict: 'useful', by: 'nick', actionTaken: 'called the team' });
  const [after] = require('../db').find('indicators');
  assert.equal(after.outcome, 'useful');
  assert.equal(after.outcomeSource, 'human');
  assert.equal(after.outcomeBy, 'nick');
  assert.equal(after.actionTaken, 'called the team');
});

test('a relayed verdict is stored as ASSISTANT, not as Nick', () => {
  const rec = seed();
  log.label(rec.id, { verdict: 'useful', by: 'assistant', note: 'Nick said he acted on this on Tuesday' });
  const [after] = require('../db').find('indicators');
  assert.equal(after.outcomeSource, 'assistant',
    'a relayed verdict was recorded as one of Nick\'s own');
  assert.equal(after.outcomeBy, 'assistant');
  assert.match(after.outcomeNote, /Tuesday/);
});

test('outcomeSource is DERIVED, so it cannot be claimed in the body', () => {
  // A caller saying by="assistant" must not be able to have it stored as human.
  const rec = seed();
  log.label(rec.id, { verdict: 'false', by: 'assistant', note: 'he said it was a false alarm', outcomeSource: 'human' });
  assert.equal(require('../db').find('indicators')[0].outcomeSource, 'assistant');
});

// ── The automatic path must not overwrite either ────────────────────────────

test('the automatic label never overwrites a RELAYED verdict', () => {
  // ⚠ An assistant-recorded verdict carries the same information Nick's own
  // does — that he acted, so the predicted episode never arrived. Letting the
  // automatic path overwrite it would record a warning that WORKED as a false
  // positive, which is exactly what the human override exists to prevent.
  const relayed = {
    id: 1, detector: 'A', subject: 'nt_open_stock', firstSeenOn: '2026-09-01',
    status: 'normalised', outcome: 'useful', outcomeSource: 'assistant',
  };
  const updates = log.observeOutcomes([relayed], [], '2026-10-01');
  assert.equal(updates.length, 0, 'the automatic path overruled a person');
});

test('a pending record with no verdict is still settled automatically', () => {
  // The positive control: the guard must not have switched the automatic path
  // off altogether.
  const pending = {
    id: 2, detector: 'A', subject: 'nt_open_stock', firstSeenOn: '2026-09-01',
    status: 'normalised', outcome: null, outcomeSource: null,
  };
  const updates = log.observeOutcomes([pending], [], '2026-10-01');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.outcomeSource, 'auto');
});

// ── The scoreboard reports its own basis ────────────────────────────────────

test('the scoreboard separates Nick\'s verdicts from relayed and automatic ones', () => {
  // ⚠ Without this the provenance would be stored and read by nothing — and a
  // precision figure that folds three kinds of evidence together hides its own
  // basis, which is the same failure as hiding the denominator.
  rows.length = 0;
  nextId = 1;
  const db = require('../db');
  db.insert('indicators', { detector: 'A', outcome: 'useful', outcomeSource: 'human', actualLeadDays: 4 });
  db.insert('indicators', { detector: 'A', outcome: 'useful', outcomeSource: 'assistant', actualLeadDays: 2 });
  db.insert('indicators', { detector: 'A', outcome: 'false', outcomeSource: 'auto' });
  db.insert('indicators', { detector: 'A', outcome: null, outcomeSource: null });
  // A row from before provenance was required.
  db.insert('indicators', { detector: 'A', outcome: 'inconclusive', outcomeSource: null });

  const [a] = log.scoreboard();
  assert.equal(a.settled, 4);
  assert.equal(a.pending, 1);
  assert.equal(a.settledByNick, 1);
  assert.equal(a.settledByAssistant, 1);
  assert.equal(a.settledAuto, 1);
  // ⚠ Not counted as Nick's. An outcome with no source this can name is its own
  // fact, and folding it into his is the attribution this change exists to stop.
  assert.equal(a.settledUnattributed, 1);
  assert.equal(
    a.settledByNick + a.settledByAssistant + a.settledAuto + a.settledUnattributed,
    a.settled,
    'the provenance split must account for every settled record');
});
