# HANDOFF — VANTAGE, as at 19 August 2026

> ⚠ **HISTORIC. This is a snapshot of 19 August 2026 and parts of it are no
> longer true.** It sat third in the mandatory reading order while claiming
> present-tense accuracy, which made it the stalest document with the most
> authority. Known to have moved since: the radar's sources changed on 31 Aug –
> 1 Sep; the overdue-task split landed after this was written; and the
> criticality handoff, the auto-push timer and `privacy.test.js` landed on
> 3 Sep.
>
> **`CLAUDE.md` and the code are the current record. Read this for how things
> got here, not for how they are.**

Written at the end of the build phase. Everything below was deployed and working
on 19 August 2026 unless it says otherwise.

**Start by reading, in this order:** `CLAUDE.md` → `context/situation.md` →
`.claude/memory/mistakes.md`. The third is not a formality; the same class of
error recurred four times in two days.

---

## Where it runs

| | |
|---|---|
| Public | https://vantage.nickward.co.uk (Netlify frontend) |
| Direct | https://pi5.tailecb90f.ts.net/vantage/ (Pi, backend + frontend) |
| PIN | in `/mnt/data/vantage/backend/.env` on the Pi; changeable from Admin |
| Backend | PM2 `vantage-backend`, port 3006, `/mnt/data/vantage` |
| Data | SQLite, `/mnt/data/vantage-data/vantage.db` — ⚠ correct, and NOT `backend/data/vantage.db`, which exists on the Pi as a stale 16KB decoy from the code's default path (verified 3 Sep 2026) |
| Repo | `Wardy-uk/vantage`, `main`, auto-deploys to Netlify on push |

## What is built

**Radar** — three tenses (has gone wrong / is going wrong / could). Sources:
NOVA flow signals, NOVA sentiment, NEURO team health, vault commitments,
waiting-on, tasks, booked 1:1s, and an LLM pass over the six most recent meeting
notes looking for risk that never became a ticket. Every source reports whether
it answered; blind spots are shown prominently.

**Findings** — dated register: what was spotted, when, whether it was raised and
with whom. Unraised findings can be drafted into a message in one click. Markdown
export for the weekly report. **9 findings, 1 raised** at time of writing.

**Plan** — the Support Review's 35 actions, owner-tagged mine/shared/above, plus
its 13 measures of success and whether each can currently be measured (4 can).

**Coach** — private. Opens with an unprompted brief; three modes. The brief reads
department signals *and* behavioural signals about Nick.

**Patterns** — observations, including `avoidance`.

**Admin** — settings with masked secrets, connection tests, PIN change.

**Standing bar** — the numbers, on every screen, permanently, no commentary.

## What is NOT built

- **Overtime UI.** The five-step WTR approval log exists in NEURO
  (`backend/services/overtime.js`, tables live) and is fully tested, but has no
  interface and no contracted-hours data, so it is inert. Deferred deliberately —
  there is no overtime happening at present.
- **NOVA KPI snapshot / trend in VANTAGE.** The radar cannot see compliance
  percentages, ageing or RAG. That is the largest remaining signal gap; NEURO's
  weekly report is built on those numbers and VANTAGE is blind to them.
- **Survey activation.** Three drafts exist in NOVA (Support Team already had
  one; KAM and Customer Success were created empty). Recipients still need
  adding by hand — NOVA has **no CSM/KAM roster anywhere**.
- **Multi-period survey trend.** `satisfaction-scores` and Trends read only the
  most recent survey per category, so monthly recurrence produces a series
  nothing plots. VANTAGE's own `sentiment-signals` does read all of them.

## Things that will bite you

1. **`deploy.ps1` in NOVA pulls from `azdo`, not `origin`.** Push to both.
2. **`git pull --ff-only` on the Pi fails** until `git checkout -- package-lock.json`
   — `npm install` rewrites it.
3. **Build stamps.** `flow-signals` and `sentiment-signals` stamp a version;
   VANTAGE refuses to render figures from an unrecognised build. Bump both sides
   together.
4. **NEURO needs two credentials** — `X-Neuro-Api-Token` for most routes,
   `X-Api-Key` (`VAULT_API_KEY`) for `/api/vault/*`.
5. **Netlify needs the webhook**, not just the repo link. It exists now; do not
   delete it.
6. **Never run `tailscale serve` without capturing Funnel state first.**

## The design rules — do not erode these

- **A source that did not answer renders as absent, never as zero.**
- **VANTAGE reads, it does not recompute.** Numbers come from NOVA over the
  bridge, so they cannot disagree with the wallboards.
- **Never build a second Weekly Risk Summary.** NEURO owns it.
- **The coaching layer is private by construction** — `coach`, `brief` and `self`
  have no dependency on the vault, the weekly report or the evidence register.
  Do not add one.
- **Fact / diagnosis / next step are separated on purpose**: the fact is always
  visible, the diagnosis is said once, the next step is always offered. This came
  from a correction and both halves matter.

## Immediate next actions (Nick's, not the next session's)

1. **Six high-severity findings are unraised.** Each has a "draft the message"
   button. This is the single most PIP-relevant thing outstanding.
2. **0 of 14 plan actions are marked as moving** — several probably have; the
   tracker just does not know yet.
3. **NOVA needs deploying** for `sentiment-b` (Jira CSAT half) — it reports
   `sentiment-a`, so VANTAGE shows portal CSAT only.
4. **Surveys**: add recipients to the two new drafts, apply the templates, activate.

## Dates

| | |
|---|---|
| 24 Aug 2026 | PIP formal review |
| 11 Sep 2026 | 60-day checkpoint — overdue management actions to zero |
| 11 Oct 2026 | PIP ends |
