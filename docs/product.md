# Block0 — the product (1 October 2026)

Implementation follow-up: [review fixes and their rationale](review-followup-2026-10-01.md).

## In one line
**Block0 tells you what materially changed in a Robinhood Chain launch, who caused it, and the on-chain evidence —
and never what to buy.**

## Who it is for, and the moment it serves
Someone following a handful of Pons / Orbio launches who wants to know **when their picture of a launch has gone out
of date**: early wallets started selling, the creator pulled staked principal, wallets with a trading record piled in or
left. The repeat-use loop is: follow a launch → get told when something material changes → open the evidence → keep
following it.

## What it is
Three surfaces over **one shared record** of observations (the agent's reads, every ~15 min, free node):

| Surface | Job | Today |
|---|---|---|
| **Dossier** (`/token`) | Explain one launch: its timeline of changes with evidence, who bought first and together, who holds it, who is selling or moving it, what the owner did before. | Live; timeline + Follow (2026-10-03). |
| **Live feed** (`/board`) + radar | Find the launches where something is happening: material changes newest first, the launches you follow, every launch being read. | Live (2026-10-03). The radar runs in the browser. |
| **Agent on X** | Distribute the few material changes, with the address so anyone can check them; the 24 h follow-up threaded underneath; one daily digest. | Dry run. Goes live after a reviewed dry-run sample. |

## What it is not
- **Not a predictor.** Every edge test failed or was inconclusive (`/methodology`). Risk scores are summaries of facts,
  never forecasts. The one open question (smart-money convergence) is measured forward under a fixed protocol and is
  not posted until it passes.
- **Not a pick list, not a call service, not a leaderboard of "alpha" wallets.**
- **Not categorical where the chain is not.** "Early wallet", not "insider". "Sold into the pool" vs "moved out".
  "Bought and has not sold or moved it since", not "holds". Every read carries its age.

## Event types (v1 of the feed)
Kept deliberately to three families the data supports today:
1. **Ownership changes** — early wallets selling into the pool; tracked wallets entering or leaving.
2. **Creator / economic actions** — Orbio principal withdrawn, lock ending, repeat owner launching again.
3. **Follow-ups** to earlier events (planned — below).

## Next to build, in order
1. ~~Token timeline~~ — built 2026-10-03 (`agent/timeline.mjs`, dossier "What changed").
2. ~~Event lifecycle + follow-ups~~ — built 2026-10-03: 24 h follow-ups (`agent/followups.mjs`) on the timeline and
   threaded under the original post; materiality bar (`agent/materiality.mjs`); graduations; daily digest.
3. ~~Watchlist~~ — built 2026-10-03: Follow on the launch page, "Following" on the live feed (browser-local, `public/follow.js`).
3b. ~~Owner track records, read history, the week in numbers~~ — built 2026-10-07 (`/owner`, `history/`, `/stats`).
4. **Editorial policy, published before any token launch:** identical treatment of Block0's own token, disclosed
   relationships, no favourable treatment for funding, no sensational wording.
5. Next candidates: an explorer link per evidence row once a reliable explorer indexes the chain; transaction hashes on
   evidence (needs the tx hash kept per transfer); a "was this useful" control on feed items.

## How we know it works
Usefulness, not prediction: repeat visits, followed launches, evidence clicks, "was this useful" on alerts, and — as
negatives — corrections, duplicate alerts and stale reads. The forward test answers the separate research question.

## Constraints that stay
$0 running cost (free node, static hosting, GitHub Actions while the repo is public). Dry run by default. No metered
fallback. A token launch waits for real usage.
