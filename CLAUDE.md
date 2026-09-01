# VANTAGE — Claude Code instructions

Leadership coaching and Service Desk continual improvement, for Nick Ward
(Head of Service Delivery, Nurtur Limited).

**Read [context/situation.md](context/situation.md) first.** It holds what is
actually being assessed, and everything here depends on it.
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
- **The exception is a pointer, never a payload.** `brief.pointer()` returns an
  id, a timestamp and a deep link — no prose, no pattern name, no quote. It is
  the only symbol those modules export outward, and it is what NEURO's Focus
  card renders.

`backend/services/privacy.test.js` enforces this by parsing the import graph.
If the test does not run, the boundary does not exist — it is not a convention.

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
