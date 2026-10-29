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
  try { return JSON.parse(t); } catch (first) {
    // Prose around the object ("Here is the profile: {...}"): take the outermost
    // braces. Still JSON.parse — a truncated or malformed object is still refused.
    const a = t.indexOf('{'); const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw first;
  }
}

module.exports = { parseModelJson };
