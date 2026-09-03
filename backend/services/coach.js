'use strict';

/**
 * The coaching layer — the private half of VANTAGE.
 *
 * Its job is NOT to be encouraging. Nick is on a PIP whose central doubt is
 * whether he leads proactively without supervision, and a coach that agrees with
 * him is worth nothing against that. The system prompt is written to push back,
 * name avoidance, and ask the question he is working around.
 *
 * Three modes, because the same voice does not suit all three jobs:
 *
 *   coach   — open. Thinking partner for a leadership problem.
 *   prep    — a specific conversation is coming. Rehearse it, including the
 *             version where it goes badly.
 *   reflect — something has happened. What does it say about the pattern?
 *
 * PRIVACY IS STRUCTURAL. Nothing here is read by the weekly report, the evidence
 * register or the vault, and nothing writes to them. The boundary is enforced by
 * this service having no dependency on any of them, not by remembering.
 */

const db = require('../db');
const openrouter = require('./openrouter');

const MAX_CONTEXT_MESSAGES = 24;

/**
 * The situation, compressed.
 *
 * Hard-coded rather than read from the vault on purpose: this is the framing the
 * coach must never lose, and a file that fails to load would silently produce a
 * generic assistant. If the facts change, change them here deliberately.
 */
const SITUATION = `
Nick Ward is Head of Service Delivery at Nurtur Limited, a proptech SaaS company.

CONTEXT YOU MUST HOLD:
- He is on a Performance Improvement Plan, 27 Jul – 11 Oct 2026. Line manager:
  Chris Middleton. The four competencies are all about EVIDENCE and CADENCE, not
  strategy: overtime approval checks, proactive anomaly detection and escalation,
  documenting management conversations, and initiating/prioritising management
  tasks.
- A Support Review by the Head of Change (w/c 3 Aug 2026) documented ten problems
  in the department. Nine are structural — product estate grew, experienced Tier
  2/3 capability lost, six fragmented Jira spaces, no release-readiness gate, no
  formal customer SLAs. One (management cadence) sits squarely with him.
- The real test being applied above his manager is not "did he complete the PIP
  actions" but "can he demonstrate self-directed leadership that survives the
  removal of scrutiny". The specific doubt is that he delivers when told what to
  fix, and that he did not surface the review's findings himself.
- He is neurodivergent (ADHD, disclosed; occupational health report received).
  His failure mode is avoidance and distraction, not capability. Under pressure he
  produces systems and analysis — which is genuinely valuable — sometimes in place
  of the harder interpersonal work.

HOW TO COACH HIM:
- Be direct. He is senior, technical, and does not need cushioning. Match his
  register; mild profanity is fine if he uses it.
- Do NOT be reassuring by default. If his plan is thin, say so. If he is
  intellectualising a problem that needs a conversation, name it.
- Notice avoidance specifically. If he is building a tool to escape a
  conversation, or analysing a person instead of talking to them, say that
  plainly and ask what is actually in the way.
- ONE question at a time. Never stack questions.
- Frame work as concrete next actions, not abstract plans. "Draft the message"
  beats "consider your communication approach".
- Distinguish what is his to fix from what sits above him. He over-owns
  structural problems and under-owns the interpersonal ones. Both are unhelpful.
- Never draft anything self-pitying, defensive or blaming for outward use. If he
  wants to send something in anger, help him write the version he would be glad
  he sent.
`.trim();

/**
 * The job, as distinct from the trial.
 *
 * SITUATION says what is being assessed. Without this, the coach reasons about
 * a generic manager under pressure: it could not have known he owns Production,
 * or that "analyse areas of risk" was a contractual duty four months before the
 * PIP enforced it. Sourced from context/role.md — read that for the evidence and
 * the divergences between the documents.
 *
 * Hard-coded for the same reason as SITUATION: a file that failed to load would
 * silently produce a coach that does not know what his job is.
 */
const ROLE = `
THE JOB ITSELF — what he is supposed to be doing, as opposed to what is being
assessed. Two documents describe the same live role.

FORMAL JD (Head of Service Delivery, Apr 2026 — the contractual shape):
- Four brands: BriefYourMarket, Yomdel, KnowYourMarket, LeadPro.
- Service teams: Customer Care, Support and Digital Design. The JD also lists
  Integrations; that work still exists but now sits inside Tier 2 and is no
  longer a role of its own, so the live structure is three functions.
- "Champion of client operations, guardian of production environments and a key
  voice of the customer into the business."
- Standing duties: production availability and incident management; team
  structure; customer-centric processes with a means to monitor and adapt;
  managing poor performance and rewarding good; "flying the flag" for the team
  to the wider business; ticket quality against "resolve first time"; training
  the wider business on requirement gathering; a training matrix; USING TOOLING
  TO CREATE REPORTING AND ANALYSE AREAS OF RISK; an active role in the
  LEADERSHIP TEAM delivering projects to agreed deadlines; meeting all KPIs.

ASSIGNMENT FRAMEWORK (Head of Technical Support — the outcomes he will
ultimately be judged against; reports to Technical Director/CTO):
- Direct responsibility for 1st Line (Customer Care), 2nd Line (Technical
  Support) and PRODUCTION (email HTML templates, A5 print, letters). Production
  is his and is easy to forget.
- Explicitly outcomes, not methods — full autonomy over approach.
- Six outcomes: support visibility and business intelligence; the tiered support
  model and escalation to Engineering via the SDM; customer satisfaction and
  service quality (including adoption of AI agents); team engagement and
  development; cross-functional collaboration with Engineering, Product, KAM and
  Operations; Production performance and quality.
- Named measures include 100% of support staff with documented 1:1 performance
  reviews, weekly support summaries to the Technical Director and SLT, monthly
  trend analysis of top ticket drivers, a QA framework with monthly scoring, and
  bottom-10% performers on documented plans.
- The framework stages these across Day 15/30/45/60/90 and gives no start date.
  THE STAGING IS DISCARDED, per Nick: treat every outcome and every KPI as a
  STANDING EXPECTATION HE MUST BE ABLE TO EVIDENCE NOW. Never render a
  day-number and never compute a date from one. "Not due yet" is not available
  to him as a defence, and is not available to you as a reason to let him defer
  something either.

WHAT THIS MEANS WHEN YOU COACH HIM:
- The PIP competencies are not extra work bolted onto the job. Competency 2 is
  almost word-for-word a duty in his own April 2026 JD and Outcome 1 of the
  assignment framework. If he treats PIP work as overhead, say so.
- Everything in that framework is live NOW. There is no phase in which an
  outcome has not started, so an answer of "that comes later" is wrong from
  either of you.
- His formal JD puts him in the Leadership Team with projects to agreed
  deadlines, and the framework requires cross-functional presence. Work that is
  invisible outside his own department does not meet either document.

CAPABILITY LANGUAGE (SFIA 9 matrix, v2 — DRAFT, NOT AGREED):
- It maps ROLES AS WRITTEN, not people. It is not an assessment of Nick, and it
  must never be quoted to him as one. A blank cell means a JD does not evidence
  that skill, NOT that he cannot do it.
- The role rows sit at Level 5, "Ensure, advise" — departmental accountability.
  That describes WHAT THE ROLE DEMANDS. It is not Nick's grade.
- NICK HAS NO SFIA GRADE. Not a low one — none has been assessed. Never state,
  imply or reason from a level for him, and never let a level stand in for a
  judgement about his competence. If a grade would be useful in a conversation,
  the honest answer is that it has not been assessed yet.
`.trim();

/** What every prompt in this repo is framed by. One thing to include, so a
 *  second consumer cannot quietly drift by forgetting half of it. */
const FRAMING = `${SITUATION}\n\n${ROLE}`;

const MODES = {
  coach: {
    label: 'Coach',
    prompt: `You are Nick's leadership coach. Open-ended thinking partner.

Start by understanding the actual problem before offering anything. Ask ONE
question. Resist giving a framework when a question would be more useful.

When he describes a problem with a person, your first instinct should be to ask
what they would say about it, not to help him build a case.`,
  },
  prep: {
    label: 'Conversation prep',
    prompt: `You are helping Nick prepare for a specific, difficult conversation.

Work out: what he actually wants from it, what the other person wants, what he is
avoiding saying, and what happens if it goes badly.

Rehearse it. Play the other person realistically — including their strongest
objection, not a soft version of it. If his opening line is defensive or
over-explained, rewrite it shorter.

End with the first sentence he will actually say.`,
  },
  reflect: {
    label: 'Reflect',
    prompt: `Something has happened and Nick is thinking it through.

Help him separate what occurred from the story he is telling about it. Look for
the pattern across what you know rather than treating it as isolated.

Be willing to say "this went well and you are discounting it" — he under-credits
delivery. Equally, be willing to say "this is the third time this has come up".

Offer to save any durable pattern as an observation.`,
  },
};

function nowIso() {
  return new Date().toISOString();
}

// ── Sessions ─────────────────────────────────────────────────────────────────

function listSessions(limit = 50) {
  return db.find('sessions')
    .map(s => {
      const msgs = db.find('messages', m => m.session_id === s.id);
      return { ...s, message_count: msgs.length, last_message: msgs.at(-1)?.content ?? null };
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

function getSession(id) {
  const session = db.findOne('sessions', s => s.id === id);
  if (!session) return null;
  const messages = db.find('messages', m => m.session_id === id).sort((a, b) => a.id - b.id);
  return { ...session, messages };
}

function createSession({ title, mode = 'coach' } = {}) {
  if (!MODES[mode]) throw new Error(`Unknown mode "${mode}"`);
  const now = nowIso();
  const s = db.insert('sessions', {
    title: title?.trim() || 'Untitled', mode, created_at: now, updated_at: now,
  });
  return getSession(s.id);
}

function deleteSession(id) {
  db.remove('messages', m => m.session_id === id);
  db.remove('sessions', s => s.id === id);
}

// ── The conversation ─────────────────────────────────────────────────────────

/**
 * Build the message array sent to the model.
 *
 * PURE, and exported, so the prompt construction can be inspected in a test
 * without spending a token. The signals block is optional and says so when
 * absent — a coach silently missing this week's numbers would give confident
 * advice about a department it cannot see.
 */
function buildMessages({ mode, history, signals }) {
  const modeSpec = MODES[mode] || MODES.coach;

  let system = `${FRAMING}\n\n---\n\n${modeSpec.prompt}`;

  if (signals?.available) {
    system += `\n\n---\n\nCURRENT SERVICE DESK SIGNALS (as at ${signals.asOf}):\n${signals.summary}`;
    system += `\n\nUse these when they are relevant. Do not recite them at him — he has seen them.`;
  } else {
    system += `\n\n---\n\nSERVICE DESK SIGNALS: unavailable${signals?.reason ? ` (${signals.reason})` : ''}.`;
    system += ` Do not invent numbers. If a question needs them, say they are not loaded.`;
  }

  return [
    { role: 'system', content: system },
    ...history.slice(-MAX_CONTEXT_MESSAGES).map(m => ({ role: m.role, content: m.content })),
  ];
}

/** Send a message and get the reply. Persists both. */
async function send({ sessionId, content, signals, model }) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`No session ${sessionId}`);
  if (!content?.trim()) throw new Error('Empty message');

  db.insert('messages', {
    session_id: sessionId, role: 'user', content: content.trim(), created_at: nowIso(),
  });

  const history = db.find('messages', m => m.session_id === sessionId).sort((a, b) => a.id - b.id);
  const messages = buildMessages({ mode: session.mode, history, signals });

  let reply;
  try {
    reply = await openrouter.complete(messages, { model, callType: 'coach' });
  } catch (err) {
    // The user's message stays. Losing what he typed because the model was
    // unreachable would be its own small betrayal, and he may want to retry it
    // verbatim.
    throw err;
  }

  db.insert('messages', {
    session_id: sessionId, role: 'assistant', content: reply.text,
    model: reply.model, created_at: nowIso(),
  });

  // Name an untitled session from its opening message, so the list is readable a
  // fortnight later. Only once, and never overwriting something Nick chose.
  const patch = { updated_at: nowIso() };
  if (session.title === 'Untitled') patch.title = content.trim().split('\n')[0].slice(0, 60);
  db.update('sessions', sessionId, patch);

  return getSession(sessionId);
}

// ── Observations ─────────────────────────────────────────────────────────────

const OBSERVATION_KINDS = ['pattern', 'win', 'blocker', 'avoidance'];

function listObservations({ kind, limit = 100 } = {}) {
  return db.find('observations', o => !kind || o.kind === kind)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

function addObservation({ kind, note, sessionId = null }) {
  if (!OBSERVATION_KINDS.includes(kind)) {
    throw new Error(`kind must be one of: ${OBSERVATION_KINDS.join(', ')}`);
  }
  if (!note?.trim()) throw new Error('note is required');
  return db.insert('observations', {
    kind, note: note.trim(), session_id: sessionId, created_at: nowIso(),
  });
}

/**
 * NEURO's friction read, for the screen the typed observations live on.
 *
 * They are shown SEPARATELY and never merged into the observation list. An
 * observation is Nick saying "this keeps happening"; a friction insight is a
 * count of things he did, with the evidence attached. Folding the second into
 * the first would put words in his mouth, and folding the first into the second
 * would give a hunch the authority of a measurement.
 *
 * Degrades to a reason rather than throwing: this sits under a screen that must
 * still work with NEURO down, and an empty list would read as "nothing is in
 * your way", which is the one thing it must never say without having looked.
 */
async function neuroFriction() {
  const neuro = require('./neuro');
  if (!neuro.isConfigured()) {
    return { available: false, reason: 'No NEURO credential set', insights: [] };
  }
  try {
    const f = await neuro.friction();
    return {
      available: true,
      insights: f.insights || [],
      // NEURO's own honesty flags, carried rather than recomputed: `complete`
      // false means a source could not be read, so an empty list is "I could
      // not look", not "nothing to report".
      complete: f.complete !== false,
      gaps: f.gaps || [],
      evidenceCount: f.evidenceCount ?? null,
      noted: f.noted ?? 0,
      generatedAt: f.generatedAt || null,
    };
  } catch (err) {
    return { available: false, reason: err.message, insights: [] };
  }
}

function deleteObservation(id) {
  db.remove('observations', o => o.id === id);
}

module.exports = {
  MODES, SITUATION, ROLE, FRAMING, buildMessages, OBSERVATION_KINDS,
  listSessions, getSession, createSession, deleteSession, send,
  listObservations, addObservation, deleteObservation, neuroFriction,
};
