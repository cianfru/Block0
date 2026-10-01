# Block0 — the product (1 October 2026)

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
| **Dossier** (`/token`) | Explain one launch: who bought first and together, who holds it, who is selling or moving it, what the deployer did before. | Live on block0.app for every launch the agent reads. |
| **Board + radar** (`/board`, `/radar`) | Find the launches where something is happening. | Live. The radar runs in the browser. |
| **Agent on X** | Distribute the few changes worth someone's attention, with the address so anyone can check them. | Dry run. Goes live after a reviewed dry-run sample. |

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
1. **Token timeline.** Each launch's dossier gains a dated list of its events, from the shared record, each with its
   evidence (transactions, amounts, read time).
2. **Event lifecycle + follow-ups.** An event is observed → updated → reversed/corrected. "Two tracked wallets entered"
   later becomes "both have since sold" on the same entry, and the agent posts the follow-up.
3. **Watchlist.** Follow a launch; changes to it are shown first (browser-local to start, no accounts).
4. **Editorial policy, published before any token launch:** identical treatment of Block0's own token, disclosed
   relationships, no favourable treatment for funding, no sensational wording.

## How we know it works
Usefulness, not prediction: repeat visits, followed launches, evidence clicks, "was this useful" on alerts, and — as
negatives — corrections, duplicate alerts and stale reads. The forward test answers the separate research question.

## Constraints that stay
$0 running cost (free node, static hosting, GitHub Actions while the repo is public). Dry run by default. No metered
fallback. A token launch waits for real usage.
