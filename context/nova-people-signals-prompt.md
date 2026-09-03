# Prompt: add `people-signals` to NOVA's neuro-bridge

_Hand this to a Claude Code session in `windows automation/daypilot`. Written
3 September 2026. VANTAGE needs per-person service desk data it currently has no
access to; this asks NOVA to expose it._

---

## ⚠ Status: the inventory came back, and it changed the job

Read this before sending anything below. The NOVA session ran the inventory
against the live database on 3 Sep 2026 and found **six bridge endpoints VANTAGE
was not reading** — `/availability`, `/121/state`, `/121/completed`,
`/kpi-snapshot`, `/kpi-trend`, `/escalation-stats`. Verified here in
`daypilot/src/server/routes/`.

**So the roster and 1:1 coverage were never NOVA work.** `/121/state` already
returns per person the cadence, the next booking and the last one held, with
nulls where there is nothing — which is the omission itself. That is now read by
`backend/services/one-to-ones.js`. **Do not build a second door to that room.**

### Decisions taken

- **Scope: TPJ's five are not Nick's; Sebastian Broome is (NT).** NOVA's
  existing `Department IN ('NT','NOVA_AI')` scope already matches. No change.
- **In:** QA and Golden Rules (daily scored-count plus score), standup
  submission coverage, escalations per person, `overSla`, `noReply`,
  `oldestDays`, `oldestSupportDays`, and `slaCompliancePct` with its 57% fill
  rate declared rather than smoothed.
- **In, but flagged verification-only:** `solvedToday`, `solvedWeek`,
  `ticketsPerHour`. See the rule in [role.md](role.md) — these are the "headline
  productivity indicators" PIP competency 1 was opened over, and they may be
  shown against an overtime claim but must never form a performance judgement.
- **Out:** per-agent CSAT (non-zero on 2% of rows), gamification (0 rows, and
  querying a table that does not exist in the schema), the `*7d` QA fields until
  a capture has run on the deployed build, and stored RAG ratings — read the
  scores, since any stored rating was computed by superseded logic.

What remains for NOVA is therefore the per-person **performance** subset only.
The conventions below still apply to it.

---

## The prompt

> VANTAGE reads exactly two endpoints from your bridge today — `flow-signals`
> and `sentiment-signals` — and both are queue/tier level. It has no per-person
> service desk data at all, so it cannot see an underperforming agent and cannot
> answer any measure counted per head. NOVA has 70+ KPIs including individual
> ones. I want a third bridge endpoint, `people-signals`, that exposes the
> per-person subset.
>
> **Before writing any of it, inventory what actually exists.** List the KPIs
> NOVA computes today that are attributable to a named individual, where each
> one comes from, and how current it is. I want to choose from a real list, not
> a designed one — do not invent a metric that would need new collection, and do
> not propose a field you have not confirmed exists. Show me the list and stop
> there; we will pick the subset together before you build anything.
>
> When we have agreed the subset, build it to the conventions the other two
> bridge endpoints already follow:
>
> - **Return the roster you are measuring against.** Name, tier/function and
>   active status for whoever the metrics cover. VANTAGE already gets a roster
>   from NEURO (`/api/team-health/roster`), so this one is not filling a void —
>   it is there so a metric can be read against the population it was computed
>   over, and so the two rosters can be compared. **If NOVA's list and NEURO's
>   list disagree, that disagreement is itself a finding** and must be visible
>   rather than reconciled silently. A metric with no population behind it
>   cannot express coverage: "8 people had a 1:1" is meaningless without knowing
>   whether there are 9 or 15.
> - **Every signal carries its own `ok`/`error`.** A signal that failed must
>   come back as failed, never as zero. VANTAGE renders an absent source as
>   absent, and a false all-clear is worse than no data — this is the single
>   most important convention in the chain.
> - **Distinguish "no data" from "zero".** An agent with no tickets in the
>   window and an agent whose query failed are different states and must not
>   collapse into the same number. Likewise someone on leave.
> - **Stamp a build.** Same pattern as `flow-signals`. VANTAGE refuses to render
>   figures from a build it does not recognise, because a stale `dist` once
>   returned a plausible response with new fields quietly `undefined`. Give the
>   stamp a fresh value and tell me what it is so I can set it on the VANTAGE
>   side.
> - **Read-only, shared-secret, no caller-supplied identity.** The bridge sits
>   in front of the JWT middleware. This endpoint returns data about the whole
>   team rather than one person, so it must not accept a "who is asking"
>   parameter that could be used to widen its scope.
> - **Query lives in a service, route stays thin**, and add
>   `scripts/validate-people-signals.ts` that imports the same service and can
>   be run on AAPP01 with `npx tsx`, stamping its own build number.
>   `validate-flow-signals.ts` is the worked example. **Do not validate the SQL
>   by deploying it.**
> - **Azure SQL safety:** only n8n-owned tables in `techservicesjsm`. Never
>   `JiraSlaRaw*` or `JiraTickets*` — those are standalone-app tables being
>   deprecated and must not be used even as a schema basis.
> - **Mind the DTUs.** `flow-signals` is deliberately sequential and takes
>   60–110 seconds against a database that is also serving the live service
>   desk. Do not make this one parallel and heavy; VANTAGE caches, so latency is
>   cheaper than load.
>
> Deploy is `deploy\deploy.ps1 -Branch nova-codex`, run on AAPP01, elevated —
> and it pulls from `azdo`, not `origin`, so **push to both** or it will report
> "Already up to date" and deploy nothing.

---

## Why the inventory step is not optional

The temptation is to specify the metrics up front and have NOVA build to the
spec. That produces a designed list rather than a real one, and the failure mode
is a signal that looks live and is computed from a column nobody populates —
which is exactly how `sla_breached` ended up always zero, and how handbacks were
counted for months by a function nothing ever called.

Ask what exists. Choose from that.

## What VANTAGE does once this lands

Not part of the NOVA prompt — this is the follow-on work here:

1. A `people.js` reader beside `signals.js` and `sentiment.js`, same contract:
   never throws, caches, names every unavailable signal, refuses an unrecognised
   build.
2. Radar cards for what the per-person view makes visible, subject to the
   existing rule that a card must be about **Nick's own work** — team
   performance management is his work; a list of other people's failings for its
   own sake is not.
3. Roster-backed coverage, which is the thing that unlocks omission detection:
   a duty that should have happened per person and did not.
