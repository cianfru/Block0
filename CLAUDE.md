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
- **Wallet PnL report (`wallet-pnl.mjs`):** one wallet's reconstructed PnL across the winner set, reusing the cached
  backtests the leaderboard warms (reconciles to the cent). `/api/wallet-pnl?a=`; per-token orbs via `/api/wallet-trades`.
- **Contract filter (`rpc.isContract`, `eth_getCode`, cached forever, fails open):** keeps bots/routers/pools off the
  leaderboard ("follow the smart money" = humans); count reported openly on the page.
- **Post desk (`cards.mjs`):** turns live numbers into postable cards (eyebrow/hero/summary/tweet/viz), each built
  defensively (omit, never fake). `/api/cards` (CONTROL_PASSWORD-gated). Rendered client-side onto a 1080² canvas by
  `public/desk-cards.js` (shared by `/desk` + `/post`).
- **Social manager (`social.mjs`):** pure `{queue, log}` reducer (queue/move/posted/unpost/logRemove + cadence),
  persisted in KV. `/api/social` (gated). Powers `/post` — build → queue → mark posted → log. Nothing auto-posts.
- **KV (`store/kv.mjs`):** 3 backends auto-selected (Upstash REST > native `redis://` TCP `store/redis-tcp.mjs` > file).
  `kvPing()` reports backend/connected honestly. Redis is live in prod.

## Front end
- **ONE repo, no parallel app** — hand-written `public/*.html` (+ shared `public/block0-cards.js` renderer + `block0.css`).
  Terminal aesthetic: near-black `#08080b`, lime `#c8ff4d` accent, cyan/magenta/coral signal colours, Instrument Serif
  display + Inter body + mono data.
- **Pages:** `/` landing · `/board` grid · `/token` dossier · `/leaderboard` proven wallets · `/wallet` per-wallet PnL ·
  `/methodology` · owner-only `/control` (forensics) · `/desk` (daily post cards) · `/post` (social manager).
- **⭐ LANDING = SHOW THE PRODUCT, not the philosophy (owner, 2026-09; big redesign).** Killed the abstract scroll-tunnel
  and the "we're honest" sermon. Hero is a LIVE verdict card (real graded token: risk dial + flags), left is one line
  ("Don't ape blind.") + a scan box that produces a **free verdict right on the landing** (fetch `/api/token`, render the
  card) with "See the full dossier →" bridging to the gated depth. Then: the **winner-corridor** lateral-profile canvas
  animation (price line threading stage gates → WINNER, losers fall out), concrete **signal tiles** (icon chips, not
  prose), a 3-number **proof band**, and a short access section. Honesty is demonstrated (real numbers, one "signal, not
  proof" line), never preached.
- **⭐ WALLETS = OUR OWN PnL PAGE, NO THIRD PARTY (Zerion KILLED 2026-09).** Zerion/DeBank don't index the Robinhood Chain
  ("unsupported address"), so every wallet everywhere (leaderboard, dossier rows, smart-money, bubble map) links to
  **`/wallet?a=<addr>`** — our reconstruction (`wallet-pnl.mjs`: per-token realized/unrealized across the winner set,
  reusing cached backtests; a lazy per-token "where it bought & sold" orbs chart via `walletTrades`). The chain block
  explorer (`EXPLORER_URL`) is the only external link, as a secondary. `r.links = {explorer}` on `/api/token`+`/api/graph`.
- **⭐ BUBBLE MAP (dossier) — 3D + drag + click-to-open-bundle (2026-09).** Nodes are shaded spheres (depth); a continuous
  self-settling force sim makes them **drag-able** (bubblemap-style); **click a bubble → focuses its bundle** (dims the
  rest, lights the cluster ring, panel lists member wallets → each links to its `/wallet` PnL). Hover tips; drag vs click
  by movement. All in `public/index.html` (canvas, no deps).
- **⭐ BUNDLES FLAGGED HARD.** Any token card (board + landing preview + hero verdict) shows a loud coral "⚠ N bundles
  detected" banner + red edge when `flags.bundles>0`.
- **Design source:** the owner may sketch in Lovable; port the good bits into `public/*.html`. Lovable binds to the live
  `/api/*` via the README data contract (CORS open).

## Conventions
- Feature engines are **pure + injectable + unit-tested** (pnl/leaderboard/graph/funders/cards/social/wallet-pnl). Endpoints
  wire them to data. Keep new engines the same way. `npm test` — 55 tests, keep it green before every push.
- Commit to `main` → Railway deploys. Use `[skip ci]`-style discipline only if a deploy-cost cap ever appears.
- `.env.example` documents every knob. New cost-affecting behaviour gets an env flag + a sensible cheap default.
- **⭐ SECURITY — escape all on-chain strings.** Token symbols/names are attacker-controlled (permissionless launchpad),
  so ANY on-chain string rendered via innerHTML MUST go through `B0.esc()` (shared in block0-cards.js). This bit us once
  (XSS via a crafted symbol on the public board) — fixed 2026-09; don't reintroduce it. Gated endpoints check
  `CONTROL_PASSWORD` and fail closed. Auth is password-in-body (not cookies) → CSRF-safe even with `CORS *`.
- **⭐ THE TOKEN GATE IS A CURTAIN, NOT A WALL (important).** `block0-gate.js` is a client-side localStorage flag + a
  read-only balance check; the `/api/*` data endpoints are PUBLIC and do not enforce it. Fine for the open/experiment
  launch (data is public chain data anyway, and the free-verdict/gated-depth split is a UX promise). If the business ever
  needs REAL gating, the deep feeds must move behind a server-side authed endpoint — that's a separate project.

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

## Shipped 2026-09 (this build cycle)
- **✅ Control/forensics `/control`** (audience geo, coverage, convergence, ops health) + **`/desk`** (daily post cards)
  + **`/post`** (social manager: queue/log, KV-persisted). All CONTROL_PASSWORD-gated.
- **✅ `/wallet` per-wallet PnL page** + Zerion removed everywhere (our reconstruction only).
- **✅ Landing rebuilt** (product-first hero, free-verdict scan, winner-corridor animation, signal chips, proof band).
- **✅ Bubble map** 3D + drag + click-to-open-bundle; **heavy bundle flag** on cards; **contract/bot filter** on the board.
- **✅ Redis** (native TCP) live for persistence. **✅ XSS hardening** (esc all on-chain strings).

## Roadmap / owner asks (open)
- **🔲 PRODUCTION SWITCH-ON (owner):** decide open vs token-gated launch; if gated, deploy the BLOCK0 token + set
  `GATE_TOKEN`/`GATE_THRESHOLD`/`GATE_SYMBOL`/`GATE_DECIMALS`/`GATE_BUY_URL`. Set `EXPLORER_URL`, `PUBLIC_URL` + domain,
  fill `/terms`. Confirm `CONTROL_PASSWORD` + `REDIS_URL` (both set). Optional Telegram alert vars.
- **🔲 REAL gating (only if the model needs it):** move the deep feeds behind a server-side authed endpoint (today the
  gate is a curtain — see Conventions).
- **🔲 Light per-IP rate limit** on the heavy public endpoints (`/api/token`, `/api/wallet-pnl`) before heavy promotion —
  they trigger on-chain reconstruction (cached, but a distinct-address spray costs RPC).
- **🔲 Still flagged:** mobile hamburger nav (most traffic is mobile-from-X), OG images + favicon, out-of-sample model
  tracking as the cohort grows, scroll-linked replay of the corridor animation.
