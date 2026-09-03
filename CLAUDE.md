# Block0 — project notes

Block0 is a transparent, real-time "should I ape?" launch scanner for the **Robinhood Chain** (Uniswap-v4 based).
It verdicts every launch (Pons launchpad + direct DEX listings) on-chain — snipers, bundles, concentration, live
dumping — places it against a study of past winners, and shows the wallet intelligence behind it. Deploys on
**Railway** (auto-deploy from `main` of `github.com/cianfru/Block0`). Node, dependency-light (`node server.mjs`).

## ⭐⭐ NORTH STAR — MINIMUM COST. This is an EXPERIMENT, keep it as cheap as it can possibly be (owner, 2026-09-03)
- **The whole project must run at the lowest cost we can manage.** We're launching a token and *hoping* for traction
  — it might get none and just die. So every recurring cost has to be justified against "what if this never takes
  off." Default to the cheapest path that still works. When in doubt, cheaper.
- **⭐ ALCHEMY IS THE METERED RESOURCE — BE BUDGET-CONSCIOUS ON EVERY PULL.** We moved to Alchemy pay-as-you-go, but
  PAYG is not permission to spend. Yes, data has to go through Alchemy; yes, everything must work — but we do NOT
  overrun Alchemy just because the plan allows it. Rules, always:
  - **Prefer the native RH RPC (`https://rpc.mainnet.chain.robinhood.com`) — it's FREE.** It serves 10k-block
    `eth_getLogs` ranges (Alchemy free tier capped these at 10 blocks, which is why Alchemy exists here at all). Use
    the native node for wide log scans (DEX discovery, transfer history) and reserve Alchemy for what genuinely needs
    it (the enhanced `getAssetTransfers` — paged, hash-carrying, cross-wallet history).
  - **Cache anything immutable FOREVER.** A wallet's first funder, a token's deploy block, historical transfers —
    these never change. Pull once, cache in KV, never re-pull. (Funder cache = `funder:{addr}`, permanent.)
  - **Incremental, never full-pull on a schedule.** The transfer store pulls only new blocks since last seen. The
    backtest reuses the store's cached transfers instead of re-pulling. Any daily/periodic job pulls deltas only.
  - **Bound every fan-out.** Per-wallet lookups (funders, wallet intel) are capped to the top N (e.g. FUNDER_CAP=40),
    never "every holder." Heavy features are **opt-in** (a query flag), not on by default / not on every refresh.
  - **Debounce + cache results.** Backtests cache 30 min (KV `bt:*`); the leaderboard runs every 30 min reusing
    cached backtests; the graph reads the store. Don't recompute what a cache already holds.
  - **The lesson from the sister project (SPX/Dune): measure BOTH execution AND the result-read/egress cost.** A
    cheap call whose RESULT is large, pulled on a schedule, is not cheap. Go incremental.
- **Paying more for Alchemy is not the fix.** If something is too expensive, make it cheaper (native RPC, cache,
  bound, opt-in, incremental) — don't raise the ceiling to spend through.

## Architecture (the cheap-by-design data flow)
- **Discovery:** Pons API (launchpad, source of truth for mcap/logo/graduation) + native-RPC topic-filtered
  `eth_getLogs` for Uniswap-v4 `Initialize` events (direct DEX listings). Tokenized stocks + infra/wrapper tokens
  are excluded (`isTokenizedStock`, `INFRA` set in dex.mjs).
- **Forensic verdict (`intel.mjs` `computeIntel`):** one transfer-replay pass → snipers / bundles / concentration /
  live dumping / risk / momentum. Same `computeRisk` the board and the historical backtest share.
- **Incremental transfer store (`store.mjs`):** per-token cached transfers, pulls only new blocks. The backtest and
  graph reuse it instead of re-pulling.
- **Board (`board.mjs`):** Pons cooking + graduated verdicts on one interval; **DEX discovery on its own interval**
  (decoupled so slow Alchemy verdicts never stall the core board). Publishes incrementally per verdict. Tags each
  token with explicit `section` (cooking|graduated|dex) + `venue` (pons|uniswap-v4).
- **Backtest (`backtest.mjs`):** replays a token's history → forensic score trajectory + swap-implied price (one
  representative swap per bucket, ~45 receipt calls, cached). Also per-wallet **PnL** (see below).
- **Winner model (`model.json` + `study/*.json`):** built offline by `tools/build-cohort.mjs` → corridor →
  projection → gen-model → validate. RPC-heavy, so it runs in the **`rebuild-model.yml` GitHub Action** (needs the
  `ALCHEMY_RPC_URL` **repo secret** — separate from Railway env), NOT in the app. Includes DEX winners via `--dex`.

## Feature engines (all pure + unit-tested; `npm test`)
- **PnL (`pnl.mjs`):** avg-cost realized (coins sold) + unrealized (coins held) per wallet, from the backtest's
  price series. Conservative — untracked-cost coins credit ZERO profit (understates, never invents). On
  `/api/backtest` as `pnl[]` + `pnlStats`. Powers "is this wallet up or down."
- **Leaderboard (`leaderboard.mjs`):** aggregates per-token PnL across graduated + DEX winners → proven positive-PnL
  wallets to follow. `/api/leaderboard`, KV-cached, refreshed every 30 min reusing cached backtests.
- **Bubble map (`graph.mjs`):** wallet-relationship graph per token from its OWN transfers (no extra RPC). Nodes
  (holders, role bundle/sniper/holder), edges (bundle = same-block first buy; transfer = token moved wallet↔wallet),
  clusters (connected components, `flag`ged when bundle-y). Per-node + per-cluster **flow** (green buy / red sell
  over ~24h) so a coordinated cohort lights up if it's distributing. `/api/graph`.
  - **Funder layer (`funders.mjs`, opt-in `?funders=1`, TOP 40 ONLY):** the deeper Bubblemaps signal — wallets
    funded from the same source. Budget-guarded: one `getAssetTransfers` per top wallet, **cached permanently**
    (funder is immutable), fan-out guard drops exchange-like common funders. Never on by default.
- **Wallet intel (`wallet.mjs`):** cross-token footprint for any wallet (held vs exited, flipper vs holder),
  `getAssetTransfers` two directions, capped, cached 15 min. `/api/wallet`.

## Front end
- **Design lives in Lovable** (owner designs there; it's slicker). Workflow: read Lovable's design, hand-port the
  good visual bits into our own `public/*.html` — **ONE repo, no parallel app**. Lovable reads this repo's
  **README.md data contract** to bind the design to the live `/api/*` endpoints (CORS is open).
- **Token-gated access:** a Block0 token will gate the platform — connect an EVM wallet, read-only balance check,
  ≥ threshold (e.g. 1M) = in. Tokenomics TBD.
- **Wallet = a Zerion card, never a raw hex string.** Zerion supports the RH chain; every wallet opens a real
  portfolio page. Render a Zerion-style preview card (from the bag/PnL/role/flow we return) linking to
  `${links.zerion}/{address}`. `links` ships on `/api/graph` + `/api/token`.

## Conventions
- Feature engines are **pure + injectable + unit-tested** (pnl/leaderboard/graph/funders). Endpoints wire them to
  data. Keep new engines the same way.
- Commit to `main` → Railway deploys. Use `[skip ci]`-style discipline only if a deploy-cost cap ever appears.
- `.env.example` documents every knob. New cost-affecting behaviour gets an env flag + a sensible cheap default.

## Tokenomics — token-gated access (owner decided 2026-09)
- **Access = holding a FIXED NUMBER OF TOKENS, not a dollar value.** Rationale (owner): a dollar-pegged threshold
  makes the required token count fall as price rises, so members hold excess above the bar and have a standing
  incentive to sell the surplus → sell pressure. A fixed token count means a member must hold exactly N to keep
  access — no excess to trim — and the market sets the price freely. Less sell pressure, simpler, honest.
- The gate (`/api/gate`, `block0-gate.js`) already works on a fixed token count: `GATE_THRESHOLD` = whole tokens.
- Sizing guide (for choosing N): access cost in $ = (N / supply) × mcap. So N as a % of supply fixes the $-cost at
  any given mcap. Pick N for the mcap where the TYPICAL member is expected to join, not the aspirational top.
  Example: N = 0.001% of supply → ~$100 access at $10M mcap (~$10 at $1M, ~$1,000 at $100M). Consider a cheaper
  founding-member bar for the first ~100–200 holders as an early growth lever.

## Roadmap / owner asks (2026-09)
- **🔲 FORENSIC ANALYTICS + CONTROL PANEL (building):** track who visits — count, country/geo, time, referrer, which
  tokens/pages viewed, and WALLET CONNECTS (how many wallets, which) — like the rainbow-chart site's intel panel.
  Plus Railway health/uptime/sustainability (process uptime, memory, board freshness, feed health). Password-gated
  `/control` dashboard. Storage via store/kv.mjs (events list + unique-visitor set + aggregates). Geo from
  cf-ipcountry/x-vercel-ip-country headers if present, else a cached best-effort IP lookup.
- **🔲 LANDING SCROLL HERO (next):** an Apple-style, highly polished winner CONE WITH DEPTH where a PRICE LINE
  travels through it as the user SCROLLS from the top to the second section (scroll-linked animation), surfacing a
  few tracked parameters. Adapt the token-page cone renderer to a scroll-driven canvas with perspective/depth.
- **🔲 Also flagged in the audit:** mobile hamburger nav (most traffic is mobile-from-X), OG images + favicon,
  out-of-sample model tracking as the cohort grows, explorer URL.
