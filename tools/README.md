# Winner-study model pipeline

`model.json` (the ladder + corridor the live board and token pages read) is **generated**, not hand-edited.
Everything here is reproducible from public Robinhood-Chain data.

```
cohort backtests ──► study/*.json ──► model.json
   (needs RPC)        (committed)      (committed, served)
```

## Cohort definition — outcome, not graduation

Every token on the chain (Pons launch or direct DEX listing) is labelled by **what it became**, with one rule
(`outcome.mjs`). Graduation is not a criterion. A winner is a sustainable path to a real valuation:

| tier | rule | role |
|---|---|---|
| major | held-peak ≥ $5M, stayed ≥ $1M for 14 days, holders ≥ 70% of peak, still ≥ 25% of held-peak | winner |
| runner | held-peak ≥ $1M, stayed ≥ $1M for 7 days, holders ≥ 70% of peak, still ≥ 25% of held-peak | winner |
| pending | too young to have held or failed the window (right-censored) | excluded |
| mid | reached ≥ $300k, alive, neither held $1M nor collapsed | excluded |
| faded | reached ≥ $300k (or held $1M a week, then collapsed), now below 25% of held-peak | control (primary) |
| stalled | a week old, never reached $300k, still has a market | control |
| dead | 48h old, under $10k | control |

"Held-peak" is the highest market cap the token stayed at for a full day — reconstructed caps wick on single swaps.
The launchpad token and quote assets are excluded. Thresholds are the `RULES` knobs; `definitions()` renders the text
the methodology page shows, so the page can't drift from the code.

## Steps

1. **Profile the universe** — `node tools/build-cohort.mjs [--budgetMin=120] [--controls=300] [--dex]`. Pulls every
   Pons launch (graduated + active) and, with `--dex`, direct DEX listings; backtests what it hasn't profiled yet,
   highest-value first, inside the wall-clock budget; writes one slim profile per token to `study/profiles/<address>.json`
   (**committed** — the cache the cohort compounds on) and the index `study/cohort.json` (every token + outcome label +
   per-tier counts). Cached tokens are re-labelled with the launchpad's live market cap at zero RPC cost and only
   re-backtested when still undecided (pending/mid), printing new highs, or a young winner whose path is still growing.
   A run stopped by the budget commits what it has; the next run continues the queue. `--dry` prints the queue.
   This is the only step that needs an RPC, so it runs offline / in the rebuild workflow, not in the deploy.

2. **Build the study data** (from the scanner root):
   - `node tools/corridor.mjs`   → `study/corridor_data.json`   — per-age trajectory envelope (winner q1/med/q3 by age bin) + every token's path, labelled
   - `node tools/projection.mjs` → `study/projection_data.json` — valuation ladder + each winner's wallets/mcap-by-age path + controls' outcomes
   - `node tools/extract_blueprint.mjs` → `study/blueprint_data.json` — the winner-fingerprint weights (reference)

3. **Assemble the model**:
   - `node tools/gen-model.mjs` → `model.json` — refuses to overwrite below 10 winners (`--minWinners`, `--force`), and
     records the cohort basis (`model.json.cohort`: counts, rules, definitions, the winner list).

4. **Measure it**: `node tools/validate.mjs` → `study/validation.json` — per-age AUC vs all controls and vs faded only,
   leave-one-out winner catch rate, false alarms on faded tokens, and a launch-date **time split** (band fitted on earlier
   winners, graded only on later launches; reported as not-ready with the reason when the later slice is under 5).

`gen-model.mjs` joins the two study files and — crucially — attaches the **concrete per-stage targets** to each
corridor bin: the median unique-wallet count (`tw`) and market cap (`tm`) the winner cohort carried at that age,
gated to bins with ≥4 winner samples so nothing is fabricated. Keeping this join in a committed script is the point:
a model refresh regenerated this way can never silently drop the targets.

`STUDY_DIR=<dir>` redirects every step to another directory (the pipeline test runs on a synthetic cohort this way).

## Refreshing as launches settle

Re-run step 1 (it only backtests what's new or still open), then steps 2–4. `model.json`, `study/cohort.json` and
`study/validation.json` are rewritten automatically — no manual editing, no lost fields. The full refresh in one line:

```
node tools/build-cohort.mjs --dex && node tools/corridor.mjs && node tools/projection.mjs && node tools/gen-model.mjs && node tools/validate.mjs
```
