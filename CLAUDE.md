# VANTAGE — Claude Code instructions

Leadership coaching and Service Desk continual improvement, for Nick Ward
(Head of Service Delivery, Nurtur Limited).

**Read [context/situation.md](context/situation.md) first.** It holds what is
actually being assessed, and everything here depends on it.
**Then [context/role.md](context/role.md)** — the job itself, from the formal
JD (what he should be doing), the HoTS assignment framework (what he is
ultimately judged against) and the DRAFT SFIA matrix. Two things it settles and
nothing else does: the 90-day checkpoints have no start date in the source and
**the staging is discarded** — per Nick, every outcome and KPI is a standing
expectation to be evidenced NOW, no day-number is ever rendered and no date is
ever computed from one; and a blank SFIA cell is a JD that did not evidence a
skill, **not** a capability Nick lacks — the same absent-is-not-zero rule, one
document over.
**Then read `.claude/memory/mistakes.md`.** It is not a formality — the same
class of error has recurred four times in this codebase.

---

## The rule that outranks everything else

> A source that did not answer renders as **absent**, never as a healthy zero.

The audience for this work includes the person assessing Nick's PIP. A false
all-clear is worse than no report. Every signal carries whether it answered; a
section that could not be measured says so.

**The recurring failure is treating the absence of a mention as the absence of a
fact.** It has happened with `sla_breached` (wrong field, column always 0),
handbacks (nothing ever called `logRejection`), meeting notes (no date mentioned
read as no date set), and vault action items (no assignee read as "his"). Before
asserting anything from a zero or a silence, ask: *does the data say this, or is
it just not saying otherwise?*

## How to build for Nick specifically

He is neurodivergent (ADHD, disclosed; OH report received). His difficulty is
**initiation**, not knowledge. The PIP names it: *"difficulty initiating and
prioritising management tasks without external structure or support."*

Therefore:

- **Never ship awareness without a next step.** A list of outstanding items
  produces avoidance. Do the starting-from-nothing part — draft the message,
  write the opening sentence, pre-fill the action.
- **Say a hard thing once.** The brief remembers named patterns for 21 days and
  is told not to re-diagnose. Repeated criticism becomes shame, which produces
  more avoidance.
- **Keep the facts permanently visible anyway.** The standing bar shows the
  numbers with no commentary. Diagnosis is rationed; the position is not.
- **Report what moved.** He under-registers completion; a tool showing only the
  outstanding column is lying by omission.
- One question at a time. Never stack.

## Architecture

| System | Authoritative for |
|---|---|
| **NOVA** `../windows automation/daypilot` | Tickets, SLA, queues, escalation, sentiment, surveys |
| **NEURO** `../nuero` | Weekly Risk Summary, management log, vault, people |
| **VANTAGE** here | Findings, plan delivery, coaching, interpretation |

**VANTAGE reads, it does not recompute.** If a number exists in NOVA, expose it
over `/api/neuro-bridge` and consume it. A second implementation drifts from the
one feeding the weekly report — and the disagreement surfaces in a document going
to Nick's manager.

### Two numbers for one competency

**Overdue tasks are split by `origin` and always will be.** NEURO classifies a
task as a COMMITMENT (somebody asked for it, or is waiting on it) or CONTINUAL
IMPROVEMENT (Nick set it himself, nobody is waiting), and the weekly risk report
counts overdue **commitments only** — because counting them together makes the
improvement backlog penalise him: a man who writes down thirty ideas and dates
them optimistically reads exactly like a man who has broken thirty promises.

The radar counted the lot and said *"PIP competency 4 measures exactly this"*.
Measured live on 1 Sep 2026: three overdue tasks, **all three improvement, zero
commitments** — so the screen he reads daily reported a competency he is meeting
as one he is failing, while the document going to his manager had it right.

Unclassified is a NAMED THIRD BUCKET, never folded into either — guessing
commitment manufactures a broken promise, guessing improvement hides one — and
while it is non-empty the commitment figure is declared a FLOOR. Improvement
work never acquires the word "overdue". Pinned by `task-origin.test.js`,
including the live shape as a fixture.

### VANTAGE shows Nick's own work, and nothing else

Two things are deliberately NOT on the radar, and neither is an oversight:

- **What other people owe him.** NEURO's waiting-on tracks it, on the People
  board, next to the person it concerns. Chasing somebody is not what this
  tool is for (Nick, 1 Sep 2026).
- **Raw vault action lines** (`/api/vault-actions`). It scrapes every unticked
  checkbox out of meeting notes and records **no assignee on any of 3,218**
  rows, so it cannot say whose work anything is. A card built on it announced
  *"307 commitments are past their due date"* — unowned lines shown to Nick as
  promises he had broken, on the screen he reads daily. `self.js` had already
  learned that exact lesson and written it down; the radar did it anyway, one
  source over. The count was wrong too: PLAUD writes several summary variants
  per recording, so the 307 folded to **seven** distinct items.

What is his comes from `tasks.origin = 'commitment'`, which is attributed. If
the vault feed ever comes back it needs an owner on the row first. Pinned by
`vault-actions-cards.test.js`, which asserts both sources are unfetched AND
that the two real ones still are — a source scan with no positive control
passes just as well against an empty file.

### What VANTAGE reads about Nick, and what it does not

Beyond the radar's sources, two reads exist because VANTAGE was measuring
something it could not see:

- **`/api/friction`** → the Patterns screen. That screen had an input and no
  source and read `0 · 0 · 0 · 0`, while NEURO had been recording deferrals with
  reasons, tasks shrunk more than once and sessions parked as too big — from
  evidence, never inferred from silence. Rendered BESIDE the typed notes and
  never merged: an observation is Nick saying "this keeps happening", an insight
  is a count of things he did. Every insight renders its `because` line; a
  surface that drops the working reintroduces the problem at the last step.
- **`/api/wins`** → `self.moved`, the coaching brief and the standing bar.
  `doneBehaviour()` counts findings raised and plan items moved — VANTAGE's own
  activity, a few percent of the work, on a tool built for a man who
  systematically under-registers completion. The ledger detects it from six
  sources and carries its own known gaps, which are passed through so nothing
  reads the total as the whole picture. **A failed read shows nothing, never a
  zero** — "you finished nothing this week" is the most damaging thing the bar
  could say wrongly.

Deliberately NOT read: health, readiness, ambient (sitting, diet, daylight),
desktop activity, location. NEURO surfaces those where they belong. VANTAGE's
line is a judgement about a number or a signal that only exists because sources
were combined, and "you have been sitting for two hours" is neither.

`neuro.stateOfPlay()` and `neuro.knowledgeGaps()` are exported and called by
NOTHING. A client function with no caller looks like coverage and is not — the
same species as a reader outliving its writer. Wire them up or delete them.

### Leading indicators — the `could` tense's first real source

`leading.js` takes DERIVATIVES of `kpi_org_daily`, read over the new
`/api/neuro-bridge/kpi-org-series` (daily rows; `kpi-org-trend` averages away
the granularity early warning needs). Deterministic, department-only, **no LLM
in the detector path** — a warning Nick cannot reproduce by hand from the
evidence line is one he cannot take to Chris. Nothing here reads health,
readiness, desktop or location; that stayed true after Nick was asked, because
those inputs improve none of the five detectors and would let a card about the
DESK explain itself with facts about HIM.

`detect()` is PURE, and that is load-bearing: `tools/replay-indicators.js`
replays it over history, so a back-tested detector and a live one cannot be
different code. `indicator-log.js` splits the same way — `plan()`/`present()`
are pure so the dedupe and the decay test without `better-sqlite3`, which is
how they came to be tested at all.

**A HOLE IS NOT A ZERO, and here it BLOCKS rather than caveats.** A day NOVA was
down is simply absent from `kpi_org_daily`; read as zero it looks like the desk
received nothing, so a net-flow detector sees an outage as a triumph and the
baseline is poisoned for a month. Any gap in the 35-day window stops the claim.

### The outcome label, and the correction of 17 Sep 2026

**The canonical measure is a RISE EPISODE**, not a RAG crossing: a stock KPI
climbing its entire green-to-red span within 14 days. A fire ON the day the
outcome becomes visible scores lead ZERO and counts as description, not warning.

⚠ **V1 measured against RAG crossings and that was wrong.** `nt_production` is
above its red line **69%** of the time and `nt_incidents` **65%**, so a
"crossing" is usually the series dipping under the line and coming back — not a
problem arriving. Several occurred while the stock was *falling* (2026-08-11:
Production at 83 on a 14-day slope of −3.3, then red). Only **6 of the 19**
V1 events were preceded by a sustained rise, and two thirds of genuine rises
never produce a crossing at all because the series is already red.

The original figure is kept below rather than overwritten. It is also carried in
code as `VALIDATED.supersedes`, so anything rendering the claim renders its
history with it.

| detector | | corrected result (rise episodes) |
|---|---|---|
| **A** net flow | ON | **6 of 19 rise episodes warned, median lead 12 days, 1 FP** — plus 3 fires that landed on the episode day and scored zero. On the 6 genuinely rising members of the old RAG set: 3 warned, median lead 7 |
| **D** dev drift | OFF | measured and FAILED — 2 fires, both false, missed both Development events |
| **B** ageing | OFF | UNMEASURABLE **and built on a counter**: `nt_oldest_development` rises +1 on 316 of 319 days and has fallen twice in 320 |
| **C** escalation | OFF | UNMEASURABLE: `nt_rejected` is RAG green on all 320 days |
| **E** capacity | ON | advisory; availability history exists but carries no booking date, so a replay cannot prove the fact was knowable in advance |

| superseded | |
|---|---|
| measured | 2026-09-16, against RAG crossings (stock red 3+ consecutive days) |
| said | 9 warnings, 0 coincident, 3 false positives, median lead 11 days |
| corrected | 2026-09-17 — the label was noise; **A stays ENABLED**, its evidence was restated, not withdrawn |

"Measured and failed" and "could not be measured" are kept apart in
`DISABLED_REASON` and never collapsed into the word "disabled" — the fixes are
different, and B needs a target its KPI can cross, not a threshold change.

⚠ Note on E: V1 said "availability has no history". That was wrong —
`agent_availability` holds 311 past rows over 156 days back to 2026-02-02. But
`updated_at` is a SYNC stamp, not a booking date, so nothing records when a row
first appeared. Annual leave is bookable in advance and could be replayed under
a stated assumption; sickness is recorded on the day and replaying it would be
pure hindsight. E therefore remains advisory.

**E is ON as an UNVALIDATED ADVISORY, and that status is load-bearing.** Every
indicator carries `validation`; the default is `unvalidated-advisory`, so a new
detector that declares nothing is treated as untested rather than inheriting A's
credibility. E's status is rendered as EVIDENCE next to its numbers, not buried
in metadata. It may reach the radar and the findings register, but the flag
travels onto the finding (`advisory`) and `auto-push.isAdvisory()` refuses to
write it to NEURO unattended — **stated independently of the fact that
`criticality` already refuses every `could`**, because a constraint Nick asked
for in words must not rest on a threshold somebody else is free to change.
E writes a dated, never-updated claim to `indicator-log.prospectiveClaims()`
(`/api/leading/claims`) so it can be scored FORWARD. There is deliberately no
scorer yet: choosing the measure before seeing an outcome is how a scorer comes
to flatter the thing it scores, and `prospective.scoreAgainst` fixes that choice
at the moment the claim is made.
**Thresholds were fixed before the first replay and are not to be moved to
improve a score.** Pinned by `leading.test.js`, which carries a positive control
beside every refusal, and by the replay's own injected-surge control.

Two series are excluded BY NAME in `kpi-series.js`: the `no_reply` KPIs (history
is `backfill-legacy`, from the table NOVA calls inflated 2-3x, and it holds a
130 between a 0 and a 2) and `nt_csat` (30 days of value in 120, with an 11-day
hole). Every long series also changes capture method around 30 Jul 2026
(`reconstruct` → live `jira`); `sourceBreaks` carries it and confidence drops
when one falls inside the measured window.

**Empty writers found while validating, and they matter as precedent:**
`ticket_trend_snapshots` and `agent_incidents` both have writers in NOVA and
ZERO rows. `agent_incidents` was to have been the independent outcome label for
the back-test. A reader that outlives its writer looks exactly like coverage —
`scripts/validate-kpi-org-series.ts` is the gate that asks, and it should be run
on AAPP01 before anything new is built on a NOVA table.

### V2: the outcome label, the ledger, and one detector in shadow

**`episodes.js` owns what counts as a problem arriving**, and both the replay
and the live ledger call it — so a prospective lead time and a historical one
are measured with the same ruler. A RISE EPISODE is a stock climbing its whole
green-to-red span within 14 days, dated when the climb COMPLETES. The old RAG
measure is still runnable as `node tools/replay-indicators.js --rag`, because a
correction nobody can reproduce is just an assertion.

**The ledger labels live warnings** — useful / false / inconclusive, with the
actual lead. The rules are all about when NOT to label: nothing is scored while
its window is open (scoring early makes any detector look bad; leaving the
window open until something happens makes any detector look good). A human
verdict outranks the automatic one, because the automatic label cannot see that
Nick read the card and prevented the thing — which otherwise records as a false
positive and systematically punishes the warnings that worked. Detector E is
`settledBy: 'human'`: it predicts a thin rota, not a backlog rise, and scoring
it against stock episodes would mark it false every time the department coped.

**S1 is a SHADOW detector — no card, no finding, no NEURO action.** It combines
four EVIDENCE FAMILIES that cannot be derived from one another: flow, ownership
(`nt_legacy_unassigned`), rejection rate, and booked capacity. **Stocks are
deliberately excluded from the corroboration set** — stock is the integral of
net flow, and the discovery-era composite that counted them as separate
agreement was one fact counted four times, which on inspection was just detector
A at a lower bar. Shadows live in their own `SHADOW_DETECTORS` list and are
filtered at two layers, so "no card" is structural rather than a filter someone
can forget. S1 earns promotion on PROSPECTIVE evidence only: the holdout was
consumed during discovery, so any back-test of it now would be fitted to history
already seen.

**Findings from discovery worth not re-deriving:**
- `nt_oldest_*` are COUNTERS. `nt_oldest_development` rises +1 on 316 of 319
  days and has fallen twice in 320 — one ancient ticket nobody will clear. Any
  age-based detector on them measures the calendar.
- D's hypothesis was wrong, not mistuned: the CC-flat veto suppressed the real
  March event, and z-against-its-own-changes is defeated by a persistent trend.
- `agent_availability` DOES hold history (311 rows, 156 days) but `updated_at`
  is a sync stamp, so nothing records when a booking became knowable.
- `escalation_type='rejection'` IS being written — 183 rows since April. The
  comment in `flow-signals.ts` saying it never would is stale.
- **No independent outcome source is populated.** `agent_incidents` is empty,
  and it is NOT a writer defect: the job runs every 15 minutes, its query
  returns ~48 tickets per 4h against a threshold of 5, and the LLM confirmation
  gate has simply never said yes. `portal_escalations` is empty too;
  `agent_alerts` has 15,386 rows but fires ~40/day and is derived from the same
  queue data. Every outcome today is a KPI scored against a KPI.

### The finding lifecycle

Radar → `+ log` → Findings → `log to NEURO` → resolve. Every step is Nick
deciding something, and the two ends are the ones with rules:

- **Logging to NEURO creates BOTH a risk and a task** — the escalation line is
  what Chris reads, the task is what makes it get done. A risk with no task is
  the pattern the Support Review found. The task create is never allowed to fail
  the escalation, and the two outcomes are reported separately: "on the report,
  but no task" is a different thing to fix than neither.
- **Resolving REQUIRES the sentence.** "Resolved" alone records nothing; at a
  review the question is never whether something was closed but what was done
  about it, and a finding closed with no account is indistinguishable from one
  quietly dropped. Enforced in `findings.resolve()`, not in the UI, so the next
  caller cannot walk past it.
- **A tick in NEURO gives `resolved_pending`, never `resolved`.** The tick
  proves the work happened and says nothing about what was done, so the register
  asks. `syncFromNeuro()` is one call for all findings, runs AFTER the register
  renders, and never writes back — resolving here does not tick the task, and
  closing someone's task on the strength of a sentence typed in another tool is
  not a write this repo has any business making. A `dropped` task is recorded
  and is NOT a resolution.
- **The radar pins what is unresolved.** Radar items are recomputed from live
  signals, so one vanishes the moment its number moves — which is not the same
  as the problem being dealt with. An unresolved finding is folded back in at
  serve time (not into the 10-minute cache, or it would not appear until the
  next rebuild), and a live item already logged says so instead of offering to
  log it twice. Matched on title: a reworded finding pins as a second card,
  which is visible and correctable, where silently merging two risks is not.
- **A hand-typed finding carries no tense and is not given one.** The three
  tenses demand different responses; an unplaced card beats a guessed one.

**Never build a second Weekly Risk Summary.** NEURO owns it
(`backend/services/weekly-risk.js`, published to `Projects/PIP/Weekly Risk
Summaries/`). Improve it in place.

### Build stamps

`flow-signals` and `sentiment-signals` stamp a build into every response, and
VANTAGE **refuses to render figures from a build it does not recognise**. This
exists because a stale NOVA `dist` once returned a plausible-looking response
with three new fields quietly `undefined`, and the numbers it *did* return were
computed by logic already corrected. Bump the stamp on both sides when the shape
changes.

## NOVA has no local instance

It runs on **BYM-AAPP01** under IIS. There is no dev database. Deploy is
`deploy\deploy.ps1 -Branch nova-codex`, run **on the prod box**, elevated.

- **`deploy.ps1` pulls from `azdo`** (Azure DevOps), not `origin` (GitHub).
  **Push to both**, or the deploy pulls nothing and reports "Already up to date".
- Never validate NOVA SQL by deploying it. Put queries in a service, keep the
  route thin, add a `scripts/validate-*.ts` that imports the same service and can
  be run on AAPP01 with `npx tsx`. `validate-flow-signals.ts` is the worked
  example, and it stamps its own build number so you can tell what the box is
  running.
- A manual `npm run build` there fails with *"vite is not recognized"* — devDeps
  are pruned after each deploy. That is expected, not a fault.

## Working with NEURO

Two credentials, not one:

- `X-Neuro-Api-Token` (`NEURO_API_TOKEN`) — everything except the vault.
- `X-Api-Key` (`VAULT_API_KEY`) — `/api/vault/*` only, a separate gate.

Prefer the token over the PIN: the PIN is what Nick types into NEURO himself.
One token unlocks writes and deletes across the whole API, so the discipline
lives on this side. Never call `weekly-risk` publish, queue-send or test-send —
VANTAGE may put a line on the report; sending it to Chris stays a decision Nick
makes in NEURO, behind NEURO's own approval gate.

**GETs, plus exactly four writes:**

- `neuro.createTask` — `POST /api/tasks`, idempotent on normalised text.
- `neuro.matchTasks` — `POST /api/task-dedupe/match`, which changes nothing.
- `neuro.linkTaskToMicrosoft` — `POST /api/task-dedupe/link`, the Planner merge.
- `neuro.setWeeklyRiskManual` — `POST /api/weekly-risk/manual`, which is how
  `findings.escalate()` puts a finding on the report's escalation list. Note
  `GET /api/weekly-risk` (the assembled report) stays unused: it triggers a NOVA
  round trip VANTAGE has already paid for. `/manual` does not, which is why
  NEURO split it out.

Nothing else in this repo may POST, PATCH or DELETE against NEURO — no updates,
no completions, no deletes. Adding a fifth write is a decision, not a detail.

**`escalateToChris` is three-valued in NEURO** — `null` (not confirmed, and
blocking publication), `[]` (a decision that there is nothing), or a list. So
the first line VANTAGE appends ANSWERS that section and clears NEURO's blocker.
`escalate()` reports when it did that and the card says so, because otherwise a
one-click convenience silently stops NEURO asking whether there was anything
else. It also deliberately does NOT set `raised_on`: being listed on a report
that has not been sent is not the same as having raised something, and that date
is the one number the register exists to produce.

**Tasks live in NEURO; VANTAGE holds only the link.** `plan-tasks.js` stores
`planId -> taskId` and reads state live. Merging a task with the MS Planner
board Mel set up is NEURO's job and already exists (`services/task-dedupe.js`) —
never call Graph from here. Note that NEURO's Planner sync reads
`/me/planner/tasks`, so it sees only what is **assigned to Nick**: "no Planner
task" is not evidence there isn't one, and the UI has to say so.

## Deploying VANTAGE

```bash
ssh nickw@100.100.28.58
export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH
cd /mnt/data/vantage
git checkout -- package-lock.json     # npm install rewrites it; blocks --ff-only
git pull --ff-only && npm run build
pm2 restart vantage-backend --update-env
```

Node 22.22.2 is pinned — Node 20 segfaults `better-sqlite3`. Run `pm2 save` after
any `pm2 start`. Netlify auto-deploys on push to `main` via a GitHub webhook.

⚠️ **Do not run `tailscale serve` without checking Funnel state first.** Adding a
path with `serve` silently downgraded port 443 from Funnel to tailnet-only and
took NEURO's public access down with it.

## Privacy

`coach`, `brief`, `self` and the observations are **private**. Nothing from them
is quoted, summarised or exported into anything outward-facing unless Nick moves
it himself.

The boundary is about DIRECTION, not isolation:

- **Private reads outward — allowed.** `self` consuming `findings` and `plan` is
  how the coach knows anything. Nothing leaks inward.
- **Outward reads private — banned**, with one exception. Nothing in the weekly
  report, the vault, the evidence register or any NEURO-facing route may import
  `coach`, `brief`, `self` or the observations.
- **The exception would be a pointer, never a payload** — and it is NOT BUILT.
  ⚠ This paragraph described `brief.pointer()` in the present tense, as "what
  NEURO's Focus card renders". It has never existed: `brief.js` exports
  `generate`, `startFrom`, `buildEvidence` and `namedThemes`, and nothing in
  NEURO renders anything from VANTAGE. So **today the rule is absolute** —
  nothing outward-facing may read the private half at all, which is stricter
  than the exception and is the safe state. If it is ever built it returns an
  id, a timestamp and a deep link: no prose, no pattern name, no quote.
  `privacy.test.js` pins its ABSENCE, and says what to replace that test with
  on the day it exists.

`backend/services/privacy.test.js` enforces this by parsing the import graph.
If the test does not run, the boundary does not exist — it is not a convention.
⚠ That sentence was written before the file was, and was untrue for as long as
it stood: by its own words the boundary was a convention. It exists now, and it
carries a positive control, because a test that passes by reading an empty set
is the same failure wearing a different hat.

Everything else should be written as though Chris or Ricky may read it.

## Safety

- **Azure SQL `techservicesjsm`**: read-only as `claude_readonly`. Only n8n-owned
  tables. Never `JiraSlaRaw*` or `JiraTickets*`.
- **`/api/neuro-bridge` sits in front of NOVA's JWT middleware**, guarded only by
  a shared secret. Anything added there is read-only and never accepts a
  caller-supplied identity — the route is hardcoded to Nick.
- Never commit `.env`, `NOVA_BRIDGE_SECRET`, `NEURO_API_TOKEN`, `VAULT_API_KEY`
  or any SQL credential.
- VANTAGE **must hard-fail without `VANTAGE_PIN`**. No dev exception. It holds
  the coaching layer and the API is publicly reachable.
