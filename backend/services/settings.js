'use strict';

/**
 * Runtime settings, editable from the admin page.
 *
 * Editing a `.env` over SSH to change a model name is the kind of friction that
 * means it never gets changed. So configuration lives in the store, with the
 * environment as a fallback — env wins nothing, but it seeds a fresh install and
 * keeps the existing `.env`-based deploy working unchanged.
 *
 * Secrets are NEVER returned in full. `describe()` reports whether a value is
 * set and shows a masked tail so Nick can tell one key from another; the real
 * value only ever travels inward. A settings page that renders an API key in
 * plain text is one screenshot away from leaking it.
 *
 * The store file lives in `backend/data/`, which is gitignored — the same reason
 * `.env` is. Nothing here is ever committed.
 */

const db = require('../db');

/** `secret: true` means never render it back. */
const FIELDS = {
  OPENROUTER_API_KEY: { secret: true, label: 'OpenRouter API key', hint: 'From openrouter.ai/keys. Coaching does not work without it.' },
  OPENROUTER_MODEL: { secret: false, label: 'Model', hint: 'e.g. anthropic/claude-sonnet-4.5', default: 'anthropic/claude-sonnet-4.5' },
  NOVA_BRIDGE_URL: { secret: false, label: 'NOVA bridge URL', hint: 'Base URL of NOVA. Same value NEURO uses.' },
  NOVA_BRIDGE_SECRET: { secret: true, label: 'NOVA bridge secret', hint: 'Shared secret for /api/neuro-bridge. Same value NEURO uses.' },
  NEURO_URL: { secret: false, label: 'NEURO URL', hint: 'Base URL of NEURO. On the Pi this is http://127.0.0.1:3001.', default: 'http://127.0.0.1:3001' },
  NEURO_API_TOKEN: { secret: true, label: 'NEURO API token', hint: 'NEURO_API_TOKEN from NEURO .env. Machine-to-machine; supplies people, commitments and task signals.' },
  NEURO_VAULT_API_KEY: { secret: true, label: 'NEURO vault API key', hint: 'VAULT_API_KEY from NEURO .env. Separate gate on /api/vault — needed to read meeting notes.' },
};

function stored() {
  return db.findOne('settings', () => true) || null;
}

/**
 * The effective value: store first, then environment, then documented default.
 *
 * Store-over-env is deliberate. Once Nick has set something in the UI, a stale
 * `.env` on the box must not silently override it — that would make the admin
 * page look broken in a way nobody would diagnose quickly.
 */
function get(key) {
  const row = stored();
  const fromStore = row?.values?.[key];
  if (fromStore !== undefined && fromStore !== null && fromStore !== '') return fromStore;
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  return FIELDS[key]?.default ?? null;
}

/** Applies settings onto process.env so existing consumers need no changes. */
function apply() {
  for (const key of Object.keys(FIELDS)) {
    const value = get(key);
    if (value) process.env[key] = value;
  }
}

function mask(value) {
  if (!value) return null;
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** What the admin page renders. Never includes a secret in full. */
function describe() {
  const row = stored();
  return Object.entries(FIELDS).map(([key, spec]) => {
    const value = get(key);
    const source = row?.values?.[key] ? 'saved' : (process.env[key] ? 'environment' : (spec.default ? 'default' : 'unset'));
    return {
      key,
      label: spec.label,
      hint: spec.hint,
      secret: spec.secret,
      isSet: Boolean(value),
      source,
      // A non-secret is shown as-is; a secret only ever as a tail.
      value: spec.secret ? mask(value) : (value || ''),
    };
  });
}

/**
 * Save. An empty string means "leave unchanged", NOT "clear".
 *
 * That distinction matters on this form: every secret renders as a mask, so
 * submitting without retyping the key would otherwise wipe it. Clearing is done
 * explicitly with `null`.
 */
function save(patch = {}) {
  const row = stored();
  const values = { ...(row?.values || {}) };

  for (const [key, value] of Object.entries(patch)) {
    if (!FIELDS[key]) throw new Error(`Unknown setting "${key}"`);
    if (value === null) delete values[key];
    else if (typeof value === 'string' && value.trim() !== '') values[key] = value.trim();
  }

  if (row) db.update('settings', row.id, { values, updated_at: new Date().toISOString() });
  else db.insert('settings', { values, updated_at: new Date().toISOString() });

  apply();
  return describe();
}

/**
 * Change the PIN.
 *
 * Written to `.env` rather than the store, because the PIN is read at STARTUP to
 * decide whether the service may run at all — and that check happens before the
 * store is open. Keeping it in one place stops a saved PIN and an env PIN
 * disagreeing, which would lock Nick out of the only thing that can fix it.
 *
 * Requires the current PIN. The endpoint is already behind PIN auth, so this is
 * belt-and-braces — but the browser holds the PIN in localStorage, and a stale
 * open tab on a shared machine should not be able to silently reassign it.
 *
 * Rewrites the line in place, preserving everything else in the file.
 */
function changePin({ current, next }) {
  const fs = require('fs');
  const path = require('path');

  if (!current || !next) throw new Error('Both the current and new PIN are required.');
  if (current !== process.env.VANTAGE_PIN) throw new Error('Current PIN is incorrect.');
  const trimmed = String(next).trim();
  if (trimmed.length < 6) throw new Error('New PIN must be at least 6 characters.');
  if (trimmed === current) throw new Error('That is already the PIN.');

  const envPath = path.join(__dirname, '..', '.env');
  let contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

  contents = /^VANTAGE_PIN=.*$/m.test(contents)
    ? contents.replace(/^VANTAGE_PIN=.*$/m, `VANTAGE_PIN=${trimmed}`)
    : `VANTAGE_PIN=${trimmed}\n${contents}`;

  fs.writeFileSync(envPath, contents, { mode: 0o600 });
  // Applied to the running process too, so the change takes effect immediately
  // rather than at the next restart — which is when Nick would otherwise
  // discover the old PIN still worked.
  process.env.VANTAGE_PIN = trimmed;

  return { changed: true };
}

module.exports = { FIELDS, get, save, describe, apply, changePin };
