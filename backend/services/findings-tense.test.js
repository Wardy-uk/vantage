'use strict';

/**
 * A legacy finding can be given a tense (fix c).
 *
 * `update`'s whitelist excluded `tense`, and the consequence was not cosmetic:
 * `criticality.assess` reads the tense to decide whether a finding is written
 * straight into Nick's task list or waits in the approval queue. Ten live rows
 * carry no tense — nine created 19 Aug before the field existed, one logged
 * from a stale browser tab on 1 Sep — so they could only ever route `pending`,
 * for ever, with nothing able to say otherwise.
 *
 * Scratch database: VANTAGE_DB_PATH is set before anything loads.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.VANTAGE_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-tense-')), 'a.db');

// The store needs `better-sqlite3`, built natively on the Pi and absent on a
// Windows checkout. The store tests skip LOUDLY rather than silently passing;
// the vocabulary tests below are pure and run everywhere.
let storeReady = true;
let db;
try {
  db = require('../db');
  db.init(process.env.VANTAGE_DB_PATH);
} catch (err) {
  storeReady = false;
  console.log(`[skip] findings-tense store tests: ${err.message.split('\n')[0]}`);
}

const findings = require('./findings');
const criticality = require('./criticality');

/** A row shaped like the nine legacy ones: no tense key at all. */
function legacyFinding() {
  const f = findings.add({ title: `Legacy ${Math.random()}`, detail: 'x', source: 'NOVA', severity: 'high' });
  return f;
}

test('a finding created without a tense has none — the state being fixed', { skip: !storeReady }, () => {
  const f = legacyFinding();
  assert.strictEqual(f.tense, null);
  assert.strictEqual(criticality.assess({ severity: f.severity, tense: f.tense, source: f.source }).route, 'pending');
});

test('the tense can now be set, and it changes where the finding routes', { skip: !storeReady }, () => {
  const f = legacyFinding();
  const updated = findings.update(f.id, { tense: 'happened' });
  assert.strictEqual(updated.tense, 'happened');

  // The whole point: high severity + already gone wrong now goes direct.
  const v = criticality.assess({ severity: updated.severity, tense: updated.tense, source: updated.source });
  assert.strictEqual(v.route, 'direct');
});

test('all three tenses are accepted', { skip: !storeReady }, () => {
  for (const t of findings.TENSES) {
    const f = legacyFinding();
    assert.strictEqual(findings.update(f.id, { tense: t }).tense, t);
  }
});

test('it can be cleared, because disagreeing without knowing the answer is allowed', { skip: !storeReady }, () => {
  const f = legacyFinding();
  findings.update(f.id, { tense: 'could' });
  assert.strictEqual(findings.update(f.id, { tense: null }).tense, null);
});

test('⚠ an unrecognised tense is REFUSED, not silently nulled', { skip: !storeReady }, () => {
  // The opposite of `add`, deliberately. `add` takes a machine payload and
  // nulling an unknown is the safe read of one; an update is a person making a
  // statement, and quietly clearing the tense they meant to set would look
  // exactly like the bug this fixes.
  const f = legacyFinding();
  findings.update(f.id, { tense: 'happening' });
  assert.throws(() => findings.update(f.id, { tense: 'imminent' }), /tense must be one of/);
  assert.strictEqual(db.findOne('findings', x => x.id === f.id).tense, 'happening', 'the refusal must not half-apply');
});

test('add and update validate against the SAME list', () => {
  // Two copies is how a value one half accepts becomes one the other drops.
  const src = fs.readFileSync(path.join(__dirname, 'findings.js'), 'utf-8');
  const literals = src.match(/\['happened',\s*'happening',\s*'could'\]/g) || [];
  assert.strictEqual(literals.length, 1, 'the tense vocabulary must be declared exactly once');
  assert.deepStrictEqual(findings.TENSES, ['happened', 'happening', 'could']);
});

test('updating the tense does not disturb anything else on the finding', { skip: !storeReady }, () => {
  const f = findings.add({
    title: 'Keeps its other fields', detail: 'detail text', source: 'NOVA',
    severity: 'high', foundOn: '2026-08-19', raisedWith: 'Chris', raisedOn: '2026-08-20',
  });
  const after = findings.update(f.id, { tense: 'happened' });
  assert.strictEqual(after.title, 'Keeps its other fields');
  assert.strictEqual(after.detail, 'detail text');
  assert.strictEqual(after.severity, 'high');
  assert.strictEqual(after.found_on, '2026-08-19');
  assert.strictEqual(after.raised_with, 'Chris');
  assert.strictEqual(after.status, 'raised');
});

// ---------------------------------------------------------------------------
// Pure — runs without the native store
// ---------------------------------------------------------------------------

test('tense is on the update whitelist', () => {
  // The whole fix in one assertion, and it needs no database: the field was
  // filtered out before it ever reached the store.
  const src = fs.readFileSync(path.join(__dirname, 'findings.js'), 'utf-8');
  const whitelist = src.match(/const allowed = \[([^\]]*)\]/);
  assert.ok(whitelist, 'update must still have a whitelist');
  assert.ok(/'tense'/.test(whitelist[1]), 'tense must be settable');
  // Positive control: the scan is reading the real list.
  assert.ok(/'severity'/.test(whitelist[1]));
});

test('an unrecognised tense is refused rather than nulled — the code path', () => {
  const src = fs.readFileSync(path.join(__dirname, 'findings.js'), 'utf-8');
  const block = src.slice(src.indexOf("if ('tense' in clean)"), src.indexOf('clean.updated_at'));
  assert.match(block, /throw new Error/);
  assert.match(block, /null to clear/);
});
