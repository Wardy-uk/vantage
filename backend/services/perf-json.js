'use strict';

/**
 * Read a model's JSON answer (29 Oct 2026).
 *
 * `response_format: json_object` is a hint, not a contract: Sonnet 4.5 through
 * OpenRouter answered the first live profile request with the JSON wrapped in a
 * ```json fence, and a bare JSON.parse refused a complete, correct answer.
 * Strip one surrounding fence (and nothing else) before parsing. Anything that
 * still is not JSON is refused — never repaired, never half-kept.
 */
function parseModelJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  let t = String(raw ?? '').trim();
  const fenced = t.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) t = fenced[1].trim();
  return JSON.parse(t);
}

module.exports = { parseModelJson };
