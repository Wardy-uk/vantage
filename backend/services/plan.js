'use strict';

/**
 * The Support Review improvement plan, as tracked delivery.
 *
 * The review produced 35 actions across four horizons and 13 measures of
 * success. As a Word document it is a list of good intentions; the difference
 * between that and delivery is whether anyone can say, on any given day, what
 * has moved.
 *
 * Two decisions that matter:
 *
 * - **Ownership is recorded honestly.** Roughly half these actions sit above
 *   Nick — release gates, pay and progression, capacity models, Development
 *   responsiveness. Marking those "not started" against his name would be
 *   dishonest in both directions: it overstates his failure and understates the
 *   real blocker. `owner` is one of mine / shared / above, and "escalated and
 *   waiting" is a legitimate terminal state for an `above` item.
 *
 * - **The seed is fixed, the status is not.** The 35 actions are the review's,
 *   verbatim in substance, and are not editable — rewriting the plan you are
 *   being measured against is the wrong instinct. Status, notes and evidence
 *   are Nick's to maintain.
 */

const db = require('../db');

const STATUSES = ['not-started', 'in-progress', 'blocked', 'escalated', 'done'];
const OWNERS = ['mine', 'shared', 'above'];

/**
 * The plan as written, w/c 3 Aug 2026.
 *
 * `id` is stable and used to attach status, so re-seeding never orphans work.
 */
const PLAN = [
  // Quick wins — first 2 weeks
  { id: 'Q1', horizon: 'quick', owner: 'above', title: 'Communicate the review action plan to all teams' },
  { id: 'Q2', horizon: 'quick', owner: 'mine', title: 'Single view of aged, blocked and cross-team tickets' },
  { id: 'Q3', horizon: 'quick', owner: 'mine', title: 'Daily cross-functional blocker review' },
  { id: 'Q4', horizon: 'quick', owner: 'shared', title: 'Single escalation route for urgent cross-team queries' },
  { id: 'Q5', horizon: 'quick', owner: 'mine', title: 'Visible "known gaps" log — training, docs, access, ownership' },
  { id: 'Q6', horizon: 'quick', owner: 'mine', title: 'Reinstate regular 1:1s for every Customer Care colleague' },
  { id: 'Q7', horizon: 'quick', owner: 'shared', title: 'Pause unsupported handovers into Support' },
  { id: 'Q8', horizon: 'quick', owner: 'shared', title: 'Customers stay on one visible case across Jira spaces' },
  { id: 'Q9', horizon: 'quick', owner: 'mine', title: 'Every escalation shows ask, investigation, blocker, owner, next update' },

  // 30 days — stabilise ownership and operating rhythm
  { id: 'T1', horizon: '30', owner: 'mine', title: 'Publish triage and escalation criteria for every team' },
  { id: 'T2', horizon: '30', owner: 'shared', title: 'Controlled front-door triage with mandatory categorisation' },
  { id: 'T3', horizon: '30', owner: 'mine', title: 'Minimum update standards for tickets passed to T2/T3/Dev/TPJ' },
  { id: 'T4', horizon: '30', owner: 'shared', title: 'Parent customer case with linked internal tasks' },
  { id: 'T5', horizon: '30', owner: 'mine', title: 'Review aged and blocked tickets for missing ownership' },
  { id: 'T6', horizon: '30', owner: 'shared', title: 'Top 10 missing troubleshooting guides, SMEs assigned' },
  { id: 'T7', horizon: '30', owner: 'mine', title: 'Clarify phone cover and queue ownership in Customer Care' },
  { id: 'T8', horizon: '30', owner: 'shared', title: 'Routing rules to suppress non-customer-actionable tickets' },
  { id: 'T9', horizon: '30', owner: 'shared', title: 'Map capacity, roles and product coverage' },
  { id: 'T10', horizon: '30', owner: 'mine', title: 'Review KPIs so they support quality resolution' },

  // 60 days — capability and release readiness
  { id: 'S1', horizon: '60', owner: 'shared', title: 'Structured Customer Care training plan' },
  { id: 'S2', horizon: '60', owner: 'shared', title: 'Product playbooks: Direct Comms, TPJ WordPress, Lead Management' },
  { id: 'S3', horizon: '60', owner: 'above', title: 'Release-readiness checklist for customer-impacting changes' },
  { id: 'S4', horizon: '60', owner: 'mine', title: 'Customer-facing update standards for long-running cases' },
  { id: 'S5', horizon: '60', owner: 'above', title: 'Post-launch reviews: email editor, BYM redesign, CRM, MS365' },
  { id: 'S6', horizon: '60', owner: 'shared', title: 'Access review for Customer Care and Tier 2' },
  { id: 'S7', horizon: '60', owner: 'above', title: 'Define Customer Success / CAM responsiveness expectations' },
  { id: 'S8', horizon: '60', owner: 'shared', title: 'Knowledge articles authored or validated by the right specialist' },
  { id: 'S9', horizon: '60', owner: 'mine', title: 'Scenario-based refreshers for repeated questions' },

  // 90 days — embed and measure
  { id: 'N1', horizon: '90', owner: 'above', title: 'Monthly Support Operating Review' },
  { id: 'N2', horizon: '90', owner: 'shared', title: 'Formal knowledge management process' },
  { id: 'N3', horizon: '90', owner: 'above', title: 'Review role profiles, senior responsibilities, progression' },
  { id: 'N4', horizon: '90', owner: 'mine', title: 'Measure impact using agreed operational indicators' },
  { id: 'N5', horizon: '90', owner: 'mine', title: 'Support performance dashboard: aged, queue time, handbacks, waiting, repeats' },
  { id: 'N6', horizon: '90', owner: 'above', title: 'Release governance forum / project gate' },
  { id: 'N7', horizon: '90', owner: 'above', title: 'Medium-term capacity and capability model' },
];

const HORIZONS = {
  quick: 'Quick wins — first 2 weeks',
  30: '30 days — stabilise ownership and operating rhythm',
  60: '60 days — capability and release readiness',
  90: '90 days — embed and measure',
};

/** The 13 measures, with whether VANTAGE can currently measure them. */
const MEASURES = [
  { id: 'M1', text: 'Aged/blocked tickets with no named case owner', measurable: true },
  { id: 'M2', text: 'Tickets recreated across Jira spaces', measurable: false },
  { id: 'M3', text: 'Tickets returned without clear guidance', measurable: true },
  { id: 'M4', text: 'Handbacks, queue moves, repeat customer chases', measurable: true },
  { id: 'M5', text: 'Average time in queue/status', measurable: false },
  { id: 'M6', text: 'Non-customer-actionable tickets reaching Customer Care', measurable: false },
  { id: 'M7', text: 'Troubleshooting guides and playbooks created', measurable: false },
  { id: 'M8', text: 'Nova deflection and resolution rate', measurable: true },
  { id: 'M9', text: 'Releases completing readiness checks', measurable: false },
  { id: 'M10', text: 'Update quality: owner, next action, next update date', measurable: false },
  { id: 'M11', text: 'Team feedback on workload, cadence and support', measurable: false },
  { id: 'M12', text: 'Staffing, skills and product complexity aligned', measurable: false },
  { id: 'M13', text: 'Dependency on individual knowledge holders reduced', measurable: false },
];

function statuses() {
  const row = db.findOne('plan', () => true);
  return row?.items || {};
}

function list() {
  const saved = statuses();
  const items = PLAN.map(p => ({
    ...p,
    horizonLabel: HORIZONS[p.horizon],
    ...(saved[p.id] || { status: 'not-started', note: '', updated_at: null }),
  }));

  const counts = STATUSES.reduce((acc, s) => ({ ...acc, [s]: items.filter(i => i.status === s).length }), {});
  const mine = items.filter(i => i.owner === 'mine');

  return {
    items,
    horizons: HORIZONS,
    counts,
    // Progress on what is actually his, reported separately. A single percentage
    // across all 35 would be dragged down by items he cannot start.
    mine: {
      total: mine.length,
      done: mine.filter(i => i.status === 'done').length,
      moving: mine.filter(i => ['in-progress', 'done'].includes(i.status)).length,
    },
    measures: MEASURES,
    measurable: MEASURES.filter(m => m.measurable).length,
  };
}

function setStatus(id, { status, note } = {}) {
  if (!PLAN.some(p => p.id === id)) throw new Error(`Unknown plan item "${id}"`);
  if (status && !STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);

  const row = db.findOne('plan', () => true);
  const items = { ...(row?.items || {}) };
  items[id] = {
    ...(items[id] || {}),
    ...(status ? { status } : {}),
    ...(note !== undefined ? { note } : {}),
    updated_at: new Date().toISOString(),
  };

  if (row) db.update('plan', row.id, { items });
  else db.insert('plan', { items });
  return list();
}

module.exports = { list, setStatus, PLAN, MEASURES, HORIZONS, STATUSES, OWNERS };
