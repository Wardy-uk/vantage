'use strict';

/**
 * Pins the coaching layer's two load-bearing properties: the prompt says what it
 * is supposed to say, and the store survives a round trip.
 *
 * No model is called. `buildMessages` is pure precisely so the framing can be
 * asserted without spending a token — and the framing is the product.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The store needs `better-sqlite3`, which is built natively on the Pi and does
 * not compile on every dev machine. The prompt tests are the ones that matter
 * most and are pure, so they run everywhere; the store tests skip loudly rather
 * than failing the suite on a machine that was never going to run the service.
 */
let storeReady = true;
let db;
try {
  db = require('../db');
  db.init(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-')), 'test.db'));
} catch (err) {
  storeReady = false;
  console.log(`[skip] store tests: ${err.message.split('\n')[0]}`);
}

const coach = require('./coach');

// ── The prompt ───────────────────────────────────────────────────────────────

test('the coach is told not to be reassuring by default', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // A coach that agrees with him is worth nothing against the doubt he is
  // actually facing. If this drifts, the tool becomes comfortable and useless.
  assert.match(system.content, /Do NOT be reassuring by default/);
  assert.match(system.content, /Notice avoidance specifically/);
  assert.match(system.content, /ONE question at a time/);
});

test('the situation carries the real test, not just the PIP actions', () => {
  const [system] = coach.buildMessages({ mode: 'coach', history: [], signals: null });
  // \s+ across the line breaks: the prompt is a wrapped template literal, and a
  // regex that only matches one particular wrapping would fail on a reflow that
  // changed nothing about the meaning.
  assert.match(system.content, /survives the\s+removal of scrutiny/);
  assert.match(system.content, /did not surface the review's findings himself/);
});

test('unavailable signals are stated, and inventing numbers is forbidden', () => {
  const [system] = coach.buildMessages({
    mode: 'coach', history: [], signals: { available: false, reason: 'NOVA unreachable' },
  });
  assert.match(system.content, /SERVICE DESK SIGNALS: unavailable \(NOVA unreachable\)/);
  assert.match(system.content, /Do not invent numbers/);
});

test('available signals are included but the coach is told not to recite them', () => {
  const [system] = coach.buildMessages({
    mode: 'coach', history: [],
    signals: { available: true, asOf: '2026-08-18T12:00:00Z', summary: '- Open with no assignee: 9' },
  });
  assert.match(system.content, /Open with no assignee: 9/);
  assert.match(system.content, /he has seen them/);
});

test('each mode contributes its own instruction', () => {
  const prep = coach.buildMessages({ mode: 'prep', history: [], signals: null })[0].content;
  assert.match(prep, /including their strongest\s+objection/, 'prep must not play a soft version of the other person');

  const reflect = coach.buildMessages({ mode: 'reflect', history: [], signals: null })[0].content;
  assert.match(reflect, /you are discounting it/, 'he under-credits delivery');
});

test('history is trimmed but the system prompt always survives', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: `m${i}` }));
  const msgs = coach.buildMessages({ mode: 'coach', history, signals: null });
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs.length < 40, 'old turns are dropped');
  assert.equal(msgs.at(-1).content, 'm59', 'the most recent turn is kept');
});

// ── The store ────────────────────────────────────────────────────────────────

test('sessions and observations round-trip', { skip: !storeReady }, () => {
  const s = coach.createSession({ title: 'Chris 1:1', mode: 'prep' });
  assert.equal(s.mode, 'prep');
  assert.deepEqual(s.messages, []);

  assert.ok(coach.listSessions().some(x => x.id === s.id));

  const o = coach.addObservation({ kind: 'avoidance', note: 'Built a dashboard instead of calling Ricky' });
  assert.equal(o.kind, 'avoidance');
  assert.equal(coach.listObservations({ kind: 'avoidance' }).length, 1);

  coach.deleteSession(s.id);
  assert.equal(coach.getSession(s.id), null);
});

test('an unknown observation kind is refused rather than stored', { skip: !storeReady }, () => {
  assert.throws(() => coach.addObservation({ kind: 'vibes', note: 'x' }), /kind must be one of/);
  assert.throws(() => coach.addObservation({ kind: 'pattern', note: '  ' }), /note is required/);
});

test('an unknown mode is refused — a typo must not silently become "coach"', { skip: !storeReady }, () => {
  assert.throws(() => coach.createSession({ mode: 'therapy' }), /Unknown mode/);
});
