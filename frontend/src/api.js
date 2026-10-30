/**
 * API client.
 *
 * The PIN is held in localStorage and sent as a header. That is appropriate for
 * a single-user tool on Nick's own devices and would not be for anything
 * multi-user — there is no session, no rotation and no per-user scope, by design.
 */

const PIN_KEY = 'vantage.pin';

export const getPin = () => localStorage.getItem(PIN_KEY) || '';
export const setPin = pin => localStorage.setItem(PIN_KEY, pin);
export const clearPin = () => localStorage.removeItem(PIN_KEY);

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
export { ApiError };

/**
 * Where the API lives, decided at build time.
 *
 * Two deployments, two answers:
 *
 * - Served BY the Pi at /vantage — same origin, so a relative path. It must
 *   carry the base path: a bare /api would hit NEURO, which sits at the root of
 *   that host.
 * - Served by NETLIFY at vantage.nickward.co.uk — the API is still on the Pi, so
 *   VITE_API_BASE is set to the absolute Funnel URL. That makes every call
 *   cross-origin, which is why the backend keeps an origin allowlist.
 */
const API_BASE = import.meta.env.VITE_API_BASE
  ? import.meta.env.VITE_API_BASE.replace(/\/$/, '')
  : `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Vantage-Pin': getPin(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload?.ok === false) {
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status);
  }
  return payload.data;
}

export const api = {
  health: () => fetch(`${API_BASE}/health`).then(r => r.json()),
  // Which view is on, for NEURO's usage heatmap. Fire and forget at the call
  // site — a usage grid must never be able to cost a screen change.
  screenOpen: screen => call('/screen-open', { method: 'POST', body: { screen } }),
  // A coalesced batch of control uses on a view — the other half of the
  // heatmap. Fire and forget at the call site.
  screenInteract: (screen, count) => call('/screen-interact', { method: 'POST', body: { screen, count } }),
  signals: (refresh = false) => call(`/signals${refresh ? '?refresh=1' : ''}`),
  radar: (refresh = false) => call(`/radar${refresh ? '?refresh=1' : ''}`),

  // Leading indicators. `leadingVerdict` is the one control that makes the
  // prospective ledger work: without it a warning is never judged, and the
  // automatic label records a prevented problem as a false alarm.
  leading: (refresh = false) => call(`/leading${refresh ? '?refresh=1' : ''}`),
  leadingScoreboard: () => call('/leading/scoreboard'),
  // The Daily KPI Tracker, with today beside yesterday in one call.
  tracker: (refresh = false) => call(`/tracker${refresh ? '?refresh=1' : ''}`),
  // `by: 'nick'` is stated explicitly, not defaulted server-side. The default
  // was removed deliberately: a verdict with no stated source would be recorded
  // as his, and this ledger is what decides whether the detectors are worth
  // trusting — a forged verdict corrupts the measurement in the flattering
  // direction, which is the one nobody checks. This call comes from a button in
  // his own browser, so the attribution is a fact rather than an assumption.
  leadingVerdict: (id, body) => call(`/leading/log/${id}/verdict`, { method: 'POST', body: { by: 'nick', ...body } }),

  plan: (refresh = false) => call(`/plan${refresh ? '?refresh=1' : ''}`),

  // Every plan (vault registers). Writes go through NEURO into the register;
  // task writes carry the register's version and answer 409 if it changed.
  plans: (refresh = false) => call(`/plans${refresh ? '?refresh=1' : ''}`),
  planDetail: (id, refresh = false) => call(`/plans/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`),
  plansConsolidated: (refresh = false) => call(`/plans/consolidated${refresh ? '?refresh=1' : ''}`),
  planCandidates: () => call('/plans/candidates'),
  adoptPlan: folder => call('/plans/adopt', { method: 'POST', body: { folder } }),
  planFromPlanner: body => call('/plans/from-planner', { method: 'POST', body }),
  proposeImport: body => call('/plans/import/propose', { method: 'POST', body }),
  saveImport: body => call('/plans/import/save', { method: 'POST', body }),
  rankPlans: order => call('/plans/rank', { method: 'POST', body: { order } }),
  rankTasks: (id, version, order) => call(`/plans/${encodeURIComponent(id)}/tasks/rank`, { method: 'POST', body: { version, order } }),
  // changes: [{ id, to: 'done'|'dropped'|'open' }] or [{ id, status }] (Undo). Returns { version, before }.
  setTaskStatus: (id, version, changes) => call(`/plans/${encodeURIComponent(id)}/tasks/status`, { method: 'POST', body: { version, changes } }),
  handoffPreview: id => call(`/plans/${encodeURIComponent(id)}/handoff`),
  handOff: (id, version) => call(`/plans/${encodeURIComponent(id)}/handoff`, { method: 'POST', body: { version } }),
  replanPreview: body => call('/plans/replan/preview', { method: 'POST', body }),
  // changes: [{ id, due: 'YYYY-MM-DD'|null }] or [{ id, dueRaw }] (Undo). Returns { version, before }.
  setTaskDue: (id, version, changes) => call(`/plans/${encodeURIComponent(id)}/tasks/due`, { method: 'POST', body: { version, changes } }),
  starTask: (id, taskId, version, starred) =>
    call(`/plans/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/star`, { method: 'POST', body: { version, starred } }),

  findings: (status) => call(`/findings${status ? '?status=' + status : ''}`),
  addFinding: f => call('/findings', { method: 'POST', body: f }),
  updateFinding: (id, patch) => call(`/findings/${id}`, { method: 'PUT', body: patch }),
  deleteFinding: id => call(`/findings/${id}`, { method: 'DELETE' }),
  draftRaise: (id, to) => call(`/findings/${id}/draft`, { method: 'POST', body: { to } }),
  findingsMarkdown: since => call(`/findings/markdown${since ? '?since=' + since : ''}`),
  escalateFinding: (id, week) => call(`/findings/${id}/neuro`, { method: 'POST', body: week ? { week } : {} }),
  resolveFinding: (id, how) => call(`/findings/${id}/resolve`, { method: 'POST', body: { how } }),
  reopenFinding: id => call(`/findings/${id}/reopen`, { method: 'POST', body: {} }),
  syncFindings: () => call('/findings/sync', { method: 'POST', body: {} }),

  modes: () => call('/coach/modes'),
  brief: (refresh = false) => call(`/coach/brief${refresh ? '?refresh=1' : ''}`),
  startFromTheme: theme => call('/coach/brief/start', { method: 'POST', body: theme }),
  self: () => call('/self'),
  selfQuick: () => call('/self/quick'),
  moved: () => call('/self/moved'),
  friction: () => call('/friction'),
  sessions: () => call('/coach/sessions'),
  session: id => call(`/coach/sessions/${id}`),
  createSession: (title, mode) => call('/coach/sessions', { method: 'POST', body: { title, mode } }),
  deleteSession: id => call(`/coach/sessions/${id}`, { method: 'DELETE' }),
  sendMessage: (id, content) => call(`/coach/sessions/${id}/messages`, { method: 'POST', body: { content } }),

  settings: () => call('/settings'),
  saveSettings: patch => call('/settings', { method: 'PUT', body: patch }),
  changePin: (current, next) => call('/settings/pin', { method: 'POST', body: { current, next } }),
  testSetting: what => call(`/settings/test/${what}`, { method: 'POST' }),
  aiGate: () => call('/ai-gate/profile'),

  observations: kind => call(`/observations${kind ? `?kind=${kind}` : ''}`),
  addObservation: (kind, note, sessionId) =>
    call('/observations', { method: 'POST', body: { kind, note, sessionId } }),
  deleteObservation: id => call(`/observations/${id}`, { method: 'DELETE' }),

  // Performance Evidence (29 Oct 2026).
  perf: () => call('/perf'),
  perfPropose: body => call('/perf/roles/propose', { method: 'POST', body }),
  perfSaveRole: body => call('/perf/roles/save', { method: 'POST', body }),
  perfEvidence: (state, limit = 100, offset = 0, stance) => call(`/perf/evidence?${new URLSearchParams({ ...(state ? { state } : {}), ...(stance ? { stance } : {}), limit, offset })}`),
  perfEvidenceItems: ids => call(`/perf/evidence/items?ids=${ids.join(',')}`),
  perfAcceptAllFor: () => call('/perf/evidence/accept-all-for', { method: 'POST' }),
  perfAdd: body => call('/perf/evidence', { method: 'POST', body }),
  perfUpdate: (id, body) => call(`/perf/evidence/${id}`, { method: 'PUT', body }),
  perfDecide: (id, decision) => call(`/perf/evidence/${id}/decide`, { method: 'POST', body: { decision } }),
  perfDecideBatch: (ids, decision) => call('/perf/evidence/decide-batch', { method: 'POST', body: { ids, decision } }),
  perfCase: (id, inCase, summary) => call(`/perf/evidence/${id}/case`, { method: 'POST', body: { inCase, summary } }),
  perfDelete: id => call(`/perf/evidence/${id}`, { method: 'DELETE' }),
  perfGather: () => call('/perf/gather/run', { method: 'POST' }),
  perfCaps: body => call('/perf/caps', { method: 'PUT', body }),
  perfOverride: on => call('/perf/backfill-override', { method: 'POST', body: { on } }),
  perfAssess: (slot, fresh = false) => call(`/perf/assess/${slot}`, { method: 'POST', body: { fresh } }),
  perfAnnex: body => call('/perf/roles/annex', { method: 'POST', body }),
  perfConfirmRole: (slot, confirmed) => call(`/perf/roles/${slot}/confirmation`, { method: 'POST', body: { confirmed } }),
  perfExport: slot => call(`/perf/export/${slot}`),
  perfCaseView: slot => call(`/perf/case/${slot}`),
  perfCaseDraft: (slot, code = null) => call(`/perf/case/${slot}/draft`, { method: 'POST', body: { code } }),
  perfCaseOpening: (slot, opening) => call(`/perf/case/${slot}/opening`, { method: 'PUT', body: { opening } }),
  perfCaseSkill: (slot, code, body) => call(`/perf/case/${slot}/skill/${code}`, { method: 'PUT', body }),
  perfCaseCandidates: (slot, code) => call(`/perf/case/${slot}/skill/${code}/candidates`),
  perfCaseAdd: (slot, code, id) => call(`/perf/case/${slot}/skill/${code}/add`, { method: 'POST', body: { id } }),
  perfCaseText: slot => call(`/perf/case/${slot}/export`),
  // The Word file comes back as bytes, not JSON (named by the page — a cross-origin page cannot read Content-Disposition); a refusal still comes back as the usual JSON error.
  perfCaseDocx: async slot => {
    const res = await fetch(`${API_BASE}/perf/case/${slot}/export?format=docx`, { headers: { 'X-Vantage-Pin': getPin() } });
    if (!res.ok) { const p = await res.json().catch(() => ({})); throw new ApiError(p?.error || `Request failed (${res.status})`, res.status); }
    return res.blob();
  },
  perfPlan: slot => call(`/perf/plan/${slot}`),
  perfPlanAct: (id, act) => call(`/perf/plan/${id}/${act}`, { method: 'POST' }),
};
