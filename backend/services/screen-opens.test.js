'use strict';

/**
 * ⚠ It drives a FAKE store, not `../db`. `better-sqlite3` is native and builds
 * only on the Pi, so a test that opened the real store would be a test nobody
 * can run on the machine the code is written on — and an unrunnable guard is
 * documentation. The store's job here is `insert` / `find` / `remove`, which is
 * three lines to stand up; what is worth pinning is the DECISIONS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const screens = require('./screen-opens');

/** The three methods this service uses, and nothing else. */
function fakeStore() {
  const rows = [];
  let id = 1;
  return {
    rows,
    insert: (collection, row) => { rows.push({ ...row, collection, id: id++ }); return row; },
    find: (collection) => rows.filter(r => r.collection === collection),
    remove: (collection, pred) => {
      const doomed = rows.filter(r => r.collection === collection && pred(r));
      for (const d of doomed) rows.splice(rows.indexOf(d), 1);
      return doomed.length;
    },
  };
}

test('a real view is recorded with a LOCAL date and a local hour', () => {
  const db = fakeStore();
  assert.deepEqual(
    screens.record('radar', new Date(2026, 8, 17, 14, 30), db),
    { ok: true, kind: 'opened', recorded: 1 },
    'and it defaults to an OPEN, which is what every row written before 18 Sep 2026 is'
  );

  const rows = screens.list(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].screen, 'radar');
  assert.equal(rows[0].date_key, '2026-09-17');
  assert.equal(rows[0].hour, 14);
  assert.equal(rows[0].kind, 'opened');
});

test('⚠ the date key is LOCAL, never toISOString() — a late evening stays on its own day', () => {
  // NEURO builds a WEEK grid from these, so an evening filed a day late lands
  // in the wrong column — and on a Sunday, in the wrong week entirely.
  //
  // ⚠ THIS TEST USED TO BE A DATE BOMB, TWICE, AND THE SECOND TIME IS THE
  // INTERESTING ONE. The first cut asserted that 23:30 on 17 Sep is "the 18th
  // in UTC", which fails outright on a machine running UTC. The SECOND cut
  // fixed that by branching on the offset — and got the DIRECTION backwards:
  // ahead of UTC (BST, +1) a late evening is still the same UTC day (23:30
  // local is 22:30Z) and it is EARLY MORNING that rolls BACK (00:30 local is
  // 23:30Z yesterday). Behind UTC it is the other way round. A test whose truth
  // depends on the host's timezone proves nothing about the code, so the rule
  // is asserted directly (the key is built from LOCAL components, at every hour
  // of a day) and the divergence from toISOString is demonstrated only from the
  // machine's OWN offset — with a positive control that fails loudly if the
  // chosen instant does not actually straddle.
  for (const hour of [0, 1, 12, 22, 23]) {
    const d = new Date(2026, 8, 17, hour, 30);
    assert.equal(screens.dateKey(d), '2026-09-17', `hour ${hour} belongs to its own local day`);
  }

  const offsetMin = -new Date(2026, 8, 17, 12).getTimezoneOffset();
  if (offsetMin === 0) {
    // On UTC there is no moment where the two disagree, so there is nothing to
    // demonstrate — and pretending otherwise is what broke this test.
    assert.equal(screens.dateKey(new Date(2026, 8, 17, 23, 30)), '2026-09-17');
    return;
  }
  // Ahead of UTC, EARLY MORNING falls back to yesterday; behind it, LATE
  // EVENING runs forward into tomorrow.
  const straddles = offsetMin > 0 ? new Date(2026, 8, 17, 0, 30) : new Date(2026, 8, 17, 23, 30);
  assert.notEqual(
    straddles.toISOString().slice(0, 10),
    '2026-09-17',
    'positive control — at this offset that instant really is a different UTC day'
  );
  assert.equal(screens.dateKey(straddles), '2026-09-17', 'and the key stays on the local day');
});

test('the view name is normalised, so a capitalised tab is not a second screen', () => {
  const db = fakeStore();
  assert.deepEqual(screens.record('  Findings  ', new Date(2026, 8, 17, 9), db), { ok: true, kind: 'opened', recorded: 1 });
  assert.ok(screens.list(db).some(r => r.screen === 'findings'));
});

test('⚠ an unrecognised view is REFUSED, never stored', () => {
  const db = fakeStore();
  const out = screens.record('definitely-not-a-view', new Date(2026, 8, 17, 9), db);
  assert.equal(out.ok, false);
  assert.match(out.reason, /unknown view/);
  assert.equal(screens.list(db).length, 0, 'a row nobody can trace to a view is worse than a missing one');
});

test('an empty or missing name is refused and says so', () => {
  const db = fakeStore();
  for (const bad of ['', null, undefined, '   ']) {
    assert.equal(screens.record(bad, new Date(), db).ok, false);
  }
  assert.equal(screens.list(db).length, 0);
});

test('⚠ it NEVER throws, whatever it is handed — it must not cost a screen change', () => {
  const db = fakeStore();
  for (const bad of [{}, [], 42, true]) {
    assert.doesNotThrow(() => screens.record(bad, new Date(), db));
  }
  // Including a store that has fallen over underneath it.
  const broken = { insert() { throw new Error('disk gone'); }, find() { return []; }, remove() { return 0; } };
  const out = screens.record('radar', new Date(), broken);
  assert.equal(out.ok, false);
  assert.match(out.reason, /disk gone/);
});

test('⚠ it records the SCREEN and nothing about what was on it', () => {
  const db = fakeStore();
  screens.record('coach', new Date(2026, 8, 17, 11), db);
  const row = screens.list(db)[0];
  assert.deepEqual(
    Object.keys(row).filter(k => k !== 'collection' && k !== 'id').sort(),
    ['at', 'count', 'date_key', 'hour', 'kind', 'screen'],
    'a navigation log carrying a finding id or a session would be a record of what he was worried about'
  );
  // Stated as a denylist too, so a future field has to be justified rather
  // than merely added to the list above.
  const serialised = JSON.stringify(row).toLowerCase();
  for (const forbidden of ['path', 'url', 'query', 'finding', 'session', 'title', 'detail', 'note']) {
    assert.ok(!serialised.includes(forbidden), `a screen open must not carry "${forbidden}"`);
  }
});

test('an INTERACTION is recorded as its own kind, carrying its batch count', () => {
  const db = fakeStore();
  assert.deepEqual(
    screens.record('radar', new Date(2026, 8, 18, 10), db, { kind: 'interacted', count: 12 }),
    { ok: true, kind: 'interacted', recorded: 12 }
  );
  const row = screens.list(db)[0];
  assert.equal(row.kind, 'interacted');
  assert.equal(row.count, 12);
});

test('⚠ an unrecognised KIND is REFUSED, never normalised to an open', () => {
  // Silently filing interactions as opens would inflate the accessed grid with
  // work that belongs in the other one, and nothing downstream could tell.
  const db = fakeStore();
  const out = screens.record('radar', new Date(), db, { kind: 'scrolled' });
  assert.equal(out.ok, false);
  assert.match(out.reason, /unknown kind/);
  assert.equal(screens.list(db).length, 0);
});

test('⚠ a runaway count is clamped, so one row cannot flatten the whole grid', () => {
  const db = fakeStore();
  const out = screens.record('radar', new Date(), db, { kind: 'interacted', count: 999999 });
  assert.equal(out.recorded, screens.MAX_COUNT);
  assert.equal(screens.list(db)[0].count, screens.MAX_COUNT);
});

test('a missing or nonsense count is 1, never 0 — a batch reported badly is still a click', () => {
  const db = fakeStore();
  for (const bad of [undefined, null, 0, -4, 'lots', NaN]) {
    screens.record('radar', new Date(), db, { kind: 'interacted', count: bad });
  }
  for (const row of screens.list(db)) assert.equal(row.count, 1);
});

test('the retention sweep drops rows past the window', () => {
  const db = fakeStore();
  const now = new Date(2026, 8, 17, 12);
  const old = new Date(now);
  old.setDate(old.getDate() - (screens.RETAIN_DAYS + 10));

  screens.record('plan', old, db);
  assert.ok(screens.list(db).some(r => r.date_key === screens.dateKey(old)), 'positive control — it went in');

  screens.prune(now, db);
  assert.ok(!screens.list(db).some(r => r.date_key === screens.dateKey(old)));
});

test('a row still inside the window survives the sweep', () => {
  const db = fakeStore();
  const now = new Date(2026, 8, 17, 12);
  screens.record('plan', new Date(2026, 8, 10, 9), db);
  screens.prune(now, db);
  assert.equal(screens.list(db).length, 1);
});

test('⚠ a row with NO readable date is KEPT — not knowing its age is not evidence it is old', () => {
  const db = fakeStore();
  db.insert(screens.COLLECTION, { screen: 'tracker', hour: 9 });
  screens.prune(new Date(2026, 8, 17, 12), db);
  assert.ok(
    screens.list(db).some(r => r.screen === 'tracker' && !r.date_key),
    'a sweep that removes what it cannot date eventually empties the store'
  );
});

test('the view list matches the app — a screen the shell can reach must be recordable', () => {
  // Read out of VANTAGE's own shell rather than restated here, so a view added
  // there fails HERE rather than silently going unmeasured on NEURO's grid.
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'App.jsx'), 'utf8');
  const nav = app.match(/tab === '([a-z-]+)'/g) || [];
  const reachable = [...new Set(nav.map(m => m.match(/'([a-z-]+)'/)[1]))];

  assert.ok(reachable.length >= 5, 'positive control — the scan found the shell\'s tabs');
  for (const view of reachable) {
    assert.ok(screens.VIEWS.has(view), `"${view}" is reachable in the app but would be refused here`);
  }
});
