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

  plan: () => call('/plan'),
  setPlanStatus: (id, patch) => call(`/plan/${id}`, { method: 'PUT', body: patch }),
  planTasks: (rematch = false) => call(`/plan/tasks${rematch ? '?rematch=1' : ''}`),
  createPlanTask: (id, body = {}) => call(`/plan/${id}/task`, { method: 'POST', body }),
  linkPlanTask: (id, taskId) => call(`/plan/${id}/link`, { method: 'POST', body: { taskId } }),
  adoptPlannerTask: (id, item) => call(`/plan/${id}/planner`, { method: 'POST', body: item }),
  unlinkPlanTask: id => call(`/plan/${id}/link`, { method: 'DELETE' }),

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

  observations: kind => call(`/observations${kind ? `?kind=${kind}` : ''}`),
  addObservation: (kind, note, sessionId) =>
    call('/observations', { method: 'POST', body: { kind, note, sessionId } }),
  deleteObservation: id => call(`/observations/${id}`, { method: 'DELETE' }),
};
