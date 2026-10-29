'use strict';

/**
 * SFIA 9 reference data, as far as this repo may hold it (29 Oct 2026).
 *
 * ⚠ The repo is PUBLIC and the SFIA licence does not allow republishing the
 * framework's text. So this file holds only the LEVEL NAMES and the five
 * generic attribute NAMES — the vocabulary needed to label things — and never a
 * skill description or level description.
 *
 * Skill codes are checked against a PRIVATE catalogue on the Pi when one is
 * present: `backend/data/sfia9-catalogue.json` (gitignored with the rest of
 * data/), shaped `{ "skills": [{ "code": "ITMG", "name": "..." }, ...] }`.
 * Without it a code is reported as NOT CHECKED, never as valid — an unverified
 * code is a model's claim, and a profile built on an invented code would carry
 * that invention into every assessment made against it.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = Object.freeze({
  1: 'Follow', 2: 'Assist', 3: 'Apply', 4: 'Enable',
  5: 'Ensure, advise', 6: 'Initiate, influence', 7: 'Set strategy, inspire, mobilise',
});

const ATTRIBUTES = Object.freeze([
  { key: 'autonomy', name: 'Autonomy' },
  { key: 'influence', name: 'Influence' },
  { key: 'complexity', name: 'Complexity' },
  { key: 'knowledge', name: 'Knowledge' },
  { key: 'business_skills', name: 'Business skills' },
]);

const CODE_RE = /^[A-Z]{4}$/;

let cache = null;
function catalogue(file = process.env.SFIA_CATALOGUE_PATH || path.join(__dirname, '..', 'data', 'sfia9-catalogue.json')) {
  if (cache && cache.file === file) return cache.value;
  let value = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const skills = Array.isArray(j?.skills) ? j.skills : [];
    const map = new Map();
    for (const s of skills) {
      const code = String(s?.code || '').toUpperCase();
      if (CODE_RE.test(code)) map.set(code, String(s.name || '').trim() || code);
    }
    value = map.size ? map : null;
  } catch { value = null; }
  cache = { file, value };
  return value;
}

/** 'verified' | 'unknown-code' | 'not-checked'. Pure given the catalogue. */
function checkCode(code, cat = catalogue()) {
  if (!CODE_RE.test(String(code || ''))) return 'unknown-code';
  if (!cat) return 'not-checked';
  return cat.has(code) ? 'verified' : 'unknown-code';
}

const levelName = (n) => LEVELS[n] || null;

module.exports = { LEVELS, ATTRIBUTES, CODE_RE, catalogue, checkCode, levelName, _reset: () => { cache = null; } };
