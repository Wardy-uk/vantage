'use strict';

/**
 * The weighting (item 12).
 *
 * What is pinned here is the ASYMMETRY, because that is the decision and the
 * thresholds are only its consequence:
 *
 *   • a wrong `direct` puts work in Nick's list he did not ask for, at the
 *     moment he is deciding what to do next — the failure that got NEURO's
 *     auto-promote removed;
 *   • a wrong `pending` delays something urgent until he opens the queue, which
 *     is a real cost, visible, and bounded.
 *
 * So the tests that must not be quietly relaxed are the negative ones: the
 * severe-but-hypothetical finding, and the one nobody has judged.
 *
 * ⚠ There is deliberately NO live-data fixture here. The plan asked for the
 * live severity mix, and the live findings register was read while this was
 * written and holds ZERO rows — so the whole nine-pair vocabulary is enumerated
 * instead. Making up a distribution and calling it measured would be worse than
 * saying that plainly.
 */

const test = require('node:test');
const assert = require('node:assert');

const { assess, isDirect, SEVERITIES, TENSES, DIRECT, PENDING } = require('./criticality');

// ---------------------------------------------------------------------------
// It is pure
// ---------------------------------------------------------------------------

test('the same item always weighs the same, with no clock and no I/O', () => {
  const item = { severity: 'high', tense: 'happened', source: 'radar' };
  const a = assess(item);
  const b = assess({ ...item });
  assert.deepStrictEqual(a, b);
  // And it does not mutate what it was given.
  assert.deepStrictEqual(item, { severity: 'high', tense: 'happened', source: 'radar' });
});

test('every severity/tense pair is answered, and every answer is one of the two routes', () => {
  for (const severity of [...SEVERITIES, undefined, 'nonsense']) {
    for (const tense of [...TENSES, undefined, 'nonsense']) {
      const out = assess({ severity, tense, source: 'radar' });
      assert.ok([DIRECT, PENDING].includes(out.route), `${severity}/${tense} produced ${out.route}`);
      assert.ok(out.basis && out.basis.length > 5, `${severity}/${tense} produced no basis`);
      assert.ok(out.level, `${severity}/${tense} produced no level`);
    }
  }
});

// ---------------------------------------------------------------------------
// What goes direct
// ---------------------------------------------------------------------------

test('high severity and already gone wrong goes straight in', () => {
  const out = assess({ severity: 'high', tense: 'happened', source: 'radar' });
  assert.strictEqual(out.route, DIRECT);
  assert.strictEqual(out.level, 'high');
  assert.match(out.basis, /already gone wrong/);
});

test('high severity and going wrong now goes straight in', () => {
  assert.strictEqual(assess({ severity: 'high', tense: 'happening', source: 'radar' }).route, DIRECT);
});

test("a high-severity finding Nick logged himself goes straight in, whatever its tense", () => {
  // He has already made the judgement this module exists to make. A tool that
  // second-guesses its own user on his own finding is one he routes around.
  for (const tense of [...TENSES, undefined]) {
    assert.strictEqual(assess({ severity: 'high', tense, source: 'manual' }).route, DIRECT, `tense ${tense}`);
  }
});

// ---------------------------------------------------------------------------
// What does NOT — the load-bearing half
// ---------------------------------------------------------------------------

test('a severe thing that has not happened yet WAITS', () => {
  // The one that most looks like it should be direct. Being early is the whole
  // value of the `could` tense, and earliness is not urgency — a hypothetical
  // does not get to write itself into his list while he is not looking.
  const out = assess({ severity: 'high', tense: 'could', source: 'radar' });
  assert.strictEqual(out.route, PENDING);
  assert.strictEqual(out.level, 'high', 'it is still high — the LEVEL and the ROUTE are different facts');
  assert.match(out.basis, /has not happened yet/);
});

test('an unjudged finding waits, and says nobody has judged it', () => {
  const out = assess({ tense: 'happened', source: 'radar' });
  assert.strictEqual(out.route, PENDING);
  assert.match(out.basis, /no severity recorded/);
  // ⚠ Unknown is never treated as LOW. It is unjudged, which is a different
  // fact, and the basis has to say which one it means.
  assert.notStrictEqual(out.level, 'low');
});

test('high severity with no tense at all still waits', () => {
  // "Severe, and nobody has said whether it has happened" is not evidence that
  // it has. Fail towards the queue.
  const out = assess({ severity: 'high', source: 'radar' });
  assert.strictEqual(out.route, PENDING);
  assert.match(out.basis, /whether it has happened/);
});

test('medium and low never go direct, in any tense, from any source', () => {
  for (const severity of ['medium', 'low']) {
    for (const tense of [...TENSES, undefined]) {
      for (const source of ['radar', 'manual', 'support-review', undefined]) {
        assert.strictEqual(assess({ severity, tense, source }).route, PENDING,
          `${severity}/${tense}/${source} must wait`);
      }
    }
  }
});

test('an unrecognised severity is unjudged, not low', () => {
  const out = assess({ severity: 'CRITICAL!!', tense: 'happened' });
  assert.strictEqual(out.route, PENDING);
  assert.match(out.basis, /no severity recorded/);
});

test('an unrecognised tense cannot buy a direct route', () => {
  assert.strictEqual(assess({ severity: 'high', tense: 'imminent', source: 'radar' }).route, PENDING);
});

// ---------------------------------------------------------------------------
// The basis travels
// ---------------------------------------------------------------------------

test('every direct route explains itself in a sentence Nick can read on the task', () => {
  // A task that arrived without being asked for must always be able to answer
  // "why is this here?" — that is what `basis` is for, and it is why this
  // returns three fields rather than a boolean.
  for (const tense of ['happened', 'happening']) {
    const out = assess({ severity: 'high', tense, source: 'radar' });
    assert.match(out.basis, /high severity/);
    assert.doesNotMatch(out.basis, /undefined|null/);
  }
});

test('isDirect agrees with assess, so there is one answer and not two', () => {
  const cases = [
    { severity: 'high', tense: 'happened' },
    { severity: 'high', tense: 'could' },
    { severity: 'low', tense: 'happening' },
    {},
  ];
  for (const c of cases) assert.strictEqual(isDirect(c), assess(c).route === DIRECT);
});
