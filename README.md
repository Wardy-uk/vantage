# VANTAGE

Leadership coaching and Service Desk continual improvement, for Nick Ward
(Head of Service Delivery, Nurtur Limited).

**Live:** https://vantage.nickward.co.uk · also https://pi5.tailecb90f.ts.net/vantage/
**Repo:** `Wardy-uk/vantage`

---

## What it is for

Two jobs, one system:

1. Turn the Support Review (w/c 3 Aug 2026) into tracked, owned delivery.
2. Make proactive oversight **structural** — so problems surface here first, and
   keep surfacing when nobody is checking.

The second is the point. The doubt on record is not "can Nick complete a plan"
but "can he demonstrate leadership that survives the removal of scrutiny". A
mechanism answers that in a way a promise cannot.

**Read [context/situation.md](context/situation.md) before working on this.** It
holds the framing everything else depends on.

## The design principle everything follows

> A source that did not answer renders as **absent**, never as a healthy zero.

Inherited from NEURO's `weekly-risk.js` and non-negotiable, because the audience
for this work includes the person assessing Nick's PIP. Every signal carries
whether it answered. Nothing may show a number it did not measure.

This has been violated four times during the build and caught each time by one
question: **does the data actually say this, or is it just not saying otherwise?**
See `.claude/memory/mistakes.md`.

## The three-way split (added 19 Aug, after a correction)

Nick is neurodivergent (ADHD, disclosed; OH report received). His difficulty is
**initiation**, not knowledge — the PIP says so directly. A tool that measures
what he has not done and reports it is not support; it is the demand restated.
But removing the measurement loses the evidence he is assessed on.

So the three are kept separate:

| | Where | How often |
|---|---|---|
| **The fact** | Standing bar, every screen | Always, no commentary |
| **The diagnosis** | The coaching brief | **Once**, then quiet for 21 days |
| **The next step** | Wherever the fact appears | Always — pre-drafted |

Anything that raises awareness without lowering the barrier is the wrong shape
for this tool.

## Screens

- **Radar** — what has gone wrong, is going wrong, or could. Three tenses,
  because each demands a different response. Combines NOVA (tickets), NEURO
  (people), meeting notes (what was said and never became either) and sentiment.
- **Findings** — a dated register of what Nick spotted, when, and whether he
  raised it. `found_on` and `raised_on` are separate: spotting and telling are
  different acts and only the second is proactive escalation. Each unraised
  finding can be **drafted into a message** in one click.
- **Plan** — the Support Review's 35 actions with honest ownership (mine /
  shared / above), plus its 13 measures of success and whether each is
  measurable. Four are.
- **Coach** — private AI coaching. Opens with an unprompted brief; three modes
  (coach, conversation prep, reflect).
- **Patterns** — durable observations, including an `avoidance` category.
- **Admin** — configuration, connection tests, PIN change.

## Where it sits

| System | Authoritative for |
|---|---|
| **NOVA** (`../windows automation/daypilot`) | Tickets, SLA, queues, escalation, sentiment, surveys |
| **NEURO** (`../nuero`) | Weekly Risk Summary, management log, the vault, people |
| **VANTAGE** (here) | Findings, plan delivery, coaching, signal interpretation |

VANTAGE **reads**; it does not recompute. If a number exists in NOVA, it crosses
the bridge — a second implementation would drift from the one feeding the weekly
report that goes to Nick's manager.

## Hosting

Pi 5, alongside NEURO and SARA.

- **Backend** — Node 22.22.2, Express, PM2 app `vantage-backend`, repo at
  `/mnt/data/vantage`, port **3006**, SQLite at `/mnt/data/vantage-data/vantage.db`.
- **Exposed** at `/vantage` on the Pi's Tailscale Funnel. Funnel only permits
  ports 443, 8443 and 10000 and all three were taken, hence the path.
- **Frontend** also on **Netlify** at `vantage.nickward.co.uk`, calling the Pi's
  Funnel URL for its API. Funnel cannot serve a custom domain.
- **Auth** — app-level PIN, read per request. **Hard-fails on startup if unset**,
  unlike NEURO which defaults open.

## Deploying

```bash
# Pi (backend + the /vantage frontend)
ssh nickw@100.100.28.58
export PATH=/home/nickw/.nvm/versions/node/v22.22.2/bin:$PATH
cd /mnt/data/vantage
git checkout -- package-lock.json     # npm install rewrites it; blocks --ff-only
git pull --ff-only
npm run build
pm2 restart vantage-backend --update-env
```

Netlify deploys itself on push to `main` — a GitHub webhook fires a Netlify build
hook. Linking the repo alone does **not** do this; it took a separate webhook,
and until it existed the site silently sat several commits behind.

## Getting started fresh

```bash
npm install
cp backend/.env.example backend/.env    # set VANTAGE_PIN at minimum
npm run dev
```

Everything else is configurable from the **Admin** screen: OpenRouter key and
model, NOVA bridge URL and secret, NEURO URL, API token and vault key.

## Tests

```bash
cd backend && node --test services/*.test.js
```

Store tests skip cleanly where `better-sqlite3` will not build; the prompt and
parser tests run everywhere and are the ones that matter.
