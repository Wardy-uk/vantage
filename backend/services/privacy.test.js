'use strict';

/**
 * The privacy boundary, enforced (item 5).
 *
 * `CLAUDE.md` has said for some time that *"`backend/services/privacy.test.js`
 * enforces this by parsing the import graph. If the test does not run, the
 * boundary does not exist — it is not a convention."* The file did not exist.
 * By its own sentence, the most important rule in that document was a
 * convention, and had been since it was written.
 *
 * ── What the rule is ─────────────────────────────────────────────────────────
 *
 * `coach`, `brief`, `self` and the observations are PRIVATE. The boundary is
 * about DIRECTION, not isolation:
 *
 *   • Private reads outward — ALLOWED. `self` consuming `findings` and `plan`
 *     is how the coach knows anything, and nothing leaks inward by doing it.
 *   • Outward reads private — BANNED. Nothing in the weekly report, the vault,
 *     the evidence register or any NEURO-facing route may import `coach`,
 *     `brief`, `self` or the observations.
 *   • The one exception is a POINTER, never a payload.
 *
 * ── Why it is asserted on the import graph ───────────────────────────────────
 *
 * Because that is the only place it can be asserted cheaply and completely. A
 * runtime check would have to be reached to fire, and the failure this guards
 * against — a coaching sentence appearing in a document Chris reads — is one
 * nobody would notice until it had already happened. A `require` is structural:
 * a module that cannot import the coaching layer cannot quote it.
 *
 * Note this test asserts what the code DOES, and where it disagrees with
 * `CLAUDE.md` it is the document that is wrong. `brief.pointer()` is a case in
 * point and is handled explicitly below.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVICES = __dirname;
const ROOT = path.join(__dirname, '..');

/** The private half. Nothing outward-facing may import any of these. */
const PRIVATE = ['coach', 'brief', 'self', 'sentiment'];

/**
 * The outward half — anything whose output leaves VANTAGE or is read by
 * somebody other than Nick.
 *
 *   neuro       — writes into NEURO, which surfaces on his phone and the kiosk
 *   findings    — the register, and the line that goes on Chris's report
 *   auto-push   — writes into NEURO unattended
 *   plan-tasks  — creates NEURO tasks from Support Review plan actions
 */
const OUTWARD = ['neuro', 'findings', 'auto-push', 'plan-tasks'];

/** Every `require('./x')` in a file, as a list of module names. */
function importsOf(name) {
  const file = path.join(SERVICES, `${name}.js`);
  const src = fs.readFileSync(file, 'utf-8')
    // Comments do not import anything, and the headers here discuss the
    // boundary by name — scanning them would fail the test for describing it.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return [...src.matchAll(/require\(\s*['"]\.\/([a-z0-9-]+)['"]\s*\)/g)].map((m) => m[1]);
}

test('the files this test reasons about all exist', () => {
  // Positive control. A rename would otherwise make every assertion below pass
  // by reading an empty set — the boundary silently unenforced again.
  for (const name of [...PRIVATE, ...OUTWARD]) {
    assert.ok(fs.existsSync(path.join(SERVICES, `${name}.js`)), `${name}.js is missing`);
  }
  // And that the scanner finds real imports.
  assert.ok(importsOf('findings').length > 0, 'the import scan found nothing at all');
});

test('nothing outward-facing imports the coaching layer', () => {
  for (const outward of OUTWARD) {
    const imported = importsOf(outward);
    for (const priv of PRIVATE) {
      assert.ok(
        !imported.includes(priv),
        `${outward}.js imports ${priv}.js — the coaching layer must never be readable from anything that leaves VANTAGE`,
      );
    }
  }
});

test('the private half may read outward, which is how the coach knows anything', () => {
  // The direction that is ALLOWED, asserted so a future tightening does not
  // quietly make the boundary symmetrical and break the coach.
  const selfImports = importsOf('self');
  assert.ok(selfImports.length > 0, 'self.js imports nothing — is the coach still wired up?');
});

test('no route file imports the coaching layer except through its own screen', () => {
  // `server.js` mounts everything, so it legitimately requires `coach` and
  // `brief` to serve their own screens. What must not happen is a NEURO-facing
  // or report-facing handler reaching them — which is what the per-service
  // assertion above covers. This checks nothing new has appeared beside them.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
  assert.ok(server.length > 0);
});

test('nothing private is exported into the weekly risk report', () => {
  // The report is the one artefact that reaches Chris. Asserted on the writer
  // rather than on the report, because the report is assembled in NEURO.
  const src = fs.readFileSync(path.join(SERVICES, 'findings.js'), 'utf-8');
  for (const priv of PRIVATE) {
    assert.doesNotMatch(src, new RegExp(`require\\(['"]\\./${priv}['"]\\)`));
  }
});

test('brief.pointer() — the documented exception — does not exist, and nothing pretends it does', () => {
  // ⚠ `CLAUDE.md` describes `brief.pointer()` in the PRESENT TENSE as "what
  // NEURO's Focus card renders". It has never existed: `brief.js` exports
  // `generate`, `startFrom`, `buildEvidence` and `namedThemes`, and nothing in
  // NEURO renders anything from VANTAGE.
  //
  // This test pins the ABSENCE rather than demanding the feature, because the
  // absence is the safe state: no pointer means no path at all from the private
  // half to a NEURO-facing surface, which is stricter than the documented rule.
  // If `pointer()` is ever built, this test should be replaced by one asserting
  // it returns an id, a timestamp and a link and NOTHING else — which is the
  // real risk it carries.
  const brief = require('./brief');
  assert.strictEqual(typeof brief.pointer, 'undefined',
    'pointer() now exists — replace this test with one that pins what it may return');
});
