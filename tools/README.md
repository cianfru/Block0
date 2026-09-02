# Winner-study model pipeline

`model.json` (the ladder + corridor the live board and token pages read) is **generated**, not hand-edited.
Everything here is reproducible from public Robinhood-Chain data.

```
cohort backtests ──► study/*.json ──► model.json
   (needs RPC)        (committed)      (committed, served)
```

## Steps

1. **Backtest the cohort** — run `backtest()` on each winner (top graduations) and a loser control set, saving
   one JSON per token into `winners_full/`, `profiles/`, and `losers/` (plus `board.json`, `losers.json`).
   This is the only step that needs an RPC, so it runs offline, not in the deploy.

2. **Build the study data** (from the scanner root, with the cohort dirs present):
   - `node tools/corridor.mjs`   → `study/corridor_data.json`   — per-age trajectory envelope (winner q1/med/q3 by age bin)
   - `node tools/projection.mjs` → `study/projection_data.json` — valuation ladder + each winner's wallets/mcap-by-age path
   - `node tools/extract_blueprint.mjs` → `study/blueprint_data.json` — the winner-fingerprint weights (reference)

3. **Assemble the model**:
   - `node tools/gen-model.mjs` → `model.json`

`gen-model.mjs` joins the two study files and — crucially — attaches the **concrete per-stage targets** to each
corridor bin: the median unique-wallet count (`tw`) and market cap (`tm`) the winner cohort carried at that age,
gated to bins with ≥4 winner samples so nothing is fabricated. Keeping this join in a committed script is the point:
a model refresh regenerated this way can never silently drop the targets.

## Refreshing with more graduations later

Re-run step 1 with the larger cohort, then steps 2–3. `model.json` is rewritten with the new ladder, corridor, and
targets automatically — no manual editing, no lost fields.
