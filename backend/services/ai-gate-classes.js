'use strict';

/**
 * VANTAGE's AI call classes — the names the shared gate admits (22 Oct 2026).
 *
 * The gate itself (ai-gate.js) is a byte-identical copy of NEURO's; this registry
 * is VANTAGE's own. Every model request goes through openrouter.js, which names
 * one of these (`callType`). Bounds are per-request CEILINGS set at each call's own
 * existing max_tokens and a generous input allowance — they refuse only a
 * genuinely unbounded request, never ordinary use. There is no daily volume or
 * spending cap: that is Nick's decision and has not been made.
 */

const REGISTRY = {
  // The radar's meeting analysis: ≤6 notes × 6000 chars + the 1:1 schedule (~10k tokens a pass).
  radar: { local: false, maxInputTokens: 40000, maxOutputTokens: 4000, maxConcurrent: 1 },
  // Coaching brief themes (bounded evidence).
  brief: { local: false, maxInputTokens: 60000, maxOutputTokens: 2500 },
  // Coaching chat: the last 24 messages, each of unbounded length — the class
  // allows the model's full context and the request carries its real estimate.
  coach: { local: false, maxInputTokens: 200000, maxOutputTokens: 2000 },
  // A drafted "raise with Chris" message for one finding.
  findings: { local: false, maxInputTokens: 20000, maxOutputTokens: 400 },
  // A document read into a proposed plan register (≤60k chars in, one call per import, Nick-initiated).
  plan_import: { local: false, maxInputTokens: 25000, maxOutputTokens: 8000 },
  // Performance Evidence (29 Oct 2026): a JD read into a proposed SFIA profile (Nick-initiated),
  // a batch of ≤20 gathered items triaged against the role profiles (capped per day in perf_state.caps),
  // and the full assessment of one role (Nick-initiated).
  perf_profile: { local: false, maxInputTokens: 15000, maxOutputTokens: 4000 },
  perf_evidence: { local: false, maxInputTokens: 12000, maxOutputTokens: 6000, maxConcurrent: 1 },
  perf_assess: { local: false, maxInputTokens: 150000, maxOutputTokens: 4000 },
  // Admin → Test connections (a one-word completion).
  connection_test: { local: false, maxInputTokens: 100, maxOutputTokens: 8 },
};

const CLASS_NAMES = Object.keys(REGISTRY).filter((k) => !k.startsWith('$'));

module.exports = { REGISTRY, CLASS_NAMES };
