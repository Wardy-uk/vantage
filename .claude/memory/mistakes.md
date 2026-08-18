# Mistakes — VANTAGE

Read at the start of every session. Append after any wrong assumption, broken
build or regression. Format: `- YYYY-MM-DD: [what went wrong] → [what to do instead]`

- 2026-08-18: Assumed the weekly risk report needed building from scratch → NEURO already has `weekly-risk.js`; always map the existing systems before proposing a build.
- 2026-08-18: Diagnosed a 30s query timeout as "table too big" and added an index, without ever checking the row count → it was 5,602 rows, blocked behind the sync's writes. Ask for the cheapest fact first (row count, index list) before proposing a fix.
- 2026-08-18: Wrote a preflight `catch {}` that swallowed its own errors → a diagnostic that fails invisibly is indistinguishable from one that never ran. Diagnostics must fail loudly, especially in a project whose premise is that silence never reads as success.
- 2026-08-18: Reported "SLA breach data is not captured" as a finding fit to take to the manager, when only the column I happened to query was empty → the wallboards showed it all along. Never generalise from one unpopulated source to a claim about the business; check where the number is already displayed.
- 2026-08-18: Queried NOVA data with no project filter → mixed NT with YO (2,148) and NTPJ (742), inflating every figure roughly 2×. All NOVA KPIs and wallboards are `project = NT`; always scope to match, and print the exclusions so the filter is auditable.
- 2026-08-18: Used the same `CASE` expression in `SELECT` and `GROUP BY` with positional params → each `?` becomes a distinct parameter (`@p0` vs `@p3`), so SQL Server sees different expressions and rejects the grouping. Compute once in a derived table.
- 2026-08-18: Left "shall I commit?" as an open question while Nick was mid-deploy → he deployed without the changes. Commit as soon as work is finished and tested; do not leave it as a question that blocks him.
- 2026-08-18: Spent three round trips on a remote box without a version marker → could not distinguish "old code" from "fix didn't work". Stamp a build marker in any script iterated on remotely, AND in any API response consumed remotely — a missing field is indistinguishable from an empty one, a version is not.
- 2026-08-18: Inferred intent from direction — treated every downward tier move as a rejection and reported 217 as friction, when ~80 were released fixes returning for test → never infer intent from a state change alone. Require evidence for the interpretation, and emit "unclassified" when there is none. Getting this wrong blames a team for the system working.
- 2026-08-18: Built a best-effort caveat query (JSON SLA coverage) that timed out every run while consuming most of the endpoint's budget → a caveat that costs the numbers it qualifies is not worth having. Measure the cost of the qualifier, not just its value.
- 2026-08-18: Reported a swallowed-error read as compliant (`status()` returned `available: true, totalClaims: 0` against a dead DB) → any read whose answer becomes a compliance claim must throw, not degrade. Keep a separate degrading read for convenience callers.
