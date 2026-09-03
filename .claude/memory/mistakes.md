# Mistakes — VANTAGE

Read at the start of every session. Append after any wrong assumption, broken
build or regression. Format: `- YYYY-MM-DD: [what went wrong] → [what to do instead]`

## The one that keeps recurring

**Treating the absence of a mention as the absence of a fact.** Four separate
instances in two days, each in different clothes. Before asserting anything from
a zero or a silence: *does the data say this, or is it just not saying otherwise?*

---

- 2026-08-18: Assumed the weekly risk report needed building from scratch → NEURO already has `weekly-risk.js`; map the existing systems before proposing a build.
- 2026-08-18: Diagnosed a 30s query timeout as "table too big" and added an index without checking the row count → it was 5,602 rows, blocked behind the sync's writes. Ask for the cheapest fact first (row count, index list) before proposing a fix.
- 2026-08-18: Wrote a preflight `catch {}` that swallowed its own errors → a diagnostic that fails invisibly is indistinguishable from one that never ran. Diagnostics must fail loudly.
- 2026-08-18: Reported "SLA breach data is not captured" as a finding fit for the manager, when only the column I happened to query was empty → the wallboards showed it all along. Never generalise from one unpopulated source to a claim about the business; check where the number is already displayed.
- 2026-08-18: Queried NOVA with no project filter → mixed NT with YO (2,148) and NTPJ (742), roughly doubling several figures. All NOVA KPIs and wallboards are `project = NT`; scope to match and print the exclusions.
- 2026-08-18: Same `CASE` expression in `SELECT` and `GROUP BY` with positional params → each `?` is a distinct parameter, so SQL Server sees different expressions. Compute once in a derived table.
- 2026-08-18: Left "shall I commit?" as an open question while Nick was mid-deploy → he deployed without the changes. Commit as soon as work is finished and tested.
- 2026-08-18: Spent three round trips on a remote box with no version marker → could not tell "old code" from "fix didn't work". Stamp a build marker in any script iterated on remotely, AND in any API response consumed remotely.
- 2026-08-18: Inferred intent from direction — every downward tier move called a rejection, 217 reported as friction when ~80 were released fixes returning for test → never infer intent from a state change alone. Require evidence for the interpretation and emit "unclassified" when there is none. Getting this wrong blames a team for the system working.
- 2026-08-18: Built a best-effort caveat query that timed out every run while consuming most of the endpoint's budget → a caveat that costs the numbers it qualifies is not worth having.
- 2026-08-18: `status()` returned `available: true, totalClaims: 0` against a dead database, because `list()` swallowed the error → any read whose answer becomes a compliance claim must throw. Keep a separate degrading read for convenience callers.
- 2026-08-19: Reported one CSAT dataset as though it were the whole picture → there are two (NOVA portal, Jira `cf12802`), sharing no table and no code, reaching different people. The figure contradicted the wallboard. Check whether a second source exists before publishing a number.
- 2026-08-19: Let the meeting analyser assert a date it inferred from a transcript → it claimed the next 1:1 was "the day after", when it was booked for a week later and the booking sat in NEURO all along. A meeting note is not the system of record for scheduling. Feed known facts as ground truth and forbid inference.
- 2026-08-19: Relied on the model returning valid JSON, three times → truncated, then unescaped, then again despite `response_format: json_object`, which Claude models appear to ignore. Parse tolerantly: salvage complete objects and discard a broken tail.
- 2026-08-19: Called 2,063 unattributed vault action items "his commitments" → NEURO never populates `assignee`. Would have told him he had 607 undated promises that were not known to be his.
- 2026-08-19: Assumed linking a repo to Netlify meant deploys were automatic → it makes the repo *cloneable*. Without a webhook the site sat several commits behind while I described features he could not see. Passing an API check does not prove the frontend shipped.
- 2026-08-19: Ran `tailscale serve --set-path` without capturing Funnel state first → it silently downgraded port 443 from Funnel to tailnet-only, taking NEURO's public access down for about a minute. Capture the state of shared infrastructure before changing it.
- 2026-08-19: Held the PIN in a `const` captured at startup → changing it via the admin page updated `.env` and `process.env` but not the comparison, so the new PIN 401'd until a restart and looked exactly like a failed change. A value changeable at runtime must be read at runtime.
- 2026-08-19: Built a tool that measured what Nick had not done and reported it → for a brain whose failure mode is avoidance, a growing register of undone things produces the avoidance it measures. Never ship awareness without lowering the barrier. Then overcorrected by de-emphasising the numbers, which lost the evidence he is assessed on: keep the fact permanently visible, ration the diagnosis, always offer the next step.
- 2026-09-03: Told Nick "VANTAGE has no roster" after checking only NOVA's two bridge endpoints → NEURO already supplies one via `/api/team-health/roster`, and `bookedOneToOnes`/`oneToOneMoves` were reading it. Checked one source, reported an absolute absence. When asserting that a capability is missing, enumerate every source it could come from — a gap in one feed is not a gap in the system.
- 2026-09-03: Treated any non-null `booked` from NOVA's /121/state as 1:1 coverage → the endpoint returns the earliest still-OPEN session, which goes stale (one sat at 2 Jul, "in_progress", nine weeks later). Five of twelve read as covered and the card vanished entirely — a clean bill of health on the exact competency he is on a PIP for. A date in the past is not an appointment. Verify a reader against a live response before trusting its shape; the route source tells you the fields, not the states they reach.
